import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, readFile, writeFile, mkdir, symlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { JsonValue, EditResult, EditReplacement, ProviderSubmitResult } from "@managed-agents/contracts";
import { startStack, input, event, signed, until } from "./stack.ts";
import type { FakeJob } from "./stack.ts";

const binary = process.env.PROCESS_EXECUTION_TEST_BINARY;
test("native runtime through worker, signed router and session: replacements, errors, file limits, symlinks and replay", { skip: !binary, timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-edit-runtime-")), endpoint = join(directory, "s.sock");
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
    job.response = response; job.error = null;
    job.status = response.status === "ok" && (response.result as { status?: string })?.status === "applied" ? "succeeded" : "failed";
  }
  async function edit(path: string, edits: EditReplacement[]) {
    const sessionId = randomUUID();
    await stack.call("/start", { sessionId, input: { ...input, cwd: directory, path, edits } });
    const job = await until(async () => [...stack.gateway.jobs.values()].find(job => job.clientContext.sessionId === sessionId));
    await execute(job);
    assert.equal((await stack.callbacks.fetch("https://callbacks/webhooks/execution-gateway", signed(event(job)))).status, 204, JSON.stringify(job.response));
    const snapshot = await until(async () => { const s = await stack.call("/snapshot", { sessionId }); return s.results.length ? s : undefined; });
    const outcome = snapshot.operations[0]!.outcome;
    assert.equal(outcome?.status, "succeeded");
    if (outcome?.status !== "succeeded") throw new Error(JSON.stringify(outcome));
    return { job, result: outcome.result as EditResult };
  }
  const replacement = (oldText: string, newText: string) => [{ oldText, newText }];
  try {
    await until(async () => {
      assert.equal(server.exitCode, null, stderr);
      try { const info = await rpc({ protocol_version: 5, request_id: randomUUID(), operation: "runtime.info" }); return info.status === "ok" ? info : undefined; }
      catch { return undefined; }
    });
    const path = "hello world.txt", original = "\uFEFFfirst=old\r\nsecond=नमस्ते 🌍\r\nremove\r\n";
    await writeFile(join(directory, path), original);
    const first = await edit(path, [{ oldText: "remove\n", newText: "" }, { oldText: "first=old", newText: "first=new" }, { oldText: "नमस्ते 🌍", newText: "hello 🌍" }]);
    const expected = "\uFEFFfirst=new\r\nsecond=hello 🌍\r\n";
    assert.equal(first.result.isError, false); assert.equal(await readFile(join(directory, path), "utf8"), expected);
    assert.equal(first.result.content[0]!.text, `Successfully replaced 3 block(s) in ${path}.`);
    assert.equal(first.result.details.changes?.[0]?.afterSha256, createHash("sha256").update(expected).digest("hex"));
    assert.equal(first.result.details.firstChangedLine, 1);
    assert.equal((await edit(join(directory, path), replacement("first=new", "first=later"))).result.isError, false);
    const later = await readFile(join(directory, path), "utf8");
    const oldReceipt = first.job.response; await execute(first.job);
    assert.deepEqual(first.job.response, oldReceipt); assert.equal(await readFile(join(directory, path), "utf8"), later);
    const replay = await stack.call<ProviderSubmitResult>("/submit", { destination: { routeKey: "test-v1", sessionId: first.job.clientContext.sessionId }, submission: {
      operationId: first.job.clientContext.operationId, submissionId: first.job.clientContext.submissionId,
      request: { provider: "tool-pi-edit", type: "edit", version: "v1", input: { ...input, cwd: directory, path, edits: first.job.request.params.patch.files[0]!.edits } } } });
    assert.equal(replay.status, "completed");
    if (replay.status === "completed" && replay.outcome.status === "succeeded") assert.deepEqual(replay.outcome.result, first.result);
    else assert.fail("Expected recovered tool result");
    await writeFile(join(directory, "matches"), "abc abc\nxyz\n");
    for (const edits of [replacement("abc", "other"), replacement("missing", "new"),
      [{ oldText: "abc abc", newText: "x" }, { oldText: "abc abc\n", newText: "y" }],
      [{ oldText: "abc abc", newText: "created" }, { oldText: "created", newText: "later" }], replacement("xyz", "xyz")]) {
      const failed = await edit("matches", edits);
      assert.equal(failed.result.isError, true); assert.equal(failed.result.details.status, "rejected");
      assert.equal(await readFile(join(directory, "matches"), "utf8"), "abc abc\nxyz\n");
    }
    assert.equal((await edit("missing", replacement("x", "y"))).result.isError, true);
    await mkdir(join(directory, "directory")); assert.equal((await edit("directory", replacement("x", "y"))).result.isError, true);
    await writeFile(join(directory, "binary"), Buffer.from([255])); assert.equal((await edit("binary", replacement("x", "y"))).result.isError, true);
    await writeFile(join(directory, "target"), "before"); await symlink("target", join(directory, "alias"));
    assert.equal((await edit("alias", replacement("before", "after"))).result.isError, false);
    assert.equal((await lstat(join(directory, "alias"))).isSymbolicLink(), true); assert.equal(await readFile(join(directory, "target"), "utf8"), "after");
    const boundary = Buffer.alloc(5242880, 120); boundary.write("unique"); await writeFile(join(directory, "boundary"), boundary);
    const large = await edit("boundary", replacement("unique", "UNIQUE")); assert.equal(large.result.isError, false);
    assert.equal(large.result.details.diffTruncated, true); assert.equal((await readFile(join(directory, "boundary"))).length, 5242880);
    assert.equal((await edit("boundary", replacement("UNIQUE", "UNIQUE!"))).result.details.error?.code, "resource_limit");
    assert.equal((await readFile(join(directory, "boundary"))).length, 5242880);
    await writeFile(join(directory, "oversized"), Buffer.alloc(5242881, 120));
    assert.equal((await edit("oversized", replacement("x", "y"))).result.details.error?.code, "resource_limit");
  } finally {
    await stack.app.dispose();
    if (server.exitCode === null) { const closed = once(server, "close"); server.kill("SIGTERM"); await closed; }
    await rm(directory, { recursive: true, force: true });
  }
});
