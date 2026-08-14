import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const modulePath = path.resolve(__dirname, '..', '..', 'backend', 'utils', 'stateNormalization.js')
const moduleUrl = pathToFileURL(modulePath).href

const {
  normalizeOpportunityState,
  normalizeStateFromText,
} = await import(moduleUrl)

test('stateNormalization: extracts full state names from freeform profile location text', () => {
  assert.equal(normalizeStateFromText('Beaver County, Pennsylvania'), 'PA')
})

test('stateNormalization: opportunity state only allows USPS codes, nationwide, or null', () => {
  assert.equal(normalizeOpportunityState('Pennsylvania'), 'PA')
  assert.equal(normalizeOpportunityState('pa'), 'PA')
  assert.equal(normalizeOpportunityState('nationwide'), 'nationwide')
  assert.equal(normalizeOpportunityState('USA'), null)
  assert.equal(normalizeOpportunityState('United States'), null)
  assert.equal(normalizeOpportunityState('nation-wide'), null)
})

test('stateNormalization: "West Virginia" resolves to WV, not VA (longest-name-first ordering)', () => {
  // "West Virginia" contains "Virginia" as a real substring at a word
  // boundary. Iterating ABBR_TO_NAME in plain (alphabetical-by-abbreviation)
  // order tested 'VA' -> "Virginia" before 'WV' -> "West Virginia", so this
  // resolved to VA. The more specific/longer name must win.
  assert.equal(normalizeStateFromText('West Virginia Housing Development Fund'), 'WV')
  assert.equal(normalizeStateFromText('Programs for West Virginia residents'), 'WV')
  // Plain "Virginia" (no "West") must still resolve to VA.
  assert.equal(normalizeStateFromText('Virginia Community College Grant'), 'VA')
})

test('stateNormalization: lowercase English words are NOT read as state codes (case-sensitive code match)', () => {
  // The bare 2-letter code fallback used a case-insensitive regex, so common
  // lowercase words that happen to be 2 letters ("in", "or", "me", "hi", "ok")
  // resolved to a state abbreviation inside ordinary prose.
  assert.equal(normalizeStateFromText('Support for families in our region'), null)
  assert.equal(normalizeStateFromText('Grants for veterans or their spouses'), null)
  assert.equal(normalizeStateFromText('Funding to help me and my community'), null)
  // A genuine uppercase USPS code in free text must still resolve.
  assert.equal(normalizeStateFromText('Serving residents of OH and surrounding counties'), 'OH')
})

