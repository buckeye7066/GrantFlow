import {EventEmitter} from 'node:events'
import {beforeEach,afterEach,it,expect,vi} from 'vitest'
import {runWithOwnerAiScope} from '../services/ownerAi/ownerAiScope.js'
const state=vi.hoisted(()=>({native:vi.fn(),text:vi.fn(),json:vi.fn()}))
vi.mock('openai',()=>({default:class{constructor(options={}){this.timeout=options.timeout??30000;this.chat={completions:{create:state.native}};this.embeddings={create:state.native};this.responses={create:state.native};this.models={list:state.native,retrieve:state.native}}}}))
vi.mock('../utils/aiProviders.js',()=>({invokeTextWithFallback:state.text,invokeJsonWithFallback:state.json}))
import {createOpenAIClient} from '../utils/openaiClient.js'
const req=()=>({ctx:{identityResolved:true,isAdmin:true,userId:'owner-real',email:'owner@example.com'},res:new EventEmitter()})
beforeEach(()=>{Object.values(state).forEach(mock=>mock.mockReset());vi.stubEnv('ADMIN_EMAIL','owner@example.com');vi.stubEnv('AGENT_CONTROL_ADMIN_EMAIL','');vi.stubEnv('OWNER_AI_USER_ID','');vi.stubEnv('OPENAI_API_KEY','sk-fixture-not-a-real-key');state.native.mockResolvedValue({choices:[{message:{content:'metered'}}]});state.text.mockResolvedValue({ok:true,text:'subscription result',provider:'subscription:codex',billing_mode:'subscription',model:'gpt-6-astra'});state.json.mockResolvedValue({ok:true,json:{answer:42},provider:'subscription:codex',billing_mode:'subscription',model:'gpt-6-astra'})})
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs()})
it('owner calls on a client created before the request still use the subscription gateway',async()=>{
  const client=createOpenAIClient().openai
  const r=await runWithOwnerAiScope(req(),()=>client.chat.completions.create({messages:[{role:'user',content:'Explain'}],max_tokens:100}))
  expect(r.choices[0].message.content).toBe('subscription result');expect(r.billing_mode).toBe('subscription');expect(state.native).not.toHaveBeenCalled()
})
it('owner direct JSON generation preserves response shape without metered usage',async()=>{
  const client=createOpenAIClient().openai
  const r=await runWithOwnerAiScope(req(),()=>client.chat.completions.create({messages:[{role:'user',content:'JSON'}],response_format:{type:'json_object'},max_tokens:100}))
  expect(JSON.parse(r.choices[0].message.content)).toEqual({answer:42});expect(state.native).not.toHaveBeenCalled()
})
it('unsupported owner operations fail before a metered SDK request',async()=>{
  const client=createOpenAIClient().openai
  await expect(runWithOwnerAiScope(req(),()=>client.embeddings.create({input:'fixture'}))).rejects.toThrow(/subscription|owner/i)
  expect(state.native).not.toHaveBeenCalled()
})
it('ordinary customer calls retain the native SDK',async()=>{
  expect((await createOpenAIClient().openai.chat.completions.create({messages:[{role:'user',content:'Explain'}]})).choices[0].message.content).toBe('metered')
  expect(state.native).toHaveBeenCalledTimes(1);expect(state.text).not.toHaveBeenCalled()
})


it('direct customer text calls fall through to a free provider after paid quota exhaustion',async()=>{
  state.native.mockRejectedValue(Object.assign(new Error('quota exhausted'),{status:429}))
  state.text.mockResolvedValue({ok:true,text:'free result',provider:'free:qwen',billing_mode:'free_or_local',model:'qwen'})
  const r=await createOpenAIClient().openai.chat.completions.create({messages:[{role:'user',content:'Explain'}],max_tokens:100})
  expect(r.choices[0].message.content).toBe('free result');expect(r.billing_mode).toBe('free_or_local')
})


it('an owner needs no API key to use the subscription transport',async()=>{
  vi.stubEnv('OPENAI_API_KEY','')
  const r=await runWithOwnerAiScope(req(),()=>createOpenAIClient({ownerInference:true}).openai.chat.completions.create({messages:[{role:'user',content:'Explain'}],max_tokens:100}))
  expect(r.billing_mode).toBe('subscription');expect(state.native).not.toHaveBeenCalled()
})


it('hosted provider tools are not falsely reported as executed by a subscription',async()=>{
  const client=createOpenAIClient().openai
  await expect(runWithOwnerAiScope(req(),()=>client.responses.create({input:'Search',tools:[{type:'web_search'}]}))).rejects.toThrow(/subscription|owner/i)
  expect(state.native).not.toHaveBeenCalled();expect(state.text).not.toHaveBeenCalled()
})
it('owner cancellation prevents a direct metered call or gateway attempt',async()=>{
  const request=req();const client=createOpenAIClient().openai
  await expect(runWithOwnerAiScope(request,async()=>{request.res.emit('close');return client.chat.completions.create({messages:[{role:'user',content:'Explain'}]})})).rejects.toThrow()
  expect(state.native).not.toHaveBeenCalled();expect(state.text).not.toHaveBeenCalled()
})


it('direct Anthropic text callers receive the actual subscription response shape',async()=>{
  const {wrapOwnerSdkClient}=await import('../utils/ownerSdkRouting.js')
  const client=wrapOwnerSdkClient({messages:{create:state.native}},'anthropic')
  const r=await runWithOwnerAiScope(req(),()=>client.messages.create({system:'Be factual',messages:[{role:'user',content:'Explain'}],max_tokens:100}))
  expect(r).toMatchObject({role:'assistant',stop_reason:'end_turn',provider:'subscription:codex',billing_mode:'subscription',content:[{type:'text',text:'subscription result'}]})
  expect(state.native).not.toHaveBeenCalled()
})


it('owner API-key verification calls the native read-only model listing',async()=>{
  state.native.mockResolvedValue({data:[{id:'verified-native-model'}]})
  const result=await runWithOwnerAiScope(req(),()=>createOpenAIClient().openai.models.list())
  expect(result.data[0].id).toBe('verified-native-model');expect(state.native).toHaveBeenCalledTimes(1);expect(state.text).not.toHaveBeenCalled()
})
it('a named adversarial provider cannot silently become another fallback model',async()=>{
  const {wrapOwnerSdkClient}=await import('../utils/ownerSdkRouting.js')
  state.native.mockRejectedValue(Object.assign(new Error('named provider unavailable'),{status:429}))
  const client=wrapOwnerSdkClient({messages:{create:state.native}},'anthropic',{providerSpecific:true})
  await expect(client.messages.create({messages:[{role:'user',content:'Author'}]})).rejects.toThrow('named provider unavailable')
  expect(state.text).not.toHaveBeenCalled()
})
it('named provider roles respect the owner no-metered policy instead of charging or substituting',async()=>{
  vi.stubEnv('OWNER_AI_ALLOW_PAID_FALLBACK','false')
  const {wrapOwnerSdkClient}=await import('../utils/ownerSdkRouting.js')
  const client=wrapOwnerSdkClient({messages:{create:state.native}},'anthropic',{providerSpecific:true})
  await expect(runWithOwnerAiScope(req(),()=>client.messages.create({messages:[{role:'user',content:'Author'}]}))).rejects.toThrow(/provider|owner|metered/i)
  expect(state.native).not.toHaveBeenCalled();expect(state.text).not.toHaveBeenCalled()
})
it.each([{name:'APIConnectionError'},{name:'APIConnectionTimeoutError'},{status:408},{status:425}])('transient direct SDK failures can reach a working fallback: %j',async shape=>{
  state.native.mockRejectedValue(Object.assign(new Error('transient provider failure'),shape))
  state.text.mockResolvedValue({ok:true,text:'free recovered',provider:'free:fixture',billing_mode:'free_or_local',model:'fixture'})
  const result=await createOpenAIClient().openai.chat.completions.create({messages:[{role:'user',content:'Explain'}]})
  expect(result.choices[0].message.content).toBe('free recovered')
})


it('optional native diagnostics preserve configured:false when the owner has no API key',async()=>{
 vi.stubEnv('OPENAI_API_KEY','')
 const client=await runWithOwnerAiScope(req(),()=>createOpenAIClient({allowMissing:true}))
 expect(client.openai).toBeNull();expect(client.diagnostics.present).toBe(false)
})
it('SDK fallback gets only the remainder of the configured client timeout',async()=>{
 vi.useFakeTimers()
 state.native.mockImplementation(async()=>{await new Promise(resolve=>setTimeout(resolve,400));throw Object.assign(new Error('quota exhausted'),{status:429})})
 const pending=createOpenAIClient({timeoutMs:1000}).openai.chat.completions.create({messages:[{role:'user',content:'Explain'}]})
 await vi.advanceTimersByTimeAsync(401);await pending
 expect(state.text.mock.calls[0][0].timeoutMs).toBe(600)
 expect(state.text.mock.calls[0][0].excludedProviders).toEqual(['openai'])
})
it('a fully expired SDK budget does not restart a fallback clock',async()=>{
 vi.useFakeTimers();state.native.mockImplementation(()=>new Promise(()=>{}))
 const pending=createOpenAIClient({timeoutMs:1000}).openai.chat.completions.create({messages:[{role:'user',content:'Explain'}]}).catch(error=>error)
 await vi.advanceTimersByTimeAsync(1001)
 expect(state.native.mock.calls[0][1].signal.aborted).toBe(true)
 expect((await pending).isTimeout).toBe(true);expect(state.text).not.toHaveBeenCalled()
})
