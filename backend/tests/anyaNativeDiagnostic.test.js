import express from 'express'
import request from 'supertest'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {runWithOwnerAiScope} from '../services/ownerAi/ownerAiScope.js'
const mocks=vi.hoisted(()=>({native:vi.fn(),gateway:vi.fn()}))
vi.mock('@anthropic-ai/sdk',()=>({default:class{constructor(){this.messages={create:mocks.native}}}}))
vi.mock('../utils/aiProviders.js',async()=>({...await vi.importActual('../utils/aiProviders.js'),invokeTextWithFallback:mocks.gateway}))
import router from '../routes/anya.js'
function app(){const app=express();app.use((req,res,next)=>{req.ctx={identityResolved:true,isAdmin:true,userId:'owner',email:'owner@example.test'};req.db={};runWithOwnerAiScope(req,next)});app.use(router);return app}
beforeEach(()=>{vi.stubEnv('NODE_ENV','test');vi.stubEnv('ADMIN_EMAIL','owner@example.test');vi.stubEnv('AGENT_CONTROL_ADMIN_EMAIL','');vi.stubEnv('OWNER_AI_USER_ID','');vi.stubEnv('ANTHROPIC_API_KEY','invalid-fixture-key');vi.stubEnv('OWNER_AI_ALLOW_PAID_FALLBACK','false');mocks.native.mockReset().mockRejectedValue(Object.assign(new Error('Invalid test credential'),{status:401}));mocks.gateway.mockReset().mockResolvedValue({ok:true,text:'ok',provider:'subscription:codex',billing_mode:'subscription',model:'fixture'})})
afterEach(()=>vi.unstubAllEnvs())
it('owner no-metered policy does not falsely certify the Anthropic key using a subscription',async()=>{
 const response=await request(app()).get('/status?test=true')
 expect(response.status).toBe(200);expect(response.body.anthropic).toMatchObject({status:'not_tested',tested:false})
 expect(mocks.native).not.toHaveBeenCalled();expect(mocks.gateway).not.toHaveBeenCalled()
})
it('explicitly enabled native diagnostics test the named provider rather than its fallback',async()=>{
 vi.stubEnv('OWNER_AI_ALLOW_PAID_FALLBACK','true')
 const response=await request(app()).get('/status?test=true')
 expect(response.status).toBe(200);expect(response.body.anthropic.status).toBe('error')
 expect(response.body.anthropic.error.status).toBe(401);expect(mocks.native).toHaveBeenCalledTimes(1);expect(mocks.gateway).not.toHaveBeenCalled()
})
