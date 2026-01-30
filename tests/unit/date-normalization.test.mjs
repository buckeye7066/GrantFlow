import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeDateToIso } from '../../backend/services/dateNormalization.js'

test('normalizeDateToIso handles known crawler formats', () => {
  assert.equal(normalizeDateToIso('2026-04-10-00-00-00'), '2026-04-10')
  assert.equal(normalizeDateToIso('01/13/2030'), '2030-01-13')
  assert.equal(normalizeDateToIso(' 01/3/2030 '), '2030-01-03')
})

test('normalizeDateToIso is null-safe', () => {
  assert.equal(normalizeDateToIso(null), null)
  assert.equal(normalizeDateToIso(undefined), null)
  assert.equal(normalizeDateToIso(''), null)
  assert.equal(normalizeDateToIso('   '), null)
})

