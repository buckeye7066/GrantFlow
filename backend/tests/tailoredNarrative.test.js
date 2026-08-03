/**
 * Tests for Hamilton's per-funder tailored-application flow:
 *   - generation produces per-section tailored text grounded in profile facts,
 *     and the fabrication guard drops an unsupported identity claim from a
 *     fixture (dropped section + a required missing question that blocks approval)
 *   - gap detection surfaces a funder requirement absent from the profile as a
 *     missing question and BLOCKS approval
 *   - approve → approved; edit → edited; inputs-hash change → pending
 *   - the auto-submit gate returns submit=false for unapproved / automation-off
 *     / missing-info, and true only when approved + no gaps + toggle on
 *   - schema self-heal creates the table on a bare db
 *
 * Hermetic: the LLM is injected through generateMbaProposal's own `_deps`
 * seam (so the REAL fabrication guard runs), and the orchestrator loaders are
 * stubbed so no heavy module graph / DB reads are needed.
 */

import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'

const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')
const { generateMbaProposal } = await import('../services/hamilton/hamiltonFullProposalGenerator.js')
const {
  generateTailoredNarrative,
  evaluateAutoSubmitGate,
  reconcileTailoredApplication,
  detectFunderRequirementGaps,
} = await import('../services/hamilton/tailoredNarrative.js')
const {
  ensureTailoredApplicationsTable,
  getTailoredApplication,
  approveTailoredApplication,
  saveTailoredApplicationEdit,
} = await import('../services/hamilton/tailoredApplicationStore.js')

// ── fixtures ─────────────────────────────────────────────────────────

function baseProfile(overrides = {}) {
  return {
    id: 'prof-1',
    display_name: 'Jordan Rivera',
    basic_information: {
      first_name: 'Jordan', last_name: 'Rivera', email: 'jordan@example.com',
      city: 'Knoxville', state: 'TN',
    },
    essays: {
      personal_statement: 'First-generation college student pursuing nursing to serve rural clinics after a parental layoff.',
      goals: 'Complete a BSN and work in a Title-X community health center.',
      statement_of_need: 'Household income fell sharply after a layoff, leaving a tuition gap.',
    },
    financial_information: { annual_income: 24000, fafsa_status: 'submitted' },
    ...overrides,
  }
}

const CLEAN_GRANT = { id: 'grant-1', profile_id: 'prof-1', funding_opportunity_id: null }
const CLEAN_OPP = {
  id: 'opp-1', title: 'Community Nursing Access Grant', sponsor: 'Volunteer Foundation',
  description: 'Supports nursing students serving rural communities.',
  priorities: 'Measurable community-health outcomes.',
}

// A grounded proposal with NO fabricated claims and NO evidence gaps.
function groundedProposalJson() {
  return {
    sections: [
      { key: 'need_statement', title: 'Statement of Need', content: 'Jordan Rivera faces a tuition gap after a household layoff and seeks to serve rural clinics.', evidence_gaps: [] },
      { key: 'goals_objectives', title: 'Goals & Objectives (SMART)', content: 'Complete a BSN within four years and practice in a Title-X community health center.', evidence_gaps: [] },
    ],
    funder_alignment: { requirements: ['Community-health outcomes'], alignment: [] },
    evidence_gaps: [],
    recommendations: [],
  }
}

// A proposal whose cover_letter fabricates an LGBTQ+ identity the profile does
// not support — the deterministic fabrication guard must strip that sentence
// (→ placeholder → section dropped from tailored fields + a required gap).
function fabricatedProposalJson() {
  return {
    sections: [
      { key: 'need_statement', title: 'Statement of Need', content: 'Jordan Rivera faces a tuition gap after a household layoff.', evidence_gaps: [] },
      { key: 'goals_objectives', title: 'Goals & Objectives (SMART)', content: 'Complete a BSN and serve a Title-X community health center.', evidence_gaps: [] },
      { key: 'cover_letter', title: 'Cover Letter', content: 'As a proud member of the LGBTQ+ community, I bring a unique perspective to nursing.', evidence_gaps: [] },
    ],
    funder_alignment: { requirements: [], alignment: [] },
    evidence_gaps: [],
    recommendations: [],
  }
}

function stubLLM(json) {
  return async () => ({ ok: true, provider: 'stub', json, raw: JSON.stringify(json) })
}

// Inject a generateMbaProposal that runs the REAL generator (incl. fabrication
// guard) against the stubbed LLM. Also stub the orchestrator loaders so the
// generation path stays hermetic.
function deps(json) {
  return {
    orchestrator: {
      loadProfileBundle: async () => baseProfile(),
      loadGrant: async () => CLEAN_GRANT,
      loadOpportunity: async () => null,
    },
    generateMbaProposal: (db, args) =>
      generateMbaProposal(db, { ...args, _deps: { invokeJson: stubLLM(json), getOpenAIOptional: () => null } }),
  }
}

function makeDb() {
  return wrapSqlite(new Database(':memory:'))
}

// ── tests ────────────────────────────────────────────────────────────

describe('tailored narrative generation + grounding', () => {
  it('produces per-section tailored text grounded in profile facts', async () => {
    const db = makeDb()
    const res = await generateTailoredNarrative(db, {
      profileId: 'prof-1', grantId: 'grant-1',
      profile: baseProfile(), opportunity: CLEAN_OPP, grant: CLEAN_GRANT,
      _deps: deps(groundedProposalJson()),
    })
    expect(res.ok).toBe(true)
    expect(Object.keys(res.record.fields)).toEqual(expect.arrayContaining(['need_statement', 'goals_objectives']))
    expect(res.record.fields.need_statement).toMatch(/tuition gap|rural/i)
    expect(res.record.status).toBe('pending')
    expect(res.record.missing_questions).toEqual([])
  })

  it('fabrication guard drops an unsupported identity claim and blocks approval', async () => {
    const db = makeDb()
    const res = await generateTailoredNarrative(db, {
      profileId: 'prof-1', grantId: 'grant-1',
      profile: baseProfile(), opportunity: CLEAN_OPP, grant: CLEAN_GRANT,
      _deps: deps(fabricatedProposalJson()),
    })
    expect(res.ok).toBe(true)
    // The fabricated LGBTQ+ claim was flagged...
    expect(res.fabrication_flags.length).toBeGreaterThan(0)
    // ...its section (cover_letter) is NOT stored as submission-ready text...
    expect(res.record.fields.cover_letter).toBeUndefined()
    expect(res.record.fields.need_statement).toBeDefined()
    // ...and it surfaces as a required missing question that blocks approval.
    expect(res.record.missing_questions.length).toBeGreaterThan(0)
    const gate = await evaluateAutoSubmitGate(db, {
      profileId: 'prof-1', grantId: 'grant-1', profile: baseProfile(), opportunity: CLEAN_OPP, grant: CLEAN_GRANT,
    })
    expect(gate.submit).toBe(false)
    expect(gate.reason).toBe('missing_info')
  })
})

describe('funder-requirement gap detection', () => {
  it('flags a funder requirement absent from the profile as a missing question', () => {
    const opportunity = {
      ...CLEAN_OPP,
      eligibility_text: 'Applicants must submit an official academic transcript with the application.',
    }
    const gaps = detectFunderRequirementGaps({ profile: baseProfile(), opportunity, grant: CLEAN_GRANT })
    expect(gaps.map((g) => g.requirement)).toContain('transcript')
  })

  it('does NOT flag a requirement the profile already satisfies', () => {
    const opportunity = { ...CLEAN_OPP, eligibility_text: 'A personal statement is required.' }
    const gaps = detectFunderRequirementGaps({ profile: baseProfile(), opportunity, grant: CLEAN_GRANT })
    // The profile has a substantial personal_statement in essays.
    expect(gaps.map((g) => g.requirement)).not.toContain('personal_statement')
  })
})

describe('approval lifecycle + hash reconcile', () => {
  it('approve → approved, edit → edited', async () => {
    const db = makeDb()
    await generateTailoredNarrative(db, {
      profileId: 'prof-1', grantId: 'grant-1',
      profile: baseProfile(), opportunity: CLEAN_OPP, grant: CLEAN_GRANT,
      _deps: deps(groundedProposalJson()),
    })
    const approved = await approveTailoredApplication(db, { profileId: 'prof-1', grantId: 'grant-1', approvedBy: 'user-1' })
    expect(approved.status).toBe('approved')
    expect(approved.approved_by).toBe('user-1')

    const edited = await saveTailoredApplicationEdit(db, {
      profileId: 'prof-1', grantId: 'grant-1', fields: { need_statement: 'Owner-edited need statement.' }, approvedBy: 'user-1',
    })
    expect(edited.status).toBe('edited')
    expect(edited.fields.need_statement).toBe('Owner-edited need statement.')
    // Untouched section preserved by the merge.
    expect(edited.fields.goals_objectives).toBeDefined()
  })

  it('bounces an approved record back to pending when the inputs hash changes', async () => {
    const db = makeDb()
    await generateTailoredNarrative(db, {
      profileId: 'prof-1', grantId: 'grant-1',
      profile: baseProfile(), opportunity: CLEAN_OPP, grant: CLEAN_GRANT,
      _deps: deps(groundedProposalJson()),
    })
    await approveTailoredApplication(db, { profileId: 'prof-1', grantId: 'grant-1', approvedBy: 'user-1' })

    // Applicant materially rewrote their essays → grounding inputs changed.
    const changedProfile = baseProfile({
      essays: { personal_statement: 'Completely different story about aerospace engineering.', goals: 'Different goals.' },
    })
    const reconciled = await reconcileTailoredApplication(db, {
      profileId: 'prof-1', grantId: 'grant-1', profile: changedProfile, opportunity: CLEAN_OPP, grant: CLEAN_GRANT,
    })
    expect(reconciled.status).toBe('pending')
    expect(reconciled.approved_by).toBeNull()
  })
})

describe('auto-submit gate', () => {
  async function seedApproved(db, { profile = baseProfile() } = {}) {
    await generateTailoredNarrative(db, {
      profileId: 'prof-1', grantId: 'grant-1',
      profile, opportunity: CLEAN_OPP, grant: CLEAN_GRANT,
      _deps: deps(groundedProposalJson()),
    })
    await approveTailoredApplication(db, { profileId: 'prof-1', grantId: 'grant-1', approvedBy: 'user-1' })
  }

  // OWNER RULE 2026-08-03: "auto submit should mean auto submit. No more, no
  // less." Selecting auto-submit IS the review decision — a missing or
  // unapproved tailored record no longer withholds. Only genuine
  // incompleteness (missing required questions) or the toggle being off can.
  it('submits when no tailored application exists (auto-submit selected is the decision)', async () => {
    const db = makeDb()
    await ensureTailoredApplicationsTable(db)
    const gate = await evaluateAutoSubmitGate(db, { profileId: 'prof-1', grantId: 'grant-1', profile: baseProfile() })
    expect(gate.submit).toBe(true)
    expect(gate.reason).toBeNull()
  })

  it('submits when generated but never human-approved (not_approved is no longer a withhold)', async () => {
    const db = makeDb()
    await generateTailoredNarrative(db, {
      profileId: 'prof-1', grantId: 'grant-1',
      profile: baseProfile(), opportunity: CLEAN_OPP, grant: CLEAN_GRANT,
      _deps: deps(groundedProposalJson()),
    })
    const gate = await evaluateAutoSubmitGate(db, {
      profileId: 'prof-1', grantId: 'grant-1', profile: baseProfile(), opportunity: CLEAN_OPP, grant: CLEAN_GRANT,
    })
    expect(gate.submit).toBe(true)
    expect(gate.reason).toBeNull()
  })

  it('false when approved but the auto-submit toggle is OFF (automation_off)', async () => {
    const db = makeDb()
    await seedApproved(db)
    const profileToggledOff = baseProfile({
      automation_preferences: { automations: { hamilton_auto_submit: false } },
    })
    const gate = await evaluateAutoSubmitGate(db, {
      profileId: 'prof-1', grantId: 'grant-1', profile: profileToggledOff, opportunity: CLEAN_OPP, grant: CLEAN_GRANT,
    })
    expect(gate.submit).toBe(false)
    expect(gate.reason).toBe('automation_off')
  })

  it('true ONLY when approved + no missing questions + toggle on', async () => {
    const db = makeDb()
    await seedApproved(db)
    const gate = await evaluateAutoSubmitGate(db, {
      profileId: 'prof-1', grantId: 'grant-1', profile: baseProfile(), opportunity: CLEAN_OPP, grant: CLEAN_GRANT,
    })
    expect(gate.submit).toBe(true)
    expect(gate.reason).toBeNull()
  })
})

describe('schema self-heal', () => {
  it('creates the tailored_applications table on a bare db', async () => {
    const raw = new Database(':memory:')
    const db = wrapSqlite(raw)
    const ok = await ensureTailoredApplicationsTable(db)
    expect(ok).toBe(true)
    const row = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tailored_applications'").get()
    expect(row?.name).toBe('tailored_applications')
    // Idempotent re-run + a round-trip insert/read works.
    await ensureTailoredApplicationsTable(db)
    const rec = await getTailoredApplication(db, { profileId: 'nope', grantId: 'nope' })
    expect(rec).toBeNull()
  })
})
