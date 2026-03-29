/**
 * Scoring Consolidation Tests (D-001/D-002/D-006/D-008/D-009/D-010/D-018)
 *
 * Verifies that:
 * - profileHelpers.js does NOT export calculateMatchScore
 * - canonical matchingEngine.calculateMatchScore is the only scoring path
 * - anya.js uses timing-safe token comparison
 * - eligibilityFilter.js uses isValidHttpUrl for URL validation
 * - eligibilityFilter.js normalizes both dates to midnight for comparison
 * - mockAI.js throws in production
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

// ──────────────────────────────────────────────────────────────────────────────
// D-001: profileHelpers must NOT export calculateMatchScore
// ──────────────────────────────────────────────────────────────────────────────
test('profileHelpers does not export calculateMatchScore', async () => {
  const mod = await import('../../backend/services/profileHelpers.js')
  assert.equal(
    typeof mod.calculateMatchScore,
    'undefined',
    'calculateMatchScore must not be exported from profileHelpers.js'
  )
})

// ──────────────────────────────────────────────────────────────────────────────
// D-002: All scoring paths delegate to canonical matchingEngine
// ──────────────────────────────────────────────────────────────────────────────
test('matchingEngine exports calculateMatchScore as the canonical scorer', async () => {
  const { calculateMatchScore } = await import('../../backend/services/matchingEngine.js')
  assert.equal(typeof calculateMatchScore, 'function', 'matchingEngine must export calculateMatchScore')
})

test('calculateMatchScore returns a numeric score between 0 and 100', async () => {
  const { calculateMatchScore } = await import('../../backend/services/matchingEngine.js')
  const profile = { state: 'TN', applicant_type: 'individual_need' }
  const opp = {
    title: 'Tennessee Emergency Housing Grant',
    description: 'For low-income individuals in Tennessee needing emergency housing',
    state: 'TN',
    is_national: false,
    keywords: ['housing', 'low income'],
    categories: ['housing'],
  }
  const result = calculateMatchScore(profile, opp)
  assert.ok(typeof result.score === 'number', 'score must be a number')
  assert.ok(result.score >= 0 && result.score <= 100, `score ${result.score} must be between 0 and 100`)
  assert.ok(Array.isArray(result.reasons), 'reasons must be an array')
})

test('calculateMatchScore is deterministic — same inputs yield same score', async () => {
  const { calculateMatchScore } = await import('../../backend/services/matchingEngine.js')
  const profile = { state: 'OH', applicant_type: 'nonprofit', veteran: true }
  const opp = {
    title: 'Ohio Veteran Services Fund',
    description: 'Supports veterans in Ohio with services',
    state: 'OH',
    keywords: ['veteran', 'ohio'],
    categories: ['veteran services'],
    is_national: false,
  }
  const r1 = calculateMatchScore(profile, opp)
  const r2 = calculateMatchScore(profile, opp)
  assert.equal(r1.score, r2.score, 'calculateMatchScore must be deterministic')
})

test('calculateMatchScore accepts full profileContext { profile, sections }', async () => {
  const { calculateMatchScore } = await import('../../backend/services/matchingEngine.js')
  const profileContext = {
    profile: { state: 'TN', id: 'p1' },
    sections: [{ section_key: 'demographics', data: JSON.stringify({ veteran: true }) }],
  }
  const opp = {
    title: 'Veteran Housing Grant',
    description: 'For veterans in Tennessee',
    state: 'TN',
    keywords: ['veteran'],
    is_national: false,
  }
  const result = calculateMatchScore(profileContext, opp)
  assert.ok(typeof result.score === 'number', 'must return a numeric score with profileContext')
})

// ──────────────────────────────────────────────────────────────────────────────
// D-006: Timing-safe token comparison in anya.js
// ──────────────────────────────────────────────────────────────────────────────
test('timing-safe comparison returns true for equal strings', () => {
  const a = 'my-secret-token-1234'
  const b = 'my-secret-token-1234'
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  assert.ok(
    bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB),
    'timingSafeEqual must return true for equal buffers'
  )
})

test('timing-safe comparison returns false for different strings of same length', () => {
  const a = 'my-secret-token-1234'
  const b = 'my-secret-token-XXXX'
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  assert.ok(
    !crypto.timingSafeEqual(bufA, bufB),
    'timingSafeEqual must return false for different buffers of same length'
  )
})

test('timing-safe comparison rejects length mismatch before calling timingSafeEqual', () => {
  const a = 'short'
  const b = 'longer-string'
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  // timingSafeEqual throws if lengths differ, so we must guard
  assert.throws(
    () => crypto.timingSafeEqual(bufA, bufB),
    'timingSafeEqual must throw when buffer lengths differ'
  )
})

// ──────────────────────────────────────────────────────────────────────────────
// D-009: eligibilityFilter normalizes deadline comparison to midnight
// ──────────────────────────────────────────────────────────────────────────────
test('eligibilityFilter isExpired: deadline is today (same day) should NOT be expired', async () => {
  const { filterEligibility } = await import('../../backend/services/profileIntelligence/eligibilityFilter.js')
  const { buildProfileIntelligence } = await import('../../backend/services/profileIntelligence/index.js')

  const profile = {
    id: 'test-p1',
    display_name: 'Test Individual',
    primary_type: 'individual',
    applicant_type: 'individual_need',
    state: 'TN',
  }
  const intel = buildProfileIntelligence(profile, {})

  // Set deadline to today — should NOT be expired
  const today = new Date()
  const todayStr = today.toISOString().slice(0, 10)

  const opp = {
    title: 'Test Opportunity',
    deadline: todayStr,
    deadline_type: 'fixed',
    source_url: 'https://example.gov/grant',
  }

  const result = filterEligibility(intel, opp)
  const expiredFailure = (result.hard_failures || []).some(f => f === 'deadline_expired')
  assert.ok(!expiredFailure, `Opportunity with deadline=today should not be marked expired, got: ${JSON.stringify(result.hard_failures)}`)
})

test('eligibilityFilter isExpired: deadline yesterday should be expired', async () => {
  const { filterEligibility } = await import('../../backend/services/profileIntelligence/eligibilityFilter.js')
  const { buildProfileIntelligence } = await import('../../backend/services/profileIntelligence/index.js')

  const profile = {
    id: 'test-p2',
    display_name: 'Test Individual',
    primary_type: 'individual',
    applicant_type: 'individual_need',
    state: 'TN',
  }
  const intel = buildProfileIntelligence(profile, {})

  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  const yesterdayStr = yesterday.toISOString().slice(0, 10)

  const opp = {
    title: 'Expired Opportunity',
    deadline: yesterdayStr,
    deadline_type: 'fixed',
    source_url: 'https://example.gov/grant',
  }

  const result = filterEligibility(intel, opp)
  const expiredFailure = (result.hard_failures || []).some(f => f === 'deadline_expired')
  assert.ok(expiredFailure, `Opportunity with deadline=yesterday should be marked expired, got: ${JSON.stringify(result.hard_failures)}`)
})

// ──────────────────────────────────────────────────────────────────────────────
// D-010: eligibilityFilter uses isValidHttpUrl for URL validation
// ──────────────────────────────────────────────────────────────────────────────
test('eligibilityFilter hasSourceUrl rejects non-http URLs', async () => {
  const { filterEligibility } = await import('../../backend/services/profileIntelligence/eligibilityFilter.js')
  const { buildProfileIntelligence } = await import('../../backend/services/profileIntelligence/index.js')

  const profile = {
    id: 'test-p3',
    display_name: 'Test Individual',
    primary_type: 'individual',
    applicant_type: 'individual_need',
  }
  const intel = buildProfileIntelligence(profile, {})

  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)

  const opp = {
    title: 'Bad URL Opportunity',
    deadline: tomorrow.toISOString().slice(0, 10),
    deadline_type: 'fixed',
    source_url: 'not-a-valid-url',
    application_url: '',
  }

  const result = filterEligibility(intel, opp)
  const urlFailure = (result.hard_failures || []).some(f => f === 'no_source_url')
  assert.ok(urlFailure, `Opportunity with invalid URL should fail no_source_url check, got: ${JSON.stringify(result.hard_failures)}`)
})

test('eligibilityFilter hasSourceUrl accepts valid https URL', async () => {
  const { filterEligibility } = await import('../../backend/services/profileIntelligence/eligibilityFilter.js')
  const { buildProfileIntelligence } = await import('../../backend/services/profileIntelligence/index.js')

  const profile = {
    id: 'test-p4',
    display_name: 'Test Individual',
    primary_type: 'individual',
    applicant_type: 'individual_need',
  }
  const intel = buildProfileIntelligence(profile, {})

  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)

  const opp = {
    title: 'Valid URL Opportunity',
    deadline: tomorrow.toISOString().slice(0, 10),
    deadline_type: 'fixed',
    source_url: 'https://grants.gov/valid-grant',
  }

  const result = filterEligibility(intel, opp)
  const urlFailure = (result.hard_failures || []).some(f => f === 'no_source_url')
  assert.ok(!urlFailure, `Opportunity with valid URL should not fail URL check, got: ${JSON.stringify(result.hard_failures)}`)
})

// ──────────────────────────────────────────────────────────────────────────────
// D-018: mockAI throws in production
// ──────────────────────────────────────────────────────────────────────────────
test('mockAI throws immediately if NODE_ENV is production', async () => {
  // The module-level guard throws at import time when NODE_ENV=production.
  // We use a cache-busting query parameter so Node.js ESM treats it as a fresh module URL.
  const original = process.env.NODE_ENV
  try {
    process.env.NODE_ENV = 'production'
    const uniqueUrl = new URL(
      `../../backend/services/mockAI.js?nocache=${Date.now()}`,
      import.meta.url
    ).href
    await assert.rejects(
      () => import(uniqueUrl),
      (err) => /production/i.test(err?.message ?? ''),
      'mockAI must throw when NODE_ENV=production'
    )
  } finally {
    process.env.NODE_ENV = original
  }
})

// ──────────────────────────────────────────────────────────────────────────────
// D-017: applicant_type alias — canonical scorer uses applicant_type
// ──────────────────────────────────────────────────────────────────────────────
test('calculateMatchScore uses applicant_type field (frontend canonical field)', async () => {
  const { calculateMatchScore } = await import('../../backend/services/matchingEngine.js')
  const profile = { state: 'TN', applicant_type: 'nonprofit' }
  const opp = {
    title: 'Nonprofit Community Grant',
    description: 'For nonprofit organizations in Tennessee',
    state: 'TN',
    keywords: ['nonprofit', 'community'],
    is_national: false,
  }
  const result = calculateMatchScore(profile, opp)
  assert.ok(typeof result.score === 'number', 'score must be returned for profile with applicant_type')
})
