import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, readFile, writeFile, mkdir, symlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { JsonValue, ApplyPatchResult, ProviderSubmitResult } from "@managed-agents/contracts";
import { startStack, input, event, signed, until } from "./stack.ts";
import type { FakeJob } from "./stack.ts";

const binary = process.env.PROCESS_EXECUTION_TEST_BINARY;
test("native runtime through worker, signed router and session: multi-file patches, matching, errors, file limits and replay", { skip: !binary, timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-patch-runtime-")), endpoint = join(directory, "s.sock");
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
  async function apply(patch: string) {
    const sessionId = randomUUID();
    await stack.call("/start", { sessionId, input: { ...input, cwd: directory, patch } });
    const job = await until(async () => [...stack.gateway.jobs.values()].find(job => job.clientContext.sessionId === sessionId));
    await execute(job);
    assert.equal((await stack.callbacks.fetch("https://callbacks/webhooks/execution-gateway", signed(event(job)))).status, 204, JSON.stringify(job.response));
    const snapshot = await until(async () => { const s = await stack.call("/snapshot", { sessionId }); return s.results.length ? s : undefined; });
    const outcome = snapshot.operations[0]!.outcome;
    assert.equal(outcome?.status, "succeeded");
    if (outcome?.status !== "succeeded") throw new Error(JSON.stringify(outcome));
    return { job, result: outcome.result as ApplyPatchResult };
  }
  const patch = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;
  try {
    await until(async () => {
      assert.equal(server.exitCode, null, stderr);
      try { const info = await rpc({ protocol_version: 5, request_id: randomUUID(), operation: "runtime.info" }); return info.status === "ok" ? info : undefined; }
      catch { return undefined; }
    });
    await writeFile(join(directory, "old.txt"), "before\n");
    await writeFile(join(directory, "gone.txt"), "remove\n");
    await writeFile(join(directory, "destination.txt"), "overwritten\n");
    const text = patch("*** Add File: nested/hello world.txt\n+नमस्ते 🌍\n*** Update File: nested/hello world.txt\n@@\n-नमस्ते 🌍\n+hello 🌍\n*** Update File: old.txt\n*** Move to: destination.txt\n@@\n-before\n+after\n*** Delete File: gone.txt");
    const first = await apply(text);
    assert.equal(first.result.isError, false);
    assert.deepEqual(first.result.details.changes?.map(c => c.kind), ["add", "update", "move", "delete"]);
    assert.equal(await readFile(join(directory, "nested/hello world.txt"), "utf8"), "hello 🌍\n");
    assert.equal(await readFile(join(directory, "destination.txt"), "utf8"), "after\n");
    await assert.rejects(readFile(join(directory, "old.txt")), { code: "ENOENT" });
    await assert.rejects(readFile(join(directory, "gone.txt")), { code: "ENOENT" });
    assert.equal(first.result.details.changes?.[2]?.destinationBeforeSha256, createHash("sha256").update("overwritten\n").digest("hex"));
    assert.equal(first.result.details.changes?.[3]?.afterSha256, null);
    // Move to a new directory has absent destination-before metadata in the native receipt.
    const moved = await apply(patch("*** Update File: destination.txt\n*** Move to: new/destination.txt\n@@\n-after\n+later"));
    assert.equal(moved.result.isError, false);
    assert.equal(moved.result.details.changes?.[0]?.destinationBeforeSha256, null);
    // Replay the original receipt after subsequent filesystem changes; never execute it again.
    const oldReceipt = first.job.response; await execute(first.job);
    assert.deepEqual(first.job.response, oldReceipt);
    await assert.rejects(readFile(join(directory, "destination.txt")), { code: "ENOENT" });
    const replay = await stack.call<ProviderSubmitResult>("/submit", { destination: { routeKey: "test-v1", sessionId: first.job.clientContext.sessionId }, submission: {
      operationId: first.job.clientContext.operationId, submissionId: first.job.clientContext.submissionId,
      request: { provider: "tool-codex-apply-patch", type: "apply_patch", version: "v1", input: { ...input, cwd: directory, patch: text } } } });
    assert.equal(replay.status, "completed");
    if (replay.status === "completed" && replay.outcome.status === "succeeded") assert.deepEqual(replay.outcome.result, first.result);
    else assert.fail("Expected recovered tool result");
    assert.equal((await stack.callbacks.fetch("https://callbacks/webhooks/execution-gateway", signed(event(first.job)))).status, 204);
    // Multiple hunks, ordered matching, fuzzy punctuation, whitespace and EOF anchoring.
    await writeFile(join(directory, "matching"), "heading\n  curly “quote”  \nuntouched\nend\n");
    const matching = await apply(patch('*** Update File: matching\n@@ heading\n-curly "quote"\n+plain\n@@\n-end\n+done\n*** End of File'));
    assert.equal(matching.result.isError, false);
    assert.equal(await readFile(join(directory, "matching"), "utf8"), "heading\nplain\nuntouched\ndone\n");
    // The entire patch is planned before writes: a later mismatch prevents an earlier add.
    for (const body of ["*** Add File: untouched-new\n+x\n*** Update File: matching\n@@\n-missing\n+new",
      "*** Update File: missing\n@@\n-x\n+y", "*** Environment ID: other\n*** Add File: untouched-new\n+x"] ) {
      const failed = await apply(patch(body));
      assert.equal(failed.result.isError, true); assert.equal(failed.result.details.status, "rejected");
      assert.deepEqual(failed.result.details.changes, []);
      await assert.rejects(readFile(join(directory, "untouched-new")), { code: "ENOENT" });
    }
    assert.equal((await apply("not a patch")).result.isError, true);
    await mkdir(join(directory, "directory"));
    assert.equal((await apply(patch("*** Delete File: directory"))).result.isError, true);
    await writeFile(join(directory, "binary"), Buffer.from([255]));
    assert.equal((await apply(patch("*** Update File: binary\n@@\n-x\n+y"))).result.isError, true);
    await writeFile(join(directory, "target"), "before\n"); await symlink("target", join(directory, "alias"));
    assert.equal((await apply(patch("*** Update File: alias\n@@\n-before\n+after"))).result.isError, false);
    assert.equal((await lstat(join(directory, "alias"))).isSymbolicLink(), true);
    assert.equal((await apply(patch("*** Delete File: alias"))).result.isError, true);
    const boundary = "unique\n" + "x".repeat(5242880 - 8) + "\n";
    await writeFile(join(directory, "boundary"), boundary);
    const large = await apply(patch("*** Update File: boundary\n@@\n-unique\n+UNIQUE"));
    assert.equal(large.result.isError, false); assert.equal(large.result.details.diffTruncated, true);
    assert.equal((await readFile(join(directory, "boundary"))).length, 5242880);
    assert.equal((await apply(patch("*** Update File: boundary\n@@\n-UNIQUE\n+UNIQUE!"))).result.details.error?.code, "resource_limit");
    assert.equal((await readFile(join(directory, "boundary"))).length, 5242880);
    await writeFile(join(directory, "oversized"), Buffer.alloc(5242881, 120));
    assert.equal((await apply(patch("*** Delete File: oversized"))).result.details.error?.code, "resource_limit");
  } finally {
    await stack.app.dispose();
    if (server.exitCode === null) { const closed = once(server, "close"); server.kill("SIGTERM"); await closed; }
    await rm(directory, { recursive: true, force: true });
  }
});
