import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderSubmitResult, EditInput, EditResult } from "@managed-agents/contracts";
import { parseLlmMessage, PI_EDIT_MAX_PARAMS_BYTES } from "@managed-agents/contracts";
import { patchParams } from "../src/gateway.ts";
import { editIdentity } from "../src/context.ts";
import { FakeGateway, startStack, input, editReceipt, event, signed, until } from "./stack.ts";
import type { Stack } from "./stack.ts";

const url = "https://callbacks/webhooks/execution-gateway";
async function start(stack: Stack, value: EditInput = input) {
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
async function result(stack: Stack, sessionId: string): Promise<EditResult> {
  const value = await outcome(stack, sessionId); assert.equal(value.status, "succeeded");
  if (value.status !== "succeeded") throw new Error("Expected a completed tool result.");
  return value.result as EditResult;
}
function submission() {
  return { destination: { routeKey: "test-v1", sessionId: "manual" }, submission: { operationId: "op", submissionId: "sub",
    request: { provider: "tool-pi-edit", type: "edit", version: "v1", input: structuredClone(input) as EditInput } } };
}
test("terminal replay verifies retained correlation and never turns detail failure into rejection", async () => {
  const stack = await startStack();
  try {
    const request = submission(), accepted = await stack.call<ProviderSubmitResult>("/submit", request);
    assert.equal(accepted.status, "accepted"); if (accepted.status !== "accepted") throw new Error("Not accepted");
    const job = stack.gateway.jobs.get(accepted.jobId)!; stack.gateway.finish(job);
    for (const patch of [{ id: randomUUID() }, { machineId: randomUUID() }, { idempotencyKey: "other" }, { runtimeGenerationId: randomUUID() },
      { status: "waiting_response" }, { clientContext: { ...job.clientContext, editsSha256: "0".repeat(64) } }]) {
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
    const changed = structuredClone(request); changed.submission.request.input.edits = [{ oldText: "old", newText: "different" }];
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
test("lost acceptance and early completion replay one edit with one immutable mutation identity", async () => {
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
  const gateway = new FakeGateway(), persistPath = await mkdtemp(join(tmpdir(), "edit-worker-"));
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

test("one native patch job carries exact edits and signed digest; callback requires durable admission", async () => {
  const stack = await startStack();
  try {
    const edits = [{ oldText: "नमस्ते 🌍\r\n\0", newText: "$(no shell)" }, { oldText: "remove", newText: "" }], path = "nested/hello world.txt";
    const { sessionId, job } = await start(stack, { ...input, edits, path });
    assert.deepEqual(job.request, { operation: "filesystem.apply_patch", params: { cwd: input.cwd,
      mutation_id: job.idempotencyKey, patch: { format: "text_replacements", files: [{ path, edits }] } } });
    assert.match(job.idempotencyKey, /^pi-edit-v1:[a-f0-9]{64}$/);
    assert.equal(job.clientContext.editCount, 2);
    assert.equal(job.clientContext.editsSha256, createHash("sha256").update(JSON.stringify(edits)).digest("hex"));
    assert.equal("edits" in job.clientContext, false);
    stack.gateway.finish(job); stack.gateway.detailError = 503;
    await stack.call("/faults", { sessionId, fail: 1 });
    assert.equal((await stack.callbacks.fetch(url, signed(event(job)))).status, 503);
    assert.equal((await stack.call("/snapshot", { sessionId })).admittedCompletions, 0);
    assert.equal((await stack.callbacks.fetch(url, signed(event(job)))).status, 204);
    const r = await result(stack, sessionId);
    assert.deepEqual(r.content, [{ type: "text", text: `Successfully replaced 2 block(s) in ${path}.` }]);
    assert.equal(r.isError, false); assert.equal(r.details.firstChangedLine, 1);
    assert.equal(r.details.patch, editReceipt(job).diff); assert.equal(r.details.diff, r.details.patch);
    assert.deepEqual(await Promise.all(Array.from({ length: 3 }, async () => (await stack.callbacks.fetch(url, signed(event(job)))).status)), [204, 204, 204]);
    assert.equal((await stack.call("/snapshot", { sessionId })).results.length, 1);
    assert.equal(stack.gateway.posts, 1); assert.equal(stack.gateway.details, 0);
    assert.doesNotThrow(() => parseLlmMessage({ role: "tool_result", toolName: "edit", toolCallId: "call", content: r.content, details: r.details, outcome: { status: "success" } }));
    assert.equal((await stack.edit.fetch("https://edit/submit", { method: "POST" })).status, 404);
    await assert.rejects(stack.call("/callback-submit", submission()));
  } finally { await stack.app.dispose(); }
});

test("rejected and partial patch receipts are model-visible errors with retained changes and no replacement jobs", async () => {
  const stack = await startStack();
  try {
    for (const status of ["rejected", "partial"] as const) {
      const { sessionId, job } = await start(stack);
      const receipt = { ...editReceipt(job), status, changes_exact: status === "rejected",
        changes: status === "rejected" ? [] : editReceipt(job).changes,
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
      if (value.status === "succeeded") assert.equal((value.result as EditResult).isError, true);
    }
    assert.equal(stack.gateway.posts, 7); assert.equal(stack.gateway.details, 0);
  } finally { await stack.app.dispose(); }
});

test("serialized 4 MiB request boundary accounts for JSON escaping and local oversized errors", async () => {
  const stack = await startStack();
  try {
    const request = submission(), params = patchParams(request.submission.request.input, await editIdentity("sub"));
    const remaining = PI_EDIT_MAX_PARAMS_BYTES - Buffer.byteLength(JSON.stringify(params));
    request.submission.request.input.edits[0]!.newText += "x".repeat(remaining);
    assert.equal(Buffer.byteLength(JSON.stringify(patchParams(request.submission.request.input, await editIdentity("sub")))), PI_EDIT_MAX_PARAMS_BYTES);
    const accepted = await stack.call<ProviderSubmitResult>("/submit", request);
    assert.equal(accepted.status, "accepted");
    const job = [...stack.gateway.jobs.values()][0]!; stack.gateway.finish(job);
    assert.equal((await stack.call<ProviderSubmitResult>("/submit", request)).status, "completed");
    const oversized = structuredClone(request); oversized.submission.submissionId = "large";
    oversized.submission.request.input.edits[0]!.newText += "x";
    const first = await stack.call<ProviderSubmitResult>("/submit", oversized);
    assert.equal(first.status, "completed");
    if (first.status !== "completed" || first.outcome.status !== "succeeded") throw new Error("Expected local error");
    assert.equal((first.outcome.result as EditResult).details.error?.code, "EDIT_REQUEST_TOO_LARGE");
    assert.equal((first.outcome.result as EditResult).details.gatewayJobId, undefined);
    assert.match(first.jobId, /^local:pi-edit-v1:/);
    assert.deepEqual(await stack.call("/submit", oversized), first);
    const escaped = submission(); escaped.submission.submissionId = "escaped";
    escaped.submission.request.input.edits[0]!.newText = "\0".repeat(750000);
    assert.equal((await stack.call<ProviderSubmitResult>("/submit", escaped)).status, "completed");
    assert.equal(stack.gateway.jobs.size, 1); assert.equal(stack.gateway.posts, 2);
  } finally { await stack.app.dispose(); }
});

test("signatures, correlation, protocol, mutation, single-file changes and patch outcomes are checked", async () => {
  const stack = await startStack();
  try {
    const { sessionId, job } = await start(stack); stack.gateway.finish(job); const n = event(job), receipt = editReceipt(job);
    assert.equal((await stack.callbacks.fetch(url, signed(n, "wrong"))).status, 401);
    const tampered = signed(n); tampered.body = tampered.body.replace('"applied"', '"partial"');
    assert.equal((await stack.callbacks.fetch(url, tampered)).status, 401);
    const badResults = [{ mutation_id: "wrong" }, { status: "partial" }, { changes_exact: false }, { changes: [] },
      { error: { code: "io", message: "bad" } }, { diff: "x".repeat(65537) }, { diff_truncated: "false" },
      { changes: [receipt.changes[0], receipt.changes[0]] },
      ...[{ path: "relative" }, { kind: "add" }, { after_sha256: "bad" }, { bytes_after: 5242881 }, { first_changed_line: 0 },
        { destination_path: "/other" }].map(p => ({ changes: [{ ...receipt.changes[0], ...p }] }))];
    for (const patch of [{ machineId: randomUUID() }, { jobId: randomUUID() }, { runtimeGenerationId: randomUUID() },
      { idempotencyKey: "wrong" }, { clientContext: { ...n.clientContext, extra: true } },
      { clientContext: { ...n.clientContext, editCount: 0 } }, { clientContext: { ...n.clientContext, editsSha256: "bad" } },
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
