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

  it('emits a TN state-programs gap (no TN-specific source in the registry)', async () => {
    const result = await buildCoverageEvidence(db, profileId)
    expect(result.error).toBeUndefined()
    const stateGap = result.gaps.find(
      (g) => g.lane === 'state_programs' && /\bTN\b/.test(g.statement),
    )
    expect(stateGap, 'expected a TN state-programs gap').toBeTruthy()
    expect(stateGap.profile_fact).toBe('state=TN')
    expect(stateGap.suggested_action).toMatch(/TN/)
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

  it('emits a county/city structural gap (no adapters exist for that lane)', async () => {
    const result = await buildCoverageEvidence(db, profileId)
    const countyLane = result.lanes.find((l) => l.lane === 'county_city')
    expect(countyLane.status).toBe('missing')
    expect(countyLane.registry_source_count).toBe(0)
    const countyGap = result.gaps.find((g) => g.lane === 'county_city')
    expect(countyGap, 'expected a county/city structural gap').toBeTruthy()
    expect(countyGap.statement).toMatch(/no .*source adapters exist/i)
  })

  it('returns all 9 lanes with a status each', async () => {
    const result = await buildCoverageEvidence(db, profileId)
    expect(result.lanes).toHaveLength(9)
    for (const lane of result.lanes) {
      expect(['searched', 'no_results', 'missing']).toContain(lane.status)
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
