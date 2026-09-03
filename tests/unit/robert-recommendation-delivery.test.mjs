import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { makeMemoryDb } from './robert-test-helpers.mjs'
import {
  createRecommendationIfHelpful,
} from '../../backend/services/robert/robertRecommendationService.js'
import {
  selectDeliverable,
  markDelivered,
  listRecommendationsSince,
} from '../../backend/services/robert/robertRecommendationDelivery.js'
import { getRecommendation } from '../../backend/services/robert/robertRunStore.js'
import { SCORE_SCALE_ID, STRONG_MATCH_SCORE } from '../../backend/config/matchThresholds.js'

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

const BASE = {
  matchDecision: 'ACCEPT', matchScore: 20, matchReasons: ['fit'],
  fourTruthProof: FOUR_TRUTH_PROOF,
  whyFound: 'discovered', opportunityTitle: 'Grant', profileDisplayName: 'Profile',
  config: {
    minToastMatchScore: STRONG_MATCH_SCORE,
    minToastMatchScoreScaleId: SCORE_SCALE_ID,
    maxToastsPerProfilePerDay: 5,
    allowReviewMatchToasts: true,
  },
}

describe('robertRecommendationDelivery — durable, dedup\'d toast queue', () => {
  it('selectDeliverable splits high/normal/batch correctly', async () => {
    await createRecommendationIfHelpful({ ...BASE, db, profileId: 'p1', opportunityId: 'o1' }) // strong ACCEPT → high
    await createRecommendationIfHelpful({ ...BASE, db, profileId: 'p1', opportunityId: 'o2', matchScore: 7 })
    // Force a low-priority by exceeding cap.
    for (let i = 0; i < 5; i += 1) {
      await createRecommendationIfHelpful({ ...BASE, db, profileId: 'p1', opportunityId: `o-pre-${i}` })
    }
    const next = await createRecommendationIfHelpful({ ...BASE, db, profileId: 'p1', opportunityId: 'o-low', matchScore: 6 })
    assert.equal(next.created, true)

    const slice = await selectDeliverable({ db, profileId: 'p1', config: BASE.config })
    assert.ok(slice.immediate.length >= 1, 'at least one HIGH item ready')
    assert.ok(slice.batch.length >= 1, 'has a low-priority batch item')
  })

  it('does not return any recommendations for a different profile', async () => {
    await createRecommendationIfHelpful({ ...BASE, db, profileId: 'p1', opportunityId: 'o1' })
    await createRecommendationIfHelpful({ ...BASE, db, profileId: 'p2', opportunityId: 'o2' })
    const sliceP1 = await selectDeliverable({ db, profileId: 'p1' })
    const sliceP2 = await selectDeliverable({ db, profileId: 'p2' })
    for (const rec of [...sliceP1.immediate, ...sliceP1.normal, ...sliceP1.batch]) assert.equal(rec.profile_id, 'p1')
    for (const rec of [...sliceP2.immediate, ...sliceP2.normal, ...sliceP2.batch]) assert.equal(rec.profile_id, 'p2')
  })

  it('markDelivered transitions pending → delivered_live and stamps toast_shown_at', async () => {
    const r = await createRecommendationIfHelpful({ ...BASE, db, profileId: 'p1', opportunityId: 'o1' })
    await markDelivered(db, r.recommendation_id, { via: 'live' })
    const rec = await getRecommendation(db, r.recommendation_id)
    assert.equal(rec.recommendation_status, 'delivered')
    assert.equal(rec.delivery_status, 'delivered_live')
    assert.ok(rec.toast_shown_at)
    assert.equal(rec.delivery_attempts, 1)
  })

  it('on-login delivery transitions to delivered_on_login (recovers missed live events)', async () => {
    const r = await createRecommendationIfHelpful({ ...BASE, db, profileId: 'p1', opportunityId: 'o1' })
    await markDelivered(db, r.recommendation_id, { via: 'login' })
    const rec = await getRecommendation(db, r.recommendation_id)
    assert.equal(rec.delivery_status, 'delivered_on_login')
  })

  it('listRecommendationsSince filters by created_at and skips declined', async () => {
    const a = await createRecommendationIfHelpful({ ...BASE, db, profileId: 'p1', opportunityId: 'oa' })
    const b = await createRecommendationIfHelpful({ ...BASE, db, profileId: 'p1', opportunityId: 'ob' })
    const c = await createRecommendationIfHelpful({ ...BASE, db, profileId: 'p1', opportunityId: 'oc' })
    assert.ok(a.created && b.created && c.created)
    // Decline B → should be excluded.
    const { markDeclined } = await import('../../backend/services/robert/robertRecommendationService.js')
    await markDeclined(db, b.recommendation_id)
    const since = '1970-01-01T00:00:00.000Z'
    const items = await listRecommendationsSince(db, 'p1', since, { limit: 10 })
    const ids = items.map((i) => i.id)
    assert.ok(ids.includes(a.recommendation_id))
    assert.ok(ids.includes(c.recommendation_id))
    assert.ok(!ids.includes(b.recommendation_id))
  })
})
