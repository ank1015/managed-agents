import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { FakeGateway, startStack, input, response, event, signed, until, row, due } from "./stack.ts";
import type { Stack } from "./stack.ts";

async function start(stack: Stack, sessionId = randomUUID()) {
  await stack.call("/start", { sessionId, input });
  const operation = await until(async () => { const r = await row(stack, sessionId); return r.gateway_job_id ? r : undefined; });
  return { sessionId, operation, job: stack.gateway.jobs.get(operation.gateway_job_id as string)! };
}
async function process(stack: Stack, id: unknown) {
  await due(stack, id);
  return stack.call("/process", { kind: "operation", id });
}
async function delivered(stack: Stack, sessionId: string) {
  return until(async () => { const r = await row(stack, sessionId); return r.delivered_at ? r : undefined; });
}
const url = "https://worker.test/webhooks/llm-gateway";

test("signed webhook completes the session inline after durable admission, without Queue delivery", async () => {
  const stack = await startStack(new FakeGateway(), { autoQueue: false });
  try {
    const { sessionId, operation, job } = await start(stack);
    assert.equal(stack.gateway.posts, 1);
    assert.equal(stack.gateway.details, 0, "pending polls must not download prompt history");
    const accepted = await until(async () => { const s = await stack.call("/snapshot", { sessionId }); return s.outbox.length === 0 ? s : undefined; });
    assert.equal(accepted.operations[0].outcome, null);
    stack.gateway.finish(job);
    const notification = event(job);
    assert.equal((await stack.llm.fetch(url, signed(notification))).status, 204);
    await delivered(stack, sessionId);
    const snapshot = await until(async () => { const s = await stack.call("/snapshot", { sessionId }); return s.results.length ? s : undefined; });
    assert.deepEqual(snapshot.operations[0].outcome, { status: "succeeded", result: { gatewayJobId: job.id, response } });
    assert.equal(snapshot.outbox.length, 0);
    assert.equal(snapshot.results.length, 1);
    assert.equal((await stack.llm.fetch(url, signed(notification))).status, 204);
    assert.equal((await stack.db.prepare("SELECT COUNT(*) AS n FROM llm_webhook_events").first())!.n, 1);
    assert.ok(!JSON.stringify(await row(stack, sessionId)).includes("private prompt"));
    assert.ok(!JSON.stringify(await row(stack, sessionId)).includes("encrypted_content"));
    assert.equal((await stack.call("/get", { operationId: operation.operation_id, submissionId: operation.submission_id, jobId: job.id })).status, "completed");
    assert.equal((await stack.llm.fetch("https://worker.test/v1/jobs", { method: "POST" })).status, 404);
  } finally { await stack.app.dispose(); }
});

test("lost gateway acceptance retries the same idempotent job, without retaining its prompt in D1", async () => {
  const gateway = new FakeGateway(); gateway.loseAcceptance = 1;
  const stack = await startStack(gateway, { autoQueue: false });
  try {
    const { job, operation } = await start(stack);
    assert.equal(gateway.posts, 2); assert.equal(gateway.jobs.size, 1);
    assert.match(job.idempotencyKey, /^ma-v1:[a-f0-9]{64}$/);
    assert.equal(operation.gateway_job_id, job.id);
  } finally { await stack.app.dispose(); }
});

test("callback can recover the reservation and complete the session before POST is acknowledged", async () => {
  const gateway = new FakeGateway(), stack = await startStack(gateway, { autoQueue: false });
  let early = false;
  gateway.onAccepted = async job => {
    gateway.finish(job);
    const notification = event(job);
    assert.equal((await stack.llm.fetch(url, signed(notification))).status, 204);
    const reserved = await stack.db.prepare("SELECT * FROM llm_operations WHERE gateway_key = ?").bind(job.idempotencyKey).first();
    assert.equal(reserved!.gateway_job_id, null);
    await stack.call("/process", { kind: "event", id: notification.eventId });
    await process(stack, reserved!.submission_id);
    early = (await row(stack, reserved!.session_id as string)).delivered_at !== null;
  };
  try {
    const { sessionId } = await start(stack);
    await until(async () => early);
    const s = await until(async () => { const s = await stack.call("/snapshot", { sessionId }); return s.results.length ? s : undefined; });
    assert.equal(s.results.length, 1); assert.equal(gateway.posts, 1); assert.equal(s.outbox.length, 0);
  } finally { await stack.app.dispose(); }
});

test("D1 mapping failure after gateway acceptance cannot acknowledge or create a second job", async () => {
  const stack = await startStack(new FakeGateway(), { autoQueue: false });
  try {
    await stack.db.prepare(`CREATE TRIGGER fail_mapping BEFORE UPDATE OF gateway_job_id ON llm_operations
      BEGIN SELECT RAISE(ABORT, 'Injected D1 failure'); END`).run();
    const sessionId = randomUUID();
    await stack.call("/start", { sessionId, input });
    await until(async () => stack.gateway.posts > 0);
    const reserved = await row(stack, sessionId);
    assert.equal(reserved.gateway_job_id, null);
    assert.equal(reserved.state, "submitting");
    assert.equal((await stack.call("/snapshot", { sessionId })).outbox.length, 1);
    await stack.db.prepare("DROP TRIGGER fail_mapping").run();
    await until(async () => (await row(stack, sessionId)).gateway_job_id);
    assert.equal(stack.gateway.jobs.size, 1);
    assert.ok(stack.gateway.posts >= 2);
  } finally { await stack.app.dispose(); }
});

test("webhook persistence failure returns a retryable response, then accepts the gateway retry", async () => {
  const stack = await startStack(new FakeGateway(), { autoQueue: false });
  try {
    const { job } = await start(stack); stack.gateway.finish(job);
    const notification = event(job);
    await stack.db.prepare(`CREATE TRIGGER fail_event BEFORE INSERT ON llm_webhook_events
      BEGIN SELECT RAISE(ABORT, 'Injected D1 failure'); END`).run();
    assert.equal((await stack.llm.fetch(url, signed(notification))).status, 503);
    assert.equal((await stack.db.prepare("SELECT COUNT(*) AS n FROM llm_webhook_events").first())!.n, 0);
    await stack.db.prepare("DROP TRIGGER fail_event").run();
    assert.equal((await stack.llm.fetch(url, signed(notification))).status, 204);
  } finally { await stack.app.dispose(); }
});

test("delivery and lost-receipt retries are durable and do not duplicate the runtime event", async () => {
  const stack = await startStack(new FakeGateway(), { autoQueue: false });
  try {
    const { sessionId, operation, job } = await start(stack);
    stack.gateway.finish(job);
    await stack.call("/faults", { sessionId, fail: 1, lose: 1 });
    assert.ok((await process(stack, operation.submission_id)).delay > 0);
    assert.equal((await row(stack, sessionId)).delivered_at, null);
    assert.ok((await process(stack, operation.submission_id)).delay > 0);
    assert.equal((await row(stack, sessionId)).delivered_at, null);
    assert.equal((await process(stack, operation.submission_id)).delay, null);
    await delivered(stack, sessionId);
    const s = await until(async () => { const s = await stack.call("/snapshot", { sessionId }); return s.results.length ? s : undefined; });
    assert.equal(s.results.length, 1); assert.equal(stack.gateway.posts, 1);
  } finally { await stack.app.dispose(); }
});

test("webhooks require a fresh raw-body signature and support signing-secret rotation", async () => {
  const stack = await startStack(new FakeGateway(), { autoQueue: false });
  try {
    const { job } = await start(stack); stack.gateway.finish(job);
    const notification = event(job);
    assert.equal((await stack.llm.fetch(url, signed(notification, "wrong"))).status, 401);
    assert.equal((await stack.llm.fetch(url, signed(notification, undefined, "1"))).status, 401);
    const tampered = signed(notification); tampered.body += " ";
    assert.equal((await stack.llm.fetch(url, tampered)).status, 401);
    const mismatch = signed(notification); mismatch.headers["X-LLM-Gateway-Event-Id"] = randomUUID();
    assert.equal((await stack.llm.fetch(url, mismatch)).status, 401);
    assert.equal((await stack.llm.fetch(url, signed(notification, "previous-secret"))).status, 204);
    assert.equal((await stack.llm.fetch(url, signed(notification))).status, 204);
    assert.equal((await stack.db.prepare("SELECT COUNT(*) AS n FROM llm_webhook_events").first())!.n, 1);
    assert.equal((await stack.llm.fetch(url, { method: "GET" })).status, 405);
  } finally { await stack.app.dispose(); }
});

test("validation, immutable retries and definitive rejection do not call the gateway incorrectly", async () => {
  const gateway = new FakeGateway(), stack = await startStack(gateway, { autoQueue: false });
  const submission = { destination: { routeKey: "test-v1", sessionId: "manual" }, submission: { operationId: "op", submissionId: "sub",
    request: { provider: "llm", type: "generate", version: "v1", input } } };
  try {
    const bad = structuredClone(submission); bad.submission.request.type = "other";
    assert.equal((await stack.call("/submit", bad)).status, "rejected"); assert.equal(gateway.posts, 0);
    const a = await stack.call("/submit", submission);
    assert.deepEqual(await stack.call("/submit", submission), a); assert.equal(gateway.posts, 1);
    const changed = structuredClone(submission); changed.submission.request.input.modelId = "different";
    await assert.rejects(stack.call("/submit", changed), /conflicts/);
    changed.submission.request.input.modelId = input.modelId; changed.destination.sessionId = "other";
    await assert.rejects(stack.call("/submit", changed), /conflicts/);
    gateway.reject = { status: 400, code: "invalid_model" };
    const rejected = structuredClone(submission); rejected.submission.submissionId = "sub2"; rejected.submission.operationId = "op2";
    assert.equal((await stack.call("/submit", rejected)).status, "rejected");
    assert.equal((await stack.call("/submit", rejected)).status, "rejected"); assert.equal(gateway.posts, 2);
    gateway.reject = { status: 401, code: "unauthorized" };
    rejected.submission.submissionId = "sub3"; rejected.submission.operationId = "op3";
    await assert.rejects(stack.call("/submit", rejected), /401/);
    assert.equal((await stack.db.prepare("SELECT state FROM llm_operations WHERE submission_id = 'sub3'").first())!.state, "submitting");
  } finally { await stack.app.dispose(); }
});

test("terminal failures, cancellation, oversize results, and missing accepted jobs", async () => {
  const stack = await startStack(new FakeGateway(), { autoQueue: false });
  try {
    for (const status of ["failed", "cancelled", "succeeded"]) {
      const { sessionId, operation, job } = await start(stack);
      const huge = structuredClone(response); huge.message.content[0]!.content![0]!.text = "x".repeat(8 * 1024 * 1024);
      stack.gateway.finish(job, status, huge);
      await process(stack, operation.submission_id);
      await delivered(stack, sessionId);
      const s = await stack.call("/snapshot", { sessionId });
      const outcome = s.operations[0].outcome;
      assert.equal(outcome.status, status === "cancelled" ? "cancelled" : "failed");
      if (status === "succeeded") assert.equal(outcome.error.code, "LLM_RESULT_TOO_LARGE");
      if (status === "failed") assert.equal(outcome.error.code, "model_error");
    }
    const { sessionId, operation, job } = await start(stack);
    stack.gateway.jobs.delete(job.id);
    assert.ok((await process(stack, operation.submission_id)).delay > 0);
    assert.match((await row(stack, sessionId)).last_error as string, /will not be resubmitted/);
    assert.equal(stack.gateway.posts, 4);
  } finally { await stack.app.dispose(); }
});

test("restart plus scheduled repair recovers expired leases and lost queue notifications without a webhook", async () => {
  const gateway = new FakeGateway(), persistPath = await mkdtemp(join(tmpdir(), "llm-worker-test-"));
  let stack = await startStack(gateway, { autoQueue: false, persistPath });
  try {
    const { sessionId, operation, job } = await start(stack);
    gateway.finish(job);
    await stack.db.prepare("UPDATE llm_operations SET lease_token = 'crashed', lease_until = 1, next_attempt_at = 0 WHERE submission_id = ?")
      .bind(operation.submission_id).run();
    await stack.app.dispose();
    stack = await startStack(gateway, { persistPath });
    await stack.call("/recover");
    await delivered(stack, sessionId);
    assert.equal(gateway.posts, 1);
    const s = await until(async () => { const s = await stack.call("/snapshot", { sessionId }); return s.results.length ? s : undefined; });
    assert.equal(s.results.length, 1);
  } finally { await stack.app.dispose(); }
});
