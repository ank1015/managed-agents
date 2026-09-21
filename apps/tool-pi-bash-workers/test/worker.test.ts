import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { FakeGateway, startStack, input, runResult, event, signed, until } from "./stack.ts";
import type { Stack } from "./stack.ts";

const url = "https://callbacks/webhooks/execution-gateway";
async function start(stack: Stack, value = input) {
  const sessionId = randomUUID();
  await stack.call("/start", { sessionId, input: value });
  const job = await until(async () => [...stack.gateway.jobs.values()].find(j => j.clientContext.sessionId === sessionId));
  await until(async () => { const s = await stack.call("/snapshot", { sessionId }); return s.operations.length ? s : undefined; });
  return { sessionId, job };
}
function completed(stack: Stack, sessionId: string) {
  return until(async () => { const s = await stack.call("/snapshot", { sessionId }); return s.results.length ? s : undefined; });
}
function submission() {
  return { destination: { routeKey: "test-v1", sessionId: "manual" }, submission: { operationId: "op", submissionId: "sub",
    request: { provider: "tool-pi-bash", type: "bash", version: "v1", input: structuredClone(input) } } };
}

test("stateless submit and inline callback wait for DO admission with no D1, Queue or gateway GET", async () => {
  const stack = await startStack();
  try {
    const { sessionId, job } = await start(stack);
    assert.equal(stack.gateway.posts, 1);
    assert.deepEqual(job.clientContext, { receiver: "tool-pi-bash-v1", routeKey: "test-v1", sessionId,
      operationId: job.clientContext.operationId, submissionId: job.clientContext.operationId,
      machineId: input.machineId, timeoutSeconds: 1.25 });
    assert.match(job.idempotencyKey, /^pi-bash-v1:[a-f0-9]{64}$/);
    assert.equal(job.request.params.timeout_ms, 1250);
    assert.equal(job.request.params.cwd, input.cwd);
    assert.equal(job.request.params.command.script, input.command);
    assert.equal(job.request.params.max_output_bytes, 65536);
    stack.gateway.finish(job, "succeeded", runResult(job.idempotencyKey, "x".repeat(100_000)));
    stack.gateway.detailError = 503; // Inline delivery is independent of the result endpoint.
    const notification = event(job);
    assert.equal((await stack.callbacks.fetch(url, signed(notification))).status, 204);
    assert.equal((await stack.call("/snapshot", { sessionId })).admittedCompletions, 1);
    const s = await completed(stack, sessionId), result = s.operations[0].outcome.result;
    assert.equal(result.isError, false); assert.equal(result.details.fullOutputPath, "/machine/outputs/run.log");
    assert.equal(result.details.truncation.outputBytes, 50 * 1024);
    assert.equal((await stack.callbacks.fetch(url, signed(notification))).status, 204);
    assert.equal((await stack.callbacks.fetch(url, signed(event(job)))).status, 204);
    assert.equal((await completed(stack, sessionId)).results.length, 1);
    assert.equal(stack.gateway.details, 0); assert.equal(stack.gateway.lookups, 0);
    assert.equal((await stack.bash.fetch("https://bash/v1/jobs", { method: "POST" })).status, 404);
    await assert.rejects(stack.call("/callback-submit", submission()));
  } finally { await stack.app.dispose(); }
});

test("lost submission acceptance replays the same gateway job and context", async () => {
  const gateway = new FakeGateway(); gateway.loseAcceptance = 1;
  const stack = await startStack(gateway);
  try { await start(stack); assert.equal(gateway.posts, 2); assert.equal(gateway.jobs.size, 1); }
  finally { await stack.app.dispose(); }
});

test("early callback reaches DO before POST returns without a Queue or duplicate completion", async () => {
  const gateway = new FakeGateway(), stack = await startStack(gateway);
  let early = false;
  gateway.onAccepted = async job => {
    gateway.finish(job);
    assert.equal((await stack.callbacks.fetch(url, signed(event(job)))).status, 204);
    early = (await stack.call("/snapshot", { sessionId: job.clientContext.sessionId })).admittedCompletions === 1;
  };
  try {
    const { sessionId } = await start(stack);
    assert.equal(early, true); assert.equal((await completed(stack, sessionId)).results.length, 1);
    assert.equal(gateway.posts, 1); assert.equal(gateway.details, 1, "already-terminal POST replay path may fetch detail");
  } finally { await stack.app.dispose(); }
});

test("terminal submission replay recovers results without callbacks; bad detail remains uncertain", async () => {
  const gateway = new FakeGateway(), stack = await startStack(gateway);
  try {
    const request = submission(), accepted = await stack.call("/submit", request), job = gateway.jobs.get(accepted.jobId)!;
    gateway.finish(job);
    for (const patch of [
      { id: randomUUID() }, { machineId: randomUUID() }, { idempotencyKey: "other" },
      { status: "waiting_response" }, { clientContext: { ...job.clientContext, sessionId: "other" } },
      { response: null }, { runtimeGenerationId: randomUUID() },
    ]) {
      gateway.detailValue = row => ({ ...row, ...patch });
      await assert.rejects(stack.call("/submit", request));
    }
    gateway.detailValue = undefined; gateway.detailError = 404;
    await assert.rejects(stack.call("/submit", request));
    gateway.detailError = undefined;
    assert.equal((await stack.call("/submit", request)).status, "completed");
    assert.equal(gateway.jobs.size, 1); assert.equal(gateway.lookups, 0);
  } finally { await stack.app.dispose(); }
});

test("lost terminal acceptance completes via source replay even with no callback", async () => {
  const gateway = new FakeGateway(); gateway.loseAcceptance = 1;
  gateway.onAccepted = async job => { gateway.finish(job); };
  const stack = await startStack(gateway);
  try {
    const { sessionId } = await start(stack);
    assert.equal((await completed(stack, sessionId)).results.length, 1);
    assert.equal(gateway.posts, 2); assert.equal(gateway.details, 1); assert.equal(gateway.jobs.size, 1);
  } finally { await stack.app.dispose(); }
});

test("DO outage, lost receipt and invalid receipt propagate 503 through router for gateway redelivery", async () => {
  const stack = await startStack();
  try {
    const { sessionId, job } = await start(stack); stack.gateway.finish(job);
    await stack.call("/faults", { sessionId, fail: 1, lose: 1, invalid: 1 });
    const n = event(job);
    assert.equal((await stack.callbacks.fetch(url, signed(n))).status, 503);
    assert.equal((await stack.call("/snapshot", { sessionId })).admittedCompletions, 0);
    assert.equal((await stack.callbacks.fetch(url, signed(n))).status, 503);
    assert.equal((await stack.call("/snapshot", { sessionId })).admittedCompletions, 1);
    assert.equal((await stack.callbacks.fetch(url, signed(n))).status, 503);
    assert.equal((await stack.callbacks.fetch(url, signed(n))).status, 204);
    assert.equal((await completed(stack, sessionId)).results.length, 1);
    assert.equal(stack.gateway.details, 0);
  } finally { await stack.app.dispose(); }
});

test("concurrent callbacks and manual redelivery deduplicate by operation", async () => {
  const stack = await startStack();
  try {
    const { sessionId, job } = await start(stack); stack.gateway.finish(job);
    const replies = await Promise.all(Array.from({ length: 4 }, () => stack.callbacks.fetch(url, signed(event(job)))));
    assert.deepEqual(replies.map(r => r.status), [204, 204, 204, 204]);
    assert.equal((await completed(stack, sessionId)).results.length, 1);
    stack.gateway.finish(job, "failed");
    assert.equal((await stack.callbacks.fetch(url, signed(event(job)))).status, 503);
  } finally { await stack.app.dispose(); }
});

test("signature authenticates inline result and context; freshness and secret rotation remain enforced", async () => {
  const stack = await startStack();
  try {
    const { job } = await start(stack); stack.gateway.finish(job);
    const n = event(job);
    assert.equal((await stack.callbacks.fetch(url, signed(n, "wrong"))).status, 401);
    assert.equal((await stack.callbacks.fetch(url, signed(n, undefined, "1"))).status, 401);
    for (const [from, to] of [[n.clientContext.sessionId, "other"], ["SGVsbG8K", "Rm9yZ2Vk"]]) {
      const tampered = signed(n); assert.ok(tampered.body.includes(from!)); tampered.body = tampered.body.replace(from!, to!);
      assert.equal((await stack.callbacks.fetch(url, tampered)).status, 401);
    }
    assert.equal((await stack.callbacks.fetch(url, signed(n, "previous-secret"))).status, 204);
    assert.equal(stack.gateway.details, 0);
  } finally { await stack.app.dispose(); }
});

test("malformed events, routing, machine/job/run/generation correlation never get acknowledged", async () => {
  const stack = await startStack();
  try {
    const { sessionId, job } = await start(stack); stack.gateway.finish(job);
    const n = event(job);
    for (const patch of [{ schemaVersion: 2 }, { response: undefined }, { error: undefined }, { runtimeGenerationId: undefined }, { clientContext: null }]) {
      assert.equal((await stack.callbacks.fetch(url, signed({ ...n, ...patch } as never))).status, 400);
    }
    for (const patch of [
      { clientContext: { ...n.clientContext, receiver: "unknown" } },
      { clientContext: { ...n.clientContext, routeKey: "unknown" } },
      { clientContext: { ...n.clientContext, sessionId: "other" } },
      { clientContext: { ...n.clientContext, timeoutSeconds: -1 } },
      { clientContext: { ...n.clientContext, extra: true } },
      { machineId: randomUUID() }, { jobId: randomUUID() }, { idempotencyKey: "wrong" },
      { runtimeGenerationId: randomUUID() }, { response: { ...(n.response as object), request_id: randomUUID() } },
      { response: { ...(n.response as object), result: runResult("wrong-run") } },
      { response: null }, { type: "job.failed" },
    ]) assert.equal((await stack.callbacks.fetch(url, signed({ ...n, ...patch } as never))).status, 503);
    assert.equal((await stack.call("/snapshot", { sessionId })).admittedCompletions, 0);
    assert.equal((await stack.callbacks.fetch(url, signed(n))).status, 204);
    assert.equal(stack.gateway.details, 0);
  } finally { await stack.app.dispose(); }
});

test("known execution errors are tool results; gateway, protocol and unknown failures are terminal", async () => {
  const stack = await startStack();
  try {
    for (const reason of ["exited", "timed_out", "terminated", "start_failed", "lost", "failed", "unknown", "protocol"]) {
      const { sessionId, job } = await start(stack);
      if (reason === "failed" || reason === "unknown") stack.gateway.finish(job, reason);
      else if (reason === "protocol") {
        stack.gateway.finish(job, "failed"); job.error = null;
        job.response = { protocol_version: 5, request_id: job.id, generation_id: job.runtimeGenerationId,
          status: "error", error: { code: "invalid_argument", message: "Invalid execution" } };
      } else stack.gateway.finish(job, "succeeded", runResult(job.idempotencyKey, "output", reason, 7));
      if (reason === "failed") job.runtimeGenerationId = null; // Failure before machine dispatch.
      assert.equal((await stack.callbacks.fetch(url, signed(event(job)))).status, 204);
      const outcome = (await completed(stack, sessionId)).operations[0].outcome;
      const failed = ["lost", "failed", "unknown", "protocol"].includes(reason);
      assert.equal(outcome.status, failed ? "failed" : "succeeded");
      if (!failed) assert.equal(outcome.result.isError, true);
      if (["lost", "unknown"].includes(reason)) assert.equal(outcome.error.code, "BASH_EXECUTION_UNKNOWN");
    }
    assert.equal(stack.gateway.details, 0); assert.equal(stack.gateway.posts, 8);
  } finally { await stack.app.dispose(); }
});

test("gateway owns immutable submission conflicts; invalid input/routes never submit; no default timeout", async () => {
  const gateway = new FakeGateway(), stack = await startStack(gateway);
  try {
    const request = submission();
    const bad = structuredClone(request); bad.submission.request.type = "invalid";
    assert.equal((await stack.call("/submit", bad)).status, "rejected");
    const injected = structuredClone(request); Object.assign(injected.submission.request.input, { clientContext: {} });
    assert.equal((await stack.call("/submit", injected)).status, "rejected");
    const route = structuredClone(request); route.destination.routeKey = "unknown";
    await assert.rejects(stack.call("/submit", route)); assert.equal(gateway.posts, 0);
    delete (request.submission.request.input as { timeout?: number }).timeout;
    const accepted = await stack.call("/submit", request);
    assert.equal(gateway.jobs.get(accepted.jobId)!.request.params.timeout_ms, undefined);
    assert.equal(gateway.jobs.get(accepted.jobId)!.clientContext.timeoutSeconds, null);
    const replies = await Promise.all([stack.call("/submit", request), stack.call("/submit", request)]);
    assert.deepEqual(replies, [accepted, accepted]);
    for (const changed of [
      { ...request, destination: { ...request.destination, sessionId: "other" } },
      { ...request, submission: { ...request.submission, request: { ...request.submission.request,
        input: { ...request.submission.request.input, command: "different" } } } },
    ]) await assert.rejects(stack.call("/submit", changed), /idempotency_conflict/);
    gateway.reject = { status: 400, code: "invalid_argument" };
    assert.equal((await stack.call("/submit", request)).status, "rejected");
    gateway.reject = { status: 409, code: "machine_offline" };
    await assert.rejects(stack.call("/submit", request));
    gateway.reject = { status: 401, code: "unauthorized" };
    await assert.rejects(stack.call("/submit", request));
    assert.equal(gateway.jobs.size, 1);
  } finally { await stack.app.dispose(); }
});

test("worker and DO restart recover through gateway redelivery after lost receipt", async () => {
  const gateway = new FakeGateway(), persistPath = await mkdtemp(join(tmpdir(), "bash-stateless-test-"));
  let stack = await startStack(gateway, { persistPath });
  try {
    const { sessionId, job } = await start(stack); gateway.finish(job);
    const n = event(job);
    await stack.app.dispose(); stack = await startStack(gateway, { persistPath });
    await stack.call("/faults", { sessionId, lose: 1 });
    assert.equal((await stack.callbacks.fetch(url, signed(n))).status, 503);
    await stack.app.dispose(); stack = await startStack(gateway, { persistPath });
    assert.equal((await stack.callbacks.fetch(url, signed(n))).status, 204);
    assert.equal((await completed(stack, sessionId)).results.length, 1);
    assert.equal(gateway.posts, 1); assert.equal(gateway.details, 0);
  } finally { await stack.app.dispose(); }
});

test("callback has an 8s end-to-end deadline; late DO admission is safely deduplicated", async () => {
  const stack = await startStack();
  try {
    const { sessionId, job } = await start(stack); stack.gateway.finish(job);
    await stack.call("/faults", { sessionId, delay: 9000 });
    const began = Date.now();
    assert.equal((await stack.callbacks.fetch(url, signed(event(job)))).status, 503);
    assert.ok(Date.now() - began >= 7800 && Date.now() - began < 9500);
    await stack.call("/faults", { sessionId });
    assert.equal((await stack.callbacks.fetch(url, signed(event(job)))).status, 204);
    await sleep(1100);
    assert.equal((await completed(stack, sessionId)).results.length, 1);
    assert.equal(stack.gateway.details, 0);
  } finally { await stack.app.dispose(); }
});

test("bash deployment has no persistence/queue/cron or diagnostic RPC", async () => {
  const config = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.doesNotMatch(config, /d1_databases|queues|BASH_DB|COMPLETIONS/);
  assert.match(config, /"crons":\s*\[\]/);
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /async (get|queue|scheduled)\(/);
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
          request: { provider: "tool-pi-bash", type: "bash", version: "v1", input } } };
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
        const value = (await completed(stack, sessionId)).operations[0].outcome;
        assert.equal(value.status, failed ? "failed" : "succeeded");
        if (failed) assert.equal(value.error.code, "invalid_argument");
        else assert.equal(value.result.isError, false);
        const replay = await stack.call("/submit", request);
        assert.equal(replay.status, "completed");
        if (replay.status !== "completed") throw new Error("Expected terminal replay");
        assert.deepEqual(replay.outcome, value);
      }
    }
    assert.equal(stack.gateway.jobs.size, 4);
  } finally { await stack.app.dispose(); }
});
