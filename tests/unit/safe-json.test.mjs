import test from 'node:test'
import assert from 'node:assert/strict'
import { safeParseJSON } from '../../backend/utils/safeJson.js'

test('safeParseJSON: parses JSON strings', () => {
  assert.deepEqual(safeParseJSON('{"a":1}', {}), { a: 1 })
})

test('safeParseJSON: returns already-parsed objects (pg json/jsonb)', () => {
  const obj = { full_name: 'Test', nested: { x: 1 } }
  assert.deepEqual(safeParseJSON(obj, {}), obj)
})

test('safeParseJSON: returns arrays as-is', () => {
  const arr = [{ id: 1 }]
  assert.deepEqual(safeParseJSON(arr, []), arr)
})

test('safeParseJSON: parses Buffers of JSON', () => {
  assert.deepEqual(safeParseJSON(Buffer.from('{"k":"v"}'), {}), { k: 'v' })
})

test('safeParseJSON: invalid string falls back', () => {
  assert.deepEqual(safeParseJSON('{not json', { ok: true }), { ok: true })
})

test('safeParseJSON: double-encoded JSON string (quoted blob in TEXT)', () => {
  const blob = JSON.stringify(JSON.stringify({ full_name: 'Demo Client', n: 1 }))
  assert.deepEqual(safeParseJSON(blob, {}), { full_name: 'Demo Client', n: 1 })
})
