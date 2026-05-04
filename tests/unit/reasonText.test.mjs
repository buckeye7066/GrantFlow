import test from 'node:test'
import assert from 'node:assert/strict'

import { formatReasonText, formatReasonList } from '../../src/utils/reasonText.js'

// ---------------------------------------------------------------------------
// Regression: production saw `Minified React error #31; ...found: object with
// keys {reason, source}` repeatedly crash routes that render
// `match_reasons.map((r) => <Badge>{r}</Badge>)`. The fix is that no render
// site renders a raw value — they all go through `formatReasonText`, which is
// guaranteed to return a string for *every* shape we have ever observed.
// These tests pin that contract so future shape drift can never re-introduce
// the same crash.
// ---------------------------------------------------------------------------

test('returns the empty string for null / undefined / empty object', () => {
  assert.equal(formatReasonText(null), '')
  assert.equal(formatReasonText(undefined), '')
  assert.equal(formatReasonText({}), '')
})

test('returns strings unchanged', () => {
  assert.equal(formatReasonText('Matches profile state (OH)'), 'Matches profile state (OH)')
  assert.equal(formatReasonText(''), '')
})

test('coerces numbers and booleans to strings', () => {
  assert.equal(formatReasonText(42), '42')
  assert.equal(formatReasonText(0), '0')
  assert.equal(formatReasonText(true), 'true')
  assert.equal(formatReasonText(false), 'false')
})

test('joins arrays of strings with commas', () => {
  assert.equal(formatReasonText(['a', 'b', 'c']), 'a, b, c')
})

test('flattens nested arrays via recursion', () => {
  assert.equal(formatReasonText(['a', ['b', 'c'], 'd']), 'a, b, c, d')
})

test('handles the {reason, source} shape that triggered React #31 in production', () => {
  const result = formatReasonText({ reason: 'Matches state', source: 'profile' })
  assert.equal(typeof result, 'string')
  assert.ok(result.length > 0, 'must produce a non-empty string')
  assert.ok(result.includes('Matches state'), 'must surface the reason text')
  assert.ok(result.includes('profile'), 'must annotate with the source')
})

test('handles {label} shape', () => {
  assert.equal(formatReasonText({ label: 'Veteran-owned' }), 'Veteran-owned')
})

test('handles {text} shape', () => {
  assert.equal(formatReasonText({ text: 'Disability support' }), 'Disability support')
})

test('handles {message} shape', () => {
  assert.equal(formatReasonText({ message: 'Match score: 87%' }), 'Match score: 87%')
})

test('handles {name} shape', () => {
  assert.equal(formatReasonText({ name: 'Title I funding' }), 'Title I funding')
})

test('handles {key, reason} shape (from suggestion guards)', () => {
  assert.equal(
    formatReasonText({ key: 'missionary', reason: 'missing_employer_evidence' }),
    'missing_employer_evidence',
  )
})

test('falls back to key=value summary for unknown object shapes', () => {
  const result = formatReasonText({ foo: 'bar', baz: 7 })
  assert.equal(typeof result, 'string')
  assert.ok(result.length > 0)
  assert.ok(result.includes('foo'))
  assert.ok(result.includes('bar'))
})

test('truncates extremely long output to a renderable length', () => {
  const long = 'x'.repeat(10_000)
  const result = formatReasonText(long)
  assert.ok(result.length <= 250, `expected <=250 chars, got ${result.length}`)
})

test('formatReasonList returns plain string array, dropping empty entries', () => {
  const out = formatReasonList([
    'Matches state',
    null,
    undefined,
    '',
    { reason: 'Veteran', source: 'demographics' },
    {},
  ])
  assert.deepEqual(
    out.map((s) => typeof s),
    ['string', 'string'],
  )
  assert.equal(out.length, 2)
  assert.equal(out[0], 'Matches state')
  assert.ok(out[1].includes('Veteran'))
})

test('formatReasonList tolerates non-array inputs without throwing', () => {
  assert.deepEqual(formatReasonList(null), [])
  assert.deepEqual(formatReasonList(undefined), [])
  assert.deepEqual(formatReasonList('one'), ['one'])
  const out = formatReasonList({ reason: 'X', source: 'Y' })
  assert.equal(out.length, 1)
  assert.ok(out[0].includes('X'))
})

test('never throws for any historically-seen shape', () => {
  const fixtures = [
    null,
    undefined,
    '',
    'plain',
    42,
    true,
    [],
    ['a', 'b'],
    {},
    { reason: 'r' },
    { source: 's' },
    { reason: 'r', source: 's' },
    { label: 'l' },
    { text: 't' },
    { message: 'm' },
    { name: 'n' },
    { key: 'k', reason: 'r' },
    { rejected: [{ key: 'foo', reason: 'unknown_field' }] },
    new Date(),
    Symbol('whatever'),
  ]
  for (const fx of fixtures) {
    assert.doesNotThrow(() => formatReasonText(fx), `threw for fixture ${String(fx)}`)
    assert.equal(typeof formatReasonText(fx), 'string')
  }
})
