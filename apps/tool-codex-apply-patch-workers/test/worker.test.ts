import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderSubmitResult, ApplyPatchInput, ApplyPatchResult } from "@managed-agents/contracts";
import { parseLlmMessage, CODEX_APPLY_PATCH_MAX_PARAMS_BYTES } from "@managed-agents/contracts";
import { patchParams } from "../src/gateway.ts";
import { applyPatchIdentity } from "../src/context.ts";
import { FakeGateway, startStack, input, patchReceipt, event, signed, until } from "./stack.ts";
import type { Stack } from "./stack.ts";

const url = "https://callbacks/webhooks/execution-gateway";
async function start(stack: Stack, value: ApplyPatchInput = input) {
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
async function result(stack: Stack, sessionId: string): Promise<ApplyPatchResult> {
  const value = await outcome(stack, sessionId); assert.equal(value.status, "succeeded");
  if (value.status !== "succeeded") throw new Error("Expected a completed tool result.");
  return value.result as ApplyPatchResult;
}
function submission() {
  return { destination: { routeKey: "test-v1", sessionId: "manual" }, submission: { operationId: "op", submissionId: "sub",
    request: { provider: "tool-codex-apply-patch", type: "apply_patch", version: "v1", input: structuredClone(input) as ApplyPatchInput } } };
}
test("terminal replay verifies retained correlation and never turns detail failure into rejection", async () => {
  const stack = await startStack();
  try {
    const request = submission(), accepted = await stack.call<ProviderSubmitResult>("/submit", request);
    assert.equal(accepted.status, "accepted"); if (accepted.status !== "accepted") throw new Error("Not accepted");
    const job = stack.gateway.jobs.get(accepted.jobId)!; stack.gateway.finish(job);
    for (const patch of [{ id: randomUUID() }, { machineId: randomUUID() }, { idempotencyKey: "other" }, { runtimeGenerationId: randomUUID() },
      { status: "waiting_response" }, { clientContext: { ...job.clientContext, patchSha256: "0".repeat(64) } }]) {
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
    const changed = structuredClone(request); changed.submission.request.input.patch = input.patch.replace("new", "different");
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
test("lost acceptance and early completion replay one patch with one immutable mutation identity", async () => {
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
test("restart and redelivery after a lost DO receipt preserve the result without writing again", async () => {
  const gateway = new FakeGateway(), persistPath = await mkdtemp(join(tmpdir(), "apply-patch-worker-"));
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

test("one native patch job carries raw text and signed digest; callback requires durable admission", async () => {
  const stack = await startStack();
  try {
    const patch = "*** Begin Patch\n*** Add File: nested/hello world.txt\n+नमस्ते 🌍\r\n+$(no shell)\n*** End Patch";
    const { sessionId, job } = await start(stack, { ...input, patch });
    assert.deepEqual(job.request, { operation: "filesystem.apply_patch", params: { cwd: input.cwd,
      mutation_id: job.idempotencyKey, patch: { format: "codex", text: patch } } });
    assert.match(job.idempotencyKey, /^codex-apply-patch-v1:[a-f0-9]{64}$/);
    assert.equal(job.clientContext.patchSha256, createHash("sha256").update(patch).digest("hex"));
    assert.equal("patch" in job.clientContext, false);
    stack.gateway.finish(job); stack.gateway.detailError = 503;
    await stack.call("/faults", { sessionId, fail: 1 });
    assert.equal((await stack.callbacks.fetch(url, signed(event(job)))).status, 503);
    assert.equal((await stack.call("/snapshot", { sessionId })).admittedCompletions, 0);
    assert.equal((await stack.callbacks.fetch(url, signed(event(job)))).status, 204);
    const r = await result(stack, sessionId);
    assert.deepEqual(r.content, [{ type: "text", text: "Success. Updated the following files:\nM /workspace/project/file.txt\n" }]);
    assert.equal(r.isError, false); assert.equal(r.details.changes?.[0]?.firstChangedLine, 1);
    assert.equal(r.details.diff, patchReceipt(job).diff);
    assert.deepEqual(await Promise.all(Array.from({ length: 3 }, async () => (await stack.callbacks.fetch(url, signed(event(job)))).status)), [204, 204, 204]);
    assert.equal((await stack.call("/snapshot", { sessionId })).results.length, 1);
    assert.equal(stack.gateway.posts, 1); assert.equal(stack.gateway.details, 0);
    assert.doesNotThrow(() => parseLlmMessage({ role: "tool_result", toolName: "apply_patch", toolCallId: "call", content: r.content, details: r.details, outcome: { status: "success" } }));
    assert.equal((await stack.patchWorker.fetch("https://patch/submit", { method: "POST" })).status, 404);
    await assert.rejects(stack.call("/callback-submit", submission()));
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
      assert.equal(job.status, "failed");
      assert.equal((await stack.callbacks.fetch(url, signed(event(job)))).status, 204);
      const r = await result(stack, sessionId);
      assert.equal(r.isError, true); assert.equal(r.details.status, status);
      assert.equal(r.details.changesExact, status === "rejected");
      assert.equal(r.details.changes?.length, status === "rejected" ? 0 : 1);
      if (status === "partial") assert.match(r.content[0]!.text, /may have changed/);
      else assert.equal(r.content[0]!.text, "Target could not be edited");
    }
    for (const code of ["resource_limit", "invalid_argument", "idempotency_conflict", "io", "unsupported_operation"]) {
      const { sessionId, job } = await start(stack); stack.gateway.fileError(job, code, "Native error");
      assert.equal((await stack.callbacks.fetch(url, signed(event(job)))).status, 204);
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
    const request = submission();
    request.submission.request.input.patch = "x".repeat(2 * 1024 * 1024);
    assert.equal((await stack.call<ProviderSubmitResult>("/submit", request)).status, "accepted");
    const job = [...stack.gateway.jobs.values()][0]!; stack.gateway.finish(job);
    assert.equal((await stack.call<ProviderSubmitResult>("/submit", request)).status, "completed");
    const oversized = structuredClone(request); oversized.submission.submissionId = "large";
    oversized.submission.request.input.patch += "x";
    const first = await stack.call<ProviderSubmitResult>("/submit", oversized);
    assert.equal(first.status, "completed");
    if (first.status !== "completed" || first.outcome.status !== "succeeded") throw new Error("Expected local error");
    assert.equal((first.outcome.result as ApplyPatchResult).details.error?.code, "APPLY_PATCH_REQUEST_TOO_LARGE");
    assert.equal((first.outcome.result as ApplyPatchResult).details.gatewayJobId, undefined);
    assert.match(first.jobId, /^local:codex-apply-patch-v1:/);
    assert.deepEqual(await stack.call("/submit", oversized), first);
    const escaped = submission(); escaped.submission.submissionId = "escaped";
    // Below 2 MiB as raw text; exactly 4 MiB after JSON escaping and metadata.
    escaped.submission.request.input.patch = "";
    const overhead = Buffer.byteLength(JSON.stringify(patchParams(escaped.submission.request.input, await applyPatchIdentity("escaped"))));
    const remaining = CODEX_APPLY_PATCH_MAX_PARAMS_BYTES - overhead;
    escaped.submission.request.input.patch = "\0".repeat(Math.floor(remaining / 6)) + "x".repeat(remaining % 6);
    assert.equal(Buffer.byteLength(JSON.stringify(patchParams(escaped.submission.request.input, await applyPatchIdentity("escaped")))), CODEX_APPLY_PATCH_MAX_PARAMS_BYTES);
    assert.equal((await stack.call<ProviderSubmitResult>("/submit", escaped)).status, "accepted");
    escaped.submission.submissionId = "escaped-too-large"; escaped.submission.request.input.patch += "x";
    assert.equal((await stack.call<ProviderSubmitResult>("/submit", escaped)).status, "completed");
    assert.equal(stack.gateway.jobs.size, 2); assert.equal(stack.gateway.posts, 3);
  } finally { await stack.app.dispose(); }
});

test("signatures, correlation, protocol, mutation, multi-file change metadata and patch outcomes are checked", async () => {
  const stack = await startStack();
  try {
    const { sessionId, job } = await start(stack); stack.gateway.finish(job); const n = event(job), receipt = patchReceipt(job);
    assert.equal((await stack.callbacks.fetch(url, signed(n, "wrong"))).status, 401);
    const tampered = signed(n); tampered.body = tampered.body.replace('"applied"', '"partial"');
    assert.equal((await stack.callbacks.fetch(url, tampered)).status, 401);
    const badResults = [{ mutation_id: "wrong" }, { status: "partial" }, { changes_exact: false }, { changes: [] },
      { error: { code: "io", message: "bad" } }, { diff: "x".repeat(65537) }, { diff_truncated: "false" },
      { changes: Array(33).fill(receipt.changes[0]) },
      ...[{ path: "relative" }, { kind: "delete" }, { after_sha256: "bad" }, { bytes_after: 5242881 }, { first_changed_line: 0 },
        { destination_path: "/other" }].map(p => ({ changes: [{ ...receipt.changes[0], ...p }] }))];
    for (const patch of [{ machineId: randomUUID() }, { jobId: randomUUID() }, { runtimeGenerationId: randomUUID() },
      { idempotencyKey: "wrong" }, { clientContext: { ...n.clientContext, extra: true } },
      { clientContext: { ...n.clientContext, patchSha256: "bad" } },
      { response: null }, { response: { ...(n.response as object), protocol_version: 4 } },
      ...badResults.map(p => ({ response: { ...(n.response as object), result: { ...receipt, ...p } } }))]) {
      assert.equal((await stack.callbacks.fetch(url, signed({ ...n, ...patch }))).status, 503, JSON.stringify(patch));
    }
    assert.equal((await stack.call("/snapshot", { sessionId })).admittedCompletions, 0);
    assert.equal((await stack.callbacks.fetch(url, signed(n))).status, 204);
    await result(stack, sessionId);
    stack.gateway.finish(job, { ...receipt, diff: "changed receipt" });
    assert.equal((await stack.callbacks.fetch(url, signed(event(job)))).status, 503);
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
    assert.equal((await stack.callbacks.fetch(url, signed(event(job)))).status, 204);
    const r = await result(stack, sessionId);
    assert.equal(r.content[0]!.text, "Success. Updated the following files:\nA /workspace/new\nA /workspace/overwritten\nM /workspace/destination\nM /workspace/updated\nD /workspace/deleted\n");
    assert.equal(r.details.changes?.[2]?.destinationBeforeSha256, update.before_sha256);
    assert.equal(r.details.changes?.[4]?.afterSha256, null);
    for (const [known, exact] of [[[], false], [[changes[0]!], false], [[changes[0]!], true]] as const) {
      const next = await start(stack);
      stack.gateway.finish(next.job, { ...patchReceipt(next.job), status: "partial", changes_exact: exact,
        changes: [...known], error: { code: "io", message: "source deletion failed", section: 0, edit: null } });
      assert.equal((await stack.callbacks.fetch(url, signed(event(next.job)))).status, 204);
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
    assert.equal((await stack.callbacks.fetch(url, signed(event(job)))).status, 204);
    const r = await result(stack, sessionId);
    assert.equal(r.isError, false); assert.equal(r.details.summaryTruncated, true);
    assert.equal(r.details.changes?.length, 32);
    assert.ok(Buffer.byteLength(r.content[0]!.text) < 17000);
    assert.ok(Buffer.byteLength(JSON.stringify(r)) < 1900000);
  } finally { await stack.app.dispose(); }
});
