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
beforeEach(()=>{mock.ingest.mockReset();vi.stubEnv('OWNER_AI_EMAIL','owner@example.test');vi.stubEnv('OWNER_AI_USER_ID','')})
afterEach(()=>vi.unstubAllEnvs())
function database(){const db=new Database(':memory:');db.dialect='sqlite';db.exec(readFileSync(new URL('../db/schema.sql',import.meta.url),'utf8'));return db}
it('a queued owner document job retains subscription scope after the HTTP reply finishes',async()=>{
 const db=database();let observed
 try {
  const {jobId}=await createCrawlerJob(db,{type:'document_ingest',buildSnapshot:false})
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
  let active;const pending=run(signal=>{active=signal;return new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}))},{timeoutMs:1000})
  expect(active.aborted).toBe(false);await vi.advanceTimersByTimeAsync(1001);await pending;expect(active.aborted).toBe(true)
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
