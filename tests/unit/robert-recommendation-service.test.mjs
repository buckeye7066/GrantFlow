import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { makeMemoryDb } from './robert-test-helpers.mjs'
import {
  createRecommendationIfHelpful,
  markAccepted,
  markDeclined,
  markViewed,
} from '../../backend/services/robert/robertRecommendationService.js'
import { getRecommendation, listRecommendationsForProfile } from '../../backend/services/robert/robertRunStore.js'
import {
  GOOD_MATCH_SCORE,
  SCORE_SCALE_ID,
  STRONG_MATCH_SCORE,
} from '../../backend/config/matchThresholds.js'

let db
beforeEach(() => { db = makeMemoryDb() })

const FOUR_TRUTH_PROOF = {
  direct_funding: true,
  all_passed: true,
  real: {
    passed: true,
    reality_status: 'VERIFIED',
    evidence_url: 'https://example.org/grant',
    content_hash_present: true,
    evidence_captured_at: '2026-09-03T00:00:00.000Z',
  },
  relatable: { passed: true, canonical_decision: 'ACCEPT' },
  meets_profile_need: {
    passed: true,
    profile_needs_defaulted: false,
    matched_needs: ['equipment'],
  },
  profile_qualifies: { passed: true, eligibility: 'eligible' },
}

const ACCEPT_SAMPLE = {
  db: null,
  profileId: 'p1',
  opportunityId: 'o1',
  matchDecision: 'ACCEPT',
  matchScore: 20,
  matchReasons: ['state matched', 'applicant_type matched'],
  fourTruthProof: FOUR_TRUTH_PROOF,
  whyFound: 'Discovered from grants.gov',
  opportunityTitle: 'Firefighter Equipment Grant',
  profileDisplayName: 'Cleveland VFD',
  config: {
    minToastMatchScore: STRONG_MATCH_SCORE,
    minToastMatchScoreScaleId: SCORE_SCALE_ID,
    allowReviewMatchToasts: true,
    maxToastsPerProfilePerDay: 5,
  },
}

describe('robertRecommendationService — creates only useful, deduped recommendations', () => {
  it('creates a HIGH-priority recommendation for a strong ACCEPT match', async () => {
    const r = await createRecommendationIfHelpful({ ...ACCEPT_SAMPLE, db })
    assert.equal(r.created, true)
    const rec = await getRecommendation(db, r.recommendation_id)
    assert.equal(rec.recommendation_status, 'pending')
    assert.equal(rec.toast_priority, 'high')
    assert.equal(rec.match_decision, 'ACCEPT')
    assert.equal(r.score_scale_id, SCORE_SCALE_ID)
  })

  it('does NOT create a recommendation for a REJECT decision', async () => {
    const r = await createRecommendationIfHelpful({
      ...ACCEPT_SAMPLE, db, matchDecision: 'REJECT', matchScore: 10, matchReasons: ['ineligible'],
    })
    assert.equal(r.created, false)
    assert.equal(r.reason, 'decision_reject')
  })

  it('does not turn a REVIEW decision into a direct recommendation', async () => {
    const r = await createRecommendationIfHelpful({
      ...ACCEPT_SAMPLE, db, matchDecision: 'REVIEW', matchScore: 100,
    })
    assert.equal(r.created, false)
    assert.equal(r.reason, 'decision_review')
  })

  it('rejects ACCEPT without positive four-truth proof', async () => {
    const r = await createRecommendationIfHelpful({
      ...ACCEPT_SAMPLE,
      db,
      fourTruthProof: null,
    })
    assert.equal(r.created, false)
    assert.equal(r.reason, 'missing_four_truth_proof')
  })

  it('translates an unstamped legacy toast threshold for priority only', async () => {
    const r = await createRecommendationIfHelpful({
      ...ACCEPT_SAMPLE,
      db,
      matchScore: GOOD_MATCH_SCORE,
      config: { ...ACCEPT_SAMPLE.config, minToastMatchScore: 70, minToastMatchScoreScaleId: undefined },
    })
    assert.equal(r.created, true)
    const rec = await getRecommendation(db, r.recommendation_id)
    assert.equal(rec.toast_priority, 'high')
  })

  it('refuses a non-canonical decision value', async () => {
    const r = await createRecommendationIfHelpful({
      ...ACCEPT_SAMPLE, db, matchDecision: 'MAYBE', matchScore: 100,
    })
    assert.equal(r.created, false)
    assert.equal(r.reason, 'invalid_match_decision')
  })

  it('refuses to create a duplicate active recommendation', async () => {
    const first = await createRecommendationIfHelpful({ ...ACCEPT_SAMPLE, db })
    const second = await createRecommendationIfHelpful({ ...ACCEPT_SAMPLE, db })
    assert.equal(first.created, true)
    assert.equal(second.created, false)
    assert.equal(second.reason, 'duplicate_active')
  })

  it('refuses to re-create a previously DECLINED recommendation unless superseding', async () => {
    const first = await createRecommendationIfHelpful({ ...ACCEPT_SAMPLE, db })
    await markDeclined(db, first.recommendation_id)
    const blocked = await createRecommendationIfHelpful({ ...ACCEPT_SAMPLE, db })
    assert.equal(blocked.created, false)
    assert.equal(blocked.reason, 'previously_declined')
    const allowed = await createRecommendationIfHelpful({ ...ACCEPT_SAMPLE, db, supersedeDeclined: true })
    assert.equal(allowed.created, true)
  })

  it('listRecommendationsForProfile returns only active recs for that profile', async () => {
    const a = await createRecommendationIfHelpful({ ...ACCEPT_SAMPLE, db, profileId: 'p1', opportunityId: 'oa' })
    const b = await createRecommendationIfHelpful({ ...ACCEPT_SAMPLE, db, profileId: 'p1', opportunityId: 'ob' })
    const c = await createRecommendationIfHelpful({ ...ACCEPT_SAMPLE, db, profileId: 'p2', opportunityId: 'oc' })
    assert.ok(a.created && b.created && c.created)
    const p1List = await listRecommendationsForProfile(db, 'p1')
    assert.equal(p1List.length, 2)
    for (const rec of p1List) assert.equal(rec.profile_id, 'p1')
  })

  it('mark accepted/declined/viewed updates status and timestamps', async () => {
    const r = await createRecommendationIfHelpful({ ...ACCEPT_SAMPLE, db })
    await markViewed(db, r.recommendation_id)
    let rec = await getRecommendation(db, r.recommendation_id)
    assert.equal(rec.recommendation_status, 'viewed')
    assert.ok(rec.viewed_at)

    await markAccepted(db, r.recommendation_id)
    rec = await getRecommendation(db, r.recommendation_id)
    assert.equal(rec.recommendation_status, 'accepted')
    assert.ok(rec.accepted_at)
  })

  it('downgrades to LOW priority when daily cap is reached', async () => {
    // Pre-fill 5 recs (the default daily cap)
    for (let i = 0; i < 5; i += 1) {
      await createRecommendationIfHelpful({ ...ACCEPT_SAMPLE, db, opportunityId: `o-pre-${i}` })
    }
    const overCap = await createRecommendationIfHelpful({
      ...ACCEPT_SAMPLE, db, opportunityId: 'o-overcap', matchScore: 6,
    })
    assert.equal(overCap.created, true)
    const rec = await getRecommendation(db, overCap.recommendation_id)
    assert.equal(rec.toast_priority, 'low')
  })
})
