import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm, symlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, Log, LogLevel } from "miniflare";
import { randomUUID } from "node:crypto";
import { bundle, auth, until, input } from "./stack.ts";
import type { Snapshot } from "./stack.ts";
import type { EditResult } from "@managed-agents/contracts";

test("real new gateway, Machine DO, daemon/core, edit worker and durable Session DO", {timeout:120000}, async t => {
  const root=fileURLToPath(new URL("../../../../",import.meta.url));
  await promisify(execFile)("cargo",["build","--manifest-path",join(root,"execution/Cargo.toml"),"-p","process-execution-daemon"],{maxBuffer:2_000_000});
  const dir=await mkdtemp(join(tmpdir(),"pi-edit-new-stack-")),state=join(dir,"state");
  const [gateway,edit,host]=await Promise.all([bundle("../../../../execution/apps/execution-gateway/src/index.ts"),bundle("../src/index.ts"),bundle("./fixture.ts")]);
  const backend="edit-test-backend-secret-at-least-32-bytes",common={modules:true,compatibilityDate:"2026-07-30",compatibilityFlags:["nodejs_compat"]};
  const app=new Miniflare({log:new Log(LogLevel.ERROR),workers:[
    {...common,name:"gateway",script:gateway,bindings:{MANAGEMENT_SECRET:backend,CREDENTIAL_SIGNING_SECRET:auth,ROUTING_SIGNING_SECRET:auth+"routing",CALLBACK_TIMEOUT_MS:"30000",CALLBACK_ROUTES:JSON.stringify({"tool-pi-edit-v1":"EDIT_EVENTS"})},durableObjects:{MACHINES:{className:"Machine",useSQLite:true}},serviceBindings:{EDIT_EVENTS:{name:"edit",entrypoint:"PiEditCallbacks"}}},
    {...common,name:"edit",script:edit,bindings:{SESSION_ROUTES:JSON.stringify({"test-v1":"SESSIONS"})},durableObjects:{SESSIONS:{className:"TestSession",scriptName:"host"}},outboundService:{name:"gateway"}},
    {...common,name:"host",script:host,serviceBindings:{EDIT:{name:"edit",entrypoint:"PiEdit"},EDIT_EVENTS:{name:"edit",entrypoint:"PiEditCallbacks"}},durableObjects:{SESSIONS:{className:"TestSession",useSQLite:true}}},
  ]});
  const binary=join(root,"execution/target/debug/process-execution-daemon");
  let daemon:ReturnType<typeof spawn>|undefined, logs="";
  t.after(async()=>{if(daemon && daemon.exitCode===null){const done=new Promise(r=>daemon!.once("exit",r));daemon.kill("SIGTERM");await done;}await app.dispose();await rm(dir,{recursive:true,force:true});});
  const address=(await app.ready).origin;
  const registration=spawn(binary,["--state-dir",state,"register","--gateway-url",address,"--name","Edit test","--allow-insecure-loopback"],{stdio:["pipe","pipe","pipe"]});
  registration.stdin.end(backend+"\n");registration.stderr.on("data",b=>logs+=b);assert.equal(await new Promise(r=>registration.once("exit",r)),0,logs);
  const credential=JSON.parse(await readFile(join(state,"credential.json"),"utf8")),machineId=credential.machine_id;
  daemon=spawn(binary,["--state-dir",state,"run"],{stdio:["ignore","ignore","pipe"]});daemon.stderr!.on("data",b=>logs+=b);
  const api=await app.getWorker("gateway"), hostApi=await app.getWorker("host");
  async function request(path:string,method="GET",body?:unknown,token=backend){const r=await api.fetch("https://gateway.test"+path,{method,headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});assert.ok(r.ok,await r.clone().text());return r.json() as Promise<any>;}
  let executionSecret = JSON.parse(await readFile(join(state,"execution-secret.json"),"utf8")).executionSecret;
  const row=await until(async()=>{const r=(await request(`/v1/machines/${machineId}`, "GET", undefined, executionSecret)).machine;return r.connectionStatus==="ready"?r:undefined;});
  const runtimeGeneration=row.runtimeGeneration;
  async function call(path:string,body:unknown){const r=await hostApi.fetch("https://host"+path,{method:"POST",body:JSON.stringify(body)});assert.ok(r.ok,await r.clone().text());return r.json() as Promise<any>;}
  async function editViaTool(path: string, edits: {oldText: string; newText: string}[]) {
    const sessionId = randomUUID(), execution = { gatewayUrl: "https://gateway.test", token: executionSecret, runtimeGeneration };
    await call("/start", { sessionId, execution, input: { ...input, machineId, cwd: dir, path, edits } });
    const snapshot = await until(async () => { const s = await call("/snapshot", { sessionId }) as Snapshot; return s.results.length ? s : undefined; });
    const outcome = snapshot.operations[0]!.outcome; assert.equal(outcome?.status, "succeeded", logs + JSON.stringify(outcome));
    return { sessionId, execution, snapshot, result: (outcome as any).result as EditResult };
  }
  const replace = (oldText: string, newText: string) => [{ oldText, newText }];
  await writeFile(join(dir, "file.txt"), "alpha\nbeta\n");
  const first = await editViaTool("file.txt", replace("alpha", "ALPHA"));
  assert.equal(first.result.isError, false); assert.match(first.result.details.diff!, /ALPHA/);
  await editViaTool("file.txt", replace("ALPHA", "newer"));
  // Rotation is owned by the caller; the tool must use the token on each RPC.
  const oldSecret = executionSecret;
  const rotated = await request(`/v1/machines/${machineId}/secrets/rotate`, "POST", { kind: "execution", expectedVersion: 1 });
  executionSecret = rotated.secret;
  await assert.rejects(call("/submit", {
    destination: { routeKey: "test-v1", sessionId: randomUUID() },
    execution: { gatewayUrl: "https://gateway.test", token: oldSecret, runtimeGeneration },
    submission: { operationId: "revoked-attempt", submissionId: "revoked-attempt",
      request: { provider: "tool-pi-edit", type: "edit", version: "v1", input: { ...input, machineId, cwd: dir, path: "file.txt" } } },
  }), /INVALID_SECRET/);
  first.execution.token = executionSecret;
  const operation = first.snapshot.operations[0]!;
  await call("/submit", { destination: {routeKey: "test-v1", sessionId: first.sessionId}, execution: first.execution,
    submission: {operationId: operation.operationId, submissionId: operation.submissionId,
      request: {provider: "tool-pi-edit", type: "edit", version: "v1", input: {...input, machineId, cwd: dir, path: "file.txt", edits: replace("alpha", "ALPHA")}}} });
  assert.equal(await readFile(join(dir, "file.txt"), "utf8"), "newer\nbeta\n");
  await writeFile(join(dir, "batch"), "one two");
  assert.equal((await editViaTool("batch", [{oldText:"one",newText:"two"},{oldText:"two",newText:"three"}])).result.isError, false);
  assert.equal(await readFile(join(dir, "batch"), "utf8"), "two three");
  await writeFile(join(dir, "crlf"), "\uFEFFalpha\r\nbeta\r\n");
  assert.equal((await editViaTool("crlf", replace("alpha\nbeta", "ALPHA\nBETA"))).result.isError, false);
  assert.equal(await readFile(join(dir, "crlf"), "utf8"), "\uFEFFALPHA\r\nBETA\r\n");
  await writeFile(join(dir, "duplicate"), "same same");
  assert.equal((await editViaTool("duplicate", replace("same", "new"))).result.isError, true);
  assert.equal(await readFile(join(dir, "duplicate"), "utf8"), "same same");
  assert.equal((await editViaTool("missing", replace("x", "y"))).result.isError, true);
  await symlink("file.txt", join(dir, "alias"));
  assert.equal((await editViaTool("alias", replace("newer", "linked"))).result.isError, false);
  assert.equal((await lstat(join(dir, "alias"))).isSymbolicLink(), true);
  assert.equal(await readFile(join(dir, "file.txt"), "utf8"), "linked\nbeta\n");
  await writeFile(join(dir, "big"), Buffer.alloc(5242881, 120));
  assert.equal((await editViaTool("big", replace("x", "y"))).result.isError, true);
});
