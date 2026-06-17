/**
 * Larry — prospect discovery: source planning + raw record normalization.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  planProspectFetches,
  normalizeRawRecord,
  discoverProspects,
} from '../../backend/services/larry/larryProspectDiscovery.js'
import { PROSPECT_REJECTION_REASONS } from '../../backend/services/larry/larryTypes.js'
import { createInMemoryDb } from './larry-test-helpers.mjs'

test('planProspectFetches biases toward national high-trust sources', () => {
  const plan = planProspectFetches({ applicantTypes: ['nonprofit'], maxSources: 3 })
  assert.ok(plan.length > 0)
  assert.ok(plan.length <= 3)
  // Top entry should be IRS BMF or USAspending — those are the highest-trust national directories.
  const topIds = plan.slice(0, 2).map((p) => p.source_id)
  assert.ok(topIds.includes('irs_bmf') || topIds.includes('usaspending_assistance'),
    `expected national high-trust source first, got ${topIds.join(',')}`)
})

test('normalizeRawRecord rejects records without a name', () => {
  const result = normalizeRawRecord({ city: 'Cleveland', state: 'TN' })
  assert.equal(result.rejected, true)
  assert.equal(result.reason, PROSPECT_REJECTION_REASONS.NO_NAME)
})

test('normalizeRawRecord rejects records without any location', () => {
  const result = normalizeRawRecord({ organization_name: 'Test Org' })
  assert.equal(result.rejected, true)
  assert.equal(result.reason, PROSPECT_REJECTION_REASONS.NO_LOCATION)
})

test('normalizeRawRecord rejects placeholder website URLs', () => {
  const result = normalizeRawRecord({
    organization_name: 'Test Org',
    city: 'Athens',
    state: 'TN',
    website_url: 'https://example.com',
  })
  assert.equal(result.rejected, true)
  assert.equal(result.reason, PROSPECT_REJECTION_REASONS.PLACEHOLDER_DATA)
})

test('normalizeRawRecord rejects disposable email domains', () => {
  const result = normalizeRawRecord({
    organization_name: 'Test Org',
    state: 'TN',
    primary_contact_email: 'foo@mailinator.com',
  })
  assert.equal(result.rejected, true)
  assert.equal(result.reason, PROSPECT_REJECTION_REASONS.EMAIL_DISPOSABLE)
})

test('normalizeRawRecord rejects government agencies', () => {
  const result = normalizeRawRecord({
    organization_name: 'Federal Agency',
    state: 'DC',
    organization_type: 'federal_agency',
  })
  assert.equal(result.rejected, true)
  assert.equal(result.reason, PROSPECT_REJECTION_REASONS.GOVERNMENT_AGENCY)
})

test('normalizeRawRecord accepts a clean nonprofit', () => {
  const result = normalizeRawRecord({
    organization_name: 'Athens Community Food Pantry',
    organization_type: 'nonprofit',
    city: 'Athens',
    state: 'TN',
    website_url: 'https://athensfoodpantry.org',
    primary_contact_email: 'director@athensfoodpantry.org',
  })
  assert.equal(result.rejected, undefined, 'should not be rejected')
  assert.equal(result.candidate.organization_name, 'Athens Community Food Pantry')
  assert.equal(result.candidate.applicant_type, null) // not provided in input
})

test('discoverProspects refuses to call adapter without one', async () => {
  await assert.rejects(
    () => discoverProspects({ db: createInMemoryDb(), searchAdapter: null }),
    /searchAdapter/,
  )
})

test('discoverProspects persists clean records and rejects junk with reasons', async () => {
  const db = createInMemoryDb()
  const adapter = async () => ({
    records: [
      {
        organization_name: 'Athens Community Food Pantry',
        organization_type: 'nonprofit',
        city: 'Athens',
        state: 'TN',
        website_url: 'https://athensfoodpantry.org',
      },
      { organization_name: 'No Place To Be Found' /* missing location */ },
      {
        organization_name: 'Junk Org',
        state: 'TN',
        website_url: 'https://example.com',
      },
    ],
  })

  const result = await discoverProspects({
    db,
    searchAdapter: adapter,
    applicantTypes: ['nonprofit'],
    maxSources: 1,
    config: { allowLiveWeb: true, persistProspects: true, rateLimitPerDomainPerHour: 100 },
  })

  assert.equal(result.candidates.length, 1, `expected 1 candidate, got ${result.candidates.length}`)
  assert.equal(result.rejected.length >= 2, true, `expected ≥2 rejected, got ${result.rejected.length}`)
  assert.ok(result.rejected.some((r) => r.reason === PROSPECT_REJECTION_REASONS.NO_LOCATION))
  assert.ok(result.rejected.some((r) => r.reason === PROSPECT_REJECTION_REASONS.PLACEHOLDER_DATA))

  const persisted = db.prepare('SELECT organization_name FROM larry_prospect_candidates').all()
  assert.equal(persisted.length, 1)
  assert.equal(persisted[0].organization_name, 'Athens Community Food Pantry')
})
