import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { FakeGateway, startStack, input, runResult, event, signed, until, row, due } from "./stack.ts";
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
const url = "https://worker.test/webhooks/execution-gateway";

test("gateway callback completes the session inline through both workers, without Queue delivery", async () => {
  const stack = await startStack(new FakeGateway(), { autoQueue: false });
  try {
    const { sessionId, operation, job } = await start(stack);
    assert.equal(stack.gateway.posts, 1);
    assert.equal(stack.gateway.details, 0, "pending polls must not download command data");
    const accepted = await until(async () => { const s = await stack.call("/snapshot", { sessionId }); return s.outbox.length === 0 ? s : undefined; });
    assert.equal(accepted.operations[0].outcome, null);
    stack.gateway.finish(job);
    const notification = event(job);
    assert.equal((await stack.callbacks.fetch(url, signed(notification))).status, 204);
    await delivered(stack, sessionId);
    const snapshot = await until(async () => { const s = await stack.call("/snapshot", { sessionId }); return s.results.length ? s : undefined; });
    assert.equal(snapshot.operations[0].outcome.status, "succeeded");
    assert.equal(snapshot.operations[0].outcome.result.content[0].text, "Hello\n");
    assert.equal(snapshot.operations[0].outcome.result.isError, false);
    assert.equal(job.request.operation, "execution.run");
    assert.deepEqual(job.clientContext, { receiver: "tool-pi-bash-v1", reference: operation.submission_id });
    assert.equal(job.request.params.run_id, job.idempotencyKey);
    assert.equal(job.request.params.timeout_ms, 1250);
    assert.equal(job.request.params.command.script, input.command);
    assert.deepEqual(job.request.params.command.shell, { executable: "bash", kind: "bash" });
    assert.equal(job.request.params.command.login, false);
    assert.equal(job.request.params.max_output_bytes, 65536);
    assert.equal(snapshot.outbox.length, 0);
    assert.equal(snapshot.results.length, 1);
    assert.equal((await stack.callbacks.fetch(url, signed(notification))).status, 204);
    assert.equal((await stack.callbackDb.prepare("SELECT COUNT(*) AS n FROM gateway_callback_events").first())!.n, 1);
    assert.equal(await stack.db.prepare("SELECT name FROM sqlite_master WHERE name = 'gateway_callback_events' OR name = 'bash_webhook_events'").first(), null);
    assert.equal(await stack.callbackDb.prepare("SELECT name FROM sqlite_master WHERE name = 'bash_operations'").first(), null);
    assert.ok(!JSON.stringify(await row(stack, sessionId)).includes("private command"));
    assert.ok(!JSON.stringify(await row(stack, sessionId)).includes("Hello"));
    assert.equal((await stack.call("/get", { operationId: operation.operation_id, submissionId: operation.submission_id, jobId: job.id })).status, "completed");
    assert.equal((await stack.bash.fetch("https://worker.test/v1/jobs", { method: "POST" })).status, 404);
    assert.equal((await stack.bash.fetch(url, signed(notification))).status, 404, "bash has no public webhook");
    await assert.rejects(stack.call("/callback-submit", {}), /submit/);
  } finally { await stack.app.dispose(); }
});

test("lost gateway acceptance retries the same idempotent job, without retaining the command in D1", async () => {
  const gateway = new FakeGateway(); gateway.loseAcceptance = 1;
  const stack = await startStack(gateway, { autoQueue: false });
  try {
    const { job, operation } = await start(stack);
    assert.equal(gateway.posts, 2); assert.equal(gateway.jobs.size, 1);
    assert.match(job.idempotencyKey, /^pi-bash-v1:[a-f0-9]{64}$/);
    assert.equal(operation.gateway_job_id, job.id);
  } finally { await stack.app.dispose(); }
});

test("an early callback durably marks the reservation before POST is acknowledged, then completes after submit returns", async () => {
  const gateway = new FakeGateway(), stack = await startStack(gateway, { autoQueue: false });
  let earlyAdmitted = false;
  gateway.onAccepted = async job => {
    gateway.finish(job);
    const notification = event(job);
    assert.equal((await stack.callbacks.fetch(url, signed(notification))).status, 204);
    const reserved = await until(async () => {
      const value = await stack.db.prepare("SELECT * FROM bash_operations WHERE gateway_key = ?").bind(job.idempotencyKey).first();
      return value?.state === "terminal" ? value : undefined;
    });
    assert.equal(reserved!.gateway_job_id, job.id);
    assert.equal(gateway.details, 0, "callback admission requires no gateway lookup");
    earlyAdmitted = true;
  };
  try {
    const { sessionId, operation } = await start(stack);
    assert.equal(earlyAdmitted, true);
    await process(stack, operation.submission_id);
    await delivered(stack, sessionId);
    const s = await until(async () => { const s = await stack.call("/snapshot", { sessionId }); return s.results.length ? s : undefined; });
    assert.equal(s.results.length, 1); assert.equal(gateway.posts, 1); assert.equal(s.outbox.length, 0);
  } finally { await stack.app.dispose(); }
});

test("D1 mapping failure after gateway acceptance cannot acknowledge or create a second job", async () => {
  const stack = await startStack(new FakeGateway(), { autoQueue: false });
  try {
    await stack.db.prepare(`CREATE TRIGGER fail_mapping BEFORE UPDATE OF gateway_job_id ON bash_operations
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
    await stack.callbackDb.prepare(`CREATE TRIGGER fail_event BEFORE INSERT ON gateway_callback_events
      BEGIN SELECT RAISE(ABORT, 'Injected D1 failure'); END`).run();
    assert.equal((await stack.callbacks.fetch(url, signed(notification))).status, 503);
    assert.equal((await stack.callbackDb.prepare("SELECT COUNT(*) AS n FROM gateway_callback_events").first())!.n, 0);
    await stack.callbackDb.prepare("DROP TRIGGER fail_event").run();
    assert.equal((await stack.callbacks.fetch(url, signed(notification))).status, 204);
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
    assert.equal((await stack.callbacks.fetch(url, signed(notification, "wrong"))).status, 401);
    assert.equal((await stack.callbacks.fetch(url, signed(notification, undefined, "1"))).status, 401);
    const tampered = signed(notification); tampered.body += " ";
    assert.equal((await stack.callbacks.fetch(url, tampered)).status, 401);
    const mismatch = signed(notification); mismatch.headers["X-Execution-Gateway-Event-Id"] = randomUUID();
    assert.equal((await stack.callbacks.fetch(url, mismatch)).status, 401);
    assert.equal((await stack.callbacks.fetch(url, signed(notification, "previous-secret"))).status, 204);
    assert.equal((await stack.callbacks.fetch(url, signed(notification))).status, 204);
    assert.equal((await stack.callbackDb.prepare("SELECT COUNT(*) AS n FROM gateway_callback_events").first())!.n, 1);
    assert.equal((await stack.callbacks.fetch(url, { method: "GET" })).status, 405);
  } finally { await stack.app.dispose(); }
});

test("validation, immutable retries and definitive rejection do not call the gateway incorrectly", async () => {
  const gateway = new FakeGateway(), stack = await startStack(gateway, { autoQueue: false });
  const submission = { destination: { routeKey: "test-v1", sessionId: "manual" }, submission: { operationId: "op", submissionId: "sub",
    request: { provider: "tool-pi-bash", type: "bash", version: "v1", input } } };
  try {
    const bad = structuredClone(submission); bad.submission.request.type = "other";
    assert.equal((await stack.call("/submit", bad)).status, "rejected"); assert.equal(gateway.posts, 0);
    const a = await stack.call("/submit", submission);
    assert.deepEqual(await stack.call("/submit", submission), a); assert.equal(gateway.posts, 1);
    const changed = structuredClone(submission); changed.submission.request.input.command = "different";
    await assert.rejects(stack.call("/submit", changed), /conflicts/);
    changed.submission.request.input.command = input.command; changed.destination.sessionId = "other";
    await assert.rejects(stack.call("/submit", changed), /conflicts/);
    gateway.reject = { status: 400, code: "invalid_argument" };
    const rejected = structuredClone(submission); rejected.submission.submissionId = "sub2"; rejected.submission.operationId = "op2";
    assert.equal((await stack.call("/submit", rejected)).status, "rejected");
    assert.equal((await stack.call("/submit", rejected)).status, "rejected"); assert.equal(gateway.posts, 2);
    gateway.reject = { status: 401, code: "unauthorized" };
    rejected.submission.submissionId = "sub3"; rejected.submission.operationId = "op3";
    await assert.rejects(stack.call("/submit", rejected), /401/);
    assert.equal((await stack.db.prepare("SELECT state FROM bash_operations WHERE submission_id = 'sub3'").first())!.state, "submitting");
  } finally { await stack.app.dispose(); }
});

test("restart plus scheduled repair recovers expired leases and lost queue notifications without a webhook", async () => {
  const gateway = new FakeGateway(), persistPath = await mkdtemp(join(tmpdir(), "bash-worker-test-"));
  let stack = await startStack(gateway, { autoQueue: false, persistPath });
  try {
    const { sessionId, operation, job } = await start(stack);
    gateway.finish(job);
    await stack.db.prepare("UPDATE bash_operations SET lease_token = 'crashed', lease_until = 1, next_attempt_at = 0 WHERE submission_id = ?")
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

test("nonzero exit, timeout, termination and launch failure are completed tools, never new executions", async () => {
  const stack = await startStack(new FakeGateway(), { autoQueue: false });
  try {
    for (const [reason, code] of [["exited", 3], ["timed_out", null], ["terminated", null], ["start_failed", null]] as const) {
      const { sessionId, operation, job } = await start(stack);
      stack.gateway.finish(job, "succeeded", runResult(job.idempotencyKey, "partial output", reason, code));
      const query = { operationId: operation.operation_id, submissionId: operation.submission_id, jobId: job.id };
      const first = await stack.call("/get", query);
      assert.equal(first.status, "completed");
      assert.equal(first.outcome.status, "succeeded");
      assert.equal(first.outcome.result.isError, true);
      assert.equal(first.outcome.result.details.reason, reason);
      assert.equal(first.outcome.result.details.exitCode, code);
      assert.deepEqual(await stack.call("/get", query), first);
      assert.equal((await process(stack, operation.submission_id)).delay, null);
      await delivered(stack, sessionId);
    }
    assert.equal(stack.gateway.posts, 4); assert.equal(stack.gateway.jobs.size, 4);
  } finally { await stack.app.dispose(); }
});

test("gateway errors and unknown/lost executions deliver failures without re-executing", async () => {
  const stack = await startStack(new FakeGateway(), { autoQueue: false });
  try {
    for (const kind of ["failed", "unknown", "response_error", "lost"]) {
      const { sessionId, operation, job } = await start(stack);
      stack.gateway.finish(job, kind === "unknown" || kind === "failed" ? kind : "succeeded",
        runResult(job.idempotencyKey, "captured", kind === "lost" ? "lost" : "exited"));
      if (kind === "response_error") {
        job.status = "failed";
        job.response = { protocol_version: 4, request_id: job.id, generation_id: job.runtimeGenerationId,
          status: "error", error: { code: "resource_limit", message: "Runtime capacity reached" } };
      }
      assert.equal((await process(stack, operation.submission_id)).delay, null);
      await delivered(stack, sessionId);
      const s = await stack.call("/snapshot", { sessionId });
      assert.equal(s.operations[0].outcome.status, "failed");
      assert.equal(s.operations[0].outcome.origin, "execution");
      assert.equal(s.operations[0].outcome.error.code,
        kind === "failed" ? "dispatch_timeout" : kind === "response_error" ? "resource_limit" : "BASH_EXECUTION_UNKNOWN");
    }
    assert.equal(stack.gateway.posts, 4); assert.equal(stack.gateway.jobs.size, 4);
  } finally { await stack.app.dispose(); }
});

test("missing accepted jobs and mismatched terminal responses stay in recovery, never resubmit", async () => {
  const stack = await startStack(new FakeGateway(), { autoQueue: false });
  try {
    const { sessionId, operation, job } = await start(stack);
    stack.gateway.jobs.delete(job.id);
    assert.ok((await process(stack, operation.submission_id)).delay > 0);
    assert.match(String((await row(stack, sessionId)).last_error), /missing/);
    stack.gateway.jobs.set(job.id, job);
    stack.gateway.finish(job, "succeeded", runResult("wrong-run"));
    assert.ok((await process(stack, operation.submission_id)).delay > 0);
    assert.match(String((await row(stack, sessionId)).last_error), /different run/);
    assert.equal((await stack.call("/snapshot", { sessionId })).operations[0].outcome, null);
    assert.equal(stack.gateway.posts, 1);
    stack.gateway.finish(job);
    assert.equal((await process(stack, operation.submission_id)).delay, null);
    await delivered(stack, sessionId);
  } finally { await stack.app.dispose(); }
});

test("callback schema and machine identity are checked; conflicting event IDs are not acknowledged", async () => {
  const stack = await startStack(new FakeGateway(), { autoQueue: false });
  try {
    const { sessionId, job } = await start(stack); stack.gateway.finish(job);
    const legacy = { ...event(job), schemaVersion: 1 };
    assert.equal((await stack.callbacks.fetch(url, signed(legacy))).status, 400);
    const notification = { ...event(job), machineId: randomUUID() };
    assert.equal((await stack.callbacks.fetch(url, signed(notification))).status, 204);
    await until(async () => (await stack.callbackDb.prepare("SELECT attempts FROM gateway_callback_events WHERE event_id = ?")
      .bind(notification.eventId).first<{ attempts: number }>())?.attempts === 1);
    assert.equal((await row(stack, sessionId)).delivered_at, null);
    const conflicting = { ...notification, machineId: job.machineId };
    assert.equal((await stack.callbacks.fetch(url, signed(conflicting))).status, 503);
    assert.equal((await stack.callbackDb.prepare("SELECT delivered_at FROM gateway_callback_events WHERE event_id = ?").bind(notification.eventId).first())!.delivered_at, null);
  } finally { await stack.app.dispose(); }
});

test("no timeout is injected and concurrent identical submissions keep one gateway job", async () => {
  const stack = await startStack(new FakeGateway(), { autoQueue: false });
  try {
    const { timeout: _, ...withoutTimeout } = input;
    const value = { destination: { routeKey: "test-v1", sessionId: "manual" }, submission: {
      operationId: "op", submissionId: "sub", request: { provider: "tool-pi-bash", type: "bash", version: "v1", input: withoutTimeout } } };
    const replies = await Promise.all(Array.from({ length: 5 }, () => stack.call("/submit", value)));
    for (const reply of replies) assert.deepEqual(reply, replies[0]);
    assert.equal(stack.gateway.jobs.size, 1);
    assert.equal(Object.hasOwn([...stack.gateway.jobs.values()][0]!.request.params, "timeout_ms"), false);
    assert.equal((await row(stack, "manual")).timeout_seconds, null);
  } finally { await stack.app.dispose(); }
});

test("private callback admission checks receiver/reference/machine/job and is idempotent without an event table", async () => {
  const stack = await startStack(new FakeGateway(), { autoQueue: false });
  try {
    const { sessionId, operation, job } = await start(stack); stack.gateway.finish(job);
    const e = event(job);
    for (const invalid of [{ ...e, clientContext: { ...e.clientContext, receiver: "tool-patch-v1" } },
      { ...e, clientContext: { ...e.clientContext, reference: "unknown-submission" } },
      { ...e, machineId: randomUUID() }, { ...e, jobId: randomUUID() }]) {
      await assert.rejects(stack.call("/admit", invalid));
    }
    assert.equal((await row(stack, sessionId)).state, "accepted");
    const receipts = await Promise.all(Array.from({ length: 4 }, () => stack.call("/admit", e)));
    for (const receipt of receipts) assert.deepEqual(receipt, { status: "accepted", eventId: e.eventId, jobId: job.id, clientContext: e.clientContext });
    assert.equal((await row(stack, sessionId)).state, "terminal");
    await process(stack, operation.submission_id);
    const deliveredAt = (await delivered(stack, sessionId)).delivered_at;
    await stack.call("/admit", e);
    assert.equal((await row(stack, sessionId)).delivered_at, deliveredAt);
    assert.equal(stack.gateway.posts, 1);
  } finally { await stack.app.dispose(); }
});

test("failed tool admission leaves callback pending; retry survives without another gateway submission", async () => {
  const stack = await startStack(new FakeGateway(), { autoQueue: false });
  try {
    const { sessionId, operation, job } = await start(stack); stack.gateway.finish(job);
    const e = event(job);
    await stack.db.prepare("CREATE TRIGGER fail_callback BEFORE UPDATE OF gateway_job_id ON bash_operations BEGIN SELECT RAISE(ABORT, 'Injected admission failure'); END").run();
    assert.equal((await stack.callbacks.fetch(url, signed(e))).status, 204);
    await until(async () => (await stack.callbackDb.prepare("SELECT attempts FROM gateway_callback_events WHERE event_id = ?")
      .bind(e.eventId).first<{ attempts: number }>())?.attempts === 1);
    assert.equal((await row(stack, sessionId)).state, "accepted", "admission failure must not partially mark terminal");
    assert.equal((await stack.callbackDb.prepare("SELECT delivered_at FROM gateway_callback_events WHERE event_id = ?").bind(e.eventId).first())!.delivered_at, null);
    await stack.db.prepare("DROP TRIGGER fail_callback").run();
    await stack.callbackDb.prepare("UPDATE gateway_callback_events SET next_attempt_at = 0 WHERE event_id = ?").bind(e.eventId).run();
    assert.equal((await stack.call("/router/process", { eventId: e.eventId })).delay, null);
    await delivered(stack, sessionId);
    assert.equal(stack.gateway.posts, 1);
  } finally { await stack.app.dispose(); }
});

test("restart and cron recover an admitted callback when its fallback Queue notification is lost", async () => {
  const gateway = new FakeGateway(), persistPath = await mkdtemp(join(tmpdir(), "bash-callback-test-"));
  let stack = await startStack(gateway, { autoQueue: false, persistPath });
  try {
    const { sessionId, job } = await start(stack); gateway.finish(job);
    const e = event(job);
    await stack.call("/admit", e);
    await stack.db.prepare("UPDATE bash_operations SET lease_token = 'crashed', lease_until = 1, next_attempt_at = 0 WHERE session_id = ?")
      .bind(sessionId).run();
    await stack.app.dispose();
    stack = await startStack(gateway, { persistPath });
    await stack.call("/recover");
    await delivered(stack, sessionId);
    assert.equal(gateway.posts, 1);
  } finally { await stack.app.dispose(); }
});

test("callback completion and lost-receipt retries use one detail read per attempt with no lookup", async () => {
  const stack = await startStack(new FakeGateway(), { autoQueue: false });
  try {
    const { sessionId, operation, job } = await start(stack);
    stack.gateway.finish(job);
    const e = event(job);
    await stack.call("/admit", e);
    assert.equal(stack.gateway.lookups, 0); assert.equal(stack.gateway.details, 0);
    await stack.call("/faults", { sessionId, fail: 1, lose: 1 });
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await process(stack, operation.submission_id);
      if (attempt < 3) assert.ok(result.delay > 0); else assert.equal(result.delay, null);
      assert.equal(stack.gateway.lookups, 0);
      assert.equal(stack.gateway.details, attempt);
    }
    await delivered(stack, sessionId);
    assert.equal((await stack.call("/get", { operationId: operation.operation_id, submissionId: operation.submission_id, jobId: job.id })).status, "completed");
    assert.equal(stack.gateway.lookups, 0); assert.equal(stack.gateway.details, 4);
    assert.equal(stack.gateway.posts, 1);
  } finally { await stack.app.dispose(); }
});

test("pending reconciliation remains metadata-only and retains terminal discovery before a result error", async () => {
  const stack = await startStack(new FakeGateway(), { autoQueue: false });
  try {
    const { sessionId, operation, job } = await start(stack);
    const query = { operationId: operation.operation_id, submissionId: operation.submission_id, jobId: job.id };
    assert.equal((await stack.call("/get", query)).status, "pending");
    assert.equal(stack.gateway.lookups, 1); assert.equal(stack.gateway.details, 0);
    stack.gateway.finish(job, "succeeded", runResult("wrong-run"));
    await assert.rejects(stack.call("/get", query), /different run/);
    assert.equal((await row(stack, sessionId)).state, "terminal");
    assert.equal(stack.gateway.lookups, 2); assert.equal(stack.gateway.details, 1);
    stack.gateway.finish(job);
    assert.equal((await stack.call("/get", query)).status, "completed");
    assert.equal(stack.gateway.lookups, 2); assert.equal(stack.gateway.details, 2);
    assert.equal(stack.gateway.posts, 1);
  } finally { await stack.app.dispose(); }
});

test("direct completion reads reject missing jobs, pending state and mismatched job/response correlation", async () => {
  const stack = await startStack(new FakeGateway(), { autoQueue: false });
  try {
    const { sessionId, operation, job } = await start(stack);
    stack.gateway.finish(job);
    await stack.call("/admit", event(job));
    const original = structuredClone(job);
    const response = original.response as Record<string, unknown>;
    let details = 0;
    // The callback is only a notification; each detail response must independently validate.
    for (const change of [null, { id: randomUUID() }, { machineId: randomUUID() }, { idempotencyKey: "other" },
      { status: "waiting_response", response: null, error: null }, { runtimeGenerationId: randomUUID() },
      { response: { ...response, request_id: randomUUID() } }, { response: { ...response, protocol_version: 3 } }]) {
      Object.assign(job, structuredClone(original), change ?? {});
      if (change === null) stack.gateway.jobs.delete(original.id); else stack.gateway.jobs.set(original.id, job);
      assert.ok((await process(stack, operation.submission_id)).delay > 0);
      assert.equal(stack.gateway.details, ++details); assert.equal(stack.gateway.lookups, 0);
      assert.equal((await row(stack, sessionId)).delivered_at, null);
      assert.equal((await stack.call("/snapshot", { sessionId })).operations[0].outcome, null);
      assert.equal(stack.gateway.posts, 1);
    }
    Object.assign(job, original);
    assert.equal((await process(stack, operation.submission_id)).delay, null);
    await delivered(stack, sessionId);
    assert.equal(stack.gateway.details, details + 1); assert.equal(stack.gateway.lookups, 0);
  } finally { await stack.app.dispose(); }
});

test("direct callback reads support all gateway terminal statuses", async () => {
  const stack = await startStack(new FakeGateway(), { autoQueue: false });
  try {
    for (const status of ["succeeded", "failed", "unknown"]) {
      const { sessionId, operation, job } = await start(stack);
      stack.gateway.finish(job, status);
      await stack.call("/event", event(job));
      await delivered(stack, sessionId);
      const outcome = (await stack.call("/snapshot", { sessionId })).operations[0].outcome;
      assert.equal(outcome.status, status === "succeeded" ? "succeeded" : "failed");
      if (status === "unknown") assert.equal(outcome.error.code, "BASH_EXECUTION_UNKNOWN");
    }
    assert.equal(stack.gateway.lookups, 0); assert.equal(stack.gateway.details, 3); assert.equal(stack.gateway.posts, 3);
  } finally { await stack.app.dispose(); }
});
