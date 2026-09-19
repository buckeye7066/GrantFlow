import {EventEmitter} from 'node:events'
import {readFileSync} from 'node:fs'
import Database from 'better-sqlite3'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {getOwnerAiScope,runWithOwnerAiScope} from '../services/ownerAi/ownerAiScope.js'
const mock=vi.hoisted(()=>({ingest:vi.fn()}))
vi.mock('../services/documentIngestion.js',async()=>({...await vi.importActual('../services/documentIngestion.js'),processDocumentIngestionJob:mock.ingest}))
import {dispatchCrawlerJob} from '../services/crawlerDispatcher.js'
import {createCrawlerJob} from '../services/crawlerJobCreation.js'
const owner=()=>({ctx:{identityResolved:true,isAdmin:true,userId:'owner-proof',email:'owner@example.test'},res:new EventEmitter()})
beforeEach(()=>{mock.ingest.mockReset();vi.stubEnv('OWNER_AI_EMAIL','owner@example.test');vi.stubEnv('OWNER_AI_USER_ID','');vi.stubEnv('AUTH_JWT_SECRET','queue-proof-fixture-secret-with-more-than-thirty-two-characters')})
afterEach(()=>vi.unstubAllEnvs())
function database(){const db=new Database(':memory:');db.dialect='sqlite';db.exec(readFileSync(new URL('../db/schema.sql',import.meta.url),'utf8'));db.prepare('INSERT INTO users (id,primary_email,is_admin) VALUES (?,?,?)').run('owner-proof','owner@example.test',1);return db}
it('a queued owner document job retains subscription scope after the HTTP reply finishes',async()=>{
 const db=database();let observed
 try {
  const request=owner();const {jobId}=await runWithOwnerAiScope(request,()=>createCrawlerJob(db,{type:'document_ingest',buildSnapshot:false}))
  mock.ingest.mockImplementation(async context=>{const scope=getOwnerAiScope({includeAborted:true});observed={present:!!scope,aborted:scope?.signal.aborted,signal:context.signal};scope?.signal.throwIfAborted();return {result_count:1}})
  const req=owner();const pending=runWithOwnerAiScope(req,()=>dispatchCrawlerJob({db,jobId}));req.res.emit('finish');await pending
  expect(observed).toMatchObject({present:true,aborted:false})
  expect(db.prepare('SELECT status FROM crawler_jobs WHERE id=?').get(jobId).status).toBe('completed')
  expect(observed.signal.aborted).toBe(true)
 } finally {db.close()}
})
it('ordinary queued jobs never acquire owner subscription scope',async()=>{
 const db=database();let observed='unset'
 try {const {jobId}=await createCrawlerJob(db,{type:'document_ingest',buildSnapshot:false});mock.ingest.mockImplementation(async()=>{observed=getOwnerAiScope({includeAborted:true});return {result_count:1}});await dispatchCrawlerJob({db,jobId});expect(observed).toBeNull()}finally{db.close()}
})
it('detached owner work respects its own timeout and rejects already-cancelled capture',async()=>{
 const {captureDetachedOwnerAiRunner}=await import('../services/ownerAi/ownerAiScope.js')
 const req=owner();let run
 runWithOwnerAiScope(req,()=>{run=captureDetachedOwnerAiRunner()});req.res.emit('finish')
 vi.useFakeTimers()
 try {
  let active;const pending=run(signal=>{active=signal;return new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}))},{timeoutMs:1000}).catch(error=>error)
  expect(active.aborted).toBe(false);await vi.advanceTimersByTimeAsync(1001);expect((await pending).name).toBe('AbortError');expect(active.aborted).toBe(true)
 } finally {vi.useRealTimers()}
 const cancelled=owner();const work=vi.fn()
 await runWithOwnerAiScope(cancelled,async()=>{cancelled.res.emit('finish');const blocked=captureDetachedOwnerAiRunner();await expect(blocked(work,{timeoutMs:1000})).rejects.toThrow()})
 expect(work).not.toHaveBeenCalled()
})
it('an externally cancelled job cannot start detached inference',async()=>{
 const {captureDetachedOwnerAiRunner}=await import('../services/ownerAi/ownerAiScope.js')
 const req=owner();const work=vi.fn()
 await runWithOwnerAiScope(req,async()=>{const run=captureDetachedOwnerAiRunner();await expect(run(work,{timeoutMs:1000,signal:AbortSignal.abort()})).rejects.toThrow()})
 expect(work).not.toHaveBeenCalled()
})


it('detached timeout settles even when the phase ignores its cancellation signal',async()=>{
 const {captureDetachedOwnerAiRunner}=await import('../services/ownerAi/ownerAiScope.js');let run;runWithOwnerAiScope(owner(),()=>{run=captureDetachedOwnerAiRunner()});vi.useFakeTimers();let release;let settled=false
 const pending=run(()=>new Promise(resolve=>{release=resolve}),{timeoutMs:1000}).then(()=>{settled=true},()=>{settled=true})
 try {await vi.advanceTimersByTimeAsync(1001);expect(settled).toBe(true)}finally{release();await pending;vi.useRealTimers()}
})


it('owner policy survives a durable queue restart while client claims cannot confer it',async()=>{
 vi.stubEnv('AUTH_JWT_SECRET','queue-proof-fixture-secret-with-more-than-thirty-two-characters')
 const db=database();let observed
 try {
  const req=owner();const job=await runWithOwnerAiScope(req,()=>createCrawlerJob(db,{type:'document_ingest',buildSnapshot:false,requestedBy:'owner-proof'}));req.res.emit('finish')
  mock.ingest.mockImplementation(async()=>{observed=!!getOwnerAiScope();return {result_count:1}})
  await dispatchCrawlerJob({db,jobId:job.jobId});expect(observed).toBe(true)
  const forged=await createCrawlerJob(db,{type:'document_ingest',buildSnapshot:false,requestedBy:'owner-proof',parameters:{_owner_ai:{userId:'owner-proof',email:'owner@example.test'}},skipIdempotencyCheck:true})
  observed=null;await dispatchCrawlerJob({db,jobId:forged.jobId});expect(observed).toBe(false)
 } finally {db.close()}
})
it('a detached job deadline has the dispatcher timeout classification',async()=>{
 const {captureDetachedOwnerAiRunner}=await import('../services/ownerAi/ownerAiScope.js')
 vi.useFakeTimers();const pending=captureDetachedOwnerAiRunner()(()=>new Promise(()=>{}),{timeoutMs:1000}).catch(error=>error)
 try {await vi.advanceTimersByTimeAsync(1001);expect((await pending).code).toBe('JOB_TIMEOUT')} finally {vi.useRealTimers()}
})
it('configured background replies are not silently limited to four minutes',async()=>{
 const {captureOwnerAiJobScope}=await import('../services/ownerAi/ownerAiScope.js')
 vi.useFakeTimers();let signal;let done
 try {const scope=captureOwnerAiJobScope(owner(),{timeoutMs:300000});const p=scope.run(()=>{signal=getOwnerAiScope().signal;return new Promise(resolve=>{done=resolve})});await vi.advanceTimersByTimeAsync(240001);expect(signal.aborted).toBe(false);await vi.advanceTimersByTimeAsync(60000);expect(signal.aborted).toBe(true);done();await p}finally{done?.();vi.useRealTimers()}
})
it('an exclusion-owning detached runner retains settlement until its underlying work ends',async()=>{
 const {captureDetachedOwnerAiRunner}=await import('../services/ownerAi/ownerAiScope.js');vi.useFakeTimers();let release;let settled=false
 const p=captureDetachedOwnerAiRunner()(()=>new Promise(resolve=>{release=resolve}),{timeoutMs:1000,waitForSettlement:true}).catch(error=>error).finally(()=>{settled=true})
 try {await vi.advanceTimersByTimeAsync(1001);expect(settled).toBe(false);release();expect((await p).code).toBe('JOB_TIMEOUT')}finally{release?.();await p;vi.useRealTimers()}
})


it('tampered or re-bound durable owner proofs fail without executing a provider',async()=>{
 vi.stubEnv('AUTH_JWT_SECRET','queue-proof-fixture-secret-with-more-than-thirty-two-characters')
 const {durableOwnerAiRunner}=await import('../services/ownerAi/ownerAiScope.js')
 const db=database()
 try {
  const req=owner();const created=await runWithOwnerAiScope(req,()=>createCrawlerJob(db,{type:'document_ingest',buildSnapshot:false}));req.res.emit('finish')
  const row=db.prepare('SELECT * FROM crawler_jobs WHERE id=?').get(created.jobId)
  await expect(durableOwnerAiRunner({...row,id:'another-job'},db)).rejects.toThrow(/policy/)
  const params=JSON.parse(row.parameters);params._owner_ai.identity.userId='other-user'
  await expect(durableOwnerAiRunner({...row,parameters:JSON.stringify(params)},db)).rejects.toThrow(/policy/)
  vi.stubEnv('OWNER_AI_EMAIL','changed-owner@example.test')
  await expect(durableOwnerAiRunner(row,db)).rejects.toThrow(/policy/)
  expect(mock.ingest).not.toHaveBeenCalled()
 } finally {db.close()}
})


it('automatic orphan retries rebind authenticated owner intent to the new job',async()=>{
 vi.stubEnv('AUTH_JWT_SECRET','queue-proof-fixture-secret-with-more-than-thirty-two-characters')
 const {autoRetryOrphanedJob}=await import('../services/crawlerConcurrencyGuard.js')
 const db=database();let observed
 try {
  const req=owner();const created=await runWithOwnerAiScope(req,()=>createCrawlerJob(db,{type:'document_ingest',buildSnapshot:false}));req.res.emit('finish')
  const original=db.prepare('SELECT * FROM crawler_jobs WHERE id=?').get(created.jobId)
  const retry=await autoRetryOrphanedJob(db,original);expect(retry.retried).toBe(true)
  mock.ingest.mockImplementation(async()=>{observed=!!getOwnerAiScope();return {result_count:1}})
  await dispatchCrawlerJob({db,jobId:retry.newJobId});expect(observed).toBe(true)
  expect(db.prepare('SELECT status FROM crawler_jobs WHERE id=?').get(retry.newJobId).status).toBe('completed')
 } finally {db.close()}
})


it('draining or retrying customer jobs inside an owner request never borrows the subscription',async()=>{
 const {autoRetryOrphanedJob}=await import('../services/crawlerConcurrencyGuard.js');const db=database();const seen=[]
 try {
  const first=await createCrawlerJob(db,{type:'document_ingest',buildSnapshot:false})
  mock.ingest.mockImplementation(async()=>{seen.push(!!getOwnerAiScope());return {result_count:1}})
  await runWithOwnerAiScope(owner(),()=>dispatchCrawlerJob({db,jobId:first.jobId}))
  const original=db.prepare('SELECT * FROM crawler_jobs WHERE id=?').get(first.jobId)
  const retry=await runWithOwnerAiScope(owner(),()=>autoRetryOrphanedJob(db,original))
  await dispatchCrawlerJob({db,jobId:retry.newJobId})
  expect(seen).toEqual([false,false])
 } finally {db.close()}
})
