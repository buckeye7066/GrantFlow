import { EventEmitter } from 'node:events'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { runWithOwnerAiScope } from '../services/ownerAi/ownerAiScope.js'
const calls = vi.hoisted(() => ({ native:vi.fn(), json:vi.fn(), text:vi.fn(), tool:vi.fn(),cancelled:vi.fn() }))
vi.mock('../utils/openaiClient.js', () => ({
  createOpenAIClient:()=>({openai:{chat:{completions:{create:calls.native}}}}),
  summarizeOpenAIError:e=>({status:e.status??null,isRateLimit:e.status===429,message:'provider unavailable'}),
}))
vi.mock('../utils/aiProviders.js', () => ({invokeJsonWithFallback:calls.json,invokeTextWithFallback:calls.text}))
vi.mock('../services/anyaToolRegistry.js', () => ({
  listToolMetadata:()=>[{name:'profile.find',description:'Find an accessible profile',schema:{type:'object',properties:{name:{type:'string'}}}}],
  invokeTool:calls.tool,
}))
vi.mock('../services/anyaRuns.js',async()=>({...await vi.importActual('../services/anyaRuns.js'),isAnyaRunCancelRequested:calls.cancelled}))
import { generateAssistantResponse } from '../services/anyaOrchestrator.js'
const user={isAdmin:true,userId:'real-owner',email:'owner@example.com'}
const ownerRequest=()=>({ctx:{...user,identityResolved:true},res:new EventEmitter()})
beforeEach(()=>{
  Object.values(calls).forEach(mock=>mock.mockReset());vi.stubEnv('ADMIN_EMAIL','owner@example.com');vi.stubEnv('AGENT_CONTROL_ADMIN_EMAIL','');vi.stubEnv('OWNER_AI_USER_ID','')
  calls.native.mockResolvedValue({choices:[{message:{content:'metered-native'}}]})
  calls.json.mockResolvedValue({ok:true,provider:'subscription:codex',billing_mode:'subscription',json:{reply:'monthly subscription reply',tool_calls:[]}})
  calls.text.mockResolvedValue({ok:true,text:'plain fallback'})
  calls.cancelled.mockResolvedValue(false)
  calls.tool.mockResolvedValue({output:{found:true}})
})
afterEach(()=>vi.unstubAllEnvs())
it('owner chat reaches the subscription gateway before any direct metered call',async()=>{
  const result=await runWithOwnerAiScope(ownerRequest(),()=>generateAssistantResponse(null,user,'fixture',{content:'Explain my next step'}))
  expect(result).toBe('monthly subscription reply');expect(calls.native).not.toHaveBeenCalled();expect(calls.json).toHaveBeenCalledTimes(1)
})
it('owner subscription tool requests execute the same registry and use its actual result',async()=>{
  calls.json.mockResolvedValueOnce({ok:true,provider:'subscription:codex',json:{reply:'',tool_calls:[{name:'profile__find',arguments:{name:'Fixture Person'}}]}})
  const result=await runWithOwnerAiScope(ownerRequest(),()=>generateAssistantResponse(null,user,'fixture',{content:'Find Fixture Person'}))
  expect(calls.tool).toHaveBeenCalledWith('profile.find',{name:'Fixture Person'},expect.objectContaining({ctx:user,user}))
  expect(result).toBe('monthly subscription reply');expect(calls.native).not.toHaveBeenCalled()
  expect(calls.json.mock.calls[1][0].prompt).toContain('found')
})
it('a paid quota failure can use a free model without losing authorized tools',async()=>{
  calls.native.mockRejectedValue(Object.assign(new Error('quota exhausted'),{status:429}))
  calls.json.mockResolvedValueOnce({ok:true,provider:'free:fixture',json:{reply:'',tool_calls:[{name:'profile__find',arguments:{name:'Fixture Person'}}]}})
    .mockResolvedValueOnce({ok:true,provider:'free:fixture',json:{reply:'Actual profile lookup complete',tool_calls:[]}})
  const result=await generateAssistantResponse(null,user,'fixture',{content:'Find Fixture Person'})
  expect(result).toBe('Actual profile lookup complete');expect(calls.tool).toHaveBeenCalledTimes(1);expect(calls.native).toHaveBeenCalledTimes(1)
})
it('unknown tool names returned by a subscription never execute',async()=>{
  calls.json.mockResolvedValue({ok:true,provider:'subscription:codex',json:{reply:'',tool_calls:[{name:'unlisted_delete_everything',arguments:{}}]}})
  await runWithOwnerAiScope(ownerRequest(),()=>generateAssistantResponse(null,user,'fixture',{content:'Explain my next step'}))
  expect(calls.tool).not.toHaveBeenCalled();expect(calls.native).not.toHaveBeenCalled()
})


it('Stop during owner planning returns the stopped reply, not a normal fallback',async()=>{
  const request=ownerRequest()
  calls.json.mockImplementation(async()=>{calls.cancelled.mockResolvedValue(true);request.res.emit('close');throw new DOMException('Stopped','AbortError')})
  const result=await runWithOwnerAiScope(request,()=>generateAssistantResponse(null,user,'fixture',{content:'Explain my next step',runId:'run-proof'}))
  expect(result).toMatch(/Stopped/);expect(calls.text).not.toHaveBeenCalled();expect(calls.native).not.toHaveBeenCalled()
})
