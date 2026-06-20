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

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
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
  },
  sections: null,
}

function countGrants(db) {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM grants').get().n)
}

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
    const first = await saveToProfilePipeline(db, baseOpp, 'p1', profileContext, 90, 55)
    expect(first.saved).toBe(true)
    expect(countGrants(db)).toBe(1)

    // Re-crawl: SAME program, but a brand-new internal funding_opportunities id
    // (the exact case the old funding_opportunity_id-only check let slip).
    const recrawled = { ...baseOpp, id: 'opp-recrawled-DIFFERENT' }
    const second = await saveToProfilePipeline(db, recrawled, 'p1', profileContext, 90, 55)

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
    const first = await saveToProfilePipeline(db, opp, 'p1', profileContext, 90, 55)
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
    const second = await saveToProfilePipeline(db, drifted, 'p1', profileContext, 90, 55)
    expect(second.saved).toBe(false)
    expect(second.gate).toBe('DUPLICATE')
    expect(countGrants(db)).toBe(1)
  })
})

describe('saveToProfilePipeline — RELEVANCE FLOOR', () => {
  let db
  beforeEach(() => {
    db = makeDb()
  })

  it('does not insert a below-floor opportunity even when caller passes threshold=0', async () => {
    const lowScoreOpp = {
      id: 'opp-low',
      title: 'Barely Relevant Program',
      sponsor: 'Some Funder',
      url: 'https://grants.example.gov/low',
      source: 'grants_gov',
    }

    // Caller tries to lower the bar to 0 (the crawler-relaxed-threshold bug).
    // Explicit score is below the canonical floor.
    const belowFloor = RELEVANCE_FLOOR - 1
    const res = await saveToProfilePipeline(db, lowScoreOpp, 'p1', profileContext, belowFloor, 0)

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
    }
    const res = await saveToProfilePipeline(db, rejectOpp, 'p1', ineligibleProfile, 99, 0)
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
    }
    const res = await saveToProfilePipeline(db, goodOpp, 'p1', profileContext, RELEVANCE_FLOOR, 0)
    expect(res.saved).toBe(true)
    expect(countGrants(db)).toBe(1)
  })
})
