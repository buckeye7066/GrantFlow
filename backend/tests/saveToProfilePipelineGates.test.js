/**
 * Choke-point gate tests for saveToProfilePipeline (services/opportunityMatcher.js).
 *
 * saveToProfilePipeline is the single saver every crawler / import path funnels
 * through. Two product invariants MUST hold there, regardless of what a caller
 * passes:
 *
 *   1. DUPLICATE gate — an opportunity already in THIS profile's pipeline is
 *      never inserted a second time, even when a re-crawl mints a brand-new
 *      internal funding_opportunities id (so funding_opportunity_id no longer
 *      matches). Dedup falls back to the canonical fingerprint and then to
 *      normalized title+funder.
 *
 *   2. RELEVANCE FLOOR — a below-floor / junk opportunity is never inserted,
 *      even if the caller passes minMatchThreshold=0. The floor is a TRUE
 *      floor: effectiveThreshold = max(callerThreshold, RELEVANCE_FLOOR).
 *
 * Uses a minimal in-memory better-sqlite3 schema (mirrors the convention in
 * enforceInvariants.test.js — the sync handle is a valid stand-in for the async
 * prod db wrapper because awaiting a non-promise resolves to its value). The
 * grants table omits the decision columns on purpose so the saver takes its
 * legacy insert path with a small, stable column set.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

vi.mock('../services/matchEngine.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    computeMatchDecision: (_profile, opportunity) => {
      const decision = opportunity.test_decision ?? 'ACCEPT'
      const score = decision === 'REJECT' ? 0 : Number(opportunity.test_score ?? 90)
      return {
        decision,
        eligible: decision === 'ACCEPT',
        score,
        reasons: ['focused pipeline-gate fixture'],
        ineligibilityReasons: decision === 'REJECT' ? ['focused fixture rejection'] : [],
        explanation: 'Focused pipeline-gate fixture decision.',
        matchedNeeds: ['community'],
        matcherVersion: 'pipeline-gate-test',
        evaluatedAt: '2026-08-06T00:00:00.000Z',
        confidence: 80,
        match_explain: { score_scale_id: 'data_point_v1' },
        scoreScaleId: 'data_point_v1',
      }
    },
  }
})

import { saveToProfilePipeline } from '../services/opportunityMatcher.js'
import { RELEVANCE_FLOOR } from '../config/relevanceFloor.js'

function makeDb() {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      organization_id TEXT
    );
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      title TEXT
    );
    CREATE TABLE exclusion_rules (
      id TEXT PRIMARY KEY,
      action TEXT
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      organization_id TEXT,
      profile_id TEXT,
      funding_opportunity_id TEXT,
      title TEXT NOT NULL,
      funder TEXT,
      status TEXT DEFAULT 'discovered',
      deadline TEXT,
      match_score INTEGER,
      match_reasons TEXT,
      notes TEXT,
      application_url TEXT,
      application_method TEXT,
      contact_name TEXT,
      contact_email TEXT,
      contact_phone TEXT,
      amount_requested TEXT,
      amount_min TEXT,
      amount_max TEXT,
      url TEXT,
      fingerprint TEXT,
      fingerprint_version INTEGER
    );
  `)
  raw.prepare('INSERT INTO profiles (id, organization_id) VALUES (?, ?)').run('p1', 'org1')
  return raw
}

// A profile context that produces a non-REJECT decision for the test opps
// (the decision engine is the authority for Gate 2; these opps land as REVIEW,
// which passes Gate 2 and lets us exercise the DUPLICATE + THRESHOLD gates).
const profileContext = {
  profile: {
    id: 'p1',
    mission: 'Community programs',
    organization_type: 'nonprofit',
    state: 'TN',
    needs: JSON.stringify(['community']),
  },
  sections: null,
}

const emsProfileContext = {
  profile: {
    id: 'p1',
    primary_type: 'individual',
    state: 'TN',
    needs: JSON.stringify(['professional_development', 'employment']),
  },
  sections: {
    employment: { occupation: 'EMT', notes: 'Paramedic training and EMS continuing education' },
  },
}

const farmBusinessProfileContext = {
  profile: {
    id: 'p1',
    primary_type: 'small_business',
    state: 'TN',
    needs: JSON.stringify(['business', 'startup', 'agriculture', 'equipment']),
  },
  sections: {
    small_business_details: { business_name: 'Test Farm LLC', industry: 'Agriculture', years_in_business: 1 },
  },
}

function countGrants(db) {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM grants').get().n)
}

function admissionReady(opportunity) {
  return {
    ...opportunity,
    application_url: opportunity.application_url ?? opportunity.url,
    opportunity_kind: opportunity.opportunity_kind ?? 'grant',
    amount_max: opportunity.amount_max ?? 10000,
    need_types_supported: opportunity.need_types_supported ??
      JSON.stringify(['community', 'professional_development', 'business']),
  }
}

describe('saveToProfilePipeline — legacy caller error contract', () => {
  it('returns and logs the original six-argument shape for admission-time exceptions', async () => {
    const db = makeDb()
    const failure = new Error('injected admission failure')
    const failingDb = {
      prepare(sql) {
        if (/SELECT id, organization_id\s+FROM profiles/i.test(String(sql))) throw failure
        return db.prepare(sql)
      },
    }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const opportunity = {
      id: 'legacy-error',
      title: 'Legacy Caller Error',
      sponsor: 'State Health Dept',
      source: 'grants_gov',
      description: 'Community program support',
      application_url: 'https://example.gov/apply',
    }

    const result = await saveToProfilePipeline(failingDb, admissionReady(opportunity), 'p1', profileContext, 90, 55)

    expect(result).toEqual({ saved: false, reason: 'injected admission failure' })
    expect(errorSpy).toHaveBeenCalledWith('[opportunityMatcher] Error saving to pipeline:', failure)

    const record = vi.fn()
    const sweepResult = await saveToProfilePipeline(
      failingDb,
      admissionReady(opportunity),
      'p1',
      profileContext,
      90,
      55,
      { mode: 'live', record },
    )
    expect(sweepResult).toMatchObject({
      saved: false,
      reason: 'injected admission failure',
      gate: 'ADMISSION_ERROR',
      matchPercentage: 90,
    })
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'error:transient',
      result: expect.objectContaining({ gate: 'ADMISSION_ERROR' }),
    }))
    errorSpy.mockRestore()
    db.close()
  })
})

describe('saveToProfilePipeline — DUPLICATE gate', () => {
  let db
  beforeEach(() => {
    db = makeDb()
  })

  it('does not re-insert an opportunity already in the pipeline on re-crawl (new internal id)', async () => {
    const baseOpp = {
      id: 'opp-original',
      title: 'Community Health Initiative',
      sponsor: 'State Health Dept',
      deadline: '2026-12-31',
      url: 'https://grants.example.gov/community-health',
      source: 'grants_gov',
    }

    // First save — supply an explicit, above-floor score so the THRESHOLD gate
    // passes deterministically and we land in the pipeline.
    const first = await saveToProfilePipeline(db, admissionReady(baseOpp), 'p1', profileContext, 90, 55)
    expect(first.saved).toBe(true)
    expect(countGrants(db)).toBe(1)

    // Re-crawl: SAME program, but a brand-new internal funding_opportunities id
    // (the exact case the old funding_opportunity_id-only check let slip).
    const recrawled = { ...baseOpp, id: 'opp-recrawled-DIFFERENT' }
    const second = await saveToProfilePipeline(db, admissionReady(recrawled), 'p1', profileContext, 90, 55)

    expect(second.saved).toBe(false)
    expect(second.gate).toBe('DUPLICATE')
    expect(countGrants(db)).toBe(1) // STILL one row — no duplicate
  })

  it('dedups via normalized title+funder even when url/deadline drift breaks the fingerprint', async () => {
    const opp = {
      id: 'opp-1',
      title: 'Community Health Initiative',
      sponsor: 'State Health Dept',
      deadline: '2026-12-31',
      url: 'https://grants.example.gov/v1',
      source: 'grants_gov',
    }
    const first = await saveToProfilePipeline(db, admissionReady(opp), 'p1', profileContext, 90, 55)
    expect(first.saved).toBe(true)
    expect(countGrants(db)).toBe(1)

    // Re-crawl with drifted url + deadline (fingerprint differs) and no id match.
    const drifted = {
      id: 'opp-2-different',
      title: '  community health initiative ', // whitespace/case drift
      sponsor: 'State Health Dept',
      deadline: '2027-01-15',
      url: 'https://grants.example.gov/v2-moved',
      source: 'grants_gov',
    }
    const second = await saveToProfilePipeline(db, admissionReady(drifted), 'p1', profileContext, 90, 55)
    expect(second.saved).toBe(false)
    expect(second.gate).toBe('DUPLICATE')
    expect(countGrants(db)).toBe(1)
  })

  it('dedups conservative acronym-family crawler variants before they repeat in the pipeline', async () => {
    const umbrella = {
      id: 'web-naemt-1',
      title: 'NAEMT Educational Scholarships',
      sponsor: 'National Association of Emergency Medical Technicians',
      description: 'Individual active NAEMT members pursuing EMT-Basic, EMT-Paramedic, or continuing EMS education.',
      url: 'https://www.naemt.org/initiatives/naemt-foundation/scholarships',
      source: 'web_search',
      record_origin: 'web_search',
    }
    const first = await saveToProfilePipeline(db, admissionReady(umbrella), 'p1', emsProfileContext, 90, 55)
    expect(first.saved).toBe(true)
    expect(countGrants(db)).toBe(1)

    const variant = {
      id: 'web-naemt-2',
      title: 'NAEMT EMT-Paramedic Scholarship',
      sponsor: 'National Association of Emergency Medical Technicians',
      description: 'Active NAEMT members pursuing EMT-Paramedic education.',
      url: 'https://www.naemt.org/initiatives/naemt-foundation/scholarships',
      source: 'web_search',
      record_origin: 'web_search',
    }
    const second = await saveToProfilePipeline(db, admissionReady(variant), 'p1', emsProfileContext, 90, 55)

    expect(second.saved).toBe(false)
    expect(second.gate).toBe('DUPLICATE')
    expect(countGrants(db)).toBe(1)
  })

  it('does not dedup distinct same-funder acronym programs', async () => {
    const valueAdded = {
      id: 'usda-1',
      title: 'USDA Value Added Producer Grant',
      sponsor: 'USDA Rural Development',
      description: 'Planning and working capital grants for value-added agricultural products.',
      url: 'https://www.rd.usda.gov/programs-services/business-programs/value-added-producer-grants',
      source: 'grants_gov',
    }
    const first = await saveToProfilePipeline(db, admissionReady(valueAdded), 'p1', farmBusinessProfileContext, 90, 55)
    expect(first.saved).toBe(true)
    expect(countGrants(db)).toBe(1)

    const reap = {
      id: 'usda-2',
      title: 'USDA REAP Grant',
      sponsor: 'USDA Rural Development',
      description: 'Renewable energy and energy efficiency assistance for rural businesses and producers.',
      url: 'https://www.rd.usda.gov/programs-services/energy-programs/rural-energy-america-program-renewable-energy-systems-energy-efficiency-improvement-guaranteed-loans',
      source: 'grants_gov',
    }
    const second = await saveToProfilePipeline(db, admissionReady(reap), 'p1', farmBusinessProfileContext, 90, 55)
    expect(second.saved).toBe(true)
    expect(countGrants(db)).toBe(2)
  })
})

describe('saveToProfilePipeline — FUNDING_RESULT gate (Gate 1.75, the 2026-08-04 pipeline-writer hole)', () => {
  let db
  beforeEach(() => {
    db = makeDb()
  })

  it('refuses a not_a_grant regulatory notice with gate FUNDING_RESULT (the prod "HRSA information-collection at 82" class)', async () => {
    const notice = {
      id: 'opp-notice',
      title: 'Agency Information Collection Activities: Proposed Collection: Public Comment Request',
      sponsor: 'Health Resources and Services Administration',
      url: 'https://www.federalregister.gov/documents/2026/06/30/y',
      // NOT 'federal_register': that string is refused by the earlier
      // SOURCE_ALLOWLIST gate — this test must reach Gate 1.75 to prove it.
      source: 'grants_gov',
    }
    // A high explicit score + threshold 0 must not smuggle it past the gate.
    const res = await saveToProfilePipeline(db, notice, 'p1', profileContext, 90, 0)
    expect(res.saved).toBe(false)
    expect(res.gate).toBe('FUNDING_RESULT')
    expect(res.decision).toBe('REJECT')
    expect(res.reason).toMatch(/not a (?:positively )?fundable opportunity/i)
    expect(res.reason).toMatch(/regulatory_notice_title/)
    expect(countGrants(db)).toBe(0)
  })

  it('refuses a benign-title Federal-Register-hosted row (the EPA "Notice of Availability" at 76)', async () => {
    const frRow = {
      id: 'opp-fr',
      title: 'Innovation Challenge: Alternatives to Conventional Pesticides for Crop Desiccation; Notice of Availability',
      sponsor: 'Environmental Protection Agency',
      url: 'https://www.federalregister.gov/documents/2026/07/02/2026-13458/x',
      source: 'web_search',
    }
    const res = await saveToProfilePipeline(db, frRow, 'p1', profileContext, 90, 0)
    expect(res.saved).toBe(false)
    expect(res.gate).toBe('FUNDING_RESULT')
    expect(res.reason).toMatch(/federal_register_source/)
    expect(countGrants(db)).toBe(0)
  })

  it('refuses a RESOURCE-bucket pointer row at the canonical writer', async () => {
    const directory = {
      id: 'opp-dir',
      title: 'findhelp — Local assistance programs',
      sponsor: 'findhelp',
      opportunity_kind: 'DIRECTORY',
      url: 'https://www.findhelp.org',
      source: 'web_search',
    }
    const res = await saveToProfilePipeline(db, directory, 'p1', profileContext, 90, 55)
    expect(res.saved).toBe(false)
    expect(res.gate).toBe('FUNDING_RESULT')
  })

  it('still never writes a NULL match_score on a successful save', async () => {
    const goodOpp = {
      id: 'opp-good-score',
      title: 'Strong Match Program',
      sponsor: 'Good Funder',
      url: 'https://grants.example.gov/good',
      source: 'grants_gov',
    }
    const res = await saveToProfilePipeline(db, admissionReady(goodOpp), 'p1', profileContext, 90, 55)
    expect(res.saved).toBe(true)
    expect(countGrants(db)).toBe(1)
    const row = db.prepare('SELECT match_score FROM grants').get()
    // SQLite is typeless — assert the persisted TYPE, not just non-nullness.
    expect(row.match_score).not.toBeNull()
    expect(typeof row.match_score).toBe('number')
  })
})

describe('saveToProfilePipeline — RELEVANCE FLOOR', () => {
  let db
  beforeEach(() => {
    db = makeDb()
  })

  it('does not insert a below-floor opportunity even when caller passes threshold=0', async () => {
    const belowFloor = RELEVANCE_FLOOR - 1
    const lowScoreOpp = {
      id: 'opp-low',
      title: 'Barely Relevant Program',
      sponsor: 'Some Funder',
      url: 'https://grants.example.gov/low',
      source: 'grants_gov',
      test_score: belowFloor,
    }

    // Caller tries to lower the bar to 0 (the crawler-relaxed-threshold bug).
    // Explicit score is below the canonical floor.
    const res = await saveToProfilePipeline(db, admissionReady(lowScoreOpp), 'p1', profileContext, belowFloor, 0)

    expect(res.saved).toBe(false)
    expect(res.gate).toBe('THRESHOLD')
    // Effective threshold must have been raised to the floor, not honored at 0.
    expect(res.threshold).toBe(RELEVANCE_FLOOR)
    expect(countGrants(db)).toBe(0)
  })

  it('never inserts a decision-engine REJECT even with a high explicit score + threshold=0', async () => {
    // Eligibility REJECT must hard-block at Gate 2 regardless of score/threshold.
    const ineligibleProfile = {
      profile: {
        id: 'p1',
        mission: 'Cancer research at our biotech lab',
        focus_areas: ['cancer', 'research'],
        organization_type: 'nonprofit',
        state: 'TN',
        needs: JSON.stringify(['community']),
      },
      sections: null,
    }
    const rejectOpp = {
      id: 'opp-reject',
      title: 'Cancer Research Grant',
      sponsor: 'NIH',
      description: 'Funding for cancer research projects',
      eligibility: 'nonprofits',
      url: 'https://grants.example.gov/reject',
      source: 'grants_gov',
      test_decision: 'REJECT',
    }
    const res = await saveToProfilePipeline(db, admissionReady(rejectOpp), 'p1', ineligibleProfile, 99, 0)
    expect(res.saved).toBe(false)
    expect(res.gate).toBe('DECISION_ENGINE')
    expect(res.decision).toBe('REJECT')
    expect(countGrants(db)).toBe(0)
  })

  it('still saves a genuinely relevant, eligible opportunity at/above the floor', async () => {
    const goodOpp = {
      id: 'opp-good',
      title: 'Strong Match Program',
      sponsor: 'Good Funder',
      url: 'https://grants.example.gov/good',
      source: 'grants_gov',
      test_score: RELEVANCE_FLOOR,
    }
    const res = await saveToProfilePipeline(db, admissionReady(goodOpp), 'p1', profileContext, RELEVANCE_FLOOR, 0)
    expect(res.saved).toBe(true)
    expect(countGrants(db)).toBe(1)
  })
})
