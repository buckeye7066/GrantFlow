import express from 'express'
import request from 'supertest'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {getOwnerAiScope,runWithOwnerAiScope} from '../services/ownerAi/ownerAiScope.js'
const calls=vi.hoisted(()=>({generate:vi.fn(),complete:vi.fn(),add:vi.fn(),cancel:vi.fn()}))
vi.mock('../services/anyaOrchestrator.js',async()=>({...await vi.importActual('../services/anyaOrchestrator.js'),generateAssistantResponse:calls.generate,addMessage:calls.add}))
vi.mock('../services/anyaRuns.js',async()=>({...await vi.importActual('../services/anyaRuns.js'),createAnyaRun:async()=> 'background-proof',completeAnyaRun:calls.complete,appendAnyaRunLog:async()=>true,requestAnyaRunCancel:calls.cancel}))
import router from '../routes/anya.js'
function app(owner=true){const app=express();app.use(express.json());app.use((req,res,next)=>{req.ctx={identityResolved:true,isAdmin:owner,userId:'fixture-user',email:'owner@example.test'};req.db={};runWithOwnerAiScope(req,next)});app.use(router);return app}
beforeEach(()=>{Object.values(calls).forEach(mock=>mock.mockReset());vi.stubEnv('ADMIN_EMAIL','owner@example.test');vi.stubEnv('AGENT_CONTROL_ADMIN_EMAIL','');vi.stubEnv('OWNER_AI_USER_ID','');calls.complete.mockResolvedValue(true);calls.add.mockImplementation(async(_db,_ctx,_sid,message)=>({id:'message',...message}));calls.cancel.mockResolvedValue({ok:true})})
afterEach(()=>vi.unstubAllEnvs())
it('the real background route preserves owner subscription scope after its 202 acknowledgement',async()=>{
  let state
  calls.generate.mockImplementation(async()=>{await new Promise(resolve=>setImmediate(resolve));const scope=getOwnerAiScope({includeAborted:true});state={present:!!scope,aborted:scope?.signal.aborted};scope?.signal.throwIfAborted();return 'actual subscription answer'})
  const response=await request(app()).post('/sessions/session/messages').send({message:'Explain',background:true})
  expect(response.status).toBe(202)
  await vi.waitFor(()=>expect(calls.complete).toHaveBeenCalled())
  expect(state).toEqual({present:true,aborted:false})
  expect(calls.add.mock.calls.some(call=>call[3].content==='actual subscription answer')).toBe(true)
})
it('non-owner background jobs never acquire the owner subscription identity',async()=>{
  let state='unset';calls.generate.mockImplementation(async()=>{await new Promise(resolve=>setImmediate(resolve));state=getOwnerAiScope({includeAborted:true});return 'customer answer'})
  expect((await request(app(false)).post('/sessions/session/messages').send({message:'Explain',background:true})).status).toBe(202)
  await vi.waitFor(()=>expect(calls.complete).toHaveBeenCalled());expect(state).toBeNull()
})
it('authorized Stop cancels the detached owner provider request',async()=>{
  let signal
  calls.generate.mockImplementation(async()=>{signal=getOwnerAiScope({includeAborted:true})?.signal;return new Promise(resolve=>signal?.addEventListener('abort',()=>resolve('Stopped'),{once:true}))})
  const server=app();expect((await request(server).post('/sessions/session/messages').send({message:'Explain',background:true})).status).toBe(202)
  await vi.waitFor(()=>expect(signal).toBeDefined());expect(signal.aborted).toBe(false)
  expect((await request(server).post('/sessions/session/runs/background-proof/cancel')).body.ok).toBe(true)
  await vi.waitFor(()=>expect(signal.aborted).toBe(true));await vi.waitFor(()=>expect(calls.complete).toHaveBeenCalled())
})
it('an unauthorized Stop does not cancel another job',async()=>{
  let signal;let release
  calls.generate.mockImplementation(async()=>{signal=getOwnerAiScope({includeAborted:true})?.signal;return new Promise(resolve=>{release=resolve})})
  const server=app();await request(server).post('/sessions/session/messages').send({message:'Explain',background:true})
  await vi.waitFor(()=>expect(release).toBeDefined());calls.cancel.mockResolvedValue({ok:false,reason:'not_found'})
  expect((await request(server).post('/sessions/other/runs/background-proof/cancel')).status).toBe(404)
  expect(signal.aborted).toBe(false);release('finished');await vi.waitFor(()=>expect(calls.complete).toHaveBeenCalled())
})
