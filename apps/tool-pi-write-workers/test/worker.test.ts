import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderSubmitResult, WriteInput, WriteResult } from "@managed-agents/contracts";
import { parseLlmMessage } from "@managed-agents/contracts";
import { FakeGateway, startStack, input, writeReceipt, event, signed, until } from "./stack.ts";
import type { Stack } from "./stack.ts";

const url = "https://callbacks/webhooks/execution-gateway";
async function start(stack: Stack, value: WriteInput = input) {
  const sessionId = randomUUID();
  await stack.call("/start", { sessionId, input: value });
  const job = await until(async () => [...stack.gateway.jobs.values()].find(j => j.clientContext.sessionId === sessionId));
  await until(async () => { const s = await stack.call("/snapshot", { sessionId }); return s.operations.length ? s : undefined; });
  return { sessionId, job };
}
async function outcome(stack: Stack, sessionId: string) {
  const snapshot = await until(async () => { const s = await stack.call("/snapshot", { sessionId }); return s.results.length ? s : undefined; });
  assert.equal(snapshot.results.length, 1); assert.equal(snapshot.progress.blocked, false);
  const result = snapshot.operations[0]!.outcome; assert.ok(result); return result;
}
async function result(stack: Stack, sessionId: string): Promise<WriteResult> {
  const value = await outcome(stack, sessionId); assert.equal(value.status, "succeeded");
  if (value.status !== "succeeded") throw new Error("Expected a completed tool result.");
  return value.result as WriteResult;
}
function submission() {
  return { destination: { routeKey: "test-v1", sessionId: "manual" }, submission: { operationId: "op", submissionId: "sub",
    request: { provider: "tool-pi-write", type: "write", version: "v1", input: structuredClone(input) as WriteInput } } };
}
test("terminal replay verifies retained correlation and never turns detail failure into rejection", async () => {
  const stack = await startStack();
  try {
    const request = submission(), accepted = await stack.call<ProviderSubmitResult>("/submit", request);
    assert.equal(accepted.status, "accepted"); if (accepted.status !== "accepted") throw new Error("Not accepted");
    const job = stack.gateway.jobs.get(accepted.jobId)!; stack.gateway.finish(job);
    for (const patch of [{ id: randomUUID() }, { machineId: randomUUID() }, { idempotencyKey: "other" }, { runtimeGenerationId: randomUUID() },
      { status: "waiting_response" }, { clientContext: { ...job.clientContext, contentSha256: "0".repeat(64) } }]) {
      stack.gateway.detailValue = row => ({ ...row, ...patch }); await assert.rejects(stack.call("/submit", request));
    }
    stack.gateway.detailValue = undefined; stack.gateway.detailError = 404;
    await assert.rejects(stack.call("/submit", request)); stack.gateway.detailError = undefined;
    assert.equal((await stack.call<ProviderSubmitResult>("/submit", request)).status, "completed");
    assert.equal(stack.gateway.jobs.size, 1);
  } finally { await stack.app.dispose(); }
});
test("invalid requests are rejected before gateway submission; routing changes conflict with immutable context", async () => {
  const stack = await startStack();
  try {
    const request = submission();
    for (const extra of [{ clientContext: {} }, { callbackUrl: "https://bad" }, { offset: 0 }, { limit: 0 }, { path: "x\0y" }]) {
      const changed = structuredClone(request); Object.assign(changed.submission.request.input, extra);
      assert.equal((await stack.call<ProviderSubmitResult>("/submit", changed)).status, "rejected");
    }
    const bad = structuredClone(request); bad.destination.routeKey = "unknown";
    await assert.rejects(stack.call("/submit", bad)); assert.equal(stack.gateway.posts, 0);
    await stack.call("/submit", request);
    const changed = structuredClone(request); changed.submission.request.input.content = "different";
    await assert.rejects(stack.call("/submit", changed), /idempotency_conflict/);
    stack.gateway.reject = { status: 409, code: "machine_offline" }; await assert.rejects(stack.call("/submit", request));
    stack.gateway.reject = { status: 400, code: "invalid_argument" };
    assert.equal((await stack.call<ProviderSubmitResult>("/submit", request)).status, "rejected");
  } finally { await stack.app.dispose(); }
});
test("gateway failures and unknown outcomes remain failed operations", async () => {
  const stack = await startStack();
  try {
    for (const status of ["unknown", "failed"]) {
      const { sessionId, job } = await start(stack); job.status = status; job.runtimeGenerationId = null;
      job.error = { code: "dispatch_failure", message: "Machine unavailable" };
      assert.equal((await stack.callbacks.fetch(url, signed(event(job)))).status, 204);
      assert.equal((await outcome(stack, sessionId)).status, "failed");
    }
  } finally { await stack.app.dispose(); }
});
test("overwrite submit carries exact UTF-8 and a compact signed context; callbacks require durable admission", async () => {
  const stack = await startStack();
  try {
    const content = "नमस्ते 🌍\r\n\0literal $(no shell)\n", path = "nested/hello world.txt";
    const { sessionId, job } = await start(stack, { ...input, content, path });
    assert.deepEqual(job.request, { operation: "filesystem.write_file", params: { path, cwd: input.cwd,
      mutation_id: job.idempotencyKey, data_base64: Buffer.from(content).toString("base64"), create_parent_directories: true, mode: "overwrite" } });
    assert.match(job.idempotencyKey, /^pi-write-v1:[a-f0-9]{64}$/);
    assert.equal(job.clientContext.contentBytes, Buffer.byteLength(content));
    assert.equal(job.clientContext.contentSha256, writeReceipt(job).sha256);
    assert.equal("content" in job.clientContext, false);
    stack.gateway.finish(job); stack.gateway.detailError = 503;
    await stack.call("/faults", { sessionId, fail: 1 });
    assert.equal((await stack.callbacks.fetch(url, signed(event(job)))).status, 503);
    assert.equal((await stack.call("/snapshot", { sessionId })).admittedCompletions, 0);
    assert.equal((await stack.callbacks.fetch(url, signed(event(job)))).status, 204);
    const r = await result(stack, sessionId);
    assert.deepEqual(r.content, [{ type: "text", text: `Successfully wrote to ${path}` }]);
    assert.equal(r.isError, false); assert.equal(r.details.file?.bytesWritten, Buffer.byteLength(content));
    assert.deepEqual(await Promise.all(Array.from({ length: 3 }, async () => (await stack.callbacks.fetch(url, signed(event(job)))).status)), [204, 204, 204]);
    assert.equal((await stack.call("/snapshot", { sessionId })).results.length, 1);
    assert.equal(stack.gateway.posts, 1); assert.equal(stack.gateway.details, 0);
    assert.doesNotThrow(() => parseLlmMessage({ role: "tool_result", toolName: "write", toolCallId: "call", content: r.content, details: r.details, outcome: { status: "success" } }));
    assert.equal((await stack.write.fetch("https://write/submit", { method: "POST" })).status, 404);
    await assert.rejects(stack.call("/callback-submit", submission()));
  } finally { await stack.app.dispose(); }
});
test("empty and absolute writes succeed; filesystem errors preserve messages including host resource limits", async () => {
  const stack = await startStack();
  try {
    const { sessionId, job } = await start(stack, { ...input, content: "", path: "/workspace/empty.txt" });
    stack.gateway.finish(job, { ...writeReceipt(job), disposition: "already_applied" });
    assert.equal((await stack.callbacks.fetch(url, signed(event(job)))).status, 204);
    assert.equal((await result(stack, sessionId)).details.file?.bytesWritten, 0);
    for (const [code, message] of [["invalid_argument", "path is not a regular file"], ["io", "Permission denied"],
      ["not_found", "No such file or directory"], ["resource_limit", "file mutation receipt limit reached"],
      ["resource_limit", "file contents exceed the configured write limit"]]) {
      const next = await start(stack); stack.gateway.fileError(next.job, code!, message!);
      assert.equal((await stack.callbacks.fetch(url, signed(event(next.job)))).status, 204);
      const r = await result(stack, next.sessionId);
      assert.equal(r.isError, true); assert.equal(r.details.error?.code, code);
      assert.equal(r.content[0]?.text, message);
    }
  } finally { await stack.app.dispose(); }
});
test("5 MiB UTF-8 boundary is accepted and larger contents complete locally without a gateway write", async () => {
  const stack = await startStack();
  try {
    const request = submission(); request.submission.request.input.content = "é".repeat(2621440);
    const accepted = await stack.call<ProviderSubmitResult>("/submit", request);
    assert.equal(accepted.status, "accepted");
    const job = [...stack.gateway.jobs.values()][0]!;
    assert.equal(Buffer.from(job.request.params.data_base64, "base64").length, 5242880);
    stack.gateway.finish(job);
    assert.equal((await stack.call<ProviderSubmitResult>("/submit", request)).status, "completed");
    const tooBig = submission(); tooBig.submission.submissionId = "large";
    tooBig.submission.request.input.content = request.submission.request.input.content + "x";
    const first = await stack.call<ProviderSubmitResult>("/submit", tooBig);
    assert.equal(first.status, "completed");
    if (first.status !== "completed" || first.outcome.status !== "succeeded") throw new Error("Expected tool result");
    const r = first.outcome.result as WriteResult;
    assert.equal(r.isError, true); assert.equal(r.details.error?.code, "WRITE_FILE_TOO_LARGE");
    assert.equal(r.details.gatewayJobId, undefined); assert.match(first.jobId, /^local:pi-write-v1:/);
    assert.deepEqual(await stack.call("/submit", tooBig), first);
    assert.equal(stack.gateway.jobs.size, 1); assert.equal(stack.gateway.posts, 2);
  } finally { await stack.app.dispose(); }
});
test("lost acceptance and early completion replay one write with one immutable mutation identity", async () => {
  const gateway = new FakeGateway(); gateway.loseAcceptance = 1;
  const stack = await startStack(gateway); let early = false, executions = 0;
  gateway.onAccepted = async job => {
    if (job.status !== "succeeded") { executions++; gateway.finish(job); }
    assert.equal((await stack.callbacks.fetch(url, signed(event(job)))).status, 204);
    early = (await stack.call("/snapshot", { sessionId: job.clientContext.sessionId })).admittedCompletions === 1;
  };
  try {
    const { sessionId } = await start(stack);
    assert.equal((await result(stack, sessionId)).isError, false); assert.equal(early, true);
    assert.equal(executions, 1); assert.equal(gateway.posts, 2); assert.equal(gateway.jobs.size, 1); assert.equal(gateway.details, 1);
  } finally { await stack.app.dispose(); }
});
test("signature, context, job/generation and write receipt are verified before admission", async () => {
  const stack = await startStack();
  try {
    const { sessionId, job } = await start(stack); stack.gateway.finish(job); const n = event(job);
    assert.equal((await stack.callbacks.fetch(url, signed(n, "wrong"))).status, 401);
    const tampered = signed(n); tampered.body = tampered.body.replace('"applied"', '"already_applied"');
    assert.equal((await stack.callbacks.fetch(url, tampered)).status, 401);
    for (const patch of [{ machineId: randomUUID() }, { jobId: randomUUID() }, { runtimeGenerationId: randomUUID() },
      { idempotencyKey: "wrong" }, { clientContext: { ...n.clientContext, extra: true } },
      { clientContext: { ...n.clientContext, contentBytes: -1 } }, { response: null },
      ...[{ sha256: "0".repeat(64) }, { mutation_id: "wrong" }, { bytes_written: 99 }, { path: "relative" }, { disposition: "wrong" }]
        .map(patch => ({ response: { ...(n.response as object), result: { ...writeReceipt(job), ...patch } } }))]) {
      assert.equal((await stack.callbacks.fetch(url, signed({ ...n, ...patch }))).status, 503);
    }
    assert.equal((await stack.call("/snapshot", { sessionId })).admittedCompletions, 0);
    assert.equal((await stack.callbacks.fetch(url, signed(n))).status, 204);
    await result(stack, sessionId);
    stack.gateway.finish(job, { ...writeReceipt(job), disposition: "already_applied" });
    assert.equal((await stack.callbacks.fetch(url, signed(event(job)))).status, 503);
  } finally { await stack.app.dispose(); }
});
test("restart and redelivery after a lost DO receipt preserve the result without writing again", async () => {
  const gateway = new FakeGateway(), persistPath = await mkdtemp(join(tmpdir(), "write-worker-"));
  let stack = await startStack(gateway, { persistPath });
  try {
    const { sessionId, job } = await start(stack); gateway.finish(job);
    await stack.call("/faults", { sessionId, lose: 1 });
    assert.equal((await stack.callbacks.fetch(url, signed(event(job)))).status, 503);
    const first = await result(stack, sessionId);
    await stack.app.dispose(); stack = await startStack(gateway, { persistPath });
    assert.equal((await stack.callbacks.fetch(url, signed(event(job)))).status, 204);
    assert.deepEqual(await result(stack, sessionId), first); assert.equal(gateway.posts, 1); assert.equal(gateway.details, 0);
  } finally { await stack.app.dispose(); await rm(persistPath, { recursive: true, force: true }); }
});
test("callback deadline and malformed receipts cannot acknowledge undelivered completion", async () => {
  const stack = await startStack();
  try {
    const { sessionId, job } = await start(stack); stack.gateway.finish(job);
    await stack.call("/faults", { sessionId, invalid: 1 });
    assert.equal((await stack.callbacks.fetch(url, signed(event(job)))).status, 503);
    await stack.call("/faults", { sessionId, delay: 9000 });
    const started = Date.now();
    assert.equal((await stack.callbacks.fetch(url, signed(event(job)))).status, 503);
    assert.ok(Date.now() - started < 9000);
    await stack.call("/faults", { sessionId });
    assert.equal((await stack.callbacks.fetch(url, signed(event(job)))).status, 204);
    assert.equal((await result(stack, sessionId)).isError, false);
    assert.equal(stack.gateway.posts, 1);
  } finally { await stack.app.dispose(); }
});
