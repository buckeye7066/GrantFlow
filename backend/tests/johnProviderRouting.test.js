import {beforeEach, afterEach, expect, it, vi} from 'vitest'
const gateway = vi.hoisted(() => ({invoke:vi.fn()}))
vi.mock('../utils/aiProviders.js', () => ({invokeJsonWithFallback:gateway.invoke}))
vi.mock('../services/john/johnOrgResearch.js', () => ({researchOrganization:async () => ({summary:'River Lab teaches watershed sampling to local students.',results:[]})}))
const {aiComposerEnabled, composeEmailWithAI} = await import('../services/john/johnEmailComposerAI.js')
const lead = {lead_id:'routing-fixture',organization_name:'River Lab',location:'Dayton, OH',qualified:true,
  public_evidence:[{type:'mission_statement',text:'Teach local students watershed sampling.'}],source_urls:['https://river-lab.example.invalid']}
beforeEach(() => {
  vi.stubEnv('ANTHROPIC_API_KEY','')
  vi.stubEnv('JOHN_AI_DRAFTING','')
  vi.stubEnv('JOHN_PHYSICAL_ADDRESS','123 Test Street, Dayton, OH 45402')
  gateway.invoke.mockReset()
})
afterEach(() => vi.unstubAllEnvs())
it.each(['subscription:codex','openai','free:fixture'])('uses %s for personalized drafting without an Anthropic key', async provider => {
  gateway.invoke.mockResolvedValue({ok:true,provider,model:'fixture-model',billing_mode:provider.startsWith('subscription:')?'subscription':provider.startsWith('free:')?'free_or_local':'paid_api',
    json:{subject:'River Lab watershed education',body:'River Lab teaches local students watershed sampling. GrantFlow could help research funding for that education work.'}})
  expect(aiComposerEnabled()).toBe(true)
  const result = await composeEmailWithAI(lead)
  expect(result.ok).toBe(true)
  expect(gateway.invoke.mock.calls[0][0].prompt).toContain('watershed sampling')
  expect(result.personalization).toMatchObject({provider,model:'fixture-model'})
})
it('honors the explicit drafting disable without model calls', async () => {
  vi.stubEnv('JOHN_AI_DRAFTING','off')
  expect(aiComposerEnabled()).toBe(false)
  expect(await composeEmailWithAI(lead)).toMatchObject({ok:false,reason:'disabled'})
  expect(gateway.invoke).not.toHaveBeenCalled()
})
