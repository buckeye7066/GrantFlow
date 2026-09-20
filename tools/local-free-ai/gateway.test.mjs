import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createGateway} from './gateway.mjs';
const token='test-token-'.repeat(6);
const body={model:'llama3.2:latest',messages:[{role:'user',content:'Public fixture'}],max_tokens:40};
async function setup(t, upstream) {
  const calls=[];
  const server=createServer(createGateway({token,fetchImpl:async(...args)=>{calls.push(args);return upstream ? upstream(...args) : Response.json({id:'fixture',model:'llama3.2:latest',choices:[{message:{role:'assistant',content:'{"amount":5000}'},finish_reason:'stop'}],usage:{prompt_tokens:8,completion_tokens:7,total_tokens:15}})}}));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r)}));
  const url=`http://127.0.0.1:${server.address().port}`;
  const post=(b=body,auth=token,path='/v1/chat/completions')=>fetch(url+path,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+auth},body:JSON.stringify(b)});
  return {calls,post,url};
}
test('rejects absent or wrong authorization before touching the model',async t=>{
  const {calls,post}=await setup(t);
  assert.equal((await post(body,'incorrect')).status,401);assert.equal(calls.length,0);
});
test('passes only bounded text inference to fixed loopback upstream',async t=>{
  const {calls,post}=await setup(t);const response=await post();const result=await response.json();
  assert.equal(response.status,200);assert.equal(result.billing_mode,'free_or_local');
  assert.equal(result.choices[0].message.content,'{"amount":5000}');
  assert.equal(calls[0][0],'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(JSON.stringify(calls).includes(token),false);
});
test('rejects tools, foreign models, streaming and excessive output',async t=>{
  const {calls,post}=await setup(t);
  for(const patch of [{tools:[{}]},{model:'remote-paid'},{stream:true},{max_tokens:999999},{messages:[{role:'user',content:[{type:'image_url',image_url:{url:'http://internal/'}}]}]}])assert.equal((await post({...body,...patch})).status,400);
  assert.equal(calls.length,0);
});
test('never exposes model download or process-control endpoints',async t=>{
  const {calls,post}=await setup(t);assert.equal((await post(body,token,'/api/pull')).status,404);assert.equal(calls.length,0);
});
test('returns busy rather than building an unbounded CPU queue',async t=>{
  let release;const gate=new Promise(r=>release=r);const {post,calls}=await setup(t,async()=>{await gate;return Response.json({model:'llama3.2:latest',choices:[{message:{content:'ok'},finish_reason:'stop'}]})});
  const first=post();while(calls.length===0)await new Promise(r=>setTimeout(r,5));
  assert.equal((await post()).status,429);release();assert.equal((await first).status,200);
});
test('truncated model output cannot become a successful completion',async t=>{
  const {post}=await setup(t,async()=>Response.json({model:'llama3.2:latest',choices:[{message:{content:'partial'},finish_reason:'length'}]}));
  assert.equal((await post()).status,502);
});

test('permits the CPU-sized local fallback and rejects malformed requests',async t=>{
  assert.doesNotThrow(()=>createGateway({token,model:'llama3.2:1b'}));
  const {post}=await setup(t);assert.equal((await post(null)).status,400);
});
