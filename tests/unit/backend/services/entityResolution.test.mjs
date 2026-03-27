import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveEntityMatch, normalizeAddress } from '../../../../backend/services/entityResolution.js'

test('matches identical UEI with full confidence', () => {
  const existing = { entity_id: 1, uei: 'ABC123XYZ999' }
  const incoming = { entity_id: 2, uei: 'ABC123XYZ999' }

  const result = resolveEntityMatch(existing, incoming)

  assert.equal(result.matched, true)
  assert.equal(result.method, 'direct_key')
  assert.equal(result.confidence, 1)
  assert.equal(result.autoMergeEligible, true)
})

test('blocks EIN match when source is not authoritative', () => {
  const existing = { entity_id: 1, ein: '123456789', source: 'sam' }
  const incoming = { entity_id: 2, ein: '123456789', source: 'vendor' }

  const result = resolveEntityMatch(existing, incoming)

  assert.equal(result.matched, false)
})

test('matches exact name and address tuple', () => {
  const existing = {
    entity_id: 1,
    legal_name: 'Alpha Biolabs LLC',
    address: { line1: '123 Main St', city: 'Cleveland', state: 'TN', zip: '37311' },
  }

  const incoming = {
    entity_id: 2,
    legal_name: 'Alpha Biolabs',
    address: { line1: '123 Main Street', city: 'Cleveland', state: 'TN', zip: '37311' },
  }

  const result = resolveEntityMatch(existing, incoming)

  assert.equal(result.matched, true)
  assert.equal(result.method, 'exact_tuple')
})

test('returns fuzzy match requiring review', () => {
  const existing = {
    entity_id: 1,
    legal_name: 'Alpha Biolabs',
    address: { line1: '123 Main St', city: 'Cleveland', state: 'TN', zip: '37311' },
  }

  const incoming = {
    entity_id: 2,
    legal_name: 'Alpha Biolab Incorporated',
    address: { line1: '123 Main Street', city: 'Cleveland', state: 'TN', zip: '37311' },
  }

  const result = resolveEntityMatch(existing, incoming)

  assert.equal(result.matched, true)
  assert.equal(result.method, 'fuzzy')
  assert.equal(result.reviewRequired, true)
})

test('returns no match for unrelated entities', () => {
  const existing = { entity_id: 1, legal_name: 'Alpha Biolabs' }
  const incoming = { entity_id: 2, legal_name: 'Zeta Holdings' }

  const result = resolveEntityMatch(existing, incoming)

  assert.equal(result.matched, false)
})

test('normalizeAddress: St and Street canonicalize identically', () => {
  const withAbbrev = normalizeAddress({ line1: '123 Main St', city: 'Columbus', state: 'OH', zip: '43004' })
  const withFull = normalizeAddress({ line1: '123 Main Street', city: 'Columbus', state: 'OH', zip: '43004' })

  assert.equal(withAbbrev, withFull)
})
