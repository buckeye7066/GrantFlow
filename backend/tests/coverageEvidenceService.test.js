/**
 * Tests for backend/services/coverageEvidenceService.js — the per-profile
 * "Coverage & Evidence" dashboard aggregation.
 *
 * Covered:
 *   1. Lane bucketing TOTALITY — every source_id in the crawler-os source
 *      registry maps to one of the 9 owner-defined lanes via LANE_OF_SOURCE,
 *      so a new adapter cannot silently fall out of the dashboard.
 *   2. Gap detection for a TN individual with a dementia health signal:
 *      - a TN state-programs gap (no TN-specific source in the registry),
 *      - a disease-specific gap mentioning dementia,
 *      - a county/city structural gap (no adapters exist for that lane).
 *   3. Match evidence extraction from match_explain_json WITH and WITHOUT the
 *      new dataPointEvidence key (fallback to matchedNeeds/scoreBreakdown).
 *   4. answer_next merge + dedup: match missing-eligibility fields, field
 *      prompts, and readiness questions collapse by canonical field, ordered
 *      by how many matches each answer unblocks.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  LANES,
  LANE_OF_SOURCE,
  laneForSource,
  extractMatchEvidence,
  buildCoverageEvidence,
  conditionCoveredBySource,
} from '../services/coverageEvidenceService.js'
import { sourceIds, allSources } from '../crawler-os/sourceRegistry.js'

const LANE_IDS = new Set(LANES.map((l) => l.lane))

function makeDb() {
  const raw = new Database(':memory:')
  raw.exec(`
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
  // better-sqlite3 is synchronous; the service awaits results, and awaiting a
  // non-promise resolves to its value — a valid stand-in for the async shim.
  return raw
}

function insertProfile(db, { id, displayName = 'Test Person', primaryType = 'individual', state = 'TN' }) {
  db.prepare(
    `INSERT INTO profiles (id, display_name, primary_type, applicant_type, status, state)
     VALUES (?, ?, ?, ?, 'active', ?)`,
  ).run(id, displayName, primaryType, primaryType, state)
}

function insertSection(db, profileId, key, data) {
  db.prepare(
    'INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)',
  ).run(profileId, key, JSON.stringify(data))
}

function insertOpportunity(db, o) {
  db.prepare(
    `INSERT INTO funding_opportunities
       (id, title, sponsor, source, deadline, deadline_type, amount_min, amount_max,
        amount_text, amount_status, application_url, apply_url, source_url, source_trust_tier)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    o.id, o.title, o.sponsor ?? null, o.source ?? null, o.deadline ?? null,
    o.deadline_type ?? null, o.amount_min ?? null, o.amount_max ?? null,
    o.amount_text ?? null, o.amount_status ?? null, o.application_url ?? null,
    o.apply_url ?? null, o.source_url ?? null, o.source_trust_tier ?? null,
  )
}

function insertMatch(db, m) {
  db.prepare(
    `INSERT INTO profile_opportunity_matches
       (id, profile_id, opportunity_id, match_score, match_decision, match_explain_json,
        matcher_version, source_query, discovered_via)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    m.id, m.profile_id, m.opportunity_id, m.match_score ?? null,
    m.match_decision ?? null,
    m.match_explain_json ? JSON.stringify(m.match_explain_json) : null,
    m.matcher_version ?? 'crawler-os', m.source_query ?? null, m.discovered_via ?? null,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Lane bucketing totality
// ─────────────────────────────────────────────────────────────────────────────

describe('lane taxonomy totality', () => {
  it('maps EVERY registry source_id to a known lane in LANE_OF_SOURCE', () => {
    for (const id of sourceIds()) {
      const lane = LANE_OF_SOURCE[id]
      expect(lane, `source "${id}" is missing from LANE_OF_SOURCE — add it so the coverage dashboard sees it`).toBeTruthy()
      expect(LANE_IDS.has(lane), `source "${id}" maps to unknown lane "${lane}"`).toBe(true)
    }
  })

  it('has no stale LANE_OF_SOURCE entries pointing at removed sources', () => {
    const known = new Set(sourceIds())
    for (const id of Object.keys(LANE_OF_SOURCE)) {
      expect(known.has(id), `LANE_OF_SOURCE entry "${id}" no longer exists in the source registry`).toBe(true)
    }
  })

  it('laneForSource resolves every registry source without falling back to inference surprises', () => {
    for (const s of allSources()) {
      expect(laneForSource(s.source_id, s)).toBe(LANE_OF_SOURCE[s.source_id])
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. Gap detection: TN individual with a dementia health signal
// ─────────────────────────────────────────────────────────────────────────────

describe('gap detection (TN profile + dementia health signal)', () => {
  let db
  const profileId = 'p-tn-dementia'

  beforeEach(async () => {
    db = makeDb()
    insertProfile(db, { id: profileId, displayName: 'Bradley County Senior', state: 'TN' })
    insertSection(db, profileId, 'basic_information', {
      state: 'TN', city: 'Cleveland', zip_code: '37311', profile_category: 'individual',
    })
    insertSection(db, profileId, 'health_medical', {
      conditions: [{ name: 'dementia' }, { name: 'parkinsons' }],
    })
    insertSection(db, profileId, 'narrative', { primary_goal: 'help paying for housing and caregiving' })
  })

  it('TN is state-covered (tn_ecf_choices) so no TN state-programs gap fires; an uncovered state still gaps', async () => {
    // The ECF CHOICES lane port (2026-07-07) added tn_ecf_choices — a real
    // TN-specific state source — so the old "no TN-specific source" gap is
    // honestly CLOSED for TN profiles...
    const result = await buildCoverageEvidence(db, profileId)
    expect(result.error).toBeUndefined()
    const tnStateGap = result.gaps.find(
      (g) => g.lane === 'state_programs' && /\bTN\b/.test(g.statement),
    )
    expect(tnStateGap, 'TN is covered by tn_ecf_choices — no state gap should fire').toBeUndefined()
    // ...and the caregiving need selects it for this profile (senior caring
    // household), so the state lane holds a real selected TN source.
    const stateLane = result.lanes.find((l) => l.lane === 'state_programs')
    expect(stateLane.selected_sources.map((s) => s.source_id)).toContain('tn_ecf_choices')

    // OH is covered as of 2026-07-08 (oh_benefits + oh_college_opportunity_grant)
    // — the former OH gap must no longer fire, and the portal is selectable.
    const ohId = 'p-oh-dementia'
    insertProfile(db, { id: ohId, displayName: 'Lorain County Senior', state: 'OH' })
    insertSection(db, ohId, 'basic_information', {
      state: 'OH', city: 'Lorain', profile_category: 'individual',
    })
    insertSection(db, ohId, 'narrative', { primary_goal: 'help paying for housing and caregiving' })
    const ohResult = await buildCoverageEvidence(db, ohId)
    const ohGap = ohResult.gaps.find(
      (g) => g.lane === 'state_programs' && /\bOH\b/.test(g.statement),
    )
    expect(ohGap, 'OH is covered by oh_benefits — no state gap should fire').toBeUndefined()

    // MT is covered as of 2026-07-12 (apply.mt.gov via STATE_BENEFITS_PORTALS —
    // every US state + DC + PR now has a portal row) — no MT gap fires.
    const mtId = 'p-mt-senior'
    insertProfile(db, { id: mtId, displayName: 'Missoula Senior', state: 'MT' })
    insertSection(db, mtId, 'basic_information', {
      state: 'MT', city: 'Missoula', profile_category: 'individual',
    })
    insertSection(db, mtId, 'narrative', { primary_goal: 'help paying for housing and caregiving' })
    const mtResult = await buildCoverageEvidence(db, mtId)
    const mtGap = mtResult.gaps.find(
      (g) => g.lane === 'state_programs' && /\bMT\b/.test(g.statement),
    )
    expect(mtGap, 'MT is covered by mt_benefits — no state gap should fire').toBeUndefined()

    // The gap detector itself still works: a jurisdiction with no registry
    // source (Guam — a valid state code with no portal row) must still emit
    // the state-programs gap.
    const guId = 'p-gu-senior'
    insertProfile(db, { id: guId, displayName: 'Hagatna Senior', state: 'GU' })
    insertSection(db, guId, 'basic_information', {
      state: 'GU', city: 'Hagatna', profile_category: 'individual',
    })
    insertSection(db, guId, 'narrative', { primary_goal: 'help paying for housing and caregiving' })
    const guResult = await buildCoverageEvidence(db, guId)
    const guGap = guResult.gaps.find(
      (g) => g.lane === 'state_programs' && /\bGU\b/.test(g.statement),
    )
    expect(guGap, 'expected a GU state-programs gap').toBeTruthy()
    expect(guGap.profile_fact).toBe('state=GU')
    expect(guGap.suggested_action).toMatch(/GU/)
  })

  it('covers dementia via alzheimers_gov_services (no false-positive gap) but gaps on parkinsons', async () => {
    const result = await buildCoverageEvidence(db, profileId)
    // dementia IS covered: the condition derives the dementia_support need and
    // the planner selects the Alzheimers.gov lane — so NO dementia gap fires.
    const disease = result.lanes.find((l) => l.lane === 'disease_specific')
    expect(disease.selected_sources.map((s) => s.source_id)).toContain('alzheimers_gov_services')
    expect(result.gaps.some((g) => g.lane === 'disease_specific' && /dementia/i.test(g.statement))).toBe(false)
    // parkinsons has NO disease-specific source in the registry → concrete gap.
    const parkinsonsGap = result.gaps.find(
      (g) => g.lane === 'disease_specific' && /parkinsons/i.test(g.statement),
    )
    expect(parkinsonsGap, 'expected a parkinsons disease-specific gap').toBeTruthy()
    expect(parkinsonsGap.profile_fact).toBe('health_condition=parkinsons')
    expect(parkinsonsGap.statement).toMatch(/No disease-specific source lane exists/i)
  })

  it('the county/city lane is REAL now (2026-07-08 fix): sources exist and get selected', async () => {
    const result = await buildCoverageEvidence(db, profileId)
    const countyLane = result.lanes.find((l) => l.lane === 'county_city')
    // The formerly-empty lane (the "22/22 profiles gapped" scoreboard statement)
    // now has geo-aware locator sources...
    expect(countyLane.registry_source_count).toBeGreaterThanOrEqual(3)
    // ...that an individual profile actually selects (usa_gov + findhelp serve
    // broad applicant/need buckets), so the structural gap must be gone.
    expect(countyLane.selected_sources.length).toBeGreaterThan(0)
    expect(countyLane.status).not.toBe('missing')
    const structuralGap = result.gaps.find(
      (g) => g.lane === 'county_city' && /source adapters exist/i.test(g.statement),
    )
    expect(structuralGap, 'the county/city "no adapters exist" gap must not fire anymore').toBeUndefined()
  })

  it('returns all 9 lanes with a status each', async () => {
    const result = await buildCoverageEvidence(db, profileId)
    expect(result.lanes).toHaveLength(9)
    for (const lane of result.lanes) {
      expect(['searched', 'no_results', 'missing', 'not_applicable']).toContain(lane.status)
    }
  })

  it('returns profile_not_found for an unknown profile id', async () => {
    const result = await buildCoverageEvidence(db, 'nope-does-not-exist')
    expect(result.error).toBe('profile_not_found')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. Match evidence extraction — with and without dataPointEvidence
// ─────────────────────────────────────────────────────────────────────────────

describe('match evidence extraction', () => {
  it('renders dataPointEvidence WHEN PRESENT', () => {
    const explain = {
      dataPointEvidence: {
        total: 10,
        matched_count: 4,
        credit: 0.4,
        matched: [{ id: 'state', kind: 'location', value: 'TN', credit: 0.1, via: 'basic_information' }],
      },
      matchedNeeds: ['housing'],
      scoreBreakdown: { eligibility_factor: 1, geo_factor: 1, need_coverage: 50 },
      confidence: 80,
      confidence_components: { sourceTrust: 'official' },
    }
    const evidence = extractMatchEvidence(JSON.stringify(explain), {
      source: 'grants_gov', deadline: '2026-09-01', amount_max: 5000, apply_url: 'https://example.gov/apply',
    })
    expect(evidence.data_points).toEqual(explain.dataPointEvidence)
    expect(evidence.matched_needs).toEqual(['housing'])
    expect(evidence.need_coverage).toBe(50)
    expect(evidence.confidence).toBe(80)
    expect(evidence.source_trust).toBe('official')
    expect(evidence.apply_url).toBe('https://example.gov/apply')
  })

  it('falls back to matchedNeeds/scoreBreakdown when dataPointEvidence is absent', () => {
    const explain = {
      matchedNeeds: ['food', 'energy'],
      matchedSignals: ['geo:state', 'applicant_type', 'needs'],
      scoreBreakdown: {
        eligibility_factor: 0.5,
        geo_factor: 1,
        eligibility_mismatches: ['income_over_limit'],
        applicant_type: 25,
      },
      missingEligibilityFields: ['income_eligibility'],
      reasons: ['Serves individuals in TN'],
    }
    const evidence = extractMatchEvidence(JSON.stringify(explain), { source: 'liheap' })
    expect(evidence.data_points).toBeNull()
    expect(evidence.matched_needs).toEqual(['food', 'energy'])
    expect(evidence.applicant_type.matched).toBe(true)
    expect(evidence.geography.tier).toBe('state')
    expect(evidence.eligibility.factor).toBe(0.5)
    expect(evidence.eligibility.mismatches).toEqual(['income_over_limit'])
    expect(evidence.eligibility.missing_fields).toEqual(['income_eligibility'])
    // registry fallback for trust tier when the catalog row carries none
    expect(evidence.trust_tier).toBeTruthy()
  })

  it('tolerates malformed / NULL match_explain_json', () => {
    expect(extractMatchEvidence('not-json', {}).matched_needs).toEqual([])
    expect(extractMatchEvidence(null, {}).data_points).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. Matches + answer_next (end-to-end over the fixture DB)
// ─────────────────────────────────────────────────────────────────────────────

describe('matches and answer_next aggregation', () => {
  let db
  const profileId = 'p-answer-next'

  beforeEach(() => {
    db = makeDb()
    insertProfile(db, { id: profileId, displayName: 'Answer Next', state: 'TN' })
    insertSection(db, profileId, 'basic_information', { state: 'TN', profile_category: 'individual' })
    insertSection(db, profileId, 'narrative', { primary_goal: 'utility help' })

    insertOpportunity(db, {
      id: 'opp-1', title: 'LIHEAP Energy Assistance', sponsor: 'ACF', source: 'liheap',
      deadline_type: 'rolling', amount_text: 'Varies by state', amount_status: 'varies',
      application_url: 'https://www.acf.hhs.gov/ocs/programs/liheap',
    })
    insertOpportunity(db, {
      id: 'opp-2', title: 'Weatherization Program', sponsor: 'DOE', source: 'benefits_gov',
      amount_max: 8000, apply_url: 'https://www.benefits.gov/x',
    })
    insertOpportunity(db, {
      id: 'opp-3', title: 'Senior Utility Fund', sponsor: 'Local Trust', source: 'community_211',
    })

    insertMatch(db, {
      id: 'm-1', profile_id: profileId, opportunity_id: 'opp-1', match_score: 62,
      match_decision: 'review',
      match_explain_json: {
        matchedNeeds: ['energy'],
        missingEligibilityFields: ['income_eligibility', 'age'],
        scoreBreakdown: { eligibility_factor: 0.5, geo_factor: 1 },
      },
    })
    insertMatch(db, {
      id: 'm-2', profile_id: profileId, opportunity_id: 'opp-2', match_score: 48,
      match_decision: 'review',
      match_explain_json: {
        dataPointEvidence: { total: 6, matched_count: 3, credit: 0.5, matched: [] },
        missingFields: ['income_eligibility'],
      },
    })
    insertMatch(db, {
      id: 'm-3', profile_id: profileId, opportunity_id: 'opp-3', match_score: 30,
      match_decision: 'review',
      match_explain_json: { matchedNeeds: [] },
    })
  })

  it('returns matches ordered by score with per-match evidence', async () => {
    const result = await buildCoverageEvidence(db, profileId)
    expect(result.matches.map((m) => m.id)).toEqual(['opp-1', 'opp-2', 'opp-3'])
    expect(result.matches[0].evidence.matched_needs).toEqual(['energy'])
    expect(result.matches[0].evidence.data_points).toBeNull()
    expect(result.matches[1].evidence.data_points).toEqual({ total: 6, matched_count: 3, credit: 0.5, matched: [] })
    expect(result.matches[0].evidence.apply_url).toBe('https://www.acf.hhs.gov/ocs/programs/liheap')
  })

  it('marks lanes with stored matches as searched (green)', async () => {
    const result = await buildCoverageEvidence(db, profileId)
    const benefits = result.lanes.find((l) => l.lane === 'federal_benefits')
    // liheap + benefits_gov both have stored matches for this profile
    expect(benefits.status).toBe('searched')
    const withResults = benefits.selected_sources.filter((s) => s.with_results).map((s) => s.source_id)
    expect(withResults).toContain('liheap')
  })

  it('dedups answer_next by canonical field and ranks blocking fields first', async () => {
    const result = await buildCoverageEvidence(db, profileId)
    const fields = result.answer_next.map((i) => i.field)
    // no duplicates
    expect(new Set(fields).size).toBe(fields.length)
    // income_eligibility blocks 2 matches (m-1 via missingEligibilityFields,
    // m-2 via legacy missingFields) — it must rank above age (1 match).
    const income = result.answer_next.find((i) => i.field === 'income_eligibility')
    const age = result.answer_next.find((i) => i.field === 'age')
    expect(income).toBeTruthy()
    expect(age).toBeTruthy()
    expect(income.blocked_matches).toBe(2)
    expect(age.blocked_matches).toBe(1)
    expect(fields.indexOf('income_eligibility')).toBeLessThan(fields.indexOf('age'))
    // every item carries a why
    for (const item of result.answer_next) {
      expect(item.question, `answer_next item ${item.field} needs a question`).toBeTruthy()
    }
  })

  it('merges readiness/field-prompt duplicates into one item per fact', async () => {
    const result = await buildCoverageEvidence(db, profileId)
    // the profile has no amount → both the field prompt (funding_amount) and
    // the readiness category (amount) fire; they must collapse to ONE item.
    const amountItems = result.answer_next.filter((i) => i.field === 'funding_amount')
    expect(amountItems).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// By-design exclusions are not fleet gaps — REGARDLESS of reason form
// (the 2026-07-12 "school portals = 81% fleet gap" class: plan reasons arrive
// humanized on the live path, and the not_applicable branch compared raw
// codes, so applicant-type skips re-entered the gap scoreboard).
// ─────────────────────────────────────────────────────────────────────────────

describe('by-design lane exclusions stay out of gaps (reason-form independent)', () => {
  let db
  beforeEach(() => {
    db = makeDb()
  })

  it('rawReasonCode maps humanized text back to its code and passes codes through', async () => {
    const { rawReasonCode, HUMAN_REASON } = await import('../crawler-os/crawlerPlanExplainer.js')
    for (const [code, text] of Object.entries(HUMAN_REASON)) {
      expect(rawReasonCode(text)).toBe(code)
      expect(rawReasonCode(code)).toBe(code)
    }
    expect(rawReasonCode('some future reason')).toBe('some future reason')
  })

  it('an org profile gets school_portals as not_applicable, never an applicant-type gap', async () => {
    const id = 'sb-org-1'
    insertProfile(db, { id, displayName: 'Begay Weaving Studio', primaryType: 'small_business', state: 'AZ' })
    insertSection(db, id, 'organization_details', { organization_type: 'small business' })
    insertSection(db, id, 'basic_information', { city: 'Window Rock', state: 'AZ', zip: '86515' })
    const result = await buildCoverageEvidence(db, id)

    const school = result.lanes.find((l) => l.lane === 'school_portals')
    expect(school).toBeTruthy()
    expect(school.status).toBe('not_applicable')

    // No gap in ANY lane may cite the by-design applicant-type skip.
    for (const g of result.gaps) {
      expect(String(g.statement)).not.toMatch(/does not fund this applicant type/i)
    }
  })

  it('geography-shaped exclusions remain REAL gaps', async () => {
    // AZ gained a portal (az_benefits) on 2026-07-12, so it no longer gaps;
    // Guam — a valid state code with no registry source — exercises the same
    // geography-is-never-by-design path.
    const id = 'geo-gap-1'
    insertProfile(db, { id, displayName: 'GU Person', primaryType: 'individual', state: 'GU' })
    insertSection(db, id, 'basic_information', { city: 'Hagatna', state: 'GU', zip: '96910' })
    insertSection(db, id, 'financial_information', { low_income: true, financial_need_level: 'high' })
    const result = await buildCoverageEvidence(db, id)

    // No GU state-programs source exists in the registry, so the state lane
    // must surface as a gap (either the lane-level geography exclusion or the
    // scoped no-state-source detector) — geography is never "by design".
    const stateGaps = result.gaps.filter((g) => g.lane === 'state_programs')
    expect(stateGaps.length).toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// State-programs lane totality (REGISTRY + TOTALITY rule, CLAUDE.md)
// ─────────────────────────────────────────────────────────────────────────────
// The stress-cohort gap report (2026-07-12) showed EVERY persona hitting
// "No {ST}-specific state-programs source exists in the source registry".
// This guard asserts the invariant that closed it: every US state, DC, and
// Puerto Rico has at least one state_programs-lane source whose geography
// covers it (the same predicate the (c1) gap check in buildCoverageEvidence
// uses), so a future registry edit cannot silently reopen a state's gap.

const US_STATES_DC_PR = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'DC', 'PR',
]

describe('state_programs lane totality', () => {
  it('covers every US state, DC, and PR with at least one state_programs source', () => {
    const registry = allSources()
    for (const state of US_STATES_DC_PR) {
      const covered = registry.some((s) => {
        if (laneForSource(s.source_id, s) !== 'state_programs') return false
        const states = s.geography?.states
        return Array.isArray(states) && states.map((x) => String(x).toUpperCase()).includes(state)
      })
      expect(covered, `no state_programs source covers ${state} — add its official portal to STATE_BENEFITS_PORTALS in sourceRegistry.js`).toBe(true)
    }
  })

  it('every state benefits portal row is well-formed and has an adapter', async () => {
    const { STATE_BENEFITS_SOURCE_IDS } = await import('../crawler-os/sourceRegistry.js')
    const { getAdapter } = await import('../crawler-os/adapters/index.js')
    const byId = new Map(allSources().map((s) => [s.source_id, s]))
    for (const id of STATE_BENEFITS_SOURCE_IDS) {
      const row = byId.get(id)
      expect(row, `${id} missing from registry`).toBeTruthy()
      expect(row.base_url, `${id} base_url`).toMatch(/^https:\/\//)
      expect(row.directory, `${id} must be a directory row`).toBe(true)
      expect(row.geography?.states?.length, `${id} must be single-state`).toBe(1)
      expect(getAdapter(id), `${id} has no adapter factory`).toBeTruthy()
      expect(LANE_OF_SOURCE[id], `${id} missing from LANE_OF_SOURCE`).toBe('state_programs')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// conditionCoveredBySource — the coverage FLOOR.
//
// The old rule was `hay.includes(token) || token.split('_').some(t => t.length>=4
// && hay.includes(t))` over a haystack of need_categories + source_id + name +
// keywords. Because source_id/name are FREE TEXT, that was a floor of ONE SHARED
// WORD — the #937/#943 class ("a shared word is a coincidence, not an identity") —
// and it fired in prod: Reeve "covered" the condition `physical` via the phrase
// "physical disability" in its name, and anything named "...disease" covered
// chronic kidney disease.
//
// The fix matches ONLY the curated vocabulary (keywords + need_categories), which
// is why every disease_specific source must carry keywords (totality-tested below).
// ─────────────────────────────────────────────────────────────────────────────
describe('conditionCoveredBySource — the coverage floor', () => {
  const DISEASE_IDS = Object.entries(LANE_OF_SOURCE)
    .filter(([, lane]) => lane === 'disease_specific')
    .map(([id]) => id)
  const diseaseSources = () => allSources().filter((s) => DISEASE_IDS.includes(s.source_id))
  const coveredBy = (condition) => diseaseSources().filter((s) => conditionCoveredBySource(condition, s))

  it('EVERY disease_specific source carries curated keywords (totality)', () => {
    // Without keywords a source is invisible to condition matching and mints a
    // false "no source lane exists" wishlist entry every night. cancer_care and
    // alzheimers_gov_services shipped for months with none.
    for (const s of diseaseSources()) {
      expect(Array.isArray(s.keywords) && s.keywords.length > 0, `${s.source_id} has no keywords[]`).toBe(true)
    }
  })

  // The regressions a stricter "every distinctive token must match" rule would have
  // caused — each of these was covered before and MUST stay covered.
  it.each([
    ['breast cancer', 'cancer_care'],
    ['stage 4 breast cancer', 'cancer_care'],
    ['cancer survivor', 'cancer_care'],
    ['alzheimers disease', 'alzheimers_gov_services'],
    ['vascular dementia', 'alzheimers_gov_services'],
    ['early onset alzheimers', 'alzheimers_gov_services'],
    ['dementia', 'alzheimers_gov_services'],
    ['wheelchair user', 'reeve_foundation_paralysis'],
    ['spinal cord injury', 'reeve_foundation_paralysis'],
    ['complex ptsd', 'samhsa_findtreatment'],
    ['obstructive sleep apnea', 'asaa_cpap_assistance'],
  ])('keeps covering %s (via %s)', (condition, expectedSource) => {
    expect(coveredBy(condition).map((s) => s.source_id)).toContain(expectedSource)
  })

  it('covers the ADJECTIVE form real profiles type ("diabetic", not "diabetes")', () => {
    // Prod 2026-07-16 carried the condition "diabetic". Token matching does not
    // stem, so the curated vocabulary must carry both forms.
    expect(coveredBy('diabetic').length).toBeGreaterThan(0)
    expect(coveredBy('type 2 diabetes').length).toBeGreaterThan(0)
  })

  it('is strictly better than the one-word floor it replaced (A/B on the real registry)', () => {
    // The OLD rule, inline, so this test proves the change MATTERS without
    // depending on git history: each case below returned true under it.
    const oldRule = (cond, s) => {
      const token = String(cond || '').toLowerCase().replace(/[^a-z0-9]+/g, '_')
      const hay = [...(s.need_categories || []), s.source_id, s.name, ...(s.keywords || [])].join(' ').toLowerCase()
      return hay.includes(token) || token.split('_').some((t) => t.length >= 4 && hay.includes(t))
    }
    const falseCovers = [
      ['chronic kidney disease', 'needymeds_diagnosis_assistance'], // shared word: 'chronic'
      ['medical debt', 'mercy_medical_angels'],                     // 'medical' in source_id/name
      ['physical therapy', 'reeve_foundation_paralysis'],           // 'physical' inside a keyword phrase
    ]
    for (const [cond, sid] of falseCovers) {
      const src = allSources().find((s) => s.source_id === sid)
      expect(oldRule(cond, src), `${cond}/${sid} should have been a FALSE cover before`).toBe(true)
      expect(conditionCoveredBySource(cond, src), `${cond}/${sid} must no longer be covered`).toBe(false)
    }
    // ...and it does not achieve that by breaking true covers:
    const cancerCare = allSources().find((s) => s.source_id === 'cancer_care')
    expect(oldRule('breast cancer', cancerCare)).toBe(true)
    expect(conditionCoveredBySource('breast cancer', cancerCare)).toBe(true)
  })

  it('does NOT cover on a single coincidental shared word', () => {
    const needymeds = allSources().find((s) => s.source_id === 'needymeds_diagnosis_assistance')
    const mercy = allSources().find((s) => s.source_id === 'mercy_medical_angels')
    const reeve = allSources().find((s) => s.source_id === 'reeve_foundation_paralysis')
    // shared word 'chronic' only — a kidney condition is not a NeedyMeds diagnosis lane
    expect(conditionCoveredBySource('chronic kidney disease', needymeds)).toBe(false)
    // 'medical' lives in the source_id/name, which is no longer consulted
    expect(conditionCoveredBySource('medical debt', mercy)).toBe(false)
    // 'physical' inside the keyword phrase "physical disability" ≠ physical therapy
    expect(conditionCoveredBySource('physical therapy', reeve)).toBe(false)
  })

  it('covers CANONICAL FLAG tokens, which arrive underscored', () => {
    // REGRESSION (prod 2026-07-16). Health signals come in two shapes: free text
    // ("breast cancer") and canonical flags minted with underscores
    // ("hearing_impairment") by profileHelpers. The old rule split on `_` before
    // matching, so it saw "hearing"; the new rule matched the raw string and
    // silently stopped covering EVERY underscore flag — `hearing_impairment` became
    // a false "no source lane exists" the moment it shipped, with
    // hlaa_financial_assistance sitting right there. Caught only by rebuilding the
    // scoreboard against real prod profiles.
    expect(coveredBy('hearing_impairment').map((s) => s.source_id)).toContain('hlaa_financial_assistance')
    expect(coveredBy('hearing impairment').map((s) => s.source_id)).toContain('hlaa_financial_assistance')
  })

  it('covers diagnoses spelled out the way real profiles type them', () => {
    // SAMHSA plainly covers these; only its vocabulary was missing the long forms.
    // Token matching neither stems nor expands acronyms.
    expect(coveredBy('post-traumatic stress disorder').map((s) => s.source_id)).toContain('samhsa_findtreatment')
    expect(coveredBy('major depressive disorder').map((s) => s.source_id)).toContain('samhsa_findtreatment')
    expect(coveredBy('ptsd').map((s) => s.source_id)).toContain('samhsa_findtreatment')
  })

  it('still reports an honestly uncovered flag as a gap (no vision lane exists)', () => {
    // The underscore fix must not paper over a REAL gap: nothing in the registry
    // serves vision, so visual_impairment stays a true structural finding.
    expect(coveredBy('visual_impairment')).toHaveLength(0)
  })

  it('matches on whole tokens only — `renal` must not hit inside `adrenal`', () => {
    const fake = { source_id: 'x', name: 'x', keywords: ['adrenal insufficiency'], need_categories: [] }
    expect(conditionCoveredBySource('renal failure', fake)).toBe(false)
    expect(conditionCoveredBySource('adrenal insufficiency', fake)).toBe(true)
  })

  it('leaves a genuinely uncovered diagnosis honestly uncovered', () => {
    for (const c of ['cipn', 'epilepsy', 'obesity', 'retina detachment (left eye)']) {
      expect(coveredBy(c), `${c} should still be an honest gap`).toHaveLength(0)
    }
  })

  it('an ADOPTED source retires the gap via the overlay (this is what converges)', () => {
    const src = allSources().find((s) => s.source_id === 'cancer_care')
    expect(conditionCoveredBySource('epilepsy', src)).toBe(false)
    // Once the consumer's find survives the full gate stack, the condition is
    // credited — otherwise the wishlist re-emits "no lane for epilepsy" forever.
    const overlay = new Set(['epilepsy'])
    expect(conditionCoveredBySource('epilepsy', src, overlay)).toBe(true)
  })

  it('a source with no curated vocabulary covers nothing (never vacuously true)', () => {
    const bare = { source_id: 'bare', name: 'Bare source', keywords: [], need_categories: [] }
    expect(conditionCoveredBySource('anything at all', bare)).toBe(false)
    expect(conditionCoveredBySource('chronic condition', bare)).toBe(false)
  })
})
