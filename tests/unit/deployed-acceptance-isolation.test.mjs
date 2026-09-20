import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildAcceptanceEnvironment,validateRevision} from '../../backend/scripts/run-deployed-acceptance.mjs';
test('only an exact immutable Git revision is accepted',()=>{
 assert.equal(validateRevision('a'.repeat(40)),'a'.repeat(40));
 for(const bad of ['main','--upload-pack=evil','../data','a'.repeat(41),''])assert.throws(()=>validateRevision(bad));
});
test('production data, mail and paid-model credentials never enter acceptance',()=>{
 const result=buildAcceptanceEnvironment({PATH:'/usr/bin',SEARXNG_URL:'http://search.railway.internal',DATABASE_URL:'postgres://production',AUTH_JWT_SECRET:'secret',OPENAI_API_KEY:'secret',RESEND_API_KEY:'secret',OWNER_AI_BRIDGE_TOKEN:'secret',NODE_OPTIONS:'--require evil',GITHUB_TOKEN:'secret'});
 for(const key of ['DATABASE_URL','AUTH_JWT_SECRET','OPENAI_API_KEY','RESEND_API_KEY','OWNER_AI_BRIDGE_TOKEN','NODE_OPTIONS','GITHUB_TOKEN'])assert.equal(result[key],undefined);
 assert.equal(result.FREE_AI_TIMEOUT_MS,'60000');
 assert.equal(result.NODE_ENV,'acceptance');assert.equal(result.SEARXNG_URL,'http://search.railway.internal');
 const [route]=JSON.parse(result.FREE_AI_ROUTES);assert.equal(route.base_url,'http://127.0.0.1:11434/v1');assert.equal(route.json_schema_mode,true);
});
test('runs the canonical fifty-profile command without replacing any acceptance authority',()=>{
 const source=readFileSync(new URL('../../backend/scripts/run-deployed-acceptance.mjs',import.meta.url),'utf8');
 assert.match(source,/scripts\/grantflow-acceptance-50\.mjs/);assert.match(source,/--expected-sha=/);
 for(const override of ['preflightDependencies:', 'loadRuntime:', 'runAmyTraining:', 'inspectSource:'])assert.equal(source.includes(override),false);
 assert.match(source,/--depth=1/);assert.match(source,/rev-parse/);assert.match(source,/status.*--porcelain/);
});

test('the runtime dependency symlink alone is excluded from clone status',()=>{
 const source=readFileSync(new URL('../../backend/scripts/run-deployed-acceptance.mjs',import.meta.url),'utf8');
 assert.ok(source.includes("path.join(folder,'.git','info','exclude')"));
 assert.ok(source.includes("'/node_modules\\n'"));
 assert.ok(source.indexOf("path.join(folder,'.git','info','exclude')") < source.indexOf("['status','--porcelain']"));
});


test('an interruption vetoes a successful child exit before any receipt is accepted',async()=>{
 const {assertAcceptanceNotInterrupted}=await import('../../backend/scripts/run-deployed-acceptance.mjs');
 assert.throws(()=>assertAcceptanceNotInterrupted(true),/acceptance_interrupted/);
 assert.doesNotThrow(()=>assertAcceptanceNotInterrupted(false));
 const source=readFileSync(new URL('../../backend/scripts/run-deployed-acceptance.mjs',import.meta.url),'utf8');
 const childResolved=source.indexOf('    clearTimeout(timer)');
 const guard=source.indexOf('assertAcceptanceNotInterrupted(interrupted)',childResolved);
 const receipt=source.indexOf('const raw=await readFile',childResolved);
 assert.ok(childResolved>=0&&guard>childResolved&&receipt>guard,'Check interruption before reading a child receipt');
});
