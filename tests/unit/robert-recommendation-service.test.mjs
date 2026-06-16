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

let db
beforeEach(() => { db = makeMemoryDb() })

const ACCEPT_SAMPLE = {
  db: null,
  profileId: 'p1',
  opportunityId: 'o1',
  matchDecision: 'ACCEPT',
  matchScore: 85,
  matchReasons: ['state matched', 'applicant_type matched'],
  whyFound: 'Discovered from grants.gov',
  opportunityTitle: 'Firefighter Equipment Grant',
  profileDisplayName: 'Cleveland VFD',
  config: { minToastMatchScore: 70, allowReviewMatchToasts: true, maxToastsPerProfilePerDay: 5 },
}

describe('robertRecommendationService — creates only useful, deduped recommendations', () => {
  it('creates a HIGH-priority recommendation for a strong ACCEPT match', async () => {
    const r = await createRecommendationIfHelpful({ ...ACCEPT_SAMPLE, db })
    assert.equal(r.created, true)
    const rec = await getRecommendation(db, r.recommendation_id)
    assert.equal(rec.recommendation_status, 'pending')
    assert.equal(rec.toast_priority, 'high')
    assert.equal(rec.match_decision, 'ACCEPT')
  })

  it('does NOT create a recommendation for a REJECT decision', async () => {
    const r = await createRecommendationIfHelpful({
      ...ACCEPT_SAMPLE, db, matchDecision: 'REJECT', matchScore: 10, matchReasons: ['ineligible'],
    })
    assert.equal(r.created, false)
    assert.equal(r.reason, 'decision_reject')
  })

  it('does NOT create a recommendation for a low-confidence REVIEW', async () => {
    const r = await createRecommendationIfHelpful({
      ...ACCEPT_SAMPLE, db, matchDecision: 'REVIEW', matchScore: 30,
    })
    assert.equal(r.created, false)
    assert.equal(r.reason, 'below_review_threshold')
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
      ...ACCEPT_SAMPLE, db, opportunityId: 'o-overcap', matchDecision: 'REVIEW', matchScore: 60,
    })
    assert.equal(overCap.created, true)
    const rec = await getRecommendation(db, overCap.recommendation_id)
    assert.equal(rec.toast_priority, 'low')
  })
})
