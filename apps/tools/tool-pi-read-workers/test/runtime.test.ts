import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm, symlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Request as WorkerRequest } from "miniflare";
import { Miniflare, Log, LogLevel } from "miniflare";
import { randomUUID } from "node:crypto";
import { bundle, auth, until, input, FakeImages, png, imageAccountId } from "./stack.ts";
import type { Snapshot } from "./stack.ts";
import type { ReadResult } from "@managed-agents/contracts";

test("real new gateway, Machine DO, daemon/core, read worker and durable Session DO", {timeout:120000}, async t => {
  const root=fileURLToPath(new URL("../../../../",import.meta.url));
  await promisify(execFile)("cargo",["build","--manifest-path",join(root,"execution/Cargo.toml"),"-p","process-execution-daemon"],{maxBuffer:2_000_000});
  const dir=await mkdtemp(join(tmpdir(),"pi-read-new-stack-")),state=join(dir,"state");
  const [gateway,read,host]=await Promise.all([bundle("../../../../execution/apps/execution-gateway/src/index.ts"),bundle("../src/index.ts"),bundle("./fixture.ts")]);
  const backend="read-test-backend-secret-at-least-32-bytes",common={modules:true,compatibilityDate:"2026-07-30",compatibilityFlags:["nodejs_compat"]};
  const images = new FakeImages();
  const app: Miniflare = new Miniflare({log:new Log(LogLevel.ERROR),workers:[
    {...common,name:"gateway",script:gateway,bindings:{MANAGEMENT_SECRET:backend,CREDENTIAL_SIGNING_SECRET:auth,ROUTING_SIGNING_SECRET:auth+"routing",CALLBACK_TIMEOUT_MS:"30000",CALLBACK_ROUTES:JSON.stringify({"tool-pi-read-v1":"READ_EVENTS"})},durableObjects:{MACHINES:{className:"Machine",useSQLite:true}},serviceBindings:{READ_EVENTS:{name:"read",entrypoint:"PiReadCallbacks"}}},
    {...common,name:"read",script:read,bindings:{EXECUTION_GATEWAY_URL:"https://gateway.test",SESSION_ROUTES:JSON.stringify({"test-v1":"SESSIONS"}), CLOUDFLARE_IMAGES_ACCOUNT_ID: imageAccountId, CLOUDFLARE_IMAGES_API_TOKEN: "images-key", CLOUDFLARE_IMAGES_VARIANT: "piread"},durableObjects:{SESSIONS:{className:"TestSession",scriptName:"host"}},outboundService: async (request: WorkerRequest) => new URL(request.url).hostname === "api.cloudflare.com" ? images.fetch(request) : (await app.getWorker("gateway")).fetch(request)},
    {...common,name:"host",script:host,serviceBindings:{READ:{name:"read",entrypoint:"PiRead"},READ_EVENTS:{name:"read",entrypoint:"PiReadCallbacks"}},durableObjects:{SESSIONS:{className:"TestSession",useSQLite:true}}},
  ]});
  const binary=join(root,"execution/target/debug/process-execution-daemon");
  let daemon:ReturnType<typeof spawn>|undefined, logs="";
  t.after(async()=>{if(daemon && daemon.exitCode===null){const done=new Promise(r=>daemon!.once("exit",r));daemon.kill("SIGTERM");await done;}await app.dispose();await rm(dir,{recursive:true,force:true});});
  const address=(await app.ready).origin;
  const registration=spawn(binary,["--state-dir",state,"register","--gateway-url",address,"--name","Read test","--allow-insecure-loopback"],{stdio:["pipe","pipe","pipe"]});
  registration.stdin.end(backend+"\n");registration.stderr.on("data",b=>logs+=b);assert.equal(await new Promise(r=>registration.once("exit",r)),0,logs);
  const credential=JSON.parse(await readFile(join(state,"credential.json"),"utf8")),machineId=credential.machine_id;
  daemon=spawn(binary,["--state-dir",state,"run"],{stdio:["ignore","ignore","pipe"]});daemon.stderr!.on("data",b=>logs+=b);
  const api=await app.getWorker("gateway"), hostApi=await app.getWorker("host");
  async function request(path:string,method="GET",body?:unknown,token=backend){const r=await api.fetch("https://gateway.test"+path,{method,headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});assert.ok(r.ok,await r.clone().text());return r.json() as Promise<any>;}
  let executionSecret = JSON.parse(await readFile(join(state,"execution-secret.json"),"utf8")).executionSecret;
  const row=await until(async()=>{const r=(await request(`/v1/machines/${machineId}`, "GET", undefined, executionSecret)).machine;return r.connectionStatus==="ready"?r:undefined;});
  const runtimeGeneration=row.runtimeGeneration;
  async function call(path:string,body:unknown){const r=await hostApi.fetch("https://host"+path,{method:"POST",body:JSON.stringify(body)});assert.ok(r.ok,await r.clone().text());return r.json() as Promise<any>;}
  async function readViaTool(path: string, paging: {offset?: number; limit?: number} = {}) {
    const sessionId = randomUUID(), execution = { token: executionSecret, runtimeGeneration };
    await call("/start", { sessionId, execution, input: { ...input, machineId, cwd: dir, path, ...paging } });
    const snapshot = await until(async () => { const s = await call("/snapshot", { sessionId }) as Snapshot; return s.results.length ? s : undefined; }, 20000);
    const outcome = snapshot.operations[0]!.outcome; assert.equal(outcome?.status, "succeeded", logs + JSON.stringify(outcome));
    return (outcome as any).result as ReadResult;
  }
  const contents = "\uFEFFनमस्ते 🌍\r\nline2\r\nline3\n";
  await writeFile(join(dir, "file.txt"), contents);
  assert.deepEqual((await readViaTool("file.txt")).content, [{ type: "text", text: contents }]);
  assert.deepEqual((await readViaTool("file.txt", { offset: 2, limit: 1 })).content,
    [{ type: "text", text: "line2\r\n\n[2 more lines in file. Use offset=3 to continue.]" }]);
  // Rotation is owned by the caller; the tool must use the token on each RPC.
  const oldSecret = executionSecret;
  const rotated = await request(`/v1/machines/${machineId}/secrets/rotate`, "POST", { kind: "execution", expectedVersion: 1 });
  executionSecret = rotated.secret;
  await assert.rejects(call("/submit", {
    destination: { routeKey: "test-v1", sessionId: randomUUID() },
    execution: { token: oldSecret, runtimeGeneration },
    submission: { operationId: "revoked-attempt", submissionId: "revoked-attempt",
      request: { provider: "tool-pi-read", type: "read", version: "v1", input: { ...input, machineId, cwd: dir, path: "file.txt" } } },
  }), /INVALID_SECRET/);
  await writeFile(join(dir, "empty"), ""); assert.equal((await readViaTool("empty")).isError, false);
  assert.equal((await readViaTool("file.txt", {offset: 50})).details.error?.code, "READ_OFFSET_OUT_OF_BOUNDS");
  assert.equal((await readViaTool("missing")).isError, true);
  await symlink("file.txt", join(dir, "alias")); assert.equal((await readViaTool("alias")).details.file?.isSymlink, true);
  await writeFile(join(dir, "big"), Buffer.alloc(5242881, 120)); assert.equal((await readViaTool("big")).isError, true);
  await writeFile(join(dir, "photo.png"), png);
  // Exercise the longer gateway + receiver budget, beyond the old eight-second deadline.
  images.uploadDelay = 8500;
  const image = await readViaTool("photo.png"); assert.equal(image.isError, false);
  assert.ok(image.content.some(p => p.type === "image" && p.url.endsWith("/piread"))); assert.deepEqual(images.uploadBytes, png);
});
