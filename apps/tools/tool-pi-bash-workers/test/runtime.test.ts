import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, Log, LogLevel } from "miniflare";
import { randomUUID } from "node:crypto";
import { bundle, auth, until, input } from "./stack.ts";
import type { Snapshot } from "./stack.ts";
import type { BashResult } from "@managed-agents/contracts";

test("real new gateway, Machine DO, daemon/core, bash worker and durable Session DO", {timeout:120000}, async t => {
  const root=fileURLToPath(new URL("../../../../",import.meta.url));
  await promisify(execFile)("cargo",["build","--manifest-path",join(root,"execution/Cargo.toml"),"-p","process-execution-daemon"],{maxBuffer:2_000_000});
  const dir=await mkdtemp(join(tmpdir(),"pi-bash-new-stack-")),state=join(dir,"state");
  const [gateway,bash,host]=await Promise.all([bundle("../../../../execution/apps/execution-gateway/src/index.ts"),bundle("../src/index.ts"),bundle("./fixture.ts")]);
  const backend="bash-test-backend-secret-at-least-32-bytes",common={modules:true,compatibilityDate:"2026-07-30",compatibilityFlags:["nodejs_compat"]};
  const app=new Miniflare({log:new Log(LogLevel.ERROR),workers:[
    {...common,name:"gateway",script:gateway,bindings:{MANAGEMENT_SECRET:backend,CREDENTIAL_SIGNING_SECRET:auth,ROUTING_SIGNING_SECRET:auth+"routing",CALLBACK_TIMEOUT_MS:"30000",CALLBACK_ROUTES:JSON.stringify({"tool-pi-bash-v1":"BASH_EVENTS"})},durableObjects:{MACHINES:{className:"Machine",useSQLite:true}},serviceBindings:{BASH_EVENTS:{name:"bash",entrypoint:"PiBashCallbacks"}}},
    {...common,name:"bash",script:bash,bindings:{EXECUTION_GATEWAY_URL:"https://gateway.test",SESSION_ROUTES:JSON.stringify({"test-v1":"SESSIONS"})},durableObjects:{SESSIONS:{className:"TestSession",scriptName:"host"}},outboundService:{name:"gateway"}},
    {...common,name:"host",script:host,serviceBindings:{BASH:{name:"bash",entrypoint:"PiBash"},BASH_EVENTS:{name:"bash",entrypoint:"PiBashCallbacks"}},durableObjects:{SESSIONS:{className:"TestSession",useSQLite:true}}},
  ]});
  const binary=join(root,"execution/target/debug/process-execution-daemon");
  let daemon:ReturnType<typeof spawn>|undefined, logs="";
  t.after(async()=>{if(daemon && daemon.exitCode===null){const done=new Promise(r=>daemon!.once("exit",r));daemon.kill("SIGTERM");await done;}await app.dispose();await rm(dir,{recursive:true,force:true});});
  const address=(await app.ready).origin;
  const registration=spawn(binary,["--state-dir",state,"register","--gateway-url",address,"--name","Bash test","--allow-insecure-loopback"],{stdio:["pipe","pipe","pipe"]});
  registration.stdin.end(backend+"\n");registration.stderr.on("data",b=>logs+=b);assert.equal(await new Promise(r=>registration.once("exit",r)),0,logs);
  const credential=JSON.parse(await readFile(join(state,"credential.json"),"utf8")),machineId=credential.machine_id;
  daemon=spawn(binary,["--state-dir",state,"run"],{stdio:["ignore","ignore","pipe"]});daemon.stderr!.on("data",b=>logs+=b);
  const api=await app.getWorker("gateway"), hostApi=await app.getWorker("host");
  async function request(path:string,method="GET",body?:unknown,token=backend){const r=await api.fetch("https://gateway.test"+path,{method,headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});assert.ok(r.ok,await r.clone().text());return r.json() as Promise<any>;}
  let executionSecret = JSON.parse(await readFile(join(state,"execution-secret.json"),"utf8")).executionSecret;
  const row=await until(async()=>{const r=(await request(`/v1/machines/${machineId}`, "GET", undefined, executionSecret)).machine;return r.connectionStatus==="ready"?r:undefined;});
  const runtimeGeneration=row.runtimeGeneration;
  async function call(path:string,body:unknown){const r=await hostApi.fetch("https://host"+path,{method:"POST",body:JSON.stringify(body)});assert.ok(r.ok,await r.clone().text());return r.json() as Promise<any>;}
  async function bashViaTool(command: string, timeout?: number) {
    const sessionId = randomUUID(), execution = {token: executionSecret, runtimeGeneration };
    const toolInput = {machineId, cwd: dir, command, ...(timeout === undefined ? {} : {timeout})};
    const started = Date.now();
    await call("/start", {sessionId, execution, input: toolInput});
    const submissionMs = Date.now() - started;
    const snapshot = await until(async () => {const s = await call("/snapshot", {sessionId}) as Snapshot; return s.results.length ? s : undefined;}, 20000);
    const outcome = snapshot.operations[0]!.outcome; assert.equal(outcome?.status, "succeeded", logs + JSON.stringify(outcome));
    return {sessionId, execution, toolInput, snapshot, submissionMs, result: (outcome as any).result as BashResult};
  }
  const first = await bashViaTool("printf 'नमस्ते 🌍\\n'; printf 'stderr\\n' >&2; printf x >> replay-count");
  assert.equal(first.result.isError, false); assert.match(first.result.content[0]!.text, /नमस्ते 🌍/); assert.match(first.result.content[0]!.text, /stderr/);
  const saved = await readFile(first.result.details.fullOutputPath, "utf8");
  assert.match(saved, /नमस्ते 🌍/); assert.equal((await stat(first.result.details.fullOutputPath)).mode & 0o777, 0o600);
  assert.equal(first.result.details.outputFile.complete, true);
  // Rotation is owned by the caller; the tool must use the token on each RPC.
  const oldSecret = executionSecret;
  const rotated = await request(`/v1/machines/${machineId}/secrets/rotate`, "POST", { kind: "execution", expectedVersion: 1 });
  executionSecret = rotated.secret;
  await assert.rejects(call("/submit", {
    destination: { routeKey: "test-v1", sessionId: randomUUID() },
    execution: { token: oldSecret, runtimeGeneration },
    submission: { operationId: "revoked-attempt", submissionId: "revoked-attempt",
      request: { provider: "tool-pi-bash", type: "bash", version: "v1", input: { ...input, machineId, cwd: dir } } },
  }), /INVALID_SECRET/);
  first.execution.token = executionSecret;
  const operation = first.snapshot.operations[0]!;
  await call("/submit", {destination:{routeKey:"test-v1",sessionId:first.sessionId},execution:first.execution,
    submission:{operationId:operation.operationId,submissionId:operation.submissionId,request:{provider:"tool-pi-bash",type:"bash",version:"v1",input:first.toolInput}}});
  assert.equal(await readFile(join(dir, "replay-count"), "utf8"), "x");
  const failed = await bashViaTool("printf failed; exit 7"); assert.equal(failed.result.isError, true); assert.equal(failed.result.details.exitCode, 7);
  const timeout = await bashViaTool("printf before; sleep 1; printf bad > should-not-exist", 0.05);
  assert.equal(timeout.result.isError, true); assert.equal(timeout.result.details.timedOut, true); assert.match(timeout.result.content[0]!.text, /before/);
  const many = await bashViaTool("for ((i=0;i<3000;i++)); do printf '%s\\n' \"$i\"; done");
  assert.equal(many.result.details.truncation.outputLines, 2000); assert.match(many.result.content[0]!.text, /2999/);
  assert.equal((await readFile(many.result.details.fullOutputPath, "utf8")).split("\n").length, 3001);
  const bytes = await bashViaTool("printf '%080000d' 0"); assert.ok(bytes.result.details.truncation.upstreamTruncated);
  assert.equal(bytes.result.details.truncation.outputBytes, 51200); assert.equal((await stat(bytes.result.details.fullOutputPath)).size, 80000);
  const empty = await bashViaTool(""); assert.equal(empty.result.content[0]!.text, "(no output)");
  const long = await bashViaTool("sleep 8; printf delayed");
  assert.ok(long.submissionMs < 7000); assert.equal(long.result.content[0]!.text, "delayed");
  await assert.rejects(stat(join(dir, "should-not-exist")), {code: "ENOENT"});
});
