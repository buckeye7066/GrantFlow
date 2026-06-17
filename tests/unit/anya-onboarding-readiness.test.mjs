import test from 'node:test'
import assert from 'node:assert/strict'

import {
  auditCompletedOnboarding,
  auditRecentCompletions,
  __exposed,
} from '../../backend/services/sam/samOnboardingReadinessAudit.js'

const FAKE_DB = { dialect: 'sqlite' } // value is irrelevant; we inject the readiness fn

function fakeReadiness(score, categoryShares = {}) {
  // categoryShares: { identity: 1.0, location: 0.5, funding_needs: 0.0, ... }
  // returns the standard detailed-readiness shape.
  const categoryDefs = [
    { key: 'identity', weight: 12 },
    { key: 'location', weight: 12 },
    { key: 'funding_needs', weight: 16 },
    { key: 'amount', weight: 8 },
    { key: 'eligibility', weight: 12 },
    { key: 'org_status', weight: 8 },
    { key: 'documents', weight: 8 },
    { key: 'timeline', weight: 8 },
    { key: 'narrative', weight: 8 },
    { key: 'contact', weight: 8 },
  ]
  const categories = categoryDefs.map((c) => ({
    key: c.key,
    weight: c.weight,
    earned: c.weight * (categoryShares[c.key] ?? 0.5),
  }))
  return async () => ({
    readiness_score: score,
    status: score >= 80 ? 'excellent' : score >= 60 ? 'good' : score >= 40 ? 'needs_work' : 'poor',
    categories,
    missing_items: [],
    recommended_questions: [],
  })
}

test('floor constants are sensible', () => {
  assert.equal(__exposed.READINESS_FLOOR, 50)
  assert.equal(__exposed.ROBERT_SEARCH_FLOOR, 60)
})

test('flags low overall readiness after onboarding', async () => {
  const r = await auditCompletedOnboarding(FAKE_DB, 'p1', {
    computeDetailedReadiness: fakeReadiness(35),
  })
  const lowFinding = r.findings.find((f) => f.category === 'readiness_too_low_after_onboarding')
  assert.ok(lowFinding, 'expected readiness_too_low finding')
  assert.equal(lowFinding.severity, 'high')
})

test('passes when readiness is healthy', async () => {
  const r = await auditCompletedOnboarding(FAKE_DB, 'p1', {
    computeDetailedReadiness: fakeReadiness(82, {
      identity: 1.0,
      location: 1.0,
      funding_needs: 1.0,
    }),
  })
  assert.deepEqual(r.findings, [])
  assert.ok(r.robert_search_readiness >= 60)
})

test('flags Robert search readiness when location missing', async () => {
  const r = await auditCompletedOnboarding(FAKE_DB, 'p1', {
    computeDetailedReadiness: fakeReadiness(60, {
      identity: 1.0,
      location: 0.0,
      funding_needs: 0.0,
    }),
  })
  const robertFinding = r.findings.find((f) => f.category === 'robert_search_readiness_too_low')
  assert.ok(robertFinding, 'expected robert_search_readiness_too_low finding')
  assert.ok(r.robert_search_readiness < 60)
})

test('aggregates many profiles', async () => {
  const r = await auditRecentCompletions(FAKE_DB, ['p1', 'p2', 'p3'], {
    computeDetailedReadiness: fakeReadiness(70, {
      identity: 1.0,
      location: 1.0,
      funding_needs: 1.0,
    }),
  })
  assert.equal(r.audited, 3)
  assert.equal(r.summaries.length, 3)
  assert.ok(r.avg_readiness >= 65 && r.avg_readiness <= 75)
  assert.ok(r.avg_robert_readiness >= 80)
})

test('degrades gracefully when readiness service is unavailable', async () => {
  // No override and no real service: passes through resolver. We can stub
  // resolveReadiness via a fake injection that returns null.
  const r = await auditCompletedOnboarding(FAKE_DB, 'p1', {
    // the helper accepts a non-function override gracefully
    computeDetailedReadiness: undefined,
  })
  // We can't guarantee whether the live profileReadinessService.js
  // exports computeDetailedReadiness on this branch, but the function
  // must always return without throwing.
  assert.ok(r)
  assert.ok(Array.isArray(r.findings))
})

test('handles missing profileId', async () => {
  const r = await auditCompletedOnboarding(FAKE_DB, null, {
    computeDetailedReadiness: fakeReadiness(80),
  })
  assert.ok(r)
  assert.equal(r.profile_id, null)
})
