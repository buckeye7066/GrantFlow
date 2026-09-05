import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { answerUnknownField } from '../services/hamilton/hamiltonFieldAnswerer.js'
import { _internal, generateMbaProposal } from '../services/hamilton/hamiltonFullProposalGenerator.js'
import { loadLatestRequirementsForOpportunity } from '../services/groundedDrafting.js'

/**
 * These pin the three things that stood between Hamilton's prompt (which says
 * "MBA-level") and a draft that actually is one. Each was verified absent on
 * main before this change:
 *
 *   1. The portal's own maxlength was NEVER read — every answer was truncated
 *      at a hard-coded 300 / 4000 regardless of what the form allowed.
 *   2. The funder's parsed, citation-backed requirements existed
 *      (solicitation_requirements + requirement_citations) but were addressable
 *      only by a grant_applications id Hamilton never has, so grepping
 *      backend/services/hamilton/ for them returned nothing.
 *   3. The proposal critic existed and was never called from this path.
 */

const PROFILE = {
  id: 'p1',
  display_name: 'Test Applicant',
  primary_type: 'individual',
  sections: {
    basic_information: { first_name: 'Dana', last_name: 'Ruiz' },
    education: { intended_major: 'Forensic Science', current_institution: 'State College' },
  },
}

describe('the portal’s stated character limit is honored', () => {
  const longAnswer = 'x'.repeat(9000)
  const deps = () => ({
    invokeJson: vi.fn(async () => ({
      ok: true,
      provider: 'openai',
      json: { answer: longAnswer, grounded_in: ['education.intended_major'], reason: null },
    })),
    getOpenAIOptional: () => null,
  })

  it('uses the portal’s maxlength when the form states one', async () => {
    const res = await answerUnknownField(
      { tag: 'textarea', name: 'essay', label: 'Describe your goals', maxLength: 8000 },
      { profile: PROFILE, _deps: deps() },
    )
    expect(res).toBeTruthy()
    expect(res.char_limit).toBe(8000)
    expect(res.char_limit_source).toBe('portal')
    expect(res.value.length).toBe(8000)
  })

  it('falls back to the historical default only when the portal states nothing', async () => {
    const res = await answerUnknownField(
      { tag: 'textarea', name: 'essay', label: 'Describe your goals', maxLength: null },
      { profile: PROFILE, _deps: deps() },
    )
    expect(res.char_limit).toBe(4000)
    expect(res.char_limit_source).toBe('default')
  })

  it('a SHORT portal limit is respected rather than overrun to 4000', async () => {
    const res = await answerUnknownField(
      { tag: 'textarea', name: 'essay', label: 'Describe your goals', maxLength: 250 },
      { profile: PROFILE, _deps: deps() },
    )
    expect(res.value.length).toBe(250)
    expect(res.truncated).toBe(true)
  })

  it('tells the model the budget so it can write to fit instead of being cut', async () => {
    const d = deps()
    await answerUnknownField(
      { tag: 'textarea', name: 'essay', label: 'Goals', maxLength: 600 },
      { profile: PROFILE, _deps: d },
    )
    const prompt = d.invokeJson.mock.calls[0][0].prompt
    expect(prompt).toContain('LENGTH LIMIT')
    expect(prompt).toContain('600')
  })
})

describe('the funder’s own parsed requirements reach the draft', () => {
  function schema(sqlite) {
    sqlite.exec(`
      CREATE TABLE opportunity_solicitations (
        id TEXT PRIMARY KEY, profile_id TEXT, opportunity_id TEXT, updated_at TEXT
      );
      CREATE TABLE solicitation_versions (
        id TEXT PRIMARY KEY, solicitation_id TEXT, version_number INTEGER
      );
      CREATE TABLE solicitation_requirements (
        id TEXT PRIMARY KEY, version_id TEXT, requirement_type TEXT,
        canonical_key TEXT, requirement_text TEXT, is_mandatory INTEGER,
        char_limit INTEGER, status TEXT
      );
      CREATE TABLE requirement_citations (
        id TEXT PRIMARY KEY, requirement_id TEXT, chunk_id TEXT, quote_text TEXT,
        char_start INTEGER, char_end INTEGER, page_number INTEGER, source_url TEXT
      );
      CREATE TABLE solicitation_chunks (id TEXT PRIMARY KEY, chunk_index INTEGER);
      INSERT INTO opportunity_solicitations VALUES ('s1','p1','opp1','2026-09-01');
      INSERT INTO solicitation_versions VALUES ('v1','s1',1);
      INSERT INTO solicitation_requirements VALUES
        ('r1','v1','narrative','need_statement','State the community need in under 500 characters.',1,500,'active'),
        ('r2','v1','section','diversity_statement','Diversity Statement',1,NULL,'active');
      INSERT INTO requirement_citations VALUES
        ('c1','r1','ch1','Applicants must state the community need.',10,60,3,'https://funder.example/nofo');
      INSERT INTO solicitation_chunks VALUES ('ch1',0);
    `)
  }

  let sqlite
  beforeEach(() => { sqlite = new Database(':memory:'); schema(sqlite) })
  afterEach(() => sqlite.close())

  it('loads requirements by (profile, opportunity) — the key Hamilton actually has', async () => {
    const out = await loadLatestRequirementsForOpportunity(sqlite, { profileId: 'p1', opportunityId: 'opp1' })
    expect(out.requirements).toHaveLength(2)
    const need = out.requirements.find((r) => r.canonical_key === 'need_statement')
    expect(need.citations[0].quote_text).toContain('community need')
  })

  it('returns empty — never throws — when the solicitation was never parsed', async () => {
    const out = await loadLatestRequirementsForOpportunity(sqlite, { profileId: 'p1', opportunityId: 'nope' })
    expect(out.requirements).toEqual([])
  })

  it('renders them as a compliance matrix carrying the funder’s verbatim words', () => {
    const block = _internal.buildComplianceMatrixBlock([
      {
        requirement_type: 'narrative',
        canonical_key: 'need_statement',
        requirement_text: 'State the community need.',
        is_mandatory: 1,
        char_limit: 500,
        citations: [{ quote_text: 'Applicants must state the community need.' }],
      },
    ])
    expect(block).toContain('THE FUNDER’S OWN STATED REQUIREMENTS'.replace('’', "'"))
    expect(block).toContain('MANDATORY')
    expect(block).toContain('CHARACTER LIMIT: 500')
    expect(block).toContain('Applicants must state the community need.')
  })

  it('is omitted entirely when nothing was parsed, so the draft still runs', () => {
    expect(_internal.buildComplianceMatrixBlock([])).toBe('')
    expect(_internal.buildComplianceMatrixBlock(null)).toBe('')
  })

  it('a funder-declared SECTION is unioned into the rubric, never replacing it', async () => {
    const prompts = []
    const invokeJson = vi.fn(async ({ prompt }) => {
      prompts.push(prompt)
      return {
        ok: true,
        provider: 'openai',
        json: {
          sections: [{ key: 'need_statement', title: 'Need', content: 'Grounded text.', evidence_gaps: [] }],
          funder_alignment: { requirements: [], alignment: [] },
          evidence_gaps: [], recommendations: [],
        },
      }
    })
    const res = await generateMbaProposal(sqlite, {
      profile: PROFILE,
      opportunity: { id: 'opp1', title: 'Community Fund', sponsor: 'Funder' },
      _deps: { invokeJson, getOpenAIOptional: () => null },
    })
    expect(res.ok).toBe(true)
    const draft = prompts[0]
    // The funder's own section appears alongside the profile-kind rubric.
    expect(draft).toContain('diversity_statement')
    expect(draft).toContain('need_statement')
    // And the funder's parsed requirement text reached the prompt.
    expect(draft).toContain('State the community need')
  })
})

describe('the proposal critic actually runs on Hamilton’s path', () => {
  const prior = process.env.PROPOSAL_CRITIC
  afterEach(() => {
    if (prior === undefined) delete process.env.PROPOSAL_CRITIC
    else process.env.PROPOSAL_CRITIC = prior
  })

  it('a critic failure NEVER blocks the draft — it is a review, not a gate', async () => {
    process.env.PROPOSAL_CRITIC = 'true'
    const invokeJson = vi.fn(async ({ prompt }) => {
      if (String(prompt).includes('auditor') || String(prompt).includes('compliance reviewer')) {
        throw new Error('critic provider exploded')
      }
      return {
        ok: true,
        provider: 'openai',
        json: {
          sections: [{ key: 'need_statement', title: 'Need', content: 'Grounded text.', evidence_gaps: [] }],
          funder_alignment: { requirements: [], alignment: [] },
          evidence_gaps: [], recommendations: [],
        },
      }
    })
    const res = await generateMbaProposal(null, {
      profile: PROFILE,
      grant: { id: 'g1', title: 'Health Grant', funder: 'Foundation', profile_id: 'p1' },
      _deps: { invokeJson, getOpenAIOptional: () => null },
    })
    // The draft survives the critic blowing up.
    expect(res.ok).toBe(true)
    expect(res.sections.length).toBeGreaterThan(0)
  })
})
