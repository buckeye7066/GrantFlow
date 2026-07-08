/**
 * profileKnownFacts — the "never re-ask a fact the profile already contains"
 * choke point (owner directive 2026-07-06: qualifier questions must not repeat
 * profile information like religion, gender, veteran status, income).
 *
 * Covered:
 *   1. The fact registry answers from CANONICAL and ALIAS locations, and from
 *      derived signals/normalized views.
 *   2. The org/person applicability matrix (no gender/age/income questions for
 *      an organization; no org-type/tax questions for an individual).
 *   3. CROSS-SURFACE integration: a profile with religion + gender + veteran +
 *      income filled gets ZERO questions/prompts for those facts from ALL four
 *      surfaces (detailed readiness, field prompts, gap interview,
 *      coverage-evidence answer_next) — while an empty profile still gets them.
 *   4. The present-fact-counted-as-missing readiness bug: the eligibility and
 *      amount categories now count facts stored under alias sections, so the
 *      readiness score reflects them (asserted as corrected behavior).
 */

import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'

import {
  profileAlreadyAnswers,
  questionAppliesToProfile,
  shouldAskProfileQuestion,
  resolveProfileSide,
  QUESTION_FIELD_TO_FACT,
  CANONICAL_FACTS,
} from '../services/profileKnownFacts.js'
import { computeDetailedReadiness } from '../services/profileReadinessService.js'
import { getProfileFieldPrompts } from '../services/profileFieldPrompts.js'
import { buildProfileGapPlan, FACET_QUESTIONS, GAP_QUESTIONS } from '../services/profileGapInterview.js'
import { buildCoverageEvidence } from '../services/coverageEvidenceService.js'
import { normalizeProfile } from '../services/profileNormalizer.js'

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** The owner's example facts, stored in REALISTIC (partly alias) locations. */
const FILLED_PERSON_SECTIONS = Object.freeze({
  basic_information: {
    state: 'TN', zip: '37311', city: 'Cleveland',
    gender: 'female', date_of_birth: '1958-04-02',
    profile_category: 'individual', email: 'test@example.com',
  },
  demographics: { religious_affiliation: 'Baptist', veteran_status: 'Veteran' },
  financial_information: { household_income: 32000 },
  narrative: { primary_goal: 'help with housing repairs and utility bills', funding_amount_needed: '5000' },
})

const EMPTY_PERSON_SECTIONS = Object.freeze({})

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      organization_id TEXT,
      user_id TEXT,
      display_name TEXT,
      primary_type TEXT,
      applicant_type TEXT,
      status TEXT,
      state TEXT,
      city TEXT,
      zip TEXT,
      zip_code TEXT,
      postal_code TEXT,
      tags TEXT,
      interests TEXT,
      keywords TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE profile_sections (
      profile_id TEXT NOT NULL,
      section_key TEXT NOT NULL,
      data TEXT,
      PRIMARY KEY (profile_id, section_key)
    );
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      profile_id TEXT,
      name TEXT,
      mime_type TEXT,
      extracted_text TEXT,
      uploaded_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      sponsor TEXT,
      source TEXT,
      deadline DATE,
      deadline_type TEXT,
      amount_min REAL,
      amount_max REAL,
      amount_text TEXT,
      amount_status TEXT,
      application_url TEXT,
      apply_url TEXT,
      source_url TEXT,
      source_trust_tier TEXT
    );
    CREATE TABLE profile_opportunity_matches (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      opportunity_id TEXT NOT NULL,
      match_score REAL,
      match_decision TEXT,
      match_explain_json TEXT,
      matcher_version TEXT,
      source_query TEXT,
      discovered_via TEXT
    );
  `)
  return db
}

function seedProfile(db, id, { primaryType = 'individual', sections = {} } = {}) {
  db.prepare(
    `INSERT INTO profiles (id, display_name, primary_type, applicant_type, status)
     VALUES (?, ?, ?, ?, 'active')`,
  ).run(id, `Fixture ${id}`, primaryType, primaryType)
  for (const [key, data] of Object.entries(sections)) {
    db.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
      .run(id, key, JSON.stringify(data))
  }
}

function seedStaleExplainMatch(db, profileId, missingFields) {
  db.prepare(
    `INSERT INTO funding_opportunities (id, title, sponsor, source, application_url)
     VALUES ('opp-stale-${profileId}', 'Stale Explain Grant', 'Fixture Trust', 'benefits_gov', 'https://example.gov/apply')`,
  ).run()
  db.prepare(
    `INSERT INTO profile_opportunity_matches
       (id, profile_id, opportunity_id, match_score, match_decision, match_explain_json, matcher_version)
     VALUES (?, ?, ?, 55, 'review', ?, 'crawler-os')`,
  ).run(
    `m-stale-${profileId}`, profileId, `opp-stale-${profileId}`,
    JSON.stringify({ matchedNeeds: ['housing'], missingEligibilityFields: missingFields }),
  )
}

const OWNER_EXAMPLE_FIELDS = [
  'gender', 'faith_based_affiliation', 'income_eligibility', 'veteran_status',
  'eligibility_traits', 'age',
]

// ─────────────────────────────────────────────────────────────────────────────
// 1. Fact registry — canonical + alias + derived answers
// ─────────────────────────────────────────────────────────────────────────────

describe('profileAlreadyAnswers (fact registry)', () => {
  it('answers the owner-example facts from their alias locations', () => {
    const ctx = { profile: { primary_type: 'individual' }, sections: FILLED_PERSON_SECTIONS }
    expect(profileAlreadyAnswers('gender', ctx)).toBe(true)
    expect(profileAlreadyAnswers('faith_based_affiliation', ctx)).toBe(true) // religion
    expect(profileAlreadyAnswers('religion', ctx)).toBe(true)
    expect(profileAlreadyAnswers('veteran', ctx)).toBe(true)
    expect(profileAlreadyAnswers('is_veteran', ctx)).toBe(true)
    expect(profileAlreadyAnswers('income_eligibility', ctx)).toBe(true)
    expect(profileAlreadyAnswers('age', ctx)).toBe(true) // via date_of_birth
    expect(profileAlreadyAnswers('is_senior', ctx)).toBe(true)
    expect(profileAlreadyAnswers('eligibility_traits', ctx)).toBe(true)
    expect(profileAlreadyAnswers('funding_amount', ctx)).toBe(true) // narrative alias
    expect(profileAlreadyAnswers('state_zip', ctx)).toBe(true)
  })

  it('reads EVERY alias spelling of a fact, not just the canonical home', () => {
    // gender stored only under demographics (not basic_information)
    expect(profileAlreadyAnswers('gender', { sections: { demographics: { gender: 'male' } } })).toBe(true)
    // veteran stored only as the military_service schema flag
    expect(profileAlreadyAnswers('veteran', { sections: { military_service: { veteran: true } } })).toBe(true)
    // an explicit military_service.status string ("veteran", "active duty") IS
    // the answer — the readiness-plan precision question must not re-ask it
    expect(profileAlreadyAnswers('veteran', { sections: { military_service: { status: 'veteran' } } })).toBe(true)
    expect(profileAlreadyAnswers('military_status_precision', { sections: { military_service: { status: 'active duty' } } })).toBe(true)
    // an EXPLICIT "not a veteran" string is an answer too
    expect(profileAlreadyAnswers('veteran', { sections: { demographics: { veteran_status: 'Not a veteran' } } })).toBe(true)
    // ZIP stored under the location_focus alias the old prompts never read
    expect(profileAlreadyAnswers('state_zip', { sections: { location_focus: { zip_code: '37311' } } })).toBe(true)
    // amount stored under financial_information (gap-interview legacy home)
    expect(profileAlreadyAnswers('funding_amount', { sections: { financial_information: { funding_amount_needed: 4000 } } })).toBe(true)
    // religion under the schema's religious_denomination spelling
    expect(profileAlreadyAnswers('faith_based_affiliation', { sections: { demographics: { religious_denomination: 'Methodist' } } })).toBe(true)
  })

  it('returns false for an empty profile and for unknown fields', () => {
    const ctx = { profile: { primary_type: 'individual' }, sections: EMPTY_PERSON_SECTIONS }
    for (const f of OWNER_EXAMPLE_FIELDS) expect(profileAlreadyAnswers(f, ctx)).toBe(false)
    expect(profileAlreadyAnswers('some_field_nobody_registered', ctx)).toBe(false)
    // unknown fields FAIL OPEN at the shouldAsk level (question is asked)
    expect(shouldAskProfileQuestion('some_field_nobody_registered', ctx)).toBe(true)
  })

  it('does NOT treat schema-default false booleans as answers (repair stamps)', () => {
    // profile repair writes every default-false flag; false must not suppress the question
    expect(profileAlreadyAnswers('veteran', { sections: { military_service: { veteran: false } } })).toBe(false)
    expect(profileAlreadyAnswers('dv_survivor_status', { sections: { family_life: { domestic_violence_survivor: false } } })).toBe(false)
  })

  it('answers from derived signals/normalized views (imported free-text facts)', () => {
    expect(profileAlreadyAnswers('gender', { signals: { genders: new Set(['female']) } })).toBe(true)
    expect(profileAlreadyAnswers('veteran', { normalized: { isVeteran: true } })).toBe(true)
    expect(profileAlreadyAnswers('disability', { normalized: { hasDisabilityNeed: true } })).toBe(true)
    expect(profileAlreadyAnswers('income_eligibility', { signals: { financial: { householdIncome: 21000 } } })).toBe(true)
  })

  it('org_status is answered only when BOTH tax id and tax status are known', () => {
    const partial = { sections: { nonprofit_compliance: { is_501c3: true } } }
    expect(profileAlreadyAnswers('org_status', partial)).toBe(false) // EIN still missing → still ask
    const full = { sections: { nonprofit_compliance: { is_501c3: true, ein: '12-3456789' } } }
    expect(profileAlreadyAnswers('org_status', full)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. Org / person applicability matrix
// ─────────────────────────────────────────────────────────────────────────────

describe('questionAppliesToProfile (type-appropriateness matrix)', () => {
  const orgCtx = { profile: { primary_type: 'nonprofit' }, sections: {} }
  const personCtx = { profile: { primary_type: 'individual' }, sections: {} }
  const unknownCtx = { profile: {}, sections: {} }

  it('resolves the profile side from the declared type', () => {
    expect(resolveProfileSide(orgCtx)).toBe('org')
    expect(resolveProfileSide(personCtx)).toBe('person')
    expect(resolveProfileSide({ profile: { primary_type: 'county_government' } })).toBe('org')
    expect(resolveProfileSide(unknownCtx)).toBe('unknown')
  })

  it('never asks an organization for person demographics', () => {
    for (const f of ['gender', 'age', 'income_eligibility', 'has_disability', 'is_veteran',
      'is_senior', 'is_student', 'is_caregiver', 'dv_survivor_status', 'ethnicity']) {
      expect(questionAppliesToProfile(f, orgCtx), `${f} must not apply to an org`).toBe(false)
    }
    // org + shared questions still apply
    for (const f of ['org_status', 'organizationType', 'state_zip', 'primary_need', 'funding_amount', 'faith_based_affiliation']) {
      expect(questionAppliesToProfile(f, orgCtx), `${f} must apply to an org`).toBe(true)
    }
  })

  it('never asks an individual for organization facts', () => {
    for (const f of ['org_status', 'organizationType', 'populationServed', 'missionFocus', 'cdc_certification']) {
      expect(questionAppliesToProfile(f, personCtx), `${f} must not apply to a person`).toBe(false)
    }
    for (const f of ['gender', 'income_eligibility', 'state_zip', 'primary_need', 'funding_amount']) {
      expect(questionAppliesToProfile(f, personCtx), `${f} must apply to a person`).toBe(true)
    }
  })

  it('fails open when the profile side is unknown', () => {
    for (const f of ['gender', 'org_status', 'primary_need']) {
      expect(questionAppliesToProfile(f, unknownCtx)).toBe(true)
    }
  })

  it('project-readiness plan question ids are in the matrix (surface 5 — Focus Forward class)', () => {
    // A ministry/agency must never be asked personal military status, DD-214
    // uploads, or personal income proof; a person still is.
    for (const f of ['military_status_precision', 'military_context', 'military_verification_upload', 'income_benefit_proof_upload']) {
      expect(questionAppliesToProfile(f, orgCtx), `${f} must not apply to an org`).toBe(false)
      expect(questionAppliesToProfile(f, personCtx), `${f} must apply to a person`).toBe(true)
    }
    // the readiness plan's test fixtures declare identity via profile_type
    expect(resolveProfileSide({ profile: { profile_type: 'ministry' } })).toBe('org')
    expect(resolveProfileSide({ profile: { profile_type: 'individual' } })).toBe('person')
  })

  it('every askable surface field id resolves to a registered fact', () => {
    for (const [field, factId] of Object.entries(QUESTION_FIELD_TO_FACT)) {
      expect(CANONICAL_FACTS[factId], `field "${field}" maps to unregistered fact "${factId}"`).toBeTruthy()
    }
    // and the gap-interview question ids are all mapped
    for (const q of FACET_QUESTIONS) {
      expect(QUESTION_FIELD_TO_FACT[q.id], `facet question "${q.id}" is unmapped`).toBeTruthy()
    }
    for (const key of Object.keys(GAP_QUESTIONS)) {
      expect(QUESTION_FIELD_TO_FACT[key], `gap question key "${key}" is unmapped`).toBeTruthy()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. Cross-surface integration — the owner's acceptance criterion
// ─────────────────────────────────────────────────────────────────────────────

describe('cross-surface: religion+gender+veteran+income filled → zero questions for those facts', () => {
  it('surface 1 — computeDetailedReadiness asks nothing about the filled facts (and scores them present)', async () => {
    const db = makeDb()
    try {
      seedProfile(db, 'p-filled', { sections: FILLED_PERSON_SECTIONS })
      const r = await computeDetailedReadiness(db, 'p-filled')
      const text = [...r.recommended_questions, ...r.missing_items].join(' ').toLowerCase()
      expect(text).not.toMatch(/gender|religio|veteran|income/)
      // CORRECTED BEHAVIOR (present-fact-counted-as-missing bug): the
      // eligibility category historically read only 9 narrow clue fields and
      // scored 0 for this profile despite veteran+income+gender being present.
      const eligibility = r.categories.find((c) => c.key === 'eligibility')
      expect(eligibility.present).toBe(true)
      expect(eligibility.earned).toBe(10)
      expect(eligibility.recommended_questions).toEqual([])
      // amount was stored under narrative.funding_amount_needed — an alias the
      // old category never read.
      const amount = r.categories.find((c) => c.key === 'amount')
      expect(amount.present).toBe(true)
    } finally {
      db.close()
    }
  })

  it('surface 2 — getProfileFieldPrompts emits no eligibility/amount prompt for the filled profile', async () => {
    const db = makeDb()
    try {
      seedProfile(db, 'p-filled', { sections: FILLED_PERSON_SECTIONS })
      const prompts = await getProfileFieldPrompts(db, 'p-filled')
      const fields = prompts.map((p) => p.field)
      expect(fields).not.toContain('eligibility_traits')
      expect(fields).not.toContain('funding_amount')
      expect(fields).not.toContain('state_zip')
      expect(fields).not.toContain('primary_need')
    } finally {
      db.close()
    }
  })

  it('surface 3 — the gap interview re-asks none of the answered facets', () => {
    const profile = { id: 'p-filled', primary_type: 'individual' }
    const normalized = normalizeProfile(profile, FILLED_PERSON_SECTIONS)
    const plan = buildProfileGapPlan(normalized, FILLED_PERSON_SECTIONS, { displayName: 'Filled', profile })
    const ids = plan.questions.map((q) => q.id)
    expect(ids).not.toContain('is_veteran')
    expect(ids).not.toContain('is_senior') // DOB present → age known
    expect(ids).not.toContain('funding_amount') // narrative.funding_amount_needed
    expect(ids).not.toContain('state')
    expect(ids).not.toContain('zip')
  })

  it('surface 4 — answer_next drops STALE match-explain questions the profile now answers', async () => {
    const db = makeDb()
    try {
      seedProfile(db, 'p-filled', { sections: FILLED_PERSON_SECTIONS })
      // A stale explain recorded before the user filled the facts:
      seedStaleExplainMatch(db, 'p-filled',
        ['gender', 'faith_based_affiliation', 'income_eligibility', 'age', 'veteran_status'])
      const result = await buildCoverageEvidence(db, 'p-filled')
      const fields = result.answer_next.map((i) => i.field)
      for (const f of ['gender', 'faith_based_affiliation', 'income_eligibility', 'age', 'veteran_status']) {
        expect(fields, `answer_next must not re-ask "${f}"`).not.toContain(f)
      }
    } finally {
      db.close()
    }
  })

  it('an EMPTY profile still gets asked those questions on every surface', async () => {
    const db = makeDb()
    try {
      seedProfile(db, 'p-empty', { sections: EMPTY_PERSON_SECTIONS })
      seedStaleExplainMatch(db, 'p-empty',
        ['gender', 'faith_based_affiliation', 'income_eligibility', 'age'])

      // answer_next keeps them all
      const result = await buildCoverageEvidence(db, 'p-empty')
      const fields = result.answer_next.map((i) => i.field)
      for (const f of ['gender', 'faith_based_affiliation', 'income_eligibility', 'age']) {
        expect(fields, `answer_next must still ask "${f}" on an empty profile`).toContain(f)
      }

      // readiness still asks its category questions
      const r = await computeDetailedReadiness(db, 'p-empty')
      expect(r.recommended_questions.length).toBeGreaterThan(0)
      const eligibility = r.categories.find((c) => c.key === 'eligibility')
      expect(eligibility.present).toBe(false)

      // field prompts still nudge
      const prompts = await getProfileFieldPrompts(db, 'p-empty')
      const promptFields = prompts.map((p) => p.field)
      expect(promptFields).toContain('state_zip')
      expect(promptFields).toContain('primary_need')

      // gap interview still asks its facets
      const profile = { id: 'p-empty', primary_type: 'individual' }
      const normalized = normalizeProfile(profile, {})
      const plan = buildProfileGapPlan(normalized, {}, { profile })
      const ids = plan.questions.map((q) => q.id)
      expect(ids).toEqual(expect.arrayContaining(['has_disability', 'is_senior', 'is_veteran']))
    } finally {
      db.close()
    }
  })

  it('readiness score is unchanged by the filtering for a fixture with no alias-hidden facts', async () => {
    const db = makeDb()
    try {
      seedProfile(db, 'p-empty', { sections: EMPTY_PERSON_SECTIONS })
      const r = await computeDetailedReadiness(db, 'p-empty')
      // Sections-empty person profile: identity (12, primary_type is set on
      // the row) + org_status partial credit (7) for non-orgs = 19 — identical
      // to the pre-filter computation for this fixture.
      expect(r.readiness_score).toBe(19)
    } finally {
      db.close()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. Applicability across surfaces (org ↔ person)
// ─────────────────────────────────────────────────────────────────────────────

describe('cross-surface: org/person applicability', () => {
  it('an ORGANIZATION profile is never asked person demographics by answer_next', async () => {
    const db = makeDb()
    try {
      seedProfile(db, 'p-org', {
        primaryType: 'nonprofit',
        sections: {
          basic_information: { state: 'TN', profile_category: 'nonprofit' },
          narrative: { primary_goal: 'food pantry expansion' },
        },
      })
      // Stale/wrong explain asking an org for gender/age/income:
      seedStaleExplainMatch(db, 'p-org', ['gender', 'age', 'income_eligibility', 'dv_survivor_status'])
      const result = await buildCoverageEvidence(db, 'p-org')
      const fields = result.answer_next.map((i) => i.field)
      for (const f of ['gender', 'age', 'income_eligibility', 'dv_survivor_status']) {
        expect(fields, `an org must never be asked "${f}"`).not.toContain(f)
      }
      // …but org facts ARE still asked
      expect(fields).toContain('org_status')
    } finally {
      db.close()
    }
  })

  it('an ORGANIZATION profile gets no person facet questions from the gap interview', () => {
    const profile = { id: 'p-org', primary_type: 'nonprofit' }
    const sections = { basic_information: { state: 'TN' } }
    const normalized = normalizeProfile(profile, sections)
    const plan = buildProfileGapPlan(normalized, sections, { profile })
    const ids = plan.questions.map((q) => q.id)
    for (const f of ['has_disability', 'is_senior', 'is_student', 'is_veteran', 'is_caregiver']) {
      expect(ids, `an org must never be asked "${f}"`).not.toContain(f)
    }
    // org gaps still surface (org type itself is NOT re-asked — the declared
    // primary_type 'nonprofit' already answers it)
    expect(ids).not.toContain('org_type')
    expect(ids).toEqual(expect.arrayContaining(['programs']))
  })

  it('an INDIVIDUAL gets no org questions from the gap interview', () => {
    const profile = { id: 'p-ind', primary_type: 'individual' }
    const sections = { basic_information: { state: 'TN' } }
    const normalized = normalizeProfile(profile, sections)
    const plan = buildProfileGapPlan(normalized, sections, { profile })
    const ids = plan.questions.map((q) => q.id)
    for (const f of ['org_type', 'population', 'mission', 'programs']) {
      expect(ids, `an individual must never be asked "${f}"`).not.toContain(f)
    }
  })
})
