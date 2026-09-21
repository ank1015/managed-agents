import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueMachineSecret } from "@managed-agents/execution-gateway-protocol";
import type { ProviderSubmitResult, BashInput, BashResult } from "@managed-agents/contracts";
import { FakeGateway, startStack, input, execution, event, until, auth, machineId, generationId, runResult } from "./stack.ts";
import type { Stack } from "./stack.ts";

async function submission() {
  return { execution: await execution("direct"), destination: { routeKey: "test-v1", sessionId: "direct" },
    submission: { operationId: "op", submissionId: "op", request: { provider: "tool-pi-bash", type: "bash", version: "v1", input: structuredClone(input) as BashInput } } };
}
async function start(s: Stack, value: BashInput = input) {
  const sessionId = randomUUID(); await s.call("/start", { sessionId, input: value });
  return { sessionId, job: await until(async () => [...s.gateway.jobs.values()].find(j => j.destination.sessionId === sessionId)) };
}
async function outcome(s: Stack, sessionId: string) {
  const state = await until(async () => { const r = await s.call("/snapshot", { sessionId }); return r.results.length ? r : undefined; });
  return state.operations[0]!.outcome!;
}
async function result(s: Stack, sessionId: string): Promise<BashResult> {
  const value = await outcome(s, sessionId); assert.equal(value.status, "succeeded");
  if (value.status !== "succeeded") throw Error("Expected tool result");
  return value.result as BashResult;
}
test("new operation, private callback and durable deduplicated completion", async t => {
  const s = await startStack(); t.after(() => s.app.dispose());
  const { sessionId, job } = await start(s);
  assert.deepEqual(job.body.operation, { operation: "execution.exec", params: { cwd: input.cwd, env: {}, tty: false, command: {type: "shell", script: input.command, shell: {executable: "bash", kind: "bash"}, login: false}, completion: {mode: "finished", timeout_ms: 1250}, output: {strategy: "tail", max_bytes: 65536, retain_full_output: true} } });
  assert.ok(!JSON.stringify(job.body.callback.context).includes("token"));
  s.gateway.finish(job); const completion = await event(job);
  await s.call("/faults", { sessionId, fail: 1 }); await assert.rejects(s.call("/event", completion));
  assert.equal((await s.call("/snapshot", { sessionId })).admittedCompletions, 0);
  const receipt = await s.call("/event", completion);
  assert.deepEqual(receipt, { status: "accepted", deliveryId: completion.deliveryId, requestId: job.id, requestHash: job.requestHash, resultHash: completion.resultHash });
  assert.equal((await result(s, sessionId)).isError, false);
  assert.equal((await result(s, sessionId)).details.requestId, job.id);
  await Promise.all([s.call("/event", completion), s.call("/event", completion)]);
  assert.equal((await s.call("/snapshot", { sessionId })).results.length, 1);
  assert.equal(s.gateway.details, 0);
  assert.equal((await s.bash.fetch("https://tool/webhooks/execution-gateway", { method: "POST" })).status, 404);
  await assert.rejects(s.call("/callback-submit", await submission()));
});
test("stable identity survives lost acceptance and execution secret rotation; changed input conflicts", async t => {
  const s = await startStack(); t.after(() => s.app.dispose()); const value = await submission();
  s.gateway.loseAcceptance = 1; await assert.rejects(s.call("/submit", value));
  const first = [...s.gateway.jobs.values()][0]!; const prior = structuredClone(first.body);
  value.execution.token = await issueMachineSecret(auth, machineId, "execution", 2);
  assert.equal((await s.call<ProviderSubmitResult>("/submit", value)).status, "accepted");
  assert.deepEqual(first.body, prior); assert.equal(s.gateway.jobs.size, 1);
  s.gateway.acceptance = r => ({ ...r, requestHash: "0".repeat(64) }); await assert.rejects(s.call("/submit", value));
  s.gateway.acceptance = undefined; value.submission.request.input.command = "changed";
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
  for (const [status, code, retryable, uncertain] of [[409,"MACHINE_OFFLINE",true,false],[401,"INVALID_TOKEN",false,false],[409,"RUNTIME_CHANGED",false,false],[409,"REQUEST_CONFLICT",false,true],[429,"BashACITY",true,false],[400,"SUBMISSION_UNCERTAIN",false,true]] as const) {
    s.gateway.reject = { status, code, retryable, uncertain }; await assert.rejects(s.call("/submit", value));
  }
  s.gateway.reject = { status: 400, code: "INVALID_REQUEST", retryable: false, uncertain: false };
  assert.equal((await s.call<ProviderSubmitResult>("/submit", value)).status, "rejected");
});
test("early completion, tampering, lost and invalid durable receipts", async t => {
  const s = await startStack(); t.after(() => s.app.dispose());
  s.gateway.onAccepted = async job => { s.gateway.finish(job); await s.call("/event", await event(job)); };
  const { sessionId, job } = await start(s); assert.equal((await result(s, sessionId)).isError, false); s.gateway.onAccepted = undefined;
  const valid = await event(job);
  for (const patch of [{protocolVersion:5},{machineId:randomUUID()},{sub:"bob"},{runtimeGeneration:randomUUID()},{requestId:"wrong"},{resultHash:"0".repeat(64)},{deliveryId:"0".repeat(64)},{callback:{...valid.callback,receiver:"wrong"}}]) {
    await assert.rejects(s.call("/event", { ...valid, ...patch }));
  }
  for (const fault of [{ lose: 1 }, { invalid: 1 }]) {
    const o = await start(s); s.gateway.finish(o.job); await s.call("/faults", { sessionId: o.sessionId, ...fault });
    await assert.rejects(s.call("/event", await event(o.job))); await s.call("/event", await event(o.job));
    assert.equal((await result(s, o.sessionId)).isError, false);
  }
});
test("native errors and uncertain outcomes remain distinct", async t => {
  const s = await startStack(); t.after(() => s.app.dispose());
  for (const code of ["not_found", "io", "invalid_argument", "resource_limit"]) {
    const { sessionId, job } = await start(s); s.gateway.fileError(job, code, "Expected filesystem error");
    await s.call("/event", await event(job)); assert.equal((await outcome(s, sessionId)).status, "failed");
  }
  const { sessionId, job } = await start(s); s.gateway.fileError(job, "DAEMON_RESTARTED", "stopped", true);
  await s.call("/event", await event(job)); const failed = await outcome(s, sessionId);
  assert.equal(failed.status, "failed"); if (failed.status === "failed") assert.equal(failed.error.code, "BASH_EXECUTION_UNKNOWN");
});
test("completion admission survives Session DO restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bash-session-")), gateway = new FakeGateway();
  let s = await startStack(gateway, { persistPath: dir });
  try {
    const { sessionId, job } = await start(s); gateway.finish(job); const completion = await event(job);
    await s.call("/event", completion); await result(s, sessionId); await s.app.dispose();
    s = await startStack(gateway, { persistPath: dir }); await s.call("/event", completion);
    assert.equal((await s.call("/snapshot", { sessionId })).results.length, 1);
  } finally { await s.app.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test("known failures finish as tool errors; lost execution remains a failed operation", async t => {
  const s = await startStack(); t.after(() => s.app.dispose());
  for (const [reason, code] of [["exited", 7], ["timed_out", null], ["terminated", null], ["start_failed", null], ["lost", null]] as const) {
    const {sessionId, job} = await start(s); s.gateway.finish(job, runResult("partial", reason, code));
    await s.call("/event", await event(job));
    if (reason === "lost") assert.equal((await outcome(s, sessionId)).status, "failed");
    else { const r = await result(s, sessionId); assert.equal(r.isError, true); assert.match(r.content[0]!.text, /partial/); }
  }
});
test("running and malformed native receipts cannot finish a bash invocation", async t => {
  const s = await startStack(); t.after(() => s.app.dispose()); const {sessionId, job} = await start(s);
  for (const patch of [{state: "running", session_id: 123}, {output: "x".repeat(65537)}, {artifact: null}]) {
    s.gateway.finish(job, {...runResult(), ...patch}); await assert.rejects(s.call("/event", await event(job)));
  }
  assert.equal((await s.call("/snapshot", {sessionId})).admittedCompletions, 0);
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
    assert.equal((sent.body as any).callback.receiver, "tool-pi-bash-v1");
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
