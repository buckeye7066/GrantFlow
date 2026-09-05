/**
 * Robert research leads — pointer rows (DIRECTORY / PAST_AWARD_INTEL) held at
 * REVIEW are carried into Robert's durable, user-visible recommendation queue
 * as research leads: visible for investigation, never offered or accepted as
 * direct funding.
 */

import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'

import {
  createRecommendationIfHelpful,
  createResearchLeadIfHelpful,
  researchLeadAcceptRefusal,
  RESEARCH_LEAD_CLASSIFICATION,
  RESEARCH_LEAD_TOAST_TITLE,
} from '../services/robert/robertRecommendationService.js'

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE robert_profile_recommendations (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      opportunity_id TEXT,
      robert_run_id TEXT,
      recommendation_status TEXT NOT NULL DEFAULT 'pending',
      delivery_status TEXT NOT NULL DEFAULT 'queued',
      match_score REAL,
      match_decision TEXT,
      match_reasons_json TEXT DEFAULT '[]',
      missing_profile_fields_json TEXT DEFAULT '[]',
      why_found TEXT,
      search_query_used TEXT,
      source_candidate_id TEXT,
      opportunity_candidate_id TEXT,
      toast_title TEXT,
      toast_body TEXT,
      toast_priority TEXT DEFAULT 'normal',
      toast_shown_at DATETIME,
      viewed_at DATETIME,
      accepted_at DATETIME,
      declined_at DATETIME,
      last_delivered_at DATETIME,
      delivery_attempts INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)
  return db
}

describe('createResearchLeadIfHelpful', () => {
  it('queues a REVIEW-held DIRECTORY pointer as a research lead', async () => {
    const db = makeDb()
    const res = await createResearchLeadIfHelpful({
      db,
      profileId: 'p1',
      opportunityId: 'dir-1',
      matchDecision: 'review',
      matchScore: 9,
      opportunityKind: 'DIRECTORY',
      opportunityTitle: 'Tennessee Youth Funder Directory',
      profileDisplayName: 'Nashville Youth Org',
    })
    expect(res.created).toBe(true)
    expect(res.classification).toBe(RESEARCH_LEAD_CLASSIFICATION)

    const row = db.prepare('SELECT * FROM robert_profile_recommendations WHERE id = ?').get(res.recommendation_id)
    expect(row.match_decision).toBe('REVIEW')
    expect(row.recommendation_status).toBe('pending')
    expect(row.toast_title).toBe(RESEARCH_LEAD_TOAST_TITLE)
    expect(row.toast_body).toMatch(/not verified as direct funding/i)
    expect(JSON.parse(row.match_reasons_json)).toEqual([RESEARCH_LEAD_CLASSIFICATION])
  })

  it('accepts a PAST_AWARD_INTEL pointer and refuses non-pointer kinds', async () => {
    const db = makeDb()
    const intel = await createResearchLeadIfHelpful({
      db, profileId: 'p1', opportunityId: 'intel-1', matchDecision: 'REVIEW', matchScore: 8, opportunityKind: 'PAST_AWARD_INTEL',
    })
    expect(intel.created).toBe(true)

    // A weak DIRECT match at REVIEW is not a research lead and must not sneak
    // into the queue through this door.
    const direct = await createResearchLeadIfHelpful({
      db, profileId: 'p1', opportunityId: 'grant-1', matchDecision: 'REVIEW', matchScore: 8, opportunityKind: 'DIRECT_GRANT',
    })
    expect(direct.created).toBe(false)
    expect(direct.reason).toBe('not_a_pointer_kind')
  })

  it('refuses anything that is not REVIEW', async () => {
    const db = makeDb()
    const accept = await createResearchLeadIfHelpful({
      db, profileId: 'p1', opportunityId: 'dir-2', matchDecision: 'ACCEPT', matchScore: 12, opportunityKind: 'DIRECTORY',
    })
    expect(accept).toMatchObject({ created: false, reason: 'decision_accept' })
    const reject = await createResearchLeadIfHelpful({
      db, profileId: 'p1', opportunityId: 'dir-3', matchDecision: 'reject', matchScore: 1, opportunityKind: 'DIRECTORY',
    })
    expect(reject).toMatchObject({ created: false, reason: 'decision_reject' })
    expect(db.prepare('SELECT COUNT(*) AS n FROM robert_profile_recommendations').get().n).toBe(0)
  })

  it('is idempotent per (profile, opportunity)', async () => {
    const db = makeDb()
    const args = { db, profileId: 'p1', opportunityId: 'dir-1', matchDecision: 'review', matchScore: 9, opportunityKind: 'DIRECTORY' }
    expect((await createResearchLeadIfHelpful(args)).created).toBe(true)
    const again = await createResearchLeadIfHelpful(args)
    expect(again.created).toBe(false)
    expect(again.reason).toBe('duplicate_active')
    expect(db.prepare('SELECT COUNT(*) AS n FROM robert_profile_recommendations').get().n).toBe(1)
  })

  it('does not loosen the direct-recommendation door: REVIEW is still refused there', async () => {
    const db = makeDb()
    const res = await createRecommendationIfHelpful({
      db, profileId: 'p1', opportunityId: 'dir-1', matchDecision: 'REVIEW', matchScore: 9,
    })
    expect(res.created).toBe(false)
    expect(res.reason).toBe('decision_review')
  })
})

describe('researchLeadAcceptRefusal (accept route guard)', () => {
  it('refuses a REVIEW row with 409 and the research-lead code', () => {
    const refusal = researchLeadAcceptRefusal({ id: 'r1', match_decision: 'REVIEW' })
    expect(refusal.status).toBe(409)
    expect(refusal.body).toMatchObject({ ok: false, code: RESEARCH_LEAD_CLASSIFICATION, match_decision: 'REVIEW' })
  })

  it('refuses a row with no decision at all', () => {
    expect(researchLeadAcceptRefusal({ id: 'r2' })?.status).toBe(409)
  })

  it('lets an ACCEPT row through (any case)', () => {
    expect(researchLeadAcceptRefusal({ match_decision: 'ACCEPT' })).toBeNull()
    expect(researchLeadAcceptRefusal({ match_decision: 'accept' })).toBeNull()
  })
})
