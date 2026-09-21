// Structured persistent Node REPL runner. The control socket is independent of stdout.
const net = require('node:net');
const repl = require('node:repl');
const { PassThrough } = require('node:stream');
const { inspect } = require('node:util');
const { AsyncLocalStorage } = require('node:async_hooks');
const { StringDecoder } = require('node:string_decoder');
const { create: createDomain } = require('node:domain');
const port = Number(process.env.EXECUTION_REPL_PORT);
const token = process.env.EXECUTION_REPL_TOKEN;
delete process.env.EXECUTION_REPL_PORT;
delete process.env.EXECUTION_REPL_TOKEN;
const socket = net.createConnection({host:'127.0.0.1',port});
const provenance = new AsyncLocalStorage();
let latest = {};
function send(message) { socket.write(JSON.stringify(message)+'\n'); }
function event(kind, data) { send({type:'event', ...(provenance.getStore() || latest), kind, ...data}); }
function text(kind, value) {
  const text = String(value);
  for (let i=0;i<text.length;i+=16000) event(kind,{text:text.slice(i,i+16000)});
}
const output = new PassThrough();
output.on('data', chunk => text('stdout',chunk));
const server = repl.start({input:new PassThrough(),output,terminal:false,prompt:'',useGlobal:false,ignoreUndefined:true,breakEvalOnSigint:true});
const logs = Object.fromEntries(['log','info','debug','warn','error'].map(name => [name,(...args)=>text(['error','warn'].includes(name)?'stderr':'stdout',args.map(x=>typeof x==='string'?x:inspect(x,{depth:4,maxArrayLength:100,maxStringLength:65536})).join(' ')+'\n')]));
server.context.console = logs;
process.stdout.write = (chunk, encoding, callback) => {text('stdout',chunk);if(typeof encoding==='function')encoding();if(callback)callback();return true;};
process.stderr.write = (chunk, encoding, callback) => {text('stderr',chunk);if(typeof encoding==='function')encoding();if(callback)callback();return true;};
let nextHelper=0;
const helpers=new Map();
async function call(operation,params) {
  const id=String(++nextHelper);
  return new Promise((resolve,reject)=>{helpers.set(id,{resolve,reject});send({type:'helper',id,...(provenance.getStore()||latest),operation,params});});
}
server.context.runtime={
  call,
  exec: async (command,options={}) => call('execution.exec',{command:{type:'shell',script:command,login:false},cwd:null,tty:false,completion:{mode:'finished',timeout_ms:null},...options}),
  read: async (path,options={}) => call('filesystem.read',{path,cwd:null,...options}),
  write: async (path,content) => call('filesystem.write',{path,cwd:null,content:{type:'text',data:content},create_parents:true,precondition:null}),
  applyPatch: async text => call('filesystem.patch',{cwd:null,patch:{format:'codex',text}}),
  emitJson: data => event('json',{data}),
  displayImage: async path => {const result=await call('filesystem.read',{path,cwd:null,mode:'image'});event('image',{image:result.image});},
};
// REPL runtime exceptions bypass the eval callback. Older Node versions route
// them through the REPL domain; newer versions honor an active caller domain.
function evaluate(code,id) {
  return new Promise(resolve=>{
    const domain = server._domain || createDomain();
    let settled = false;
    function finish(error,result) {
      if (settled) return;
      settled = true;
      domain.removeListener('error',onError);
      resolve({error,result});
    }
    function onError(error) { finish(error); }
    domain.on('error',onError);
    domain.run(()=>server.eval(code,server.context,id,finish));
  });
}
async function execute(message) {
  let failed=false;
  for(const cell of message.cells){
    latest={execution_id:message.execution_id,cell_id:cell.id};
    if(failed&&message.stop_on_error){send({type:'cell_done',...latest,status:'skipped'});continue;}
    await provenance.run({...latest},async()=>{
      send({type:'cell_started',...latest});
      const {error,result}=await evaluate(cell.code+'\n',cell.id+'.js');
      if(error){failed=true;event('error',{name:error.name||'Error',message:String(error.message||error).slice(0,65536),traceback:String(error.stack||'').slice(-65536)});}
      else if(result!==undefined){event('result',{text:inspect(result,{depth:4,maxArrayLength:100,maxStringLength:65536}).slice(0,65536)});}
      send({type:'cell_done',...latest,status:error?'failed':'succeeded'});
    });
  }
  send({type:'execution_done',execution_id:message.execution_id,status:failed?'failed':'succeeded'});
}
let chain=Promise.resolve(),buffer='';
const decoder = new StringDecoder('utf8');
socket.on('connect',()=>send({type:'hello',token}));
socket.on('data',chunk=>{
  buffer+=decoder.write(chunk);
  for(;;){const end=buffer.indexOf('\n');if(end<0)break;const line=buffer.slice(0,end);buffer=buffer.slice(end+1);const message=JSON.parse(line);
    if(message.type==='helper_result'){const waiter=helpers.get(message.id);helpers.delete(message.id);if(waiter){if(message.error)waiter.reject(Error(message.error));else waiter.resolve(message.result);}}
    else if(message.type==='execute'){chain=chain.then(()=>execute(message)).catch(error=>event('error',{message:String(error)}));}
  }
});
socket.on('close',()=>process.exit(0));
socket.on('error',()=>process.exit(1));
