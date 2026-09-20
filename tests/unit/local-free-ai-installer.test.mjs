import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../../tools/local-free-ai/manage.ps1',import.meta.url),'utf8');
test('selected model validation precedes installer configuration and task writes',()=>{
 const check=source.indexOf("model-preflight.mjs");
 assert.ok(check>=0,'Installer must verify its selected model before declaring success');
 for(const operation of ['New-Item -ItemType Directory','Set-Content -LiteralPath $configPath','Register-ScheduledTask']){
  assert.ok(check<source.indexOf(operation),'Model check must precede '+operation);
 }
});
test('local model verification is explicit and does not provision credentials',async()=>{
 const {verifyLocalModel}=await import('../../tools/local-free-ai/model-preflight.mjs');
 const fetchImpl=async(url,options)=>{
  assert.equal(url,'http://127.0.0.1:11434/api/tags');
  assert.equal(options.redirect,'error');
  return Response.json({models:[{name:'llama3.2:1b'}]});
 };
 assert.equal(await verifyLocalModel('llama3.2:1b',{fetchImpl}),true);
 await assert.rejects(verifyLocalModel('llama3.2:latest',{fetchImpl}),/not installed/);
 await assert.rejects(verifyLocalModel('llama3.2:1b',{fetchImpl:async()=>Response.json({models:[]})}),/not installed/);
 await assert.rejects(verifyLocalModel('llama3.2:1b',{fetchImpl:async()=>{throw new Error('offline')}}),/unavailable/);
 await assert.rejects(verifyLocalModel('unapproved-cloud-model',{fetchImpl}),/Unsupported/);
});
