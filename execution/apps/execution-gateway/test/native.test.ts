import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { input, machineId, stack, until } from "./stack.ts";
import { OPERATIONS, uuid } from "@managed-agents/execution-gateway-protocol";
import type { Json, Outcome, Submission } from "@managed-agents/execution-gateway-protocol";
const root = fileURLToPath(new URL("../../../../", import.meta.url));

test("HTTP -> machine DO -> WebSocket -> real Rust core -> durable callback, including REPLs and images", { timeout: 180000 }, async t => {
  await promisify(execFile)("cargo", ["build", "--manifest-path", join(root,"execution/Cargo.toml"), "--example", "gateway_test_peer"], { maxBuffer: 2_000_000 });
  const dir = await mkdtemp(join(tmpdir(),"gateway-native-")); t.after(() => rm(dir,{recursive:true,force:true}));
  const child = spawn(join(root,"execution/target/debug/examples/gateway_test_peer"),[dir],{stdio:["pipe","pipe","pipe"]});
  let generation: string | undefined; let stderr = "";
  child.stderr.on("data", b => { stderr += b.toString(); });
  const waiting = new Map<string,(outcome: Outcome)=>void>();
  createInterface({input:child.stdout}).on("line",line=>{
    const value=JSON.parse(line); if(value.type==="ready") generation=value.generation;
    else { const resolve=waiting.get(value.requestId);waiting.delete(value.requestId);resolve?.(value.outcome); }
  });
  t.after(async()=>{child.stdin.end();await new Promise<void>(resolve=>{if(child.exitCode!==null)resolve();else child.once("exit",()=>resolve());});});
  await until(()=>generation,10000);
  const s=await stack({vars:{ACCEPT_TIMEOUT_MS:"2000",CALLBACK_TIMEOUT_MS:"2000"}});t.after(()=>s.app.dispose());
  const operations = [...OPERATIONS];
  const peer=await s.connect(await s.register(),{runtimeGeneration:generation!,operations});
  const secret=await s.executionSecret();
  const seen=new Map<string,{hash:string,result:Promise<Outcome>}>();
  let effects=0;
  peer.onRequest=async request=>{
    let entry=seen.get(request.requestId);
    if(entry && entry.hash!==request.requestHash){peer.send({type:"rejected",dispatchId:request.dispatchId,requestId:request.requestId,requestHash:request.requestHash,runtimeGeneration:request.runtimeGeneration,error:{code:"IDEMPOTENCY_CONFLICT",message:"Request identity already used",retryable:false,uncertain:false}});return;}
    if(!entry){effects++;const result=new Promise<Outcome>(resolve=>waiting.set(request.requestId,resolve));entry={hash:request.requestHash,result};seen.set(request.requestId,entry);child.stdin.write(JSON.stringify(request)+"\n");}
    peer.accept(request);await peer.result(request,await entry.result);
  };
  async function call(id:string,operation:Submission["operation"]["operation"],params:Json):Promise<any>{
    const res=await s.request(`/v1/machines/${machineId}/requests`,"POST",input(id,{runtimeGeneration:generation!,operation:{operation,params}}),secret);
    assert.equal(res.status,202,await res.text());
    const event=await until(async()=> (await s.events()).find(e=>e.requestId===id),20000);
    assert.equal(event.outcome.status,"ok",JSON.stringify(event.outcome)+stderr);
    return event.outcome.result;
  }
  await call("write","filesystem.write",{cwd:dir,path:"test.txt",content:{type:"text",data:"old\n"}});
  await call("edit","filesystem.patch",{cwd:dir,patch:{format:"text_replacements",files:[{path:"test.txt",edits:[{oldText:"old",newText:"new"}]}]}});
  const read=await call("read","filesystem.read",{cwd:dir,path:"test.txt"});assert.equal(read.text,"new\n");
  const exec=await call("exec","execution.exec",{cwd:dir,env:{},command:{type:"shell",script:"printf x >> once; cat test.txt",login:false},completion:{mode:"finished",timeout_ms:5000}});assert.equal(exec.output,"new\n");
  const before=effects;await call("exec","execution.exec",{cwd:dir,env:{},command:{type:"shell",script:"printf x >> once; cat test.txt",login:false},completion:{mode:"finished",timeout_ms:5000}});assert.equal(effects,before);assert.equal(await readFile(join(dir,"once"),"utf8"),"x");
  const python=await call("python","repl.execute",{target:{type:"create",runtime:"python",cwd:dir,env:{}},cells:[{id:"one",code:"x = 41\nprint(x + 1)"}],completion:{mode:"finished",timeout_ms:10000}});assert.equal(python.state,"succeeded");
  const next=await call("python-next","repl.execute",{target:{type:"existing",session:python.session},cells:[{id:"two",code:"print(x)"}],completion:{mode:"finished",timeout_ms:10000}});assert.ok(next.events.some((e:any)=>e.text?.includes("41")));
  const node=await call("node","repl.execute",{target:{type:"create",runtime:"node",cwd:dir,env:{}},cells:[{id:"one",code:"var x = await Promise.resolve(42); x"}],completion:{mode:"finished",timeout_ms:10000}});assert.equal(node.state,"succeeded");
  assert.equal(uuid(python.session),python.session);assert.equal(uuid(node.session),node.session);
  // Valid 2-by-3 PNG generated using Python standard-library modules.
  await call("make-image","repl.execute",{target:{type:"existing",session:python.session},cells:[{id:"image",code:"import struct, zlib\ndef png_chunk(t, d):\n    return struct.pack('!I', len(d)) + t + d + struct.pack('!I', zlib.crc32(t+d))\nopen('image.png', 'wb').write(bytes([137,80,78,71,13,10,26,10]) + png_chunk(b'IHDR', struct.pack('!2I5B', 2, 3, 8, 2, 0, 0, 0)) + png_chunk(b'IDAT', zlib.compress(bytes([0,255,0,0,255,0,0])*3)) + png_chunk(b'IEND', b''))"}],completion:{mode:"finished",timeout_ms:10000}});
  const image=await call("image","filesystem.read",{cwd:dir,path:"image.png",mode:"image"});assert.equal(image.image.width,2);assert.ok(image.image.data_base64.length>0);
  await call("close-python","repl.close",{session:python.session});
  await call("close-node","repl.close",{session:node.session});
  assert.equal((await s.events()).filter(e=>e.requestId==="exec").length,1);
});
