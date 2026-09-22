import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm, symlink, lstat, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, Log, LogLevel } from "miniflare";
import { randomUUID, createHash } from "node:crypto";
import { bundle, auth, until, input } from "./stack.ts";
import { codexScenarios } from "./codex-scenarios.ts";
import type { Snapshot } from "./stack.ts";
import type { ApplyPatchResult } from "@managed-agents/contracts";

test("real new gateway, Machine DO, daemon/core, apply-patch worker and durable Session DO", {timeout:120000}, async t => {
  const root=fileURLToPath(new URL("../../../../",import.meta.url));
  await promisify(execFile)("cargo",["build","--manifest-path",join(root,"execution/Cargo.toml"),"-p","process-execution-daemon"],{maxBuffer:2_000_000});
  const dir=await mkdtemp(join(tmpdir(),"codex-apply-patch-new-stack-")),state=join(dir,"state");
  const [gateway,patchWorker,host]=await Promise.all([bundle("../../../../execution/apps/execution-gateway/src/index.ts"),bundle("../src/index.ts"),bundle("./fixture.ts")]);
  const backend="apply-patch-test-backend-secret-at-least-32-bytes",common={modules:true,compatibilityDate:"2026-07-30",compatibilityFlags:["nodejs_compat"]};
  const app=new Miniflare({log:new Log(LogLevel.ERROR),workers:[
    {...common,name:"gateway",script:gateway,bindings:{MANAGEMENT_SECRET:backend,CREDENTIAL_SIGNING_SECRET:auth,ROUTING_SIGNING_SECRET:auth+"routing",CALLBACK_TIMEOUT_MS:"30000",CALLBACK_ROUTES:JSON.stringify({"tool-codex-apply-patch-v1":"APPLY_PATCH_EVENTS"})},durableObjects:{MACHINES:{className:"Machine",useSQLite:true}},serviceBindings:{APPLY_PATCH_EVENTS:{name:"apply-patch",entrypoint:"CodexApplyPatchCallbacks"}}},
    {...common,name:"apply-patch",script:patchWorker,bindings:{SESSION_ROUTES:JSON.stringify({"test-v1":"SESSIONS"})},durableObjects:{SESSIONS:{className:"TestSession",scriptName:"host"}},outboundService:{name:"gateway"}},
    {...common,name:"host",script:host,serviceBindings:{APPLY_PATCH:{name:"apply-patch",entrypoint:"CodexApplyPatch"},APPLY_PATCH_EVENTS:{name:"apply-patch",entrypoint:"CodexApplyPatchCallbacks"}},durableObjects:{SESSIONS:{className:"TestSession",useSQLite:true}}},
  ]});
  const binary=join(root,"execution/target/debug/process-execution-daemon");
  let daemon:ReturnType<typeof spawn>|undefined, logs="";
  t.after(async()=>{if(daemon && daemon.exitCode===null){const done=new Promise(r=>daemon!.once("exit",r));daemon.kill("SIGTERM");await done;}await app.dispose();await rm(dir,{recursive:true,force:true});});
  const address=(await app.ready).origin;
  const registration=spawn(binary,["--state-dir",state,"register","--gateway-url",address,"--name","Apply-patch test","--allow-insecure-loopback"],{stdio:["pipe","pipe","pipe"]});
  registration.stdin.end(backend+"\n");registration.stderr.on("data",b=>logs+=b);assert.equal(await new Promise(r=>registration.once("exit",r)),0,logs);
  const credential=JSON.parse(await readFile(join(state,"credential.json"),"utf8")),machineId=credential.machine_id;
  daemon=spawn(binary,["--state-dir",state,"run"],{stdio:["ignore","ignore","pipe"]});daemon.stderr!.on("data",b=>logs+=b);
  const api=await app.getWorker("gateway"), hostApi=await app.getWorker("host");
  async function request(path:string,method="GET",body?:unknown,token=backend){const r=await api.fetch("https://gateway.test"+path,{method,headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});assert.ok(r.ok,await r.clone().text());return r.json() as Promise<any>;}
  let executionSecret = JSON.parse(await readFile(join(state,"execution-secret.json"),"utf8")).executionSecret;
  const row=await until(async()=>{const r=(await request(`/v1/machines/${machineId}`, "GET", undefined, executionSecret)).machine;return r.connectionStatus==="ready"?r:undefined;});
  const runtimeGeneration=row.runtimeGeneration;
  async function call(path:string,body:unknown){const r=await hostApi.fetch("https://host"+path,{method:"POST",body:JSON.stringify(body)});assert.ok(r.ok,await r.clone().text());return r.json() as Promise<any>;}
  async function apply(patch: string, cwd = dir) {
    const sessionId = randomUUID(), execution = { gatewayUrl: "https://gateway.test", token: executionSecret, runtimeGeneration };
    const nativeInput = { ...input, machineId, cwd, patch };
    await call("/start", { sessionId, execution, input: nativeInput });
    const snapshot = await until(async () => { const s = await call("/snapshot", { sessionId }) as Snapshot; return s.results.length ? s : undefined; });
    const outcome = snapshot.operations[0]!.outcome;
    assert.equal(outcome?.status, "succeeded", logs + JSON.stringify(outcome));
    if (outcome?.status !== "succeeded") throw Error("Expected tool result.");
    return { sessionId, execution, nativeInput, snapshot, result: outcome.result as ApplyPatchResult };
  }
  const patch = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;
    await writeFile(join(dir, "old.txt"), "before\n");
    await writeFile(join(dir, "gone.txt"), "remove\n");
    await writeFile(join(dir, "destination.txt"), "overwritten\n");
    const text = patch("*** Add File: nested/hello world.txt\n+नमस्ते 🌍\n*** Update File: nested/hello world.txt\n@@\n-नमस्ते 🌍\n+hello 🌍\n*** Update File: old.txt\n*** Move to: destination.txt\n@@\n-before\n+after\n*** Delete File: gone.txt");
    const first = await apply(text);
    assert.equal(first.result.isError, false);
    assert.deepEqual(first.result.details.changes?.map(c => c.kind), ["add", "update", "move", "delete"]);
    assert.equal(await readFile(join(dir, "nested/hello world.txt"), "utf8"), "hello 🌍\n");
    assert.equal(await readFile(join(dir, "destination.txt"), "utf8"), "after\n");
    await assert.rejects(readFile(join(dir, "old.txt")), { code: "ENOENT" });
    await assert.rejects(readFile(join(dir, "gone.txt")), { code: "ENOENT" });
    assert.equal(first.result.details.changes?.[2]?.destinationBeforeSha256, createHash("sha256").update("overwritten\n").digest("hex"));
    assert.equal(first.result.details.changes?.[3]?.afterSha256, null);
    // Move to a new dir has absent destination-before metadata in the native receipt.
    const moved = await apply(patch("*** Update File: destination.txt\n*** Move to: new/destination.txt\n@@\n-after\n+later"));
    assert.equal(moved.result.isError, false);
    assert.equal(moved.result.details.changes?.[0]?.destinationBeforeSha256, null);
    // Credential rotation never changes request/mutation identity.
    const oldSecret = executionSecret;
    executionSecret = (await request(`/v1/machines/${machineId}/secrets/rotate`, "POST", { kind: "execution", expectedVersion: 1 })).secret;
    const operation = first.snapshot.operations[0]!;
    const replay = {
      destination: { routeKey: "test-v1", sessionId: first.sessionId }, execution: first.execution,
      submission: { operationId: operation.operationId, submissionId: operation.submissionId,
        request: { provider: "tool-codex-apply-patch", type: "apply_patch", version: "v1", input: first.nativeInput } },
    };
    assert.equal(replay.execution.token, oldSecret);
    await assert.rejects(call("/submit", replay), /INVALID_SECRET/);
    replay.execution.token = executionSecret;
    assert.equal((await call("/submit", replay)).status, "accepted");
    await assert.rejects(readFile(join(dir, "destination.txt")), { code: "ENOENT" });
    assert.equal(await readFile(join(dir, "new/destination.txt"), "utf8"), "later\n");
    // The daemon outbox replays the retained result, not a fresh filesystem mutation.
    const replayed = await call("/snapshot", { sessionId: first.sessionId }) as Snapshot;
    assert.deepEqual(replayed.operations[0]!.outcome, first.snapshot.operations[0]!.outcome);
    assert.equal(replayed.results.length, 1);
    // Multiple hunks, ordered matching, fuzzy punctuation, whitespace and EOF anchoring.
    await writeFile(join(dir, "matching"), "heading\n  curly “quote”  \nuntouched\nend\n");
    const matching = await apply(patch('*** Update File: matching\n@@ heading\n-curly "quote"\n+plain\n@@\n-end\n+done\n*** End of File'));
    assert.equal(matching.result.isError, false);
    assert.equal(await readFile(join(dir, "matching"), "utf8"), "heading\nplain\nuntouched\ndone\n");
    // The entire patch is planned before writes: a later mismatch prevents an earlier add.
    for (const body of ["*** Add File: untouched-new\n+x\n*** Update File: matching\n@@\n-missing\n+new",
      "*** Update File: missing\n@@\n-x\n+y", "*** Environment ID: other\n*** Add File: untouched-new\n+x"] ) {
      const failed = await apply(patch(body));
      assert.equal(failed.result.isError, true); assert.equal(failed.result.details.status, "rejected");
      assert.deepEqual(failed.result.details.changes, []);
      await assert.rejects(readFile(join(dir, "untouched-new")), { code: "ENOENT" });
    }
    assert.equal((await apply("not a patch")).result.isError, true);
    await mkdir(join(dir, "dir"));
    assert.equal((await apply(patch("*** Delete File: dir"))).result.isError, true);
    await writeFile(join(dir, "binary"), Buffer.from([255]));
    assert.equal((await apply(patch("*** Update File: binary\n@@\n-x\n+y"))).result.isError, true);
    await writeFile(join(dir, "target"), "before\n"); await symlink("target", join(dir, "alias"));
    assert.equal((await apply(patch("*** Update File: alias\n@@\n-before\n+after"))).result.isError, false);
    assert.equal((await lstat(join(dir, "alias"))).isSymbolicLink(), true);
    assert.equal((await apply(patch("*** Delete File: alias"))).result.isError, true);
    const boundary = "unique\n" + "x".repeat(5242880 - 8) + "\n";
    await writeFile(join(dir, "boundary"), boundary);
    const large = await apply(patch("*** Update File: boundary\n@@\n-unique\n+UNIQUE"));
    assert.equal(large.result.isError, false); assert.equal(large.result.details.diffTruncated, true);
    assert.equal((await readFile(join(dir, "boundary"))).length, 5242880);
    assert.equal((await apply(patch("*** Update File: boundary\n@@\n-UNIQUE\n+UNIQUE!"))).result.details.error?.code, "resource_limit");
    assert.equal((await readFile(join(dir, "boundary"))).length, 5242880);
    await writeFile(join(dir, "oversized"), Buffer.alloc(5242881, 120));
    assert.equal((await apply(patch("*** Delete File: oversized"))).result.details.error?.code, "resource_limit");

  for (const scenario of codexScenarios) {
    await t.test(`Codex reference: ${scenario.name}`, async () => {
      const cwd = join(dir, scenario.name);
      await mkdir(cwd);
      for (const [path, content] of Object.entries(scenario.input)) {
        await mkdir(dirname(join(cwd, path)), { recursive: true });
        await writeFile(join(cwd, path), content);
      }
      await apply(scenario.patch, cwd);
      const entries = await readdir(cwd, { recursive: true, withFileTypes: true });
      const actual: Record<string, string> = {};
      for (const entry of entries.filter(e => e.isFile())) {
        const path = join(entry.parentPath, entry.name);
        actual[path.slice(cwd.length + 1)] = await readFile(path, "utf8");
      }
      assert.deepEqual(actual, scenario.expected);
    });
  }

});
