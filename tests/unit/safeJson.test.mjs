import test from 'node:test'
import assert from 'node:assert/strict'

import { safeParseJSON, safeStringifyJSON } from '../../backend/utils/safeJson.js'

test('safeParseJSON: returns fallback for null/empty', () => {
  assert.equal(safeParseJSON(null, 'x'), 'x')
  assert.equal(safeParseJSON('', 'x'), 'x')
})

test('safeParseJSON: parses valid JSON', () => {
  assert.deepEqual(safeParseJSON('{"a":1}'), { a: 1 })
})

test('safeParseJSON: returns fallback for invalid JSON', () => {
  assert.equal(safeParseJSON('{bad}', 'fallback'), 'fallback')
})

test('safeStringifyJSON: stringifies objects', () => {
  assert.equal(safeStringifyJSON({ a: 1 }), '{"a":1}')
})

test('safeStringifyJSON: returns fallback for null', () => {
  assert.equal(safeStringifyJSON(null, 'nope'), 'nope')
})

