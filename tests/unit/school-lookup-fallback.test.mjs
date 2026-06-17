import test from 'node:test'
import assert from 'node:assert/strict'

import { buildSchoolLookupFallbackData, EMPTY_SCHOOL_LOOKUP_DATA } from '../../backend/services/schoolLookupFallback.js'

test('school lookup fallback fills FAFSA code for known schools', () => {
  const result = buildSchoolLookupFallbackData('Middle Tennessee State University')

  assert.equal(result.fafsaCode, '003510')
  assert.equal(result.acceptanceRate, '—')
})

test('school lookup fallback returns empty placeholders for unknown schools', () => {
  const result = buildSchoolLookupFallbackData('Totally Unknown Academy')

  assert.deepEqual(result, { ...EMPTY_SCHOOL_LOOKUP_DATA })
})
