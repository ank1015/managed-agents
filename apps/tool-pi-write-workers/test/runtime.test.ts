import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, readFile, writeFile, mkdir, symlink, lstat, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { JsonValue, WriteResult, ProviderSubmitResult } from "@managed-agents/contracts";
import { startStack, input, event, signed, until } from "./stack.ts";
import type { FakeJob } from "./stack.ts";

// Optional cross-repository integration. Normal checks require no Rust checkout or machine daemon.
const binary = process.env.PROCESS_EXECUTION_TEST_BINARY;
test("actual execution runtime: create, truncate, UTF-8, links, large replacement and replay through worker callbacks", { skip: !binary, timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-write-runtime-")), endpoint = join(directory, "s.sock");
  const server = spawn(binary!, ["serve", "--endpoint", endpoint, "--cwd", directory], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; server.stderr.on("data", data => { stderr += data.toString(); });
  server.on("error", error => { stderr += String(error); });
  const stack = await startStack();
  async function rpc(request: unknown): Promise<Record<string, JsonValue>> {
    const child = spawn(binary!, ["rpc", "--endpoint", endpoint, "--timeout-ms", "5000"], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "", error = "";
    child.stdout.on("data", data => { output += data.toString(); });
    child.stderr.on("data", data => { error += data.toString(); });
    child.stdin.end(JSON.stringify(request));
    await once(child, "close");
    if (!output) throw new Error(error);
    return JSON.parse(output) as Record<string, JsonValue>;
  }
  async function execute(job: FakeJob) {
    const response = await rpc({ protocol_version: 5, request_id: job.id, ...job.request });
    job.runtimeGenerationId = response.generation_id as string;
    job.response = response; job.error = null; job.status = response.status === "ok" ? "succeeded" : "failed";
  }
  async function write(path: string, content: string) {
    const sessionId = randomUUID();
    await stack.call("/start", { sessionId, input: { ...input, cwd: directory, path, content } });
    const job = await until(async () => [...stack.gateway.jobs.values()].find(job => job.clientContext.sessionId === sessionId));
    await execute(job);
    assert.equal((await stack.callbacks.fetch("https://callbacks/webhooks/execution-gateway", signed(event(job)))).status, 204);
    const snapshot = await until(async () => { const s = await stack.call("/snapshot", { sessionId }); return s.results.length ? s : undefined; });
    const outcome = snapshot.operations[0]!.outcome;
    assert.equal(outcome?.status, "succeeded");
    if (outcome?.status !== "succeeded") throw new Error(JSON.stringify(outcome));
    return { job, result: outcome.result as WriteResult };
  }
  try {
    await until(async () => {
      assert.equal(server.exitCode, null, stderr);
      try { const info = await rpc({ protocol_version: 5, request_id: randomUUID(), operation: "runtime.info" }); return info.status === "ok" ? info : undefined; }
      catch { return undefined; }
    });
    const path = "nested/hello world.txt", content = "नमस्ते 🌍\r\n\0literal $(not executed)\n";
    const first = await write(path, content);
    assert.equal(first.result.isError, false); assert.equal(await readFile(join(directory, path), "utf8"), content);
    assert.equal((await write(path, "replacement")).result.isError, false);
    assert.equal(await readFile(join(directory, path), "utf8"), "replacement");
    // Replaying an old mutation must not overwrite the later value within this runtime generation.
    const oldReceipt = first.job.response; await execute(first.job);
    assert.deepEqual(first.job.response, oldReceipt);
    assert.equal(await readFile(join(directory, path), "utf8"), "replacement");
    assert.equal((await write(join(directory, path), "")).result.isError, false);
    assert.equal((await readFile(join(directory, path))).length, 0);
    const large = join(directory, "old-large.txt"); await writeFile(large, Buffer.alloc(5242881, 120));
    assert.equal((await write(large, "small")).result.isError, false);
    assert.equal(await readFile(large, "utf8"), "small");
    const target = join(directory, "target.txt"), alias = join(directory, "alias.txt");
    await writeFile(target, "old"); await symlink("target.txt", alias);
    assert.equal((await write(alias, "through link")).result.isError, false);
    assert.equal((await lstat(alias)).isSymbolicLink(), true); assert.equal(await readFile(target, "utf8"), "through link");
    const dangling = join(directory, "dangling.txt"); await symlink("new-dir/target.txt", dangling);
    assert.equal((await write(dangling, "created target")).result.isError, false);
    assert.equal((await lstat(dangling)).isSymbolicLink(), true); assert.equal(await readFile(join(directory, "new-dir/target.txt"), "utf8"), "created target");
    const hard = join(directory, "hard.txt"); await link(target, hard);
    await write(target, "new inode"); assert.equal(await readFile(hard, "utf8"), "through link");
    const same = await write(target, "new inode"); assert.equal(same.result.details.file?.disposition, "already_applied");
    await mkdir(join(directory, "directory")); assert.equal((await write("directory", "bad")).result.isError, true);
    await writeFile(join(directory, "parent-file"), "parent"); assert.equal((await write("parent-file/child", "bad")).result.isError, true);
    // Exact 5 MiB goes directly through private submit: production session history has a smaller inline limit.
    const id = randomUUID(), request = { destination: { routeKey: "test-v1", sessionId: "direct" }, submission: {
      operationId: id, submissionId: id, request: { provider: "tool-pi-write", type: "write", version: "v1",
        input: { ...input, cwd: directory, path: "boundary.txt", content: "é".repeat(2621440) } } } };
    const accepted = await stack.call<ProviderSubmitResult>("/submit", request);
    assert.equal(accepted.status, "accepted"); if (accepted.status !== "accepted") throw new Error("not accepted");
    await execute(stack.gateway.jobs.get(accepted.jobId)!);
    const done = await stack.call<ProviderSubmitResult>("/submit", request);
    assert.equal(done.status, "completed");
    if (done.status !== "completed" || done.outcome.status !== "succeeded") throw new Error(JSON.stringify(done));
    assert.equal((done.outcome.result as WriteResult).isError, false);
    assert.deepEqual(await readFile(join(directory, "boundary.txt")), Buffer.from(request.submission.request.input.content));
  } finally {
    await stack.app.dispose();
    if (server.exitCode === null) { const closed = once(server, "close"); server.kill("SIGTERM"); await closed; }
    await rm(directory, { recursive: true, force: true });
  }
});
