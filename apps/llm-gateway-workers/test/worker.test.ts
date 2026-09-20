import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { FakeGateway, startStack, input, response, event, signed, until } from "./stack.ts";
import type { Stack } from "./stack.ts";

const url = "https://worker.test/webhooks/llm-gateway";
async function start(stack: Stack, sessionId = randomUUID()) {
  await stack.call("/start", { sessionId, input });
  const job = await until(async () => [...stack.gateway.jobs.values()].find(job => job.clientContext.sessionId === sessionId));
  await until(async () => { const s = await stack.call("/snapshot", { sessionId }); return s.operations.length ? s : undefined; });
  return { sessionId, job };
}
function completed(stack: Stack, sessionId: string) {
  return until(async () => { const s = await stack.call("/snapshot", { sessionId }); return s.results.length ? s : undefined; });
}
function submission() {
  return { destination: { routeKey: "test-v1", sessionId: "manual" }, submission: { operationId: "op", submissionId: "sub",
    request: { provider: "llm", type: "generate", version: "v1", input: structuredClone(input) } } };
}

test("stateless submit and signed callback work with no D1 or Queue bindings, and duplicate delivery is safe", async () => {
  const stack = await startStack();
  try {
    const { sessionId, job } = await start(stack);
    assert.equal(stack.gateway.posts, 1); assert.equal(stack.gateway.details, 0);
    assert.deepEqual(job.clientContext, { routeKey: "test-v1", sessionId,
      operationId: job.clientContext.operationId, submissionId: job.clientContext.operationId });
    assert.match(job.idempotencyKey, /^ma-v1:[a-f0-9]{64}$/);
    stack.gateway.finish(job);
    const notification = event(job);
    assert.equal((await stack.llm.fetch(url, signed(notification))).status, 204);
    assert.equal((await stack.call("/snapshot", { sessionId })).admittedCompletions, 1, "204 follows durable inbox admission");
    const snapshot = await completed(stack, sessionId);
    assert.deepEqual(snapshot.operations[0].outcome, { status: "succeeded", result: { gatewayJobId: job.id, response } });
    assert.equal(snapshot.outbox.length, 0);
    assert.equal(stack.gateway.details, 0);
    assert.equal((await stack.llm.fetch(url, signed(notification))).status, 204);
    assert.equal((await stack.llm.fetch(url, signed(event(job)))).status, 204, "manual redelivery with a new event ID deduplicates by operation");
    assert.equal((await completed(stack, sessionId)).results.length, 1);
    assert.equal(stack.gateway.details, 0, "duplicates do not fetch a gateway result either");
    assert.equal((await stack.llm.fetch("https://worker.test/v1/jobs", { method: "POST" })).status, 404);
  } finally { await stack.app.dispose(); }
});

test("lost gateway acceptance replays the same context and key, without another job", async () => {
  const gateway = new FakeGateway(); gateway.loseAcceptance = 1;
  const stack = await startStack(gateway);
  try {
    await start(stack);
    assert.equal(gateway.posts, 2); assert.equal(gateway.jobs.size, 1);
  } finally { await stack.app.dispose(); }
});

test("early callback is durably admitted before POST returns, and terminal replay does not duplicate completion", async () => {
  const gateway = new FakeGateway(), stack = await startStack(gateway);
  let early = false;
  gateway.onAccepted = async job => {
    gateway.finish(job);
    assert.equal((await stack.llm.fetch(url, signed(event(job)))).status, 204);
    early = (await stack.call("/snapshot", { sessionId: job.clientContext.sessionId })).admittedCompletions === 1;
  };
  try {
    const { sessionId } = await start(stack);
    assert.equal(early, true);
    const s = await completed(stack, sessionId);
    assert.equal(s.results.length, 1); assert.equal(s.progress.blocked, false); assert.equal(gateway.posts, 1);
  } finally { await stack.app.dispose(); }
});

test("terminal submission replay returns the result even when there is no callback", async () => {
  const gateway = new FakeGateway(); gateway.loseAcceptance = 1;
  gateway.onAccepted = async job => { gateway.finish(job); };
  const stack = await startStack(gateway);
  try {
    const { sessionId, job } = await start(stack);
    const s = await completed(stack, sessionId);
    assert.equal(s.operations[0].outcome.status, "succeeded");
    assert.equal(gateway.jobs.size, 1); assert.equal(gateway.posts, 2); assert.equal(gateway.details, 1);
    assert.equal((await stack.llm.fetch(url, signed(event(job)))).status, 204);
    assert.equal((await completed(stack, sessionId)).results.length, 1);
  } finally { await stack.app.dispose(); }
});

test("terminal detail read errors remain uncertain, never definitive submission rejections", async () => {
  const gateway = new FakeGateway(), stack = await startStack(gateway);
  const request = submission();
  try {
    const accepted = await stack.call("/submit", request);
    gateway.finish(gateway.jobs.get(accepted.jobId)!); gateway.detailError = 404;
    await assert.rejects(stack.call("/submit", request), /404/);
    gateway.detailError = undefined;
    assert.equal((await stack.call("/submit", request)).status, "completed");
    assert.equal(gateway.jobs.size, 1);
  } finally { await stack.app.dispose(); }
});

test("gateway redelivery handles DO failure, lost receipt and invalid acknowledgement without duplicate events", async () => {
  const stack = await startStack();
  try {
    const { sessionId, job } = await start(stack); stack.gateway.finish(job);
    const notification = event(job);
    await stack.call("/faults", { sessionId, fail: 1, lose: 1, invalid: 1 });
    assert.equal((await stack.llm.fetch(url, signed(notification))).status, 503);
    assert.equal((await stack.call("/snapshot", { sessionId })).admittedCompletions, 0);
    assert.equal((await stack.llm.fetch(url, signed(notification))).status, 503);
    assert.equal((await stack.call("/snapshot", { sessionId })).admittedCompletions, 1);
    assert.equal((await stack.llm.fetch(url, signed(notification))).status, 503);
    assert.equal((await stack.llm.fetch(url, signed(notification))).status, 204);
    assert.equal((await completed(stack, sessionId)).results.length, 1); assert.equal(stack.gateway.posts, 1);
  } finally { await stack.app.dispose(); }
});

test("concurrent callbacks only admit one completion", async () => {
  const stack = await startStack();
  try {
    const { sessionId, job } = await start(stack); stack.gateway.finish(job);
    const notification = event(job);
    const replies = await Promise.all(Array.from({ length: 4 }, () => stack.llm.fetch(url, signed(notification))));
    assert.deepEqual(replies.map(r => r.status), [204, 204, 204, 204]);
    assert.equal((await completed(stack, sessionId)).results.length, 1);
  } finally { await stack.app.dispose(); }
});

test("webhook signatures cover routing context, enforce freshness and support signing-secret rotation", async () => {
  const stack = await startStack();
  try {
    const { job } = await start(stack); stack.gateway.finish(job);
    const notification = event(job);
    assert.equal((await stack.llm.fetch(url, signed(notification, "wrong"))).status, 401);
    assert.equal((await stack.llm.fetch(url, signed(notification, undefined, "1"))).status, 401);
    const tampered = signed(notification); tampered.body = tampered.body.replace(notification.clientContext.sessionId, "another-session");
    assert.equal((await stack.llm.fetch(url, tampered)).status, 401);
    const tamperedResult = signed(notification); tamperedResult.body = tamperedResult.body.replace("Hello", "Forged result");
    assert.equal((await stack.llm.fetch(url, tamperedResult)).status, 401, "the signature authenticates the inline result too");
    const mismatch = signed(notification); mismatch.headers["X-LLM-Gateway-Event-Id"] = randomUUID();
    assert.equal((await stack.llm.fetch(url, mismatch)).status, 401);
    assert.equal(stack.gateway.details, 0);
    assert.equal((await stack.llm.fetch(url, signed(notification, "previous-secret"))).status, 204);
    assert.equal((await stack.llm.fetch(url, { method: "GET" })).status, 405);
  } finally { await stack.app.dispose(); }
});

test("missing/malformed context is rejected, and unavailable routes remain retryable without fetching results", async () => {
  const stack = await startStack();
  try {
    const { job } = await start(stack); stack.gateway.finish(job);
    const notification = event(job);
    for (const context of [undefined, null, [], {}, { ...notification.clientContext, url: "https://evil.test" }, { ...notification.clientContext, sessionId: "" }]) {
      assert.equal((await stack.llm.fetch(url, signed({ ...notification, clientContext: context } as never))).status, 400);
    }
    assert.equal((await stack.llm.fetch(url, signed({ ...notification, clientContext: { ...notification.clientContext, routeKey: "not-configured" } }))).status, 503);
    assert.equal(stack.gateway.details, 0);
  } finally { await stack.app.dispose(); }
});

test("gateway owns request/context conflict detection; invalid operations and routes never reach it", async () => {
  const gateway = new FakeGateway(), stack = await startStack(gateway);
  const request = submission();
  try {
    const bad = structuredClone(request); bad.submission.request.type = "other";
    assert.equal((await stack.call("/submit", bad)).status, "rejected"); assert.equal(gateway.posts, 0);
    const injected = structuredClone(request); Object.assign(injected.submission.request.input, { clientContext: {} });
    assert.equal((await stack.call("/submit", injected)).status, "rejected");
    const route = structuredClone(request); route.destination.routeKey = "unknown";
    await assert.rejects(stack.call("/submit", route), /route/); assert.equal(gateway.posts, 0);
    const accepted = await stack.call("/submit", request);
    assert.deepEqual(await stack.call("/submit", request), accepted); assert.equal(gateway.posts, 2);
    const changed = structuredClone(request); changed.submission.request.input.modelId = "different";
    await assert.rejects(stack.call("/submit", changed), /idempotency_conflict/);
    changed.submission.request.input.modelId = input.modelId; changed.destination.sessionId = "other";
    await assert.rejects(stack.call("/submit", changed), /idempotency_conflict/);
    gateway.reject = { status: 400, code: "invalid_model" };
    assert.equal((await stack.call("/submit", request)).status, "rejected");
    gateway.reject = { status: 401, code: "unauthorized" };
    await assert.rejects(stack.call("/submit", request), /401/);
    assert.equal(gateway.jobs.size, 1);
  } finally { await stack.app.dispose(); }
});

test("continuation submits its own host routing context, never inherited/caller-injected context", async () => {
  const stack = await startStack();
  try {
    const request = submission();
    const parent = await stack.call("/submit", request);
    const next = { destination: { routeKey: "test-v1", sessionId: "another" }, submission: { operationId: "op2", submissionId: "sub2",
      request: { provider: "llm", type: "generate", version: "v1", input: { previousJobId: parent.jobId, messages: input.messages } } } };
    const accepted = await stack.call("/submit", next), job = stack.gateway.jobs.get(accepted.jobId)!;
    assert.deepEqual(job.clientContext, { ...next.destination, operationId: "op2", submissionId: "sub2" });
    assert.deepEqual(job.request, { previousJobId: parent.jobId, messages: input.messages, clientContext: job.clientContext, idempotencyKey: job.idempotencyKey });
  } finally { await stack.app.dispose(); }
});

test("inline callbacks need no gateway availability; invalid outcomes and correlation are rejected", async () => {
  const gateway = new FakeGateway(), stack = await startStack(gateway);
  try {
    const { sessionId, job } = await start(stack); gateway.finish(job);
    const notification = event(job);
    for (const status of [404, 401, 503]) {
      gateway.detailError = status;
      assert.equal((await stack.llm.fetch(url, signed(notification))).status, 204);
    }
    gateway.detailErrorBody = "error".repeat(5_000);
    assert.equal((await stack.llm.fetch(url, signed(notification))).status, 204);
    gateway.detailErrorBody = undefined;
    gateway.detailError = undefined;
    for (const replacement of [
      { schemaVersion: 1 }, { schemaVersion: undefined }, { type: "job.running" }, { type: "job.failed" },
      { clientContext: null }, { response: null }, { response: undefined }, { error: undefined },
      { error: { code: "unexpected", message: "failure on success" } },
    ]) {
      assert.equal((await stack.llm.fetch(url, signed({ ...notification, ...replacement } as never))).status, 400);
    }
    assert.equal((await stack.llm.fetch(url, signed({ ...notification, jobId: randomUUID() }))).status, 503);
    assert.equal((await stack.llm.fetch(url, signed({ ...notification, clientContext: { ...notification.clientContext, sessionId: "other" } }))).status, 503);
    assert.equal((await stack.call("/snapshot", { sessionId })).admittedCompletions, 1);
    assert.equal((await stack.llm.fetch(url, signed(notification))).status, 204);
    assert.equal((await completed(stack, sessionId)).results.length, 1); assert.equal(gateway.posts, 1);
    gateway.finish(job, "failed");
    assert.equal((await stack.llm.fetch(url, signed(event(job)))).status, 503, "changed terminal result conflicts with the admitted result");
    assert.equal(gateway.details, 0);
  } finally { await stack.app.dispose(); }
});

test("failure, cancellation and oversized results deliver terminal outcomes without local persistence", async () => {
  const stack = await startStack();
  try {
    for (const status of ["failed", "cancelled", "succeeded"]) {
      const { sessionId, job } = await start(stack);
      const huge = structuredClone(response); huge.message.content[0]!.content![0]!.text = "x".repeat(2_000_000);
      stack.gateway.finish(job, status, huge);
      assert.equal((await stack.llm.fetch(url, signed(event(job)))).status, 204);
      const s = await completed(stack, sessionId), outcome = s.operations[0].outcome;
      assert.equal(outcome.status, status === "cancelled" ? "cancelled" : "failed");
      if (status === "succeeded") assert.equal(outcome.error.code, "LLM_RESULT_TOO_LARGE");
      if (status === "failed") assert.equal(outcome.error.code, "model_error");
      assert.equal((await stack.llm.fetch(url, signed(event(job)))).status, 204);
    }
    assert.equal(stack.gateway.posts, 3);
    assert.equal(stack.gateway.details, 0);
  } finally { await stack.app.dispose(); }
});

test("inline callbacks accept results above the old notification limit and bound transport before parsing", async () => {
  const stack = await startStack();
  try {
    const { sessionId, job } = await start(stack);
    const large = structuredClone(response); large.message.content[0]!.content![0]!.text = "large result ".repeat(5_000);
    stack.gateway.finish(job, "succeeded", large);
    assert.equal((await stack.llm.fetch(url, signed(event(job)))).status, 204);
    assert.deepEqual((await completed(stack, sessionId)).operations[0].outcome.result.response, large);
    // Valid timestamp/headers reach the streaming cap; no JSON parse, signature
    // verification or DO admission is possible for a body over that bound.
    const oversized = signed(event(job)); oversized.body = "x".repeat(32 * 1024 * 1024 + 1);
    assert.equal((await stack.llm.fetch(url, oversized)).status, 413);
    assert.equal((await stack.call("/snapshot", { sessionId })).admittedCompletions, 1);
    assert.equal(stack.gateway.details, 0);
  } finally { await stack.app.dispose(); }
});

test("terminal submission replay still validates fetched result and correlation", async () => {
  const gateway = new FakeGateway(), stack = await startStack(gateway);
  try {
    const request = submission(), accepted = await stack.call("/submit", request);
    const job = gateway.jobs.get(accepted.jobId)!; gateway.finish(job);
    for (const replacement of [
      { id: randomUUID() }, { idempotencyKey: "other" }, { status: "running" },
      { clientContext: { ...job.clientContext, sessionId: "other" } },
      { response: null }, { error: { code: "unexpected", message: "failed" } },
    ]) {
      gateway.detailValue = value => ({ ...value, ...replacement });
      await assert.rejects(stack.call("/submit", request));
    }
    gateway.detailError = 503; gateway.detailErrorBody = "proxy failure ".repeat(5_000);
    await assert.rejects(stack.call("/submit", request));
    gateway.detailError = undefined; gateway.detailValue = undefined;
    assert.equal((await stack.call("/submit", request)).status, "completed");
    assert.equal(gateway.jobs.size, 1);
    assert.equal(gateway.details, 8);
  } finally { await stack.app.dispose(); }
});

test("worker and DO restart recover solely through gateway redelivery, including a previously lost receipt", async () => {
  const gateway = new FakeGateway(), persistPath = await mkdtemp(join(tmpdir(), "llm-stateless-test-"));
  let stack = await startStack(gateway, { persistPath });
  try {
    const { sessionId, job } = await start(stack); gateway.finish(job);
    const notification = event(job);
    await stack.app.dispose(); stack = await startStack(gateway, { persistPath });
    await stack.call("/faults", { sessionId, lose: 1 });
    assert.equal((await stack.llm.fetch(url, signed(notification))).status, 503);
    await stack.app.dispose(); stack = await startStack(gateway, { persistPath });
    assert.equal((await stack.llm.fetch(url, signed(notification))).status, 204);
    assert.equal((await completed(stack, sessionId)).results.length, 1); assert.equal(gateway.posts, 1);
  } finally { await stack.app.dispose(); }
});

test("inline callback has one deadline for DO admission; late admission remains deduplicated", async () => {
  const gateway = new FakeGateway(), stack = await startStack(gateway);
  try {
    const { sessionId, job } = await start(stack); gateway.finish(job);
    await stack.call("/faults", { sessionId, delay: 9_000 });
    const began = Date.now();
    assert.equal((await stack.llm.fetch(url, signed(event(job)))).status, 503);
    const elapsed = Date.now() - began;
    assert.ok(elapsed >= 7_800 && elapsed < 9_500, `Shared 8s deadline took ${elapsed} ms`);
    gateway.onDetail = undefined;
    await stack.call("/faults", { sessionId });
    assert.equal((await stack.llm.fetch(url, signed(event(job)))).status, 204);
    await sleep(1_100);
    assert.equal((await completed(stack, sessionId)).results.length, 1);
    assert.equal(gateway.details, 0);
  } finally { await stack.app.dispose(); }
});

test("deployment config has no LLM persistence, Queue or polling resources", async () => {
  const config = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.doesNotMatch(config, /d1_databases|queue|LLM_DB|COMPLETIONS/);
  assert.match(config, /"crons":\s*\[\]/);
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /async (get|queue|scheduled)\(/);
});
