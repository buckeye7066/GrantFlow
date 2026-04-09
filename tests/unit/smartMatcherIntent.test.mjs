/**
 * Unit tests for backend/services/smartMatcherIntent.js (rules path; no OpenAI).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..', '..')
const modPath = path.join(rootDir, 'backend', 'services', 'smartMatcherIntent.js')

const {
  sanitizeSearchTerm,
  interpretFundingIntentRules,
  interpretFundingIntent,
} = await import(pathToFileURL(modPath).href)

test('sanitizeSearchTerm lowercases, trims, strips LIKE wildcards', () => {
  assert.equal(sanitizeSearchTerm('  Foo%Bar_\\  '), 'foo bar')
})

test('interpretFundingIntentRules — bereavement + travel expands assistance terms', () => {
  const text =
    'help me find a funding source for an airplane ticket for bereavement'
  const { search_terms, method, summary } = interpretFundingIntentRules(text)
  assert.equal(method, 'rules')
  assert.ok(summary.includes('Searching for'))
  assert.ok(search_terms.includes('bereavement'))
  assert.ok(search_terms.includes('travel assistance'))
  assert.ok(search_terms.includes('emergency travel'))
})

test('interpretFundingIntentRules — 15 passenger van includes vehicle-oriented terms', () => {
  const text = 'Help me find a 15 passenger van'
  const { search_terms, method } = interpretFundingIntentRules(text)
  assert.equal(method, 'rules')
  assert.ok(search_terms.some((t) => t.includes('van')))
  assert.ok(search_terms.includes('vehicle grant') || search_terms.includes('transportation equipment'))
})

test('interpretFundingIntent with openai: null uses rules only', async () => {
  const out = await interpretFundingIntent('food assistance for my family', { openai: null })
  assert.equal(out.method, 'rules')
  assert.ok(out.search_terms.length > 0)
  assert.ok(out.search_terms.some((t) => t.includes('food') || t.includes('nutrition')))
})

test('interpretFundingIntentRules — empty input', () => {
  const out = interpretFundingIntentRules('   ')
  assert.deepEqual(out.search_terms, [])
  assert.equal(out.method, 'rules')
})
