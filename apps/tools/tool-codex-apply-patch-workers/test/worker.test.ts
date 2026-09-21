import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderSubmitResult, ApplyPatchInput, ApplyPatchResult } from "@managed-agents/contracts";
import { parseLlmMessage, CODEX_APPLY_PATCH_MAX_PARAMS_BYTES } from "@managed-agents/contracts";
import { issueMachineSecret } from "@managed-agents/execution-gateway-protocol";
import { patchParams } from "../src/gateway.ts";
import { FakeGateway, startStack, input, patchReceipt, event, execution, until, auth, machineId, generationId } from "./stack.ts";
import type { Stack } from "./stack.ts";


async function start(stack: Stack, value: ApplyPatchInput = input) {
  const sessionId = randomUUID();
  await stack.call("/start", { sessionId, input: value });
  const job = await until(async () => [...stack.gateway.jobs.values()].find(j => j.destination.sessionId === sessionId));
  await until(async () => { const s = await stack.call("/snapshot", { sessionId }); return s.operations.length ? s : undefined; });
  return { sessionId, job };
}
async function outcome(stack: Stack, sessionId: string) {
  const snapshot = await until(async () => { const s = await stack.call("/snapshot", { sessionId }); return s.results.length ? s : undefined; });
  assert.equal(snapshot.results.length, 1); assert.equal(snapshot.progress.blocked, false);
  const result = snapshot.operations[0]!.outcome; assert.ok(result); return result;
}
async function result(stack: Stack, sessionId: string): Promise<ApplyPatchResult> {
  const value = await outcome(stack, sessionId); assert.equal(value.status, "succeeded");
  if (value.status !== "succeeded") throw new Error("Expected a completed tool result.");
  return value.result as ApplyPatchResult;
}
async function submission() {
  return { execution: await execution("manual"), destination: { routeKey: "test-v1", sessionId: "manual" }, submission: { operationId: "op", submissionId: "sub",
    request: { provider: "tool-codex-apply-patch", type: "apply_patch", version: "v1", input: structuredClone(input) as ApplyPatchInput } } };
}
test("invalid requests are rejected before gateway submission; routing changes conflict with immutable context", async () => {
  const stack = await startStack();
  try {
    const request = await submission();
    for (const extra of [{ clientContext: {} }, { callbackUrl: "https://bad" }, { offset: 0 }, { limit: 0 }, { path: "x\0y" }]) {
      const changed = structuredClone(request); Object.assign(changed.submission.request.input, extra);
      assert.equal((await stack.call<ProviderSubmitResult>("/submit", changed)).status, "rejected");
    }
    const bad = structuredClone(request); bad.destination.routeKey = "unknown";
    await assert.rejects(stack.call("/submit", bad)); assert.equal(stack.gateway.posts, 0);
    await stack.call("/submit", request);
    const changed = structuredClone(request); changed.submission.request.input.patch = input.patch.replace("new", "different");
    await assert.rejects(stack.call("/submit", changed), /REQUEST_CONFLICT/);
    stack.gateway.reject = { status: 409, code: "MACHINE_OFFLINE", retryable: true, uncertain: false }; await assert.rejects(stack.call("/submit", request));
    stack.gateway.reject = { status: 400, code: "invalid_argument", retryable: false, uncertain: false };
    assert.equal((await stack.call<ProviderSubmitResult>("/submit", request)).status, "rejected");
  } finally { await stack.app.dispose(); }
});
test("gateway failures and unknown outcomes remain failed operations", async () => {
  const stack = await startStack();
  try {
    for (const status of ["unknown", "failed"]) {
      const { sessionId, job } = await start(stack); stack.gateway.fileError(job, "dispatch_failure", "Machine unavailable", status === "unknown");
      await stack.call("/event", await event(job));
      assert.equal((await outcome(stack, sessionId)).status, "failed");
    }
  } finally { await stack.app.dispose(); }
});
test("lost acceptance and early completion replay one patch with one immutable mutation identity", async () => {
  const gateway = new FakeGateway(); gateway.loseAcceptance = 1;
  const stack = await startStack(gateway); let early = false, executions = 0;
  gateway.onAccepted = async job => {
    if (job.outcome.status !== "ok") { executions++; gateway.finish(job); }
    await stack.call("/event", await event(job));
    early = (await stack.call("/snapshot", { sessionId: job.destination.sessionId })).admittedCompletions === 1;
  };
  try {
    const { sessionId } = await start(stack);
    assert.equal((await result(stack, sessionId)).isError, false); assert.equal(early, true);
    assert.equal(executions, 1); assert.equal(gateway.posts, 2); assert.equal(gateway.jobs.size, 1); assert.equal(gateway.details, 0);
  } finally { await stack.app.dispose(); }
});
test("restart and redelivery after a lost DO receipt preserve the result without writing again", async () => {
  const gateway = new FakeGateway(), persistPath = await mkdtemp(join(tmpdir(), "apply-patch-worker-"));
  let stack = await startStack(gateway, { persistPath });
  try {
    const { sessionId, job } = await start(stack); gateway.finish(job);
    await stack.call("/faults", { sessionId, lose: 1 });
    await assert.rejects(stack.call("/event", await event(job)));
    const first = await result(stack, sessionId);
    await stack.app.dispose(); stack = await startStack(gateway, { persistPath });
    await stack.call("/event", await event(job));
    assert.deepEqual(await result(stack, sessionId), first); assert.equal(gateway.posts, 1); assert.equal(gateway.details, 0);
  } finally { await stack.app.dispose(); await rm(persistPath, { recursive: true, force: true }); }
});
test("callback deadline and malformed receipts cannot acknowledge undelivered completion", async () => {
  const stack = await startStack();
  try {
    const { sessionId, job } = await start(stack); stack.gateway.finish(job);
    await stack.call("/faults", { sessionId, invalid: 1 });
    await assert.rejects(stack.call("/event", await event(job)));
    await stack.call("/faults", { sessionId, delay: 9000 });
    const started = Date.now();
    await assert.rejects(stack.call("/event", await event(job)));
    assert.ok(Date.now() - started < 9000);
    await stack.call("/faults", { sessionId });
    await stack.call("/event", await event(job));
    assert.equal((await result(stack, sessionId)).isError, false);
    assert.equal(stack.gateway.posts, 1);
  } finally { await stack.app.dispose(); }
});

test("one native patch job carries raw text and signed digest; callback requires durable admission", async () => {
  const stack = await startStack();
  try {
    const patch = "*** Begin Patch\n*** Add File: nested/hello world.txt\n+नमस्ते 🌍\r\n+$(no shell)\n*** End Patch";
    const { sessionId, job } = await start(stack, { ...input, patch });
    assert.deepEqual(job.body.operation, { operation: "filesystem.patch", params: { cwd: input.cwd,
      patch: { format: "codex", text: patch } } });
    assert.match(job.id, /^codex-apply-patch-v1:[a-f0-9]{64}$/);
    assert.equal((job.body.callback.context as any).patchSha256, createHash("sha256").update(patch).digest("hex"));
    assert.equal("patch" in (job.body.callback.context as object), false);
    stack.gateway.finish(job);
    await stack.call("/faults", { sessionId, fail: 1 });
    await assert.rejects(stack.call("/event", await event(job)));
    assert.equal((await stack.call("/snapshot", { sessionId })).admittedCompletions, 0);
    await stack.call("/event", await event(job));
    const r = await result(stack, sessionId);
    assert.deepEqual(r.content, [{ type: "text", text: "Success. Updated the following files:\nM /workspace/project/file.txt\n" }]);
    assert.equal(r.isError, false); assert.equal(r.details.changes?.[0]?.firstChangedLine, 1);
    assert.equal(r.details.diff, patchReceipt(job).diff);
    assert.deepEqual(await Promise.all(Array.from({ length: 3 }, async () => (await stack.call<{status:string}>("/event", await event(job))).status)), ["accepted", "accepted", "accepted"]);
    assert.equal((await stack.call("/snapshot", { sessionId })).results.length, 1);
    assert.equal(stack.gateway.posts, 1); assert.equal(stack.gateway.details, 0);
    assert.doesNotThrow(() => parseLlmMessage({ role: "tool_result", toolName: "apply_patch", toolCallId: "call", content: r.content, details: r.details, outcome: { status: "success" } }));
    assert.equal((await stack.patchWorker.fetch("https://patch/submit", { method: "POST" })).status, 404);
    await assert.rejects(stack.call("/callback-submit", await submission()));
  } finally { await stack.app.dispose(); }
});

test("rejected and partial patch receipts are model-visible errors with retained changes and no replacement jobs", async () => {
  const stack = await startStack();
  try {
    for (const status of ["rejected", "partial"] as const) {
      const { sessionId, job } = await start(stack);
      const receipt = { ...patchReceipt(job), status, changes_exact: status === "rejected",
        changes: status === "rejected" ? [] : patchReceipt(job).changes, diff: status === "rejected" ? "" : patchReceipt(job).diff,
        error: { code: status === "rejected" ? "invalid_argument" : "io", message: "Target could not be edited", section: 0, edit: null } };
      stack.gateway.finish(job, receipt);
      assert.equal(job.outcome.status, "ok");
      await stack.call("/event", await event(job));
      const r = await result(stack, sessionId);
      assert.equal(r.isError, true); assert.equal(r.details.status, status);
      assert.equal(r.details.changesExact, status === "rejected");
      assert.equal(r.details.changes?.length, status === "rejected" ? 0 : 1);
      if (status === "partial") assert.match(r.content[0]!.text, /may have changed/);
      else assert.equal(r.content[0]!.text, "Target could not be edited");
    }
    for (const code of ["resource_limit", "invalid_argument", "idempotency_conflict", "io", "unsupported_operation"]) {
      const { sessionId, job } = await start(stack); stack.gateway.fileError(job, code, "Native error");
      await stack.call("/event", await event(job));
      const value = await outcome(stack, sessionId);
      assert.equal(value.status, ["resource_limit", "invalid_argument"].includes(code) ? "succeeded" : "failed");
      if (value.status === "succeeded") assert.equal((value.result as ApplyPatchResult).isError, true);
    }
    assert.equal(stack.gateway.posts, 7); assert.equal(stack.gateway.details, 0);
  } finally { await stack.app.dispose(); }
});

test("patch text and serialized parameter boundaries produce stable local errors without submission", async () => {
  const stack = await startStack();
  try {
    const request = await submission();
    request.submission.request.input.patch = "x".repeat(2 * 1024 * 1024);
    assert.equal((await stack.call<ProviderSubmitResult>("/submit", request)).status, "accepted");
    const job = [...stack.gateway.jobs.values()][0]!; stack.gateway.finish(job);
    assert.equal((await stack.call<ProviderSubmitResult>("/submit", request)).status, "accepted");
    const oversized = structuredClone(request); oversized.submission.submissionId = "large";
    oversized.submission.request.input.patch += "x";
    const first = await stack.call<ProviderSubmitResult>("/submit", oversized);
    assert.equal(first.status, "completed");
    if (first.status !== "completed" || first.outcome.status !== "succeeded") throw new Error("Expected local error");
    assert.equal((first.outcome.result as ApplyPatchResult).details.error?.code, "APPLY_PATCH_REQUEST_TOO_LARGE");
    assert.equal((first.outcome.result as ApplyPatchResult).details.requestId, undefined);
    assert.match(first.jobId, /^local:codex-apply-patch-v1:/);
    assert.deepEqual(await stack.call("/submit", oversized), first);
    const escaped = await submission(); escaped.submission.submissionId = "escaped";
    // Below 2 MiB as raw text; exactly 4 MiB after JSON escaping and metadata.
    escaped.submission.request.input.patch = "";
    const overhead = Buffer.byteLength(JSON.stringify(patchParams(escaped.submission.request.input)));
    const remaining = CODEX_APPLY_PATCH_MAX_PARAMS_BYTES - overhead;
    escaped.submission.request.input.patch = "\0".repeat(Math.floor(remaining / 6)) + "x".repeat(remaining % 6);
    assert.equal(Buffer.byteLength(JSON.stringify(patchParams(escaped.submission.request.input))), CODEX_APPLY_PATCH_MAX_PARAMS_BYTES);
    assert.equal((await stack.call<ProviderSubmitResult>("/submit", escaped)).status, "accepted");
    escaped.submission.submissionId = "escaped-too-large"; escaped.submission.request.input.patch += "x";
    assert.equal((await stack.call<ProviderSubmitResult>("/submit", escaped)).status, "completed");
    assert.equal(stack.gateway.jobs.size, 2); assert.equal(stack.gateway.posts, 3);
  } finally { await stack.app.dispose(); }
});

test("correlation, result hashes, mutation identity and receipt variants are checked", async () => {
  const stack = await startStack();
  try {
    const { sessionId, job } = await start(stack); stack.gateway.finish(job); const n = await event(job), receipt = patchReceipt(job);
    const badResults = [{ mutation_id: "wrong" }, { status: "partial" }, { changes_exact: false }, { changes: [] },
      { error: { code: "io", message: "bad" } }, { diff: "x".repeat(65537) }, { diff_truncated: "false" },
      { changes: Array(33).fill(receipt.changes[0]) },
      ...[{ path: "relative" }, { kind: "delete" }, { after_sha256: "bad" }, { bytes_after: 5242881 }, { first_changed_line: 0 },
        { destination_path: "/other" }].map(p => ({ changes: [{ ...receipt.changes[0], ...p }] }))];
    for (const patch of [{ machineId: randomUUID() }, { requestId: randomUUID() }, { runtimeGeneration: randomUUID() },
      { protocolVersion: 5 }, { resultHash: "0".repeat(64) }, { deliveryId: "0".repeat(64) },
      { callback: { ...n.callback, context: { ...(n.callback.context as object), extra: true } } },
      { callback: { ...n.callback, context: { ...(n.callback.context as object), patchSha256: "bad" } } },
      { schemaVersion: 3 }, { outcome: null }]) {
      await assert.rejects(stack.call("/event", { ...n, ...patch }));
    }
    for (const patch of badResults) {
      stack.gateway.finish(job, { ...receipt, ...patch });
      await assert.rejects(stack.call("/event", await event(job)));
    }
    assert.equal((await stack.call("/snapshot", { sessionId })).admittedCompletions, 0);
    await stack.call("/event", n); await result(stack, sessionId);
    stack.gateway.finish(job, { ...receipt, diff: "changed receipt" });
    await assert.rejects(stack.call("/event", await event(job)));
  } finally { await stack.app.dispose(); }
});

test("multi-file receipts retain add overwrite, move destinations, deletion and partial move writes", async () => {
  const stack = await startStack();
  try {
    const { sessionId, job } = await start(stack), base = patchReceipt(job), update = base.changes[0]!;
    const changes = [
      { ...update, kind: "add", path: "/workspace/new", before_sha256: null, bytes_before: null },
      { ...update, kind: "add", path: "/workspace/overwritten" },
      { ...update, kind: "move", path: "/workspace/source", destination_path: "/workspace/destination",
        destination_before_sha256: update.before_sha256, destination_bytes_before: 3 },
      { ...update, kind: "update", path: "/workspace/updated" },
      { ...update, kind: "delete", path: "/workspace/deleted", after_sha256: null, bytes_after: null },
    ];
    stack.gateway.finish(job, { ...base, changes });
    await stack.call("/event", await event(job));
    const r = await result(stack, sessionId);
    assert.equal(r.content[0]!.text, "Success. Updated the following files:\nA /workspace/new\nA /workspace/overwritten\nM /workspace/destination\nM /workspace/updated\nD /workspace/deleted\n");
    assert.equal(r.details.changes?.[2]?.destinationBeforeSha256, update.before_sha256);
    assert.equal(r.details.changes?.[4]?.afterSha256, null);
    for (const [known, exact] of [[[], false], [[changes[0]!], false], [[changes[0]!], true]] as const) {
      const next = await start(stack);
      stack.gateway.finish(next.job, { ...patchReceipt(next.job), status: "partial", changes_exact: exact,
        changes: [...known], error: { code: "io", message: "source deletion failed", section: 0, edit: null } });
      await stack.call("/event", await event(next.job));
      const failed = await result(stack, next.sessionId);
      assert.equal(failed.isError, true); assert.equal(failed.details.changesExact, exact);
      assert.equal(failed.details.changes?.length, known.length);
      assert.match(failed.content[0]!.text, /Inspect the affected files/);
    }
    assert.equal(stack.gateway.posts, 4);
  } finally { await stack.app.dispose(); }
});

test("large multi-file summaries are bounded without losing structured changes", async () => {
  const stack = await startStack();
  try {
    const { sessionId, job } = await start(stack), base = patchReceipt(job);
    const changes = Array.from({ length: 32 }, (_, i) => ({ ...base.changes[0]!, path: `/${i}/` + "\u0001".repeat(4000) }));
    stack.gateway.finish(job, { ...base, changes, diff: "\u0000".repeat(65536), diff_truncated: true });
    await stack.call("/event", await event(job));
    const r = await result(stack, sessionId);
    assert.equal(r.isError, false); assert.equal(r.details.summaryTruncated, true);
    assert.equal(r.details.changes?.length, 32);
    assert.ok(Buffer.byteLength(r.content[0]!.text) < 17000);
    assert.ok(Buffer.byteLength(JSON.stringify(r)) < 1900000);
  } finally { await stack.app.dispose(); }
});

test("only harness-supplied machine execution secrets and the current RPC envelope are accepted", async t => {
  const s = await startStack(); t.after(() => s.app.dispose()); const value = await submission();
  const daemonToken = await issueMachineSecret(auth, machineId, "daemon", 1);
  for (const execution of [
    { runtimeGeneration: generationId },
    { ...value.execution, token: daemonToken },
    { ...value.execution, token: "eyJhbGciOiJIUzI1NiJ9.eyJraW5kIjoiZ3JhbnQifQ.signature" },
    { ...value.execution, userId: "old-user" },
    { ...value.execution, scopeId: "old-scope" },
    { ...value.execution, grant: value.execution.token },
  ]) {
    assert.equal((await s.call<ProviderSubmitResult>("/submit", { ...value, execution })).status, "rejected");
  }
  for (const extra of [{ token: value.execution.token }, { callbackUrl: "https://example.invalid" }]) {
    assert.equal((await s.call<ProviderSubmitResult>("/submit", { ...value, ...extra })).status, "rejected");
  }
  assert.equal(s.gateway.posts, 0);
});

test("each submission forwards its own machine secret only in the authorization header", async t => {
  const s = await startStack(); t.after(() => s.app.dispose());
  const first = await submission(), second = await submission();
  const otherMachine = randomUUID();
  second.execution.token = await issueMachineSecret(auth, otherMachine, "execution", 1);
  second.submission.operationId = "other-operation"; second.submission.submissionId = "other-operation";
  second.submission.request.input.machineId = otherMachine;
  const replies = await Promise.all([s.call<ProviderSubmitResult>("/submit", first), s.call<ProviderSubmitResult>("/submit", second)]);
  assert.ok(replies.every(r => r.status === "accepted"));
  for (const value of [first, second]) {
    const sent = s.gateway.requests.find(r => r.path === `/v1/machines/${value.submission.request.input.machineId}/requests`)!;
    assert.equal(sent.authorization, `Bearer ${value.execution.token}`);
    assert.deepEqual(Object.keys(sent.body as object).sort(), ["callback", "operation", "requestId", "runtimeGeneration"]);
    assert.ok(!JSON.stringify(sent.body).includes(value.execution.token));
    assert.equal((sent.body as any).callback.receiver, "tool-codex-apply-patch-v1");
    assert.equal((sent.body as any).callback.context.sessionId, value.destination.sessionId);
  }
});

test("malformed or legacy acceptance remains uncertain after dispatch and never creates a new identity", async t => {
  const s = await startStack(); t.after(() => s.app.dispose()); const value = await submission();
  for (const reply of [null, [], 1, { status: "accepted", jobId: "legacy-job" }]) {
    s.gateway.acceptance = () => reply;
    await assert.rejects(s.call("/submit", value), /uncertain/);
  }
  for (const patch of [{ machineId: randomUUID() }, { runtimeGeneration: randomUUID() },
    { jobId: "legacy-job" }, { userId: "legacy-user" }]) {
    s.gateway.acceptance = r => ({ ...r, ...patch });
    await assert.rejects(s.call("/submit", value), /uncertain/);
  }
  s.gateway.acceptance = undefined;
  assert.equal((await s.call<ProviderSubmitResult>("/submit", value)).status, "accepted");
  assert.equal(s.gateway.jobs.size, 1);
});

test("malformed error replies cannot turn dispatched work into a definitive rejection", async t => {
  const s = await startStack(); t.after(() => s.app.dispose()); const value = await submission();
  s.gateway.acceptanceStatus = 400;
  for (const body of [null, { error: null }, { error: [] }, { error: { code: "INVALID_REQUEST" } },
    { error: { code: "INVALID_REQUEST", message: "legacy", retryable: false, uncertain: false }, jobId: "old-job" }]) {
    s.gateway.acceptance = () => body;
    await assert.rejects(s.call("/submit", value), /uncertain/);
  }
  s.gateway.acceptanceStatus = 202; s.gateway.acceptance = undefined;
  assert.equal((await s.call<ProviderSubmitResult>("/submit", value)).status, "accepted");
  assert.equal(s.gateway.jobs.size, 1);
});

test("stable identity survives lost acceptance and execution secret rotation; changed input conflicts", async t => {
  const s = await startStack(); t.after(() => s.app.dispose()); const value = await submission();
  s.gateway.loseAcceptance = 1; await assert.rejects(s.call("/submit", value));
  const first = [...s.gateway.jobs.values()][0]!; const prior = structuredClone(first.body);
  value.execution.token = await issueMachineSecret(auth, machineId, "execution", 2);
  assert.equal((await s.call<ProviderSubmitResult>("/submit", value)).status, "accepted");
  assert.deepEqual(first.body, prior); assert.equal(s.gateway.jobs.size, 1);
  s.gateway.acceptance = r => ({ ...r, requestHash: "0".repeat(64) }); await assert.rejects(s.call("/submit", value));
  s.gateway.acceptance = undefined; value.submission.request.input.patch += "\nchanged";
  await assert.rejects(s.call("/submit", value), /REQUEST_CONFLICT/);
});
test("malformed envelopes and wrong machines cannot dispatch; gateway fences stale runtimes", async t => {
  const s = await startStack(); t.after(() => s.app.dispose()); const value = await submission();
  const { execution: omitted, ...legacy } = value;
  assert.equal((await s.call<ProviderSubmitResult>("/submit", legacy)).status, "rejected");
  for (const patch of [{ token: await issueMachineSecret(auth, randomUUID(), "execution", 1) }, { runtimeGeneration: randomUUID() }]) {
    await assert.rejects(s.call("/submit", { ...value, execution: { ...value.execution, ...patch } }));
  }
  const injected = structuredClone(value); Object.assign(injected.submission.request.input, { callbackUrl: "https://bad" });
  assert.equal((await s.call<ProviderSubmitResult>("/submit", injected)).status, "rejected");
  assert.equal(s.gateway.posts, 1); assert.equal(s.gateway.jobs.size, 0);
  for (const [status, code, retryable, uncertain] of [[409,"MACHINE_OFFLINE",true,false],[401,"INVALID_TOKEN",false,false],[409,"RUNTIME_CHANGED",false,false],[409,"REQUEST_CONFLICT",false,true],[429,"ApplyPatchACITY",true,false],[400,"SUBMISSION_UNCERTAIN",false,true]] as const) {
    s.gateway.reject = { status, code, retryable, uncertain }; await assert.rejects(s.call("/submit", value));
  }
  s.gateway.reject = { status: 400, code: "INVALID_REQUEST", retryable: false, uncertain: false };
  assert.equal((await s.call<ProviderSubmitResult>("/submit", value)).status, "rejected");
});
