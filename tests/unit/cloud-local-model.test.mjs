import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {localModelEnvironment, localModelThreadLimit, startLocalModel} from '../../backend/services/localModelRuntime.js';

test('local inference inherits no provider credentials and never exposes a public port',()=>{
 const env=localModelEnvironment({PATH:'/usr/bin',OPENAI_API_KEY:'secret',OWNER_AI_BRIDGE_TOKEN:'secret',OLLAMA_HOST:'0.0.0.0:11434',OLLAMA_API_KEY:'secret'});
 assert.equal(env.OLLAMA_HOST,'127.0.0.1:11434');assert.equal(env.OLLAMA_NO_CLOUD,'1');
 assert.equal(env.OLLAMA_MAX_LOADED_MODELS,'1');assert.equal(env.OLLAMA_MAX_QUEUE,'8');
 for(const key of ['OPENAI_API_KEY','OWNER_AI_BRIDGE_TOKEN','OLLAMA_API_KEY'])assert.equal(env[key],undefined);
});
test('disabled by default, with no process or network calls',async()=>{
 let calls=0;const runtime=startLocalModel({env:{},spawnImpl:()=>calls++,fetchImpl:()=>calls++});
 await runtime.ready;assert.equal(runtime.status().state,'disabled');assert.equal(calls,0);runtime.stop();
});
test('ready means the required model is available, not merely an open socket',async()=>{
 const child=new EventEmitter();child.kill=()=>child.emit('exit',0);let requestCount=0;
 const runtime=startLocalModel({env:{GRANTFLOW_LOCAL_MODEL_ENABLED:'1'},platform:'linux',spawnImpl:()=>child,
 fetchImpl:async()=>{requestCount++;return Response.json({models:[{name:'llama3.2:1b',digest:'baf6a787fdffd633537aa2eb51cfd54cb93ff08e28040095462bb63daf552878'}]})},delay:async()=>{},makeDir:async()=>{}});
 await runtime.ready;assert.equal(runtime.status().state,'ready');assert.equal(requestCount,1);runtime.stop();
});
test('missing model is not reported ready and timeout terminates only its own child',async()=>{
 const child=new EventEmitter();let kills=0;child.kill=()=>{kills++;child.emit('exit',0)};let now=0;
 const runtime=startLocalModel({env:{GRANTFLOW_LOCAL_MODEL_ENABLED:'1'},platform:'linux',spawnImpl:()=>child,
 fetchImpl:async()=>Response.json({models:[]}),delay:async()=>{now+=1000},now:()=>now,startupMs:2000,makeDir:async()=>{}});
 await assert.rejects(runtime.ready,/local_model_not_ready/);assert.equal(runtime.status().state,'failed');assert.ok(kills>=1);runtime.stop();
});
test('unsupported platforms do not launch a bundled Linux executable',async()=>{
 let calls=0;const runtime=startLocalModel({env:{GRANTFLOW_LOCAL_MODEL_ENABLED:'1'},platform:'win32',spawnImpl:()=>calls++});
 await assert.rejects(runtime.ready,/local_model_platform_unsupported/);assert.equal(calls,0);runtime.stop();
});
test('runtime image pins the model engine and keeps inference private',()=>{
 const docker=readFileSync(new URL('../../Dockerfile',import.meta.url),'utf8');
 assert.match(docker,/ollama\/ollama:0\.34\.2/);assert.match(docker,/COPY --from=local-model-assets/);
 assert.doesNotMatch(docker,/EXPOSE[^\n]*11434/);
 const start=readFileSync(new URL('../../backend/start.js',import.meta.url),'utf8');
 assert.match(start,/startLocalModel/);
});

test('an unexpected engine exit requests supervised application recovery once',async()=>{
 const child=new EventEmitter();child.kill=()=>child.emit('exit',0);let recoveries=0;
 const runtime=startLocalModel({env:{GRANTFLOW_LOCAL_MODEL_ENABLED:'1'},platform:'linux',spawnImpl:()=>child,
 fetchImpl:async()=>Response.json({models:[{name:'llama3.2:1b',digest:'baf6a787fdffd633537aa2eb51cfd54cb93ff08e28040095462bb63daf552878'}]}),makeDir:async()=>{},onUnexpectedExit:()=>recoveries++});
 await runtime.ready;child.emit('exit',1);child.emit('error',new Error('engine failed'));
 assert.equal(recoveries,1);assert.equal(runtime.status().state,'failed');runtime.stop();
});
test('a changed model digest cannot silently replace the verified weights',async()=>{
 const child=new EventEmitter();child.kill=()=>child.emit('exit',0);let now=0;
 const runtime=startLocalModel({env:{GRANTFLOW_LOCAL_MODEL_ENABLED:'1'},platform:'linux',spawnImpl:()=>child,
 fetchImpl:async()=>Response.json({models:[{name:'llama3.2:1b',digest:'unexpected'}]}),makeDir:async()=>{},delay:async()=>{now+=1000},now:()=>now,startupMs:1000});
 await assert.rejects(runtime.ready,/local_model_not_ready/);runtime.stop();
});

test('CPU workers stay inside the container quota and never use all host cores',()=>{
 for(const [quota,cpus,expected] of [['2400000 100000',48,8],['200000 100000',48,2],['50000 100000',48,1],['max 100000',4,4],['invalid',48,8]]){
  assert.equal(localModelThreadLimit({quotaReader:()=>quota,available:()=>cpus}),String(expected));
 }
 assert.equal(localModelThreadLimit({quotaReader:()=>{throw new Error('absent')},available:()=>4}),'4');
 const env=localModelEnvironment({LLAMA_ARG_THREADS:'128'});assert.ok(Number(env.LLAMA_ARG_THREADS)>=1&&Number(env.LLAMA_ARG_THREADS)<=8);
});
