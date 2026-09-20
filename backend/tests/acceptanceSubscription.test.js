import {describe,it,expect,vi,afterEach} from 'vitest'
import {fileURLToPath} from 'node:url'
const native=vi.hoisted(()=>({probe:vi.fn(),execute:vi.fn()}))
vi.mock('../../tools/owner-ai/officialCli.mjs',()=>({probeProvider:native.probe,executeJob:native.execute}))
const entry=fileURLToPath(new URL('../../scripts/grantflow-acceptance-50.mjs',import.meta.url))
const originalArgv=process.argv
const result=()=>({ok:true,complete:true,provider:'subscription:codex',billing_mode:'subscription',model:'verified-model',raw:'{"answer":"verified"}',usage:{input_tokens:12,cached_input_tokens:0,output_tokens:8}})
async function api(){return {...await import('../utils/acceptanceSubscriptionContext.js'),...await import('../../tools/owner-ai/acceptance.mjs')}}
function canonical(){process.argv=[process.execPath,entry,'--subscription=codex'];vi.stubEnv('LOCALAPPDATA','C:\\Fixture');native.probe.mockResolvedValue('ready');native.execute.mockResolvedValue(result())}
afterEach(()=>{process.argv=originalArgv;vi.unstubAllEnvs();vi.clearAllMocks()})

describe('explicit canonical acceptance subscription context',()=>{
 it('is off outside an explicitly selected canonical CLI run',async()=>{
  const m=await api();expect(m.getAcceptanceSubscription()).toBeNull()
  await expect(m.runWithCodexAcceptance(async()=>true)).rejects.toThrow(/canonical/)
  expect(native.probe).not.toHaveBeenCalled()
 })
 it('requires verified native ChatGPT authentication, not merely a selected mode',async()=>{
  canonical();native.probe.mockResolvedValue('auth_required');const m=await api();const work=vi.fn()
  await expect(m.runWithCodexAcceptance(work)).rejects.toThrow(/ChatGPT/)
  expect(work).not.toHaveBeenCalled();expect(m.getAcceptanceSubscription()).toBeNull()
 })
 it('does not leak the subscription context after the callback finishes',async()=>{
  canonical();const m=await api()
  await m.runWithCodexAcceptance(async()=>{expect(m.getAcceptanceSubscription().provider).toBe('subscription:codex')})
  expect(m.getAcceptanceSubscription()).toBeNull()
 })
})

describe('native-only inference and honest receipts',()=>{
 it('returns the actual provider, model and JSON while making no fallback call',async()=>{
  canonical();const m=await api();const {invokeJsonWithFallback}=await import('../utils/aiProviders.js');const paid=vi.fn();const free=vi.fn()
  await m.runWithCodexAcceptance(async()=>{
   const response=await invokeJsonWithFallback({prompt:'Extract facts',maxTokens:128,timeoutMs:5000,openai:{chat:{completions:{create:paid}}},freeRoutes:[{id:'not-called',base_url:'https://example.invalid/v1',model:'unused'}],freeClientFactory:free})
   expect(response).toMatchObject({ok:true,provider:'subscription:codex',billing_mode:'subscription',model:'verified-model',json:{answer:'verified'}})
   expect(m.getAcceptanceSubscription().summary()).toMatchObject({completed_calls:1,failed_calls:0,provider:'subscription:codex'})
  });expect(paid).not.toHaveBeenCalled();expect(free).not.toHaveBeenCalled()
 })
 it.each([null,{...result(),raw:'not JSON'},{...result(),complete:false},{...result(),provider:'openai',billing_mode:'paid_api'}])('fails closed on invalid native result %j',async(output)=>{
  canonical();native.execute.mockResolvedValue(output);const m=await api();const {invokeJsonWithFallback}=await import('../utils/aiProviders.js');const fallback=vi.fn()
  await m.runWithCodexAcceptance(async()=>{
   const response=await invokeJsonWithFallback({prompt:'Extract',maxTokens:128,timeoutMs:5000,openai:null,freeRoutes:[{id:'never',base_url:'https://example.invalid/v1',model:'unused'}],freeClientFactory:fallback})
   expect(response.ok).toBe(false);expect(m.getAcceptanceSubscription().summary().failed_calls).toBe(1)
  });expect(fallback).not.toHaveBeenCalled()
 })
 it('forwards cancellation and never accepts a post-abort native response',async()=>{
  canonical();const c=new AbortController();const m=await api();native.execute.mockImplementation(async(_job,{signal})=>{c.abort();expect(signal.aborted).toBe(true);return result()})
  await m.runWithCodexAcceptance(async()=>{const r=await m.getAcceptanceSubscription().invoke({prompt:'Extract',format:'json',maxTokens:128,timeoutMs:5000,signal:c.signal});expect(r.ok).toBe(false)})
 })
 it('scrubs metered model settings during the isolated operation and restores afterward',async()=>{
  canonical();vi.stubEnv('OPENAI_API_KEY','fixture-secret');vi.stubEnv('ANTHROPIC_API_KEY','fixture-secret');vi.stubEnv('FREE_AI_ROUTES','fixture-routes');const m=await api()
  await m.runWithCodexAcceptance(async()=>{expect(process.env.OPENAI_API_KEY).toBeUndefined();expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();expect(process.env.FREE_AI_ROUTES).toBe('[]')})
  expect(process.env.OPENAI_API_KEY).toBe('fixture-secret');expect(process.env.FREE_AI_ROUTES).toBe('fixture-routes')
  expect(native.probe.mock.calls[0][1].env.OPENAI_API_KEY).toBeUndefined()
 })
})

it('preflight verifies subscription identity rather than API configuration',async()=>{
 canonical();const m=await api();const {runDependencyPreflight}=await import('../services/acceptance/amyWebParityAcceptance.js')
 const rows=[{url:'https://grants.gov/example'}];Object.defineProperty(rows,'searchMeta',{value:{provider:'searxng',provenance:'live',status:'ok'}})
 await m.runWithCodexAcceptance(async()=>{
  for(const reported of ['subscription:codex','openai','free:local']){
   const candidates=[{title:'Grounded fixture',sponsor:'Fixture',raw:{blind_extraction:true}}]
   Object.defineProperty(candidates,'extraction_provider',{value:reported})
   const proof=await runDependencyPreflight({env:{SEARXNG_URL:'https://search.example.invalid'},allowedProviders:['searxng'],searchWeb:async()=>rows,extractOpportunitiesFromPage:async()=>candidates})
   expect(proof.extractor.configured_providers).toEqual(['subscription:codex']);expect(proof.ok).toBe(reported==='subscription:codex')
  }
 })
})
it('rejects a retained context after its operator lifetime ends',async()=>{
 canonical();const m=await api();let retained
 await m.runWithCodexAcceptance(async()=>{retained=m.getAcceptanceSubscription()})
 const answer=await retained.invoke({prompt:'Too late',format:'json',maxTokens:128,timeoutMs:1000})
 expect(answer.ok).toBe(false);expect(native.execute).not.toHaveBeenCalled()
})
it('cannot enable subscription mode inside a production process',async()=>{
 canonical();vi.stubEnv('NODE_ENV','production');const m=await api()
 await expect(m.runWithCodexAcceptance(async()=>true)).rejects.toThrow(/canonical/)
 expect(native.probe).not.toHaveBeenCalled()
})
