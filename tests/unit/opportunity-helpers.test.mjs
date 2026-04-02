import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..', '..')

// Import helpers from the extracted module
const helpersPath = path.join(rootDir, 'backend', 'routes', 'opportunityHelpers.js')
const {
  parseLooseDate,
  normalizeUrlForDedupe,
  dedupeKeyFromRow,
  isExpiredOpportunity,
} = await import(pathToFileURL(helpersPath).href)

// ─── parseLooseDate ─────────────────────────────────────────────
test('parseLooseDate - ISO format', () => {
  const d = parseLooseDate('2024-03-15')
  assert.ok(d instanceof Date)
  assert.equal(d.toISOString().slice(0, 10), '2024-03-15')
})

test('parseLooseDate - human format "April 14th, 2001"', () => {
  const d = parseLooseDate('April 14th, 2001')
  assert.ok(d instanceof Date)
  assert.equal(d.getFullYear(), 2001)
  assert.equal(d.getUTCMonth(), 3) // April = 3
  assert.equal(d.getUTCDate(), 14)
})

test('parseLooseDate - comma spacing "March 1, 2025"', () => {
  const d = parseLooseDate('March 1, 2025')
  assert.ok(d instanceof Date)
  assert.equal(d.getFullYear(), 2025)
  assert.equal(d.getUTCMonth(), 2) // March = 2
})

test('parseLooseDate - returns null for invalid input', () => {
  assert.equal(parseLooseDate(null), null)
  assert.equal(parseLooseDate(''), null)
  assert.equal(parseLooseDate('not a date'), null)
  assert.equal(parseLooseDate(undefined), null)
})

test('parseLooseDate - Date instance passthrough', () => {
  const input = new Date('2024-06-01T00:00:00Z')
  const d = parseLooseDate(input)
  assert.ok(d instanceof Date)
  assert.equal(d.getTime(), input.getTime())
})

test('parseLooseDate - invalid Date instance returns null', () => {
  const d = parseLooseDate(new Date('invalid'))
  assert.equal(d, null)
})

// ─── normalizeUrlForDedupe ──────────────────────────────────────
test('normalizeUrlForDedupe - strips UTM params', () => {
  const result = normalizeUrlForDedupe('https://example.com/grant?utm_source=google&utm_medium=cpc&id=123')
  assert.ok(result.includes('id=123'))
  assert.ok(!result.includes('utm_source'))
  assert.ok(!result.includes('utm_medium'))
})

test('normalizeUrlForDedupe - removes hash', () => {
  const result = normalizeUrlForDedupe('https://example.com/page#section')
  assert.ok(!result.includes('#'))
  assert.ok(result.includes('example.com/page'))
})

test('normalizeUrlForDedupe - lowercases host and path', () => {
  const result = normalizeUrlForDedupe('https://Example.COM/Grant-Page/')
  assert.equal(result, 'https://example.com/grant-page')
})

test('normalizeUrlForDedupe - removes trailing slash', () => {
  const result = normalizeUrlForDedupe('https://example.com/grants/')
  assert.ok(!result.endsWith('/'))
})

test('normalizeUrlForDedupe - returns null for empty/null', () => {
  assert.equal(normalizeUrlForDedupe(null), null)
  assert.equal(normalizeUrlForDedupe(''), null)
  assert.equal(normalizeUrlForDedupe('   '), null)
})

test('normalizeUrlForDedupe - strips fbclid and gclid', () => {
  const result = normalizeUrlForDedupe('https://example.com/page?fbclid=abc&gclid=def&real=1')
  assert.ok(!result.includes('fbclid'))
  assert.ok(!result.includes('gclid'))
  assert.ok(result.includes('real=1'))
})

// ─── dedupeKeyFromRow ───────────────────────────────────────────
test('dedupeKeyFromRow - prefers URL when available', () => {
  const key = dedupeKeyFromRow({
    application_url: 'https://example.com/grant',
    source_id: 'ABC',
    title: 'Test',
    sponsor: 'Org',
  })
  assert.ok(key.startsWith('url:'))
})

test('dedupeKeyFromRow - falls back to source_id when no URL', () => {
  const key = dedupeKeyFromRow({
    application_url: null,
    source_url: null,
    source_id: 'XYZ-123',
    title: 'Test',
    sponsor: 'Org',
  })
  assert.ok(key.startsWith('sid:'))
  assert.ok(key.includes('xyz-123'))
})

test('dedupeKeyFromRow - falls back to title+sponsor+deadline', () => {
  const key = dedupeKeyFromRow({
    application_url: null,
    source_url: null,
    source_id: null,
    title: 'Community Grant',
    sponsor: 'Foundation X',
    deadline: '2025-06-01',
  })
  assert.ok(key.startsWith('tsd:'))
  assert.ok(key.includes('community grant'))
  assert.ok(key.includes('foundation x'))
})

test('dedupeKeyFromRow - returns null for null row', () => {
  assert.equal(dedupeKeyFromRow(null), null)
})

test('dedupeKeyFromRow - falls back to id', () => {
  const key = dedupeKeyFromRow({
    id: 'abc-123',
    application_url: null,
    source_url: null,
    source_id: null,
    title: '',
    sponsor: '',
  })
  assert.equal(key, 'id:abc-123')
})

// ─── isExpiredOpportunity ───────────────────────────────────────
test('isExpiredOpportunity - rolling deadline is never expired', () => {
  assert.equal(isExpiredOpportunity({ deadline_type: 'rolling', deadline: '2020-01-01' }), false)
})

test('isExpiredOpportunity - ongoing deadline is never expired', () => {
  assert.equal(isExpiredOpportunity({ deadline_type: 'ongoing', deadline: '2020-01-01' }), false)
})

test('isExpiredOpportunity - directory-like is never expired', () => {
  assert.equal(isExpiredOpportunity({ type: 'DIRECTORY', deadline: '2020-01-01' }), false)
  assert.equal(isExpiredOpportunity({ record_origin: 'some-directory', deadline: '2020-01-01' }), false)
  assert.equal(isExpiredOpportunity({ opportunity_type: 'directory_resource', deadline: '2020-01-01' }), false)
})

test('isExpiredOpportunity - past fixed deadline is expired', () => {
  const now = new Date('2025-06-15T12:00:00Z')
  assert.equal(isExpiredOpportunity({ deadline: '2025-01-01', deadline_type: 'fixed' }, { now }), true)
})

test('isExpiredOpportunity - future fixed deadline is NOT expired', () => {
  const now = new Date('2025-06-15T12:00:00Z')
  assert.equal(isExpiredOpportunity({ deadline: '2025-12-31', deadline_type: 'fixed' }, { now }), false)
})

test('isExpiredOpportunity - null deadline is NOT expired', () => {
  assert.equal(isExpiredOpportunity({ deadline: null, deadline_type: 'fixed' }), false)
})

test('isExpiredOpportunity - null row returns false', () => {
  assert.equal(isExpiredOpportunity(null), false)
})
