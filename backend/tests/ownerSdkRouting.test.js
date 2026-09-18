import {EventEmitter} from 'node:events'
import {beforeEach,afterEach,it,expect,vi} from 'vitest'
import {runWithOwnerAiScope} from '../services/ownerAi/ownerAiScope.js'
const state=vi.hoisted(()=>({native:vi.fn(),text:vi.fn(),json:vi.fn()}))
vi.mock('openai',()=>({default:class{constructor(){this.chat={completions:{create:state.native}};this.embeddings={create:state.native};this.responses={create:state.native}}}}))
vi.mock('../utils/aiProviders.js',()=>({invokeTextWithFallback:state.text,invokeJsonWithFallback:state.json}))
import {createOpenAIClient} from '../utils/openaiClient.js'
const req=()=>({ctx:{identityResolved:true,isAdmin:true,userId:'owner-real',email:'owner@example.com'},res:new EventEmitter()})
beforeEach(()=>{Object.values(state).forEach(mock=>mock.mockReset());vi.stubEnv('ADMIN_EMAIL','owner@example.com');vi.stubEnv('AGENT_CONTROL_ADMIN_EMAIL','');vi.stubEnv('OWNER_AI_USER_ID','');vi.stubEnv('OPENAI_API_KEY','sk-fixture-not-a-real-key');state.native.mockResolvedValue({choices:[{message:{content:'metered'}}]});state.text.mockResolvedValue({ok:true,text:'subscription result',provider:'subscription:codex',billing_mode:'subscription',model:'gpt-6-astra'});state.json.mockResolvedValue({ok:true,json:{answer:42},provider:'subscription:codex',billing_mode:'subscription',model:'gpt-6-astra'})})
afterEach(()=>vi.unstubAllEnvs())
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
  const r=await runWithOwnerAiScope(req(),()=>createOpenAIClient().openai.chat.completions.create({messages:[{role:'user',content:'Explain'}],max_tokens:100}))
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
