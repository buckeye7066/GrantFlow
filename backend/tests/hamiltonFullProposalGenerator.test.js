/**
 * Tests for hamiltonFullProposalGenerator — Hamilton's full MBA-level grant
 * proposal author.
 *
 * Hermetic: the LLM call is injected via the `_deps.invokeJson` seam so no
 * network / API key is required. Verifies:
 *   - the section rubric adapts to profile type (individual vs organization)
 *   - evidence gaps (top-level + per-section) are collected, deduped, and
 *     shaped as { kind:'field', key:'proposal_*', ... } missing-info items
 *   - graceful fallback when the LLM throws OR returns ok:false / no sections
 *   - saveProposalDocument persists a `hamilton_proposal` document row
 */

import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'

const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')
const {
  generateMbaProposal,
  saveProposalDocument,
  resolveProfileKind,
  buildEvidencePack,
  rubricForProfileKind,
} = await import('../services/hamilton/hamiltonFullProposalGenerator.js')

const INDIVIDUAL_PROFILE = {
  id: 'prof-indiv-1',
  display_name: 'Jordan Rivera',
  basic_information: {
    first_name: 'Jordan', last_name: 'Rivera', email: 'jordan@example.com',
    city: 'Knoxville', state: 'TN', zip: '37902', household_size: 4,
  },
  essays: {
    personal_statement: 'First-generation college student pursuing nursing to serve rural clinics.',
    goals: 'Complete a BSN and work in a Title-X community health center.',
    financial_hardship: 'Household income fell after a parental layoff.',
  },
  financial_information: { annual_income: 24000, fafsa_status: 'submitted' },
  university_applications: { applications: [{ name: 'UT Knoxville', major: 'Nursing', degree_level: 'Bachelor' }] },
}

const ORG_PROFILE = {
  id: 'prof-org-1',
  applicant_type: 'nonprofit_organization',
  organization: {
    name: 'Rivertown Youth Coalition', ein: '12-3456789', mission: 'After-school STEM for underserved youth.',
    annual_budget: 480000, programs: 'Robotics club, tutoring, summer camp', years_operating: 9,
    staff: '6 FTE, 30 volunteers', outcomes: '82% of participants improved math grades.',
  },
  basic_information: { first_name: 'Dana', last_name: 'Ops', email: 'dana@rivertown.org', city: 'Memphis', state: 'TN' },
}

const OPPORTUNITY = {
  id: 'opp-1', title: 'Community STEM Access Grant', funder_name: 'Volunteer Foundation',
  description: 'Supports STEM access programs for low-income students.',
  eligibility_text: '501(c)(3) nonprofits or students in TN.',
  priorities: 'Measurable academic outcomes; sustainability.',
  amount_max: 25000, deadline: '2026-09-30',
}

function stubInvokeJson(json) {
  return async () => ({ ok: true, provider: 'stub', json, raw: JSON.stringify(json) })
}

function orgProposalJson() {
  return {
    sections: [
      { key: 'need_statement', title: 'Statement of Need', content: 'Rivertown youth lack STEM access. [ EVIDENCE NEEDED: current waitlist size ]', evidence_gaps: [{ key: 'waitlist_size', label: 'Current program waitlist size', description: 'Add to organization profile.' }] },
      { key: 'goals_objectives', title: 'Goals & Objectives (SMART)', content: 'By 2027, enroll 120 students; raise math proficiency 15%.' },
      { key: 'organizational_capacity', title: 'Organizational Capacity', content: '9 years operating, 6 FTE, 30 volunteers.' },
      { key: 'sustainability', title: 'Sustainability Plan', content: 'Diversify funding across 3 foundations.' },
    ],
    funder_alignment: {
      requirements: ['501(c)(3) eligibility', 'Measurable academic outcomes'],
      alignment: [{ requirement: 'Measurable academic outcomes', addressed_in: 'evaluation_outcomes', note: 'Tracks math proficiency.' }],
    },
    evidence_gaps: [{ key: 'audit', label: 'Most recent financial audit', description: 'Upload the FY audit.', required: true }],
    recommendations: ['Attach a logic model.'],
  }
}

function individualProposalJson() {
  return {
    sections: [
      { key: 'cover_letter', title: 'Cover Letter', content: 'Dear Volunteer Foundation, I am applying...' },
      { key: 'need_statement', title: 'Statement of Need', content: 'First-gen nursing student with reduced household income.' },
      { key: 'goals_objectives', title: 'Goals & Objectives (SMART)', content: 'Complete BSN by 2028; serve a rural clinic.' },
      { key: 'budget_narrative', title: 'Budget Narrative', content: 'Tuition $18k, fees $2k.' },
    ],
    funder_alignment: { requirements: ['TN student eligibility'], alignment: [] },
    evidence_gaps: [],
    recommendations: [],
  }
}

describe('resolveProfileKind + rubric', () => {
  it('classifies an individual profile', () => {
    expect(resolveProfileKind(INDIVIDUAL_PROFILE)).toBe('individual')
    expect(rubricForProfileKind('individual').map((r) => r.key)).toContain('personal_capacity')
  })

  it('classifies an organization profile', () => {
    expect(resolveProfileKind(ORG_PROFILE)).toBe('organization')
    const keys = rubricForProfileKind('organization').map((r) => r.key)
    expect(keys).toContain('organizational_capacity')
    expect(keys).toContain('sustainability')
  })

  it('extracts labeled evidence from the profile without inventing empties', () => {
    const ev = buildEvidencePack(INDIVIDUAL_PROFILE, 'individual')
    expect(ev.applicant_name).toBe('Jordan Rivera')
    expect(ev.school).toBe('UT Knoxville')
    expect(ev.annual_income).toBe('24000')
    // A field that is absent must not appear at all.
    expect(ev.organization_name).toBeUndefined()
  })
})

describe('generateMbaProposal — section rubric per profile type', () => {
  it('produces organization sections including capacity + sustainability', async () => {
    const res = await generateMbaProposal(null, {
      profile: ORG_PROFILE, opportunity: OPPORTUNITY,
      _deps: { invokeJson: stubInvokeJson(orgProposalJson()), getOpenAIOptional: () => null },
    })
    expect(res.ok).toBe(true)
    expect(res.kind).toBe('organization')
    const keys = res.sections.map((s) => s.key)
    expect(keys).toContain('organizational_capacity')
    expect(keys).toContain('sustainability')
    expect(res.funder_alignment.requirements.length).toBeGreaterThan(0)
    expect(res.meta.section_keys).toEqual(keys)
  })

  it('produces individual sections (cover letter + need) for a student profile', async () => {
    const res = await generateMbaProposal(null, {
      profile: INDIVIDUAL_PROFILE, opportunity: OPPORTUNITY,
      _deps: { invokeJson: stubInvokeJson(individualProposalJson()), getOpenAIOptional: () => null },
    })
    expect(res.ok).toBe(true)
    expect(res.kind).toBe('individual')
    expect(res.sections.map((s) => s.key)).toContain('cover_letter')
    expect(res.sections.map((s) => s.key)).toContain('need_statement')
  })
})

describe('generateMbaProposal — evidence-gap flagging', () => {
  it('collects + dedupes per-section and top-level gaps as proposal_ missing-info items', async () => {
    const res = await generateMbaProposal(null, {
      profile: ORG_PROFILE, opportunity: OPPORTUNITY,
      _deps: { invokeJson: stubInvokeJson(orgProposalJson()), getOpenAIOptional: () => null },
    })
    expect(res.ok).toBe(true)
    // one per-section gap (waitlist_size) + one top-level gap (audit) = 2
    expect(res.evidence_gaps.length).toBe(2)
    for (const g of res.evidence_gaps) {
      expect(g.kind).toBe('field')
      expect(g.key.startsWith('proposal_')).toBe(true)
      expect(typeof g.label).toBe('string')
    }
    const keys = res.evidence_gaps.map((g) => g.key)
    expect(new Set(keys).size).toBe(keys.length) // deduped
  })
})

describe('generateMbaProposal — graceful fallback', () => {
  it('returns ok:false (never throws) when the LLM throws', async () => {
    const res = await generateMbaProposal(null, {
      profile: INDIVIDUAL_PROFILE, opportunity: OPPORTUNITY,
      _deps: { invokeJson: async () => { throw new Error('boom') }, getOpenAIOptional: () => null },
    })
    expect(res.ok).toBe(false)
    expect(res.sections).toEqual([])
    expect(res.error).toMatch(/boom/)
  })

  it('returns ok:false when the LLM reports failure', async () => {
    const res = await generateMbaProposal(null, {
      profile: INDIVIDUAL_PROFILE, opportunity: OPPORTUNITY,
      _deps: { invokeJson: async () => ({ ok: false, json: null, error: new Error('no provider') }), getOpenAIOptional: () => null },
    })
    expect(res.ok).toBe(false)
    expect(res.error).toBeTruthy()
  })

  it('returns ok:false when the model returns zero groundable sections', async () => {
    const res = await generateMbaProposal(null, {
      profile: INDIVIDUAL_PROFILE, opportunity: OPPORTUNITY,
      _deps: { invokeJson: stubInvokeJson({ sections: [{ key: 'need_statement', content: '' }] }), getOpenAIOptional: () => null },
    })
    expect(res.ok).toBe(false)
    expect(res.sections).toEqual([])
  })

  it('throws only for a programming error (missing profile)', async () => {
    await expect(generateMbaProposal(null, { profile: null })).rejects.toThrow(/profile required/)
  })
})

describe('saveProposalDocument — persistence', () => {
  function makeDocsDb() {
    const sqlite = new Database(':memory:')
    // Minimal documents shape matching insertDocumentRecord's fallback columns.
    sqlite.exec(`
      CREATE TABLE documents (
        id TEXT PRIMARY KEY, organization_id TEXT, grant_id TEXT, profile_id TEXT,
        name TEXT, type TEXT, file_url TEXT, file_path TEXT, file_size INTEGER,
        mime_type TEXT, extracted_text TEXT, processing_status TEXT, notes TEXT
      );
      CREATE TABLE profile_documents (profile_id TEXT, document_id TEXT);
    `)
    return wrapSqlite(sqlite)
  }

  it('inserts a hamilton_proposal document linked to the profile', async () => {
    const db = makeDocsDb()
    const proposal = {
      kind: 'organization',
      sections: [
        { key: 'need_statement', title: 'Statement of Need', content: 'Need text.', evidence_gaps: [] },
        { key: 'sustainability', title: 'Sustainability Plan', content: 'Sustain text.', evidence_gaps: [] },
      ],
      funder_alignment: { requirements: ['R1'], alignment: [{ requirement: 'R1', addressed_in: 'need_statement', note: 'covered' }] },
      evidence_gaps: [{ kind: 'field', key: 'proposal_audit', label: 'Audit', description: 'Upload it', required: true }],
      recommendations: ['Add a logic model.'],
      meta: { provider: 'stub' },
    }
    const out = await saveProposalDocument(db, {
      profile: ORG_PROFILE, opportunity: OPPORTUNITY, proposal, taskId: 'task-1', userId: 'user-1',
    })
    expect(out.proposal_document_id).toBeTruthy()
    expect(out.title).toMatch(/Full Proposal/)

    const row = await db.prepare('SELECT * FROM documents WHERE id = ?').get(out.proposal_document_id)
    expect(row.type).toBe('hamilton_proposal')
    expect(row.profile_id).toBe(ORG_PROFILE.id)
    expect(row.extracted_text).toMatch(/Statement of Need/)
    expect(row.extracted_text).toMatch(/Funder Alignment/)

    const link = await db.prepare('SELECT * FROM profile_documents WHERE document_id = ?').get(out.proposal_document_id)
    expect(link.profile_id).toBe(ORG_PROFILE.id)
  })

  it('rejects a proposal with no sections', async () => {
    const db = makeDocsDb()
    await expect(saveProposalDocument(db, { profile: ORG_PROFILE, proposal: { sections: [] } }))
      .rejects.toThrow(/sections required/)
  })
})
