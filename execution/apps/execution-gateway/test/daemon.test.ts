import test from "node:test";
import assert from "node:assert/strict";
import { createServer, connect } from "node:net";
import type { Socket } from "node:net";
import { uuid } from "@managed-agents/execution-gateway-protocol";
import { spawn, execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { auth, backend, input, stack, until } from "./stack.ts";
import type { Json, Submission } from "@managed-agents/execution-gateway-protocol";
const root=fileURLToPath(new URL("../../../../",import.meta.url));
const binary=join(root,"execution/target/debug/process-execution-daemon");

test("real daemon registers, executes, reconnects, and recovers its durable outbox after a crash",{timeout:180000},async t=>{
  await promisify(execFile)("cargo",["build","--manifest-path",join(root,"execution/Cargo.toml"),"-p","process-execution-daemon"],{maxBuffer:2_000_000});
  const dir=await mkdtemp(join(tmpdir(),"real-daemon-")),state=join(dir,"state");
  const s=await stack({vars:{ACCEPT_TIMEOUT_MS:"3000",CALLBACK_TIMEOUT_MS:"1000"}});
  const target=await s.app.ready;
  const sockets=new Set<Socket>();
  const proxy=createServer(client=>{
    const upstream=connect(Number(target.port),target.hostname);
    sockets.add(client); sockets.add(upstream); client.pipe(upstream); upstream.pipe(client);
    const done=()=>{client.destroy();upstream.destroy();sockets.delete(client);sockets.delete(upstream);};
    client.on("error",done);upstream.on("error",done);client.on("close",done);upstream.on("close",done);
  });
  await new Promise<void>(resolve=>proxy.listen(0,"127.0.0.1",resolve));
  const address=`http://127.0.0.1:${(proxy.address() as import("node:net").AddressInfo).port}`;
  async function cli(args:string[],stdin?:string):Promise<{stdout:string;stderr:string;code:number|null}>{
    const child=spawn(binary,["--state-dir",state,...args],{stdio:["pipe","pipe","pipe"]});let stdout="",stderr="";
    child.stdout.on("data",b=>stdout+=b);child.stderr.on("data",b=>stderr+=b);child.stdin.end(stdin);
    return new Promise((resolve,reject)=>{child.once("error",reject);child.once("exit",code=>resolve({stdout,stderr,code}));});
  }
  const registration=["register","--gateway-url",address,"--name","Integration machine","--allow-insecure-loopback"];
  const first=await cli(registration,backend+"\n");assert.equal(first.code,0,first.stderr);assert.match(first.stdout,/Registered Integration machine/);assert.ok(!first.stdout.includes(backend));
  const credential=JSON.parse(await readFile(join(state,"credential.json"),"utf8"));const machine=credential.machine_id;
  assert.equal((await cli(registration,backend+"\n")).code,0);assert.equal(JSON.parse(await readFile(join(state,"credential.json"),"utf8")).machine_id,machine);
  const config=JSON.parse(await readFile(join(state,"config.json"),"utf8"));Object.assign(config,{cwd:dir,delivery_retry_ms:100,reconnect_min_ms:50,reconnect_max_ms:200,heartbeat_seconds:1});await writeFile(join(state,"config.json"),JSON.stringify(config));
  let child:ChildProcess|undefined,logs="";
  const start=()=>{child=spawn(binary,["--state-dir",state,"run"],{stdio:["ignore","pipe","pipe"]});child.stderr!.on("data",b=>logs+=b);};
  const end=async(signal:NodeJS.Signals)=>{if(!child||child.exitCode!==null||child.signalCode!==null)return;const closed=new Promise(resolve=>child!.once("exit",resolve));child.kill(signal);await closed;};
  t.after(async()=>{await end("SIGTERM");for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>proxy.close(()=>resolve()));await s.app.dispose();await rm(dir,{recursive:true,force:true});});start();
  const row=async()=> (await (await s.request(`/v1/machines/${machine}`, "GET", undefined, await s.executionSecret(machine))).json() as any).machine;
  const ready=await until(async()=>{const r=await row();return r.connectionStatus==="ready"?r:null;},15000);
  let generation=ready.runtimeGeneration; const secret=await s.executionSecret(machine);
  const send=async(id:string,operation:Submission["operation"]["operation"],params:Json)=>{
    const response=await s.request(`/v1/machines/${machine}/requests`,"POST",input(id,{runtimeGeneration:generation!,operation:{operation,params}}),secret);assert.equal(response.status,202,await response.text());
  };
  const event=async(id:string)=>until(async()=>(await s.events()).find(e=>e.requestId===id),15000);
  const call=async(id:string,operation:Submission["operation"]["operation"],params:Json)=>{await send(id,operation,params);const e=await event(id);assert.equal(e.outcome.status,"ok",JSON.stringify(e.outcome)+logs);return e.outcome.result;};
  await call("capabilities","runtime.capabilities",{});
  await call("write","filesystem.write",{cwd:dir,path:"hello.txt",content:{type:"text",data:"before\n"}});
  await call("edit","filesystem.patch",{cwd:dir,patch:{format:"text_replacements",files:[{path:"hello.txt",edits:[{oldText:"before",newText:"after"}]}]}});
  assert.equal((await call("read","filesystem.read",{cwd:dir,path:"hello.txt"})).text,"after\n");
  const command={cwd:dir,env:{GATEWAY_TEST_OUTPUT:"done"},command:{type:"shell",script:"printf x >> once; printf '%s' \"$GATEWAY_TEST_OUTPUT\"",login:false},completion:{mode:"finished",timeout_ms:5000}};
  await Promise.all([send("exec","execution.exec",command),send("exec","execution.exec",command)]);assert.equal((await event("exec")).outcome.result.output,"done");assert.equal(await readFile(join(dir,"once"),"utf8"),"x");
  const changed=await s.request(`/v1/machines/${machine}/requests`,"POST",input("exec",{runtimeGeneration:generation,operation:{operation:"execution.exec",params:{...command,tty:true}}}),secret);assert.equal(changed.status,409);
  const tty=await call("tty","execution.exec",{cwd:dir,env:{},command:{type:"shell",script:"cat",login:false},tty:true,completion:{mode:"yield",wait_ms:10}});
  assert.equal(uuid(tty.session_id),tty.session_id);
  const interaction=await call("stdin","execution.interact",{session_id:tty.session_id,input:{type:"text",text:"hello stdin\n"},wait_ms:250});assert.match(interaction.output,/hello stdin/);
  await call("close-tty","execution.close",{session_id:tty.session_id});
  const python=await call("python","repl.execute",{target:{type:"create",runtime:"python",cwd:dir,env:{}},cells:[{id:"a",code:"x = 41\nprint(x + 1)"}],completion:{mode:"finished",timeout_ms:10000}});assert.equal(python.state,"succeeded");
  const node=await call("node","repl.execute",{target:{type:"create",runtime:"node",cwd:dir,env:{}},cells:[{id:"a",code:"var x = await Promise.resolve(42); x"}],completion:{mode:"finished",timeout_ms:10000}});assert.equal(node.state,"succeeded");
  assert.equal(uuid(python.session),python.session);assert.equal(uuid(node.session),node.session);
  await call("image-write","filesystem.write",{cwd:dir,path:"image.png",content:{type:"base64",data:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"}});
  const image=await call("image","filesystem.read",{cwd:dir,path:"image.png",mode:"image"});assert.equal(image.image.width,1);
  const epoch=(await row()).connectionEpoch;
  // Cut the real TCP connection; the reconnect must preserve the running REPL.
  for(const socket of [...sockets])socket.destroy();
  await until(async()=> {const r=await row();return r.connectionStatus==="ready"&&r.connectionEpoch>epoch;},15000);
  assert.equal((await row()).runtimeGeneration,generation);
  await call("after-reconnect","filesystem.read",{cwd:dir,path:"hello.txt"});
  const continued=await call("python-after-reconnect","repl.execute",{target:{type:"existing",session:python.session},cells:[{id:"b",code:"print(x + 1)"}],completion:{mode:"finished",timeout_ms:10000}});
  assert.ok(continued.events.some((e:any)=>e.text?.includes("42")));
  await call("close-python","repl.close",{session:python.session});
  await call("close-node","repl.close",{session:node.session});
  const cancellable=await call("cancellable","execution.exec",{cwd:dir,env:{},command:{type:"shell",script:"sleep 30",login:false},completion:{mode:"yield",wait_ms:10}});
  assert.equal((await call("cancel","request.cancel",{request_id:"cancellable"})).state,"cancelled");
  const cancelled=await call("cancelled","execution.interact",{session_id:cancellable.session_id,input:{type:"none"},wait_ms:1000});
  assert.equal(cancelled.state,"finished");assert.equal(cancelled.reason,"terminated");
  // Persist a result locally while the durable receiver is unavailable, then crash.
  await s.faults({fail:100});await send("saved-result","filesystem.write",{cwd:dir,path:"saved.txt",content:{type:"text",data:"saved"}});
  await until(async()=>{const status=await cli(["status"]);return /[1-9]\d* awaiting delivery/.test(status.stdout);},10000);
  assert.equal(await readFile(join(dir,"saved.txt"),"utf8"),"saved");
  // The second operation has a side effect but is still running when killed.
  await send("interrupted","execution.exec",{cwd:dir,env:{},command:{type:"shell",script:"printf x >> interrupted-once; sleep 3",login:false},completion:{mode:"finished",timeout_ms:10000}});
  await until(async()=>readFile(join(dir,"interrupted-once"),"utf8").catch(()=>""));await end("SIGKILL");
  await s.faults({fail:0});start();
  await until(async()=>{const r=await row();return r.connectionStatus==="ready"&&r.runtimeGeneration!==generation;},15000);
  const saved=await event("saved-result");assert.equal(saved.outcome.status,"ok");assert.equal(saved.runtimeGeneration,generation);
  const interrupted=await event("interrupted");assert.equal(interrupted.outcome.error.code,"DAEMON_RESTARTED");assert.equal(interrupted.outcome.error.uncertain,true);
  assert.equal(await readFile(join(dir,"interrupted-once"),"utf8"),"x");
  const status=await cli(["status"]);assert.equal(status.code,0);assert.match(status.stdout,/Daemon: connected/);assert.ok(!status.stdout.includes(credential.token));
  // Deletion stops the daemon; it must not reconnect forever.
  await s.request(`/v1/machines/${machine}`,"DELETE");
  await until(()=>child!.exitCode!==null,10000);assert.equal(child!.exitCode,2);
  assert.equal((await s.request(`/v1/machines/${machine}`, "GET", undefined, secret)).status,410);
});
