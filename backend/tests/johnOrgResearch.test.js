/**
 * John pre-draft web research.
 *
 * Verifies the flow added to John's outreach drafting:
 *   pick lead -> searchWeb(org name + location) -> summarize -> feed into the
 *   AI draft prompt.
 *
 * Two layers are tested:
 *   1. johnOrgResearch.js in isolation (query build, summarization, failure
 *      tolerance when searchWeb returns [] or throws).
 *   2. composeEmailWithAI end-to-end with a mocked Anthropic client, proving
 *      (a) the research context is gathered and PASSED INTO the draft prompt
 *      when results exist, and (b) drafting still works when web search returns
 *      [] or throws.
 *
 * The web engine and the Anthropic SDK are mocked so the test never hits the
 * network.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const searchWebMock = vi.fn()
const anthropicCreateMock = vi.fn()

vi.mock('../services/crawlers/webSearchEngine.js', () => ({
  searchWeb: (...a) => searchWebMock(...a),
}))

// Mock the Anthropic SDK so composeEmailWithAI's LLM call is deterministic and
// we can capture the exact prompt John sent (to prove research reached it).
vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    constructor() {
      this.messages = { create: (...a) => anthropicCreateMock(...a) }
    }
  }
  return { default: FakeAnthropic }
})

const { researchOrganization, summarizeResearch, buildResearchQuery } = await import(
  '../services/john/johnOrgResearch.js'
)
const { composeEmailWithAI } = await import('../services/john/johnEmailComposerAI.js')

const RESULTS = [
  {
    url: 'https://helpinghands.org/about',
    title: 'Helping Hands of Memphis — About Us',
    snippet: 'Helping Hands runs a Saturday food pantry and after-school tutoring in South Memphis.',
  },
  {
    url: 'https://news.example.org/helping-hands',
    title: 'Local nonprofit expands tutoring program',
    snippet: 'Helping Hands added a second tutoring site this year serving 120 students.',
  },
]

// A compliant AI body the safety classifiers will pass (no guarantees, no prior
// relationship, no urgency, no dashes), so composeEmailWithAI returns ok:true.
const AI_OUTPUT = JSON.stringify({
  subject: 'A note about Helping Hands tutoring',
  body:
    'Hi team, I came across the work Helping Hands does with after-school tutoring in South Memphis and wanted to reach out. ' +
    'I am Dr. John White and I built GrantFlow, a tool that finds funding that fits an organization. ' +
    'It could help you find grants for your tutoring and food pantry work.',
})

function fakeMessage(text) {
  return { content: [{ type: 'text', text }] }
}

const lead = {
  lead_id: 'lead-1',
  organization_name: 'Helping Hands of Memphis',
  location: 'Memphis, TN',
  qualified: true,
  contact_points: [{ type: 'email', value: 'director@helpinghands.org', name: 'Pat Lee', role: 'Executive Director' }],
  public_evidence: [{ type: 'mission_statement', text: 'Fight hunger and support youth education.' }],
  source_urls: ['https://helpinghands.org'],
}

let originalEnv

beforeEach(() => {
  searchWebMock.mockReset()
  anthropicCreateMock.mockReset()
  originalEnv = { ...process.env }
  // Force the AI composer's API-key gate open and the research step on. A
  // postal address must be configured so the code-appended footer satisfies
  // the CAN-SPAM physical-address classifier (else the body is blocked and the
  // composer falls back to the template, which we are not testing here).
  process.env.ANTHROPIC_API_KEY = 'test-key'
  process.env.JOHN_PHYSICAL_ADDRESS = '123 Main St, Memphis, TN 38103'
  delete process.env.JOHN_WEB_RESEARCH
  anthropicCreateMock.mockResolvedValue(fakeMessage(AI_OUTPUT))
})

afterEach(() => {
  process.env = originalEnv
})

describe('johnOrgResearch helpers', () => {
  it('buildResearchQuery combines org name + location, and is empty without a name', () => {
    expect(buildResearchQuery('Helping Hands', 'Memphis, TN')).toBe('Helping Hands Memphis, TN')
    expect(buildResearchQuery('Helping Hands', '')).toBe('Helping Hands')
    expect(buildResearchQuery('', 'Memphis')).toBe('')
    expect(buildResearchQuery(null, null)).toBe('')
  })

  it('summarizeResearch uses ONLY returned title + snippet, and is empty for no results', () => {
    const summary = summarizeResearch(RESULTS)
    expect(summary).toContain('Helping Hands of Memphis')
    expect(summary).toContain('Saturday food pantry')
    expect(summary).toContain('120 students')
    expect(summarizeResearch([])).toBe('')
    expect(summarizeResearch(null)).toBe('')
  })
})

describe('researchOrganization — failure tolerance', () => {
  it('returns a summary + results when searchWeb returns results', async () => {
    searchWebMock.mockResolvedValue(RESULTS)
    const out = await researchOrganization({ orgName: 'Helping Hands of Memphis', location: 'Memphis, TN' })
    expect(searchWebMock).toHaveBeenCalledOnce()
    const [query, opts] = searchWebMock.mock.calls[0]
    expect(query).toBe('Helping Hands of Memphis Memphis, TN')
    expect(opts).toMatchObject({ count: expect.any(Number), timeoutMs: expect.any(Number) })
    expect(out.summary).toContain('food pantry')
    expect(out.results).toHaveLength(2)
  })

  it('returns an empty summary when searchWeb returns [] (e.g. SEARXNG_URL unset)', async () => {
    searchWebMock.mockResolvedValue([])
    const out = await researchOrganization({ orgName: 'Helping Hands of Memphis' })
    expect(out.summary).toBe('')
    expect(out.results).toEqual([])
  })

  it('NEVER throws when searchWeb itself throws — returns empty summary', async () => {
    searchWebMock.mockRejectedValue(new Error('network down'))
    const out = await researchOrganization({ orgName: 'Helping Hands of Memphis' })
    expect(out.summary).toBe('')
    expect(out.results).toEqual([])
  })

  it('skips search entirely (no call) when JOHN_WEB_RESEARCH=off', async () => {
    process.env.JOHN_WEB_RESEARCH = 'off'
    const out = await researchOrganization({ orgName: 'Helping Hands of Memphis' })
    expect(searchWebMock).not.toHaveBeenCalled()
    expect(out.summary).toBe('')
  })
})

describe('composeEmailWithAI — research feeds the draft prompt', () => {
  it('(a) gathers research and passes the context INTO the draft prompt when results exist', async () => {
    searchWebMock.mockResolvedValue(RESULTS)

    const result = await composeEmailWithAI(lead, {})
    expect(result.ok).toBe(true)

    // The research step ran with org name + location.
    expect(searchWebMock).toHaveBeenCalledOnce()
    expect(searchWebMock.mock.calls[0][0]).toBe('Helping Hands of Memphis Memphis, TN')

    // The prompt sent to the LLM must contain the research findings.
    expect(anthropicCreateMock).toHaveBeenCalledOnce()
    const sentArgs = anthropicCreateMock.mock.calls[0][0]
    const userContent = sentArgs.messages[0].content
    expect(userContent).toContain('web_research')
    expect(userContent).toContain('food pantry')
    expect(userContent).toContain('120 students')

    // And the personalization audit records that research was used.
    expect(result.personalization.web_research.used).toBe(true)
    expect(result.personalization.web_research.result_count).toBe(2)
    expect(result.personalization.web_research.source_urls).toContain('https://helpinghands.org/about')
  })

  it('(b) still drafts when web search returns [] — no research in prompt', async () => {
    searchWebMock.mockResolvedValue([])

    const result = await composeEmailWithAI(lead, {})
    expect(result.ok).toBe(true)
    expect(anthropicCreateMock).toHaveBeenCalledOnce()

    const userContent = anthropicCreateMock.mock.calls[0][0].messages[0].content
    // web_research is present as a key but null (no snippets injected).
    expect(userContent).toContain('"web_research": null')
    expect(result.personalization.web_research.used).toBe(false)
    expect(result.personalization.web_research.result_count).toBe(0)
  })

  it('(b) still drafts when web search THROWS — drafting is never blocked', async () => {
    searchWebMock.mockRejectedValue(new Error('search backend exploded'))

    const result = await composeEmailWithAI(lead, {})
    expect(result.ok).toBe(true)
    expect(anthropicCreateMock).toHaveBeenCalledOnce()
    expect(result.personalization.web_research.used).toBe(false)
  })
})
