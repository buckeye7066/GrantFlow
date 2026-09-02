/**
 * NEED_COVERAGE gate on the sole public pipeline entry point
 * (services/opportunityMatcher.saveToProfilePipeline).
 *
 * Owner order 2026-08-21: a source reaches a pipeline only if it MEETS A NEED
 * THE PROFILE DECLARED. The decision engine scores need coverage instead of
 * rejecting on it ("a low score alone is not hard ineligibility"), so Gate 1.9
 * is the ONE place conjunct (1) is enforced at admission. Structured
 * declarations only; admission requires positive evidence on both sides.
 *
 * Same fixture conventions as saveToProfilePipelineGates.test.js: a minimal
 * in-memory better-sqlite3 schema and a focused decision-engine mock so the
 * need gate — not the engine — is what decides here.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

vi.mock('../services/matchEngine.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    computeMatchDecision: () => ({
      decision: 'ACCEPT',
      eligible: true,
      score: 90,
      reasons: ['need-gate fixture'],
      ineligibilityReasons: [],
      explanation: 'Need-gate fixture decision.',
      matchedNeeds: ['community'],
      matcherVersion: 'need-gate-test',
      evaluatedAt: '2026-08-22T00:00:00.000Z',
      confidence: 80,
      match_explain: { score_scale_id: 'data_point_v1' },
      scoreScaleId: 'data_point_v1',
    }),
  }
})

import { saveToProfilePipeline } from '../services/opportunityMatcher.js'

function makeDb() {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY, organization_id TEXT);
    CREATE TABLE funding_opportunities (id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE exclusion_rules (id TEXT PRIMARY KEY, action TEXT);
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

const countGrants = (db) => Number(db.prepare('SELECT COUNT(*) AS n FROM grants').get().n)

const needProfileContext = {
  profile: { id: 'p1', primary_type: 'individual', state: 'TN', needs: JSON.stringify(['education', 'housing']) },
  sections: { financial_information: { needs: ['food'] } },
}
const silentProfileContext = {
  profile: { id: 'p1', primary_type: 'individual', state: 'TN' },
  sections: null,
}

const legalOpp = (id) => ({
  id,
  title: 'Small Business Legal Defense Fund',
  sponsor: 'Legal Aid Society',
  source: 'grants_gov',
  need_types_supported: JSON.stringify(['legal']),
  application_url: 'https://example-legal.org/fund',
})

describe('saveToProfilePipeline — NEED_COVERAGE gate', () => {
  let db
  beforeEach(() => {
    db = makeDb()
  })

  it('REFUSES an opportunity that serves only a need the profile never declared', async () => {
    const result = await saveToProfilePipeline(db, legalOpp('opp-legal'), 'p1', needProfileContext, 90, 55)
    expect(result.saved).toBe(false)
    expect(result.gate).toBe('NEED_COVERAGE')
    expect(result.reason).toMatch(/declared need/i)
    expect(countGrants(db)).toBe(0)
  })

  it('ADMITS an opportunity covering at least PART of one declared need', async () => {
    const opp = {
      id: 'opp-food',
      title: 'Campus Food Pantry Voucher',
      sponsor: 'Student Affairs',
      source: 'grants_gov',
      need_types_supported: JSON.stringify(['food', 'legal']),
      application_url: 'https://example.edu/pantry',
    }
    const result = await saveToProfilePipeline(db, opp, 'p1', needProfileContext, 90, 55)
    expect(result.saved).toBe(true)
    expect(countGrants(db)).toBe(1)
  })

  it('refuses when the opportunity states no need vocabulary', async () => {
    const opp = {
      id: 'opp-silent',
      title: 'Murfreesboro Community Scholarship',
      sponsor: 'Rutherford County Foundation',
      source: 'grants_gov',
      application_url: 'https://example-rcf.org/apply',
    }
    const result = await saveToProfilePipeline(db, opp, 'p1', needProfileContext, 90, 55)
    expect(result.saved).toBe(false)
    expect(result.gate).toBe('NEED_COVERAGE')
  })

  it('refuses when the profile declares no needs', async () => {
    const result = await saveToProfilePipeline(db, legalOpp('opp-legal-2'), 'p1', silentProfileContext, 90, 55)
    expect(result.saved).toBe(false)
    expect(result.gate).toBe('NEED_COVERAGE')
  })

  it('records the denial as a TERMINAL live_reject for promotion sinks', async () => {
    const record = vi.fn()
    await saveToProfilePipeline(db, legalOpp('opp-legal-3'), 'p1', needProfileContext, 90, 55, { mode: 'live', record })
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'live_reject',
      result: expect.objectContaining({ gate: 'NEED_COVERAGE' }),
    }))
  })
})
