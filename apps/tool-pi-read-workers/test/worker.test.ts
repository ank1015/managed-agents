import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderSubmitResult, ReadInput, ReadResult } from "@managed-agents/contracts";
import { parseLlmMessage } from "@managed-agents/contracts";
import { FakeGateway, FakeImages, startStack, input, png, fileResult, event, signed, until } from "./stack.ts";
import type { Stack } from "./stack.ts";

const url = "https://callbacks/webhooks/execution-gateway";
async function start(stack: Stack, value: ReadInput = input) {
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
async function result(stack: Stack, sessionId: string): Promise<ReadResult> {
  const value = await outcome(stack, sessionId); assert.equal(value.status, "succeeded");
  if (value.status !== "succeeded") throw new Error("Expected a completed tool result.");
  return value.result as ReadResult;
}
function submission() {
  return { destination: { routeKey: "test-v1", sessionId: "manual" }, submission: { operationId: "op", submissionId: "sub",
    request: { provider: "tool-pi-read", type: "read", version: "v1", input: structuredClone(input) as ReadInput } } };
}
test("text submit and inline callback preserve paging and require durable DO admission", async () => {
  const stack = await startStack(undefined, undefined, { imageConfig: false });
  try {
    const { sessionId, job } = await start(stack, { ...input, offset: 2, limit: 2 });
    assert.equal(stack.gateway.posts, 1);
    assert.deepEqual(job.request, { operation: "filesystem.read_file", params: { path: input.path, cwd: input.cwd, max_bytes: 5242880 } });
    assert.deepEqual(job.clientContext, { receiver: "tool-pi-read-v1", routeKey: "test-v1", sessionId, operationId: job.clientContext.operationId,
      submissionId: job.clientContext.operationId, machineId: input.machineId, path: input.path, offset: 2, limit: 2 });
    assert.match(job.idempotencyKey, /^pi-read-v1:[a-f0-9]{64}$/);
    stack.gateway.finish(job, fileResult("one\ntwo\nthree\nfour")); stack.gateway.detailError = 503;
    const notification = event(job);
    assert.equal((await stack.callbacks.fetch(url, signed(notification))).status, 204);
    assert.equal((await stack.call("/snapshot", { sessionId })).admittedCompletions, 1);
    const r = await result(stack, sessionId);
    assert.deepEqual(r.content, [{ type: "text", text: "two\nthree\n\n[1 more lines in file. Use offset=4 to continue.]" }]);
    assert.equal(r.isError, false);
    assert.deepEqual(await Promise.all(Array.from({ length: 3 }, async () => (await stack.callbacks.fetch(url, signed(event(job)))).status)), [204, 204, 204]);
    assert.equal((await stack.call("/snapshot", { sessionId })).results.length, 1);
    assert.equal(stack.gateway.details, 0); assert.equal(stack.images.posts, 0);
    assert.equal((await stack.read.fetch("https://read/submit", { method: "POST" })).status, 404);
    await assert.rejects(stack.call("/callback-submit", submission()));
  } finally { await stack.app.dispose(); }
});
test("5 MiB file succeeds; too-big, missing, directory, permissions and offset errors are completed tool results", async () => {
  const stack = await startStack();
  try {
    const { sessionId, job } = await start(stack);
    stack.gateway.finish(job, fileResult(Buffer.alloc(5 * 1024 * 1024, 10)));
    assert.equal((await stack.callbacks.fetch(url, signed(event(job)))).status, 204);
    assert.equal((await result(stack, sessionId)).isError, false);
    for (const [code, message] of [["resource_limit", "file exceeds the requested byte limit"], ["not_found", "File not found"],
      ["invalid_argument", "path is not a regular file"], ["io", "Permission denied"]]) {
      const next = await start(stack); stack.gateway.fileError(next.job, code!, message!);
      assert.equal((await stack.callbacks.fetch(url, signed(event(next.job)))).status, 204);
      const r = await result(stack, next.sessionId); assert.equal(r.isError, true);
      if (code === "resource_limit") { assert.equal(r.details.error?.code, "READ_FILE_TOO_LARGE"); assert.match(JSON.stringify(r.content), /5 MiB/); }
    }
    const next = await start(stack, { ...input, offset: 100 }); stack.gateway.finish(next.job);
    assert.equal((await stack.callbacks.fetch(url, signed(event(next.job)))).status, 204);
    assert.equal((await result(stack, next.sessionId)).details.error?.code, "READ_OFFSET_OUT_OF_BOUNDS");
    assert.equal(stack.gateway.details, 0);
  } finally { await stack.app.dispose(); }
});
test("images upload once and return a stable model-compatible URL across lost receipts and concurrent callbacks", async () => {
  const stack = await startStack();
  try {
    const { sessionId, job } = await start(stack, { ...input, offset: 999, limit: 1 });
    stack.gateway.finish(job, fileResult(png)); stack.images.loseUpload = 1;
    await stack.call("/faults", { sessionId, lose: 1 });
    assert.equal((await stack.callbacks.fetch(url, signed(event(job)))).status, 503);
    const r = await result(stack, sessionId);
    assert.equal(r.isError, false); assert.equal(r.content[1]?.type, "image");
    assert.match(r.details.image!.url, /^https:\/\/imagedelivery.net\/test-hash\/pi-read-v1-[a-f0-9]{64}\/piread$/);
    assert.deepEqual(stack.images.uploadBytes, png);
    assert.equal(stack.images.uploadType, "image/png");
    assert.equal(stack.images.images.size, 1);
    const replies = await Promise.all(Array.from({ length: 3 }, async () => (await stack.callbacks.fetch(url, signed(event(job)))).status));
    assert.deepEqual(replies, [204, 204, 204]); assert.equal(stack.images.posts, 1);
    assert.equal(stack.gateway.details, 0);
    assert.doesNotThrow(() => parseLlmMessage({ role: "tool_result", toolName: "read", toolCallId: "call", content: r.content, details: r.details, outcome: { status: "success" } }));
    const stored = [...stack.images.images.values()][0]!; stored.meta.sha256 = "other";
    assert.equal((await stack.callbacks.fetch(url, signed(event(job)))).status, 503);
  } finally { await stack.app.dispose(); }
});
test("concurrent first image uploads recover a single custom ID", async () => {
  const stack = await startStack();
  try {
    const { sessionId, job } = await start(stack); stack.gateway.finish(job, fileResult(png));
    const replies = await Promise.all(Array.from({ length: 3 }, async () => (await stack.callbacks.fetch(url, signed(event(job)))).status));
    assert.deepEqual(replies, [204, 204, 204]); assert.equal(stack.images.images.size, 1);
    assert.equal((await result(stack, sessionId)).isError, false);
  } finally { await stack.app.dispose(); }
});
test("image upload outage retries delivery; permanent image rejection is a tool error", async () => {
  const stack = await startStack();
  try {
    const first = await start(stack); stack.gateway.finish(first.job, fileResult(png));
    stack.images.uploadFailure = 503;
    assert.equal((await stack.callbacks.fetch(url, signed(event(first.job)))).status, 503);
    assert.equal((await stack.call("/snapshot", { sessionId: first.sessionId })).admittedCompletions, 0);
    stack.images.uploadFailure = undefined;
    assert.equal((await stack.callbacks.fetch(url, signed(event(first.job)))).status, 204);
    assert.equal((await result(stack, first.sessionId)).isError, false);
    const second = await start(stack); stack.gateway.finish(second.job, fileResult(png)); stack.images.uploadFailure = 415;
    assert.equal((await stack.callbacks.fetch(url, signed(event(second.job)))).status, 204);
    assert.equal((await result(stack, second.sessionId)).details.error?.code, "READ_IMAGE_REJECTED");
  } finally { await stack.app.dispose(); }
});
test("missing image configuration fails delivery without admitting a false result", async () => {
  const stack = await startStack(undefined, undefined, { imageConfig: false });
  try {
    const { sessionId, job } = await start(stack); stack.gateway.finish(job, fileResult(png));
    assert.equal((await stack.callbacks.fetch(url, signed(event(job)))).status, 503);
    assert.equal((await stack.call("/snapshot", { sessionId })).admittedCompletions, 0);
  } finally { await stack.app.dispose(); }
});
test("BMP images are converted to PNG inside workerd before upload", async () => {
  const stack = await startStack();
  try {
    const bmp = Buffer.alloc(58); bmp.write("BM"); bmp.writeUInt32LE(58, 2); bmp.writeUInt32LE(54, 10);
    bmp.writeUInt32LE(40, 14); bmp.writeUInt32LE(1, 18); bmp.writeUInt32LE(1, 22); bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28); bmp[56] = 255;
    const { sessionId, job } = await start(stack); stack.gateway.finish(job, fileResult(bmp));
    assert.equal((await stack.callbacks.fetch(url, signed(event(job)))).status, 204);
    const r = await result(stack, sessionId);
    assert.equal(r.isError, false); assert.equal(r.details.image?.mimeType, "image/png");
    assert.equal(stack.images.uploadBytes?.subarray(1, 4).toString(), "PNG");
  } finally { await stack.app.dispose(); }
});
test("lost gateway acceptance replays the same job; early image completion can arrive before POST returns", async () => {
  const gateway = new FakeGateway(); gateway.loseAcceptance = 1;
  const stack = await startStack(gateway);
  let early = false;
  gateway.onAccepted = async job => {
    gateway.finish(job, fileResult(png));
    assert.equal((await stack.callbacks.fetch(url, signed(event(job)))).status, 204);
    early = (await stack.call("/snapshot", { sessionId: job.clientContext.sessionId })).admittedCompletions === 1;
  };
  try {
    const { sessionId } = await start(stack);
    assert.equal((await result(stack, sessionId)).isError, false); assert.equal(early, true);
    assert.equal(gateway.jobs.size, 1); assert.equal(gateway.posts, 2); assert.equal(gateway.details, 1);
    assert.equal(stack.images.images.size, 1); assert.equal(stack.images.posts, 1);
  } finally { await stack.app.dispose(); }
});
test("terminal replay verifies retained correlation and never turns detail failure into rejection", async () => {
  const stack = await startStack();
  try {
    const request = submission(), accepted = await stack.call<ProviderSubmitResult>("/submit", request);
    assert.equal(accepted.status, "accepted"); if (accepted.status !== "accepted") throw new Error("Not accepted");
    const job = stack.gateway.jobs.get(accepted.jobId)!; stack.gateway.finish(job);
    for (const patch of [{ id: randomUUID() }, { machineId: randomUUID() }, { idempotencyKey: "other" }, { runtimeGenerationId: randomUUID() },
      { status: "waiting_response" }, { clientContext: { ...job.clientContext, offset: 9 } }]) {
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
    const changed = structuredClone(request); changed.submission.request.input.offset = 2;
    await assert.rejects(stack.call("/submit", changed), /idempotency_conflict/);
    stack.gateway.reject = { status: 409, code: "machine_offline" }; await assert.rejects(stack.call("/submit", request));
    stack.gateway.reject = { status: 400, code: "invalid_argument" };
    assert.equal((await stack.call<ProviderSubmitResult>("/submit", request)).status, "rejected");
  } finally { await stack.app.dispose(); }
});
test("signature, paging context, job/generation identity and file digest are checked before admission", async () => {
  const stack = await startStack();
  try {
    const { sessionId, job } = await start(stack); stack.gateway.finish(job); const n = event(job);
    assert.equal((await stack.callbacks.fetch(url, signed(n, "wrong"))).status, 401);
    const changed = signed(n); changed.body = changed.body.replace("SGVsbG8K", "Rm9yZ2Vk");
    assert.equal((await stack.callbacks.fetch(url, changed)).status, 401);
    for (const patch of [{ machineId: randomUUID() }, { jobId: randomUUID() }, { runtimeGenerationId: randomUUID() }, { idempotencyKey: "wrong" },
      { clientContext: { ...n.clientContext, extra: true } }, { clientContext: { ...n.clientContext, offset: -1 } }, { response: null },
      { response: { ...(n.response as object), result: { ...fileResult(), sha256: "0".repeat(64) } } }]) {
      assert.equal((await stack.callbacks.fetch(url, signed({ ...n, ...patch }))).status, 503);
    }
    assert.equal((await stack.call("/snapshot", { sessionId })).admittedCompletions, 0);
    assert.equal((await stack.callbacks.fetch(url, signed(n))).status, 204);
    stack.gateway.finish(job, fileResult("changed"));
    assert.equal((await stack.callbacks.fetch(url, signed(event(job)))).status, 503);
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
test("restart and redelivery recover the same uploaded image after a lost DO receipt", async () => {
  const gateway = new FakeGateway(), images = new FakeImages(), persistPath = await mkdtemp(join(tmpdir(), "read-worker-"));
  let stack = await startStack(gateway, images, { persistPath });
  try {
    const { sessionId, job } = await start(stack); gateway.finish(job, fileResult(png));
    await stack.call("/faults", { sessionId, lose: 1 });
    assert.equal((await stack.callbacks.fetch(url, signed(event(job)))).status, 503);
    const first = await result(stack, sessionId);
    await stack.app.dispose(); stack = await startStack(gateway, images, { persistPath });
    assert.equal((await stack.callbacks.fetch(url, signed(event(job)))).status, 204);
    assert.deepEqual(await result(stack, sessionId), first); assert.equal(images.posts, 1); assert.equal(gateway.details, 0);
  } finally { await stack.app.dispose(); await rm(persistPath, { recursive: true, force: true }); }
});
test("image work shares the callback deadline and cannot acknowledge before upload and DO admission", async () => {
  const stack = await startStack();
  try {
    const { sessionId, job } = await start(stack); stack.gateway.finish(job, fileResult(png)); stack.images.uploadDelay = 9000;
    const started = Date.now();
    assert.equal((await stack.callbacks.fetch(url, signed(event(job)))).status, 503);
    assert.ok(Date.now() - started < 9000);
    assert.equal((await stack.call("/snapshot", { sessionId })).admittedCompletions, 0);
    stack.images.uploadDelay = 0;
    assert.equal((await stack.callbacks.fetch(url, signed(event(job)))).status, 204);
    assert.equal((await result(stack, sessionId)).isError, false);
  } finally { await stack.app.dispose(); }
});
test("read deployment is standalone and callback routing includes both bash and read", async () => {
  const config = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.doesNotMatch(config, /d1_databases|queues|durable_objects|MINIMAL_BASH_SESSIONS/);
  assert.match(config, /"SESSION_ROUTES": "\{\}"/);
  const router = await readFile(new URL("../../execution-gateway-callback-workers/wrangler.jsonc", import.meta.url), "utf8");
  assert.match(router, /PiReadCallbacks/); assert.match(router, /PiBashCallbacks/);
});


test("v4 and v5 callbacks and terminal replay preserve success/error semantics; unsupported versions reject", async () => {
  const stack = await startStack();
  try {
    for (const version of [4, 5]) {
      for (const failed of [false, true]) {
        const { sessionId, job } = await start(stack);
        stack.gateway.finish(job);
        if (failed) {
          job.status = "failed";
          job.response = { protocol_version: version, request_id: job.id, generation_id: job.runtimeGenerationId,
            status: "error", error: { code: "invalid_argument", message: "Known native error" } };
        } else job.response = { ...(job.response as object), protocol_version: version };
        const request = { destination: { routeKey: "test-v1", sessionId }, submission: {
          operationId: job.clientContext.operationId, submissionId: job.clientContext.submissionId,
          request: { provider: "tool-pi-read", type: "read", version: "v1", input } } };
        const notification = event(job);
        for (const unsupported of [3, 6, "5", null]) {
          const response: { protocol_version: number | string | null } = { ...(job.response as object), protocol_version: unsupported };
          assert.equal((await stack.callbacks.fetch(url, signed({ ...notification, response }))).status, 503);
          stack.gateway.detailValue = row => ({ ...row, response });
          await assert.rejects(stack.call("/submit", request));
        }
        stack.gateway.detailValue = undefined;
        assert.equal((await stack.call("/snapshot", { sessionId })).admittedCompletions, 0);
        assert.equal((await stack.callbacks.fetch(url, signed(notification))).status, 204);
        const value = await outcome(stack, sessionId);
        assert.equal(value.status, "succeeded");
        if (value.status !== "succeeded") throw new Error("Expected tool result");
        assert.equal((value.result as ReadResult).isError, failed);
        const replay = await stack.call<ProviderSubmitResult>("/submit", request);
        assert.equal(replay.status, "completed");
        if (replay.status !== "completed") throw new Error("Expected terminal replay");
        assert.deepEqual(replay.outcome, value);
      }
    }
    assert.equal(stack.gateway.jobs.size, 4);
  } finally { await stack.app.dispose(); }
});
