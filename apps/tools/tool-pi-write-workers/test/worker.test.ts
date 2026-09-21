import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderSubmitResult, WriteResult, WriteInput } from "@managed-agents/contracts";
import { FakeGateway, startStack, input, execution, event, until, writeReceipt, auth, machineId, generationId } from "./stack.ts";
import type { Stack } from "./stack.ts";
import { issueMachineSecret } from "@managed-agents/execution-gateway-protocol";
async function submission() { return { execution: await execution("direct"), destination: { routeKey: "test-v1", sessionId: "direct" }, submission: { operationId: "op", submissionId: "op", request: { provider: "tool-pi-write", type: "write", version: "v1", input: structuredClone(input) } } }; }
async function start(s: Stack, value: WriteInput = input) {
  const sessionId = randomUUID(); await s.call("/start", { sessionId, input: value });
  return { sessionId, job: await until(async () => [...s.gateway.jobs.values()].find(j => j.destination.sessionId === sessionId)) };
}
async function result(s: Stack, sessionId: string) {
  const state = await until(async () => { const r = await s.call("/snapshot", { sessionId }); return r.results.length ? r : undefined; });
  const outcome = state.operations[0]!.outcome; assert.equal(outcome?.status, "succeeded");
  return (outcome as unknown as { result: WriteResult }).result;
}
test("new request/token contract, exact UTF-8, Pi success and durable callback replay", async t => {
  const s = await startStack(); t.after(() => s.app.dispose());
  const content = "नमस्ते 🌍\r\n\0literal $(no shell)\n", path = "nested/file.txt";
  const { sessionId, job } = await start(s, { ...input, content, path });
  assert.deepEqual(job.body.operation, { operation: "filesystem.write", params: { path, cwd: input.cwd, content: { type: "base64", data: Buffer.from(content).toString("base64") }, create_parents: true } });
  assert.ok(!JSON.stringify(job.body.callback.context).includes("token")); assert.ok(!JSON.stringify(job.body.callback.context).includes(content));
  s.gateway.finish(job); const completion = await event(job);
  await s.call("/faults", { sessionId, fail: 1 }); await assert.rejects(s.call("/event", completion));
  assert.equal((await s.call("/snapshot", { sessionId })).admittedCompletions, 0);
  const receipt = await s.call<any>("/event", completion);
  assert.deepEqual(receipt, { status: "accepted", deliveryId: completion.deliveryId, requestId: job.id, requestHash: job.requestHash, resultHash: completion.resultHash });
  assert.deepEqual((await result(s, sessionId)).content, [{ type: "text", text: `Successfully wrote to ${path}` }]);
  assert.equal((await result(s, sessionId)).details.file?.bytesWritten, Buffer.byteLength(content));
  await Promise.all([s.call("/event", completion), s.call("/event", completion)]);
  assert.equal((await s.call("/snapshot", { sessionId })).results.length, 1);
  assert.equal(s.gateway.details, 0);
  assert.equal((await s.write.fetch("https://write/webhooks/execution-gateway", { method: "POST" })).status, 404);
  await assert.rejects(s.call("/callback-submit", await submission()));
});
test("lost and malformed acceptance remain uncertain; stable retry and secret rotation do not create new work", async t => {
  const s = await startStack(); t.after(() => s.app.dispose()); const value = await submission();
  s.gateway.loseAcceptance = 1; await assert.rejects(s.call("/submit", value));
  const first = [...s.gateway.jobs.values()][0]!; const prior = structuredClone(first.body);
  value.execution.token = await issueMachineSecret(auth, machineId, "execution", 2);
  assert.equal((await s.call<ProviderSubmitResult>("/submit", value)).status, "accepted"); assert.deepEqual(first.body, prior); assert.equal(s.gateway.jobs.size, 1);
  s.gateway.finish(first); assert.equal((await s.call<ProviderSubmitResult>("/submit", value)).status, "accepted");
  s.gateway.acceptance = r => ({ ...r, requestHash: "0".repeat(64) }); await assert.rejects(s.call("/submit", value));
  s.gateway.acceptance = undefined; value.submission.request.input.content = "changed"; await assert.rejects(s.call("/submit", value), /REQUEST_CONFLICT/);
});
test("malformed submissions and wrong machines are rejected; gateway fences stale runtimes", async t => {
  const s = await startStack(); t.after(() => s.app.dispose()); const value = await submission();
  const { execution: omitted, ...legacy } = value; assert.equal((await s.call<ProviderSubmitResult>("/submit", legacy)).status,"rejected");
  for (const change of [{machineId:randomUUID()}, {callbackUrl:"https://bad"}, {path:"x\0y"}]) {
    const v=structuredClone(value);Object.assign(v.submission.request.input,change);
    if ("machineId" in change) await assert.rejects(s.call("/submit",v)); else assert.equal((await s.call<ProviderSubmitResult>("/submit",v)).status,"rejected");
  }
  for (const patch of [{token:await issueMachineSecret(auth, randomUUID(), "execution", 1)}, {runtimeGeneration:randomUUID()}]) await assert.rejects(s.call("/submit",{...value,execution:{...value.execution,...patch}}));
  assert.equal(s.gateway.posts, 1); assert.equal(s.gateway.jobs.size, 0);
});
test("gateway retryability and uncertainty flags are preserved rather than treating every 4xx as rejection", async t => {
  const s=await startStack();t.after(()=>s.app.dispose());const value=await submission();
  for (const [status,code,retryable,uncertain] of [[409,"MACHINE_OFFLINE",true,false],[401,"INVALID_TOKEN",false,false],[409,"RUNTIME_CHANGED",false,false],[409,"REQUEST_CONFLICT",false,true],[429,"CAPACITY",true,false],[400,"SUBMISSION_UNCERTAIN",false,true]] as const) {
    s.gateway.reject={status,code,retryable,uncertain};await assert.rejects(s.call("/submit",value));
  }
  s.gateway.reject={status:400,code:"INVALID_REQUEST",retryable:false,uncertain:false};assert.equal((await s.call<ProviderSubmitResult>("/submit",value)).status,"rejected");
});
test("native errors, uncertain crash and write-receipt mismatches", async t => {
  const s=await startStack();t.after(()=>s.app.dispose());
  for (const code of ["io","not_found","invalid_argument","resource_limit"]) {
    const {sessionId,job}=await start(s);s.gateway.fileError(job,code,"Expected filesystem error");await s.call("/event",await event(job));assert.equal((await result(s,sessionId)).isError,true);
  }
  const {sessionId,job}=await start(s);s.gateway.fileError(job,"DAEMON_RESTARTED","stopped",true);await s.call("/event",await event(job));
  const state=await until(async()=>{const x=await s.call("/snapshot",{sessionId});return x.results.length?x:undefined;});const failed=state.operations[0]!.outcome;assert.equal(failed?.status,"failed");if(failed?.status==="failed")assert.equal(failed.error.code,"WRITE_OUTCOME_UNKNOWN");
  const other=await start(s);s.gateway.finish(other.job,{...writeReceipt(other.job),sha256:"0".repeat(64)});await assert.rejects(s.call("/event",await event(other.job)));assert.equal((await s.call("/snapshot",{sessionId:other.sessionId})).admittedCompletions,0);
});
test("completion correlation, hash and durable receipt are checked, including an early completion", async t => {
  const s=await startStack();t.after(()=>s.app.dispose());
  s.gateway.onAccepted=async job=>{s.gateway.finish(job);await s.call("/event",await event(job));};
  const {sessionId,job}=await start(s);assert.equal((await result(s,sessionId)).isError,false);s.gateway.onAccepted=undefined;
  const valid=await event(job);
  for(const patch of [{protocolVersion:5},{machineId:randomUUID()},{sub:"bob"},{runtimeGeneration:randomUUID()},{requestId:"wrong"},{resultHash:"0".repeat(64)},{deliveryId:"0".repeat(64)},{callback:{...valid.callback,receiver:"wrong"}}])await assert.rejects(s.call("/event",{...valid,...patch}));
  for(const fault of [{lose:1},{invalid:1}]){const o=await start(s);s.gateway.finish(o.job);await s.call("/faults",{sessionId:o.sessionId,...fault});await assert.rejects(s.call("/event",await event(o.job)));await s.call("/event",await event(o.job));assert.equal((await result(s,o.sessionId)).isError,false);}
});
test("empty content and 5 MiB limit use UTF-8 byte size", async t => {
  const s=await startStack();t.after(()=>s.app.dispose());const empty=await start(s,{...input,content:""});s.gateway.finish(empty.job);await s.call("/event",await event(empty.job));assert.equal((await result(s,empty.sessionId)).details.file?.bytesWritten,0);
  const value=await submission();value.submission.request.input.content="é".repeat(2621440);assert.equal((await s.call<ProviderSubmitResult>("/submit",value)).status,"accepted");const posts=s.gateway.posts;
  value.submission.request.input.content+="x";const tooBig=await s.call<ProviderSubmitResult>("/submit",value);assert.equal(tooBig.status,"completed");if(tooBig.status==="completed"&&tooBig.outcome.status==="succeeded")assert.equal((tooBig.outcome.result as WriteResult).isError,true);assert.equal(s.gateway.posts,posts);
});
test("session completion deduplication survives a Durable Object restart", async () => {
  const dir=await mkdtemp(join(tmpdir(),"write-session-"));const gateway=new FakeGateway();let s=await startStack(gateway,{persistPath:dir});
  try{const {sessionId,job}=await start(s);gateway.finish(job);const completion=await event(job);await s.call("/event",completion);await result(s,sessionId);await s.app.dispose();s=await startStack(gateway,{persistPath:dir});await s.call("/event",completion);assert.equal((await s.call("/snapshot",{sessionId})).results.length,1);}finally{await s.app.dispose();await rm(dir,{recursive:true,force:true});}
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
    assert.equal((sent.body as any).callback.receiver, "tool-pi-write-v1");
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
