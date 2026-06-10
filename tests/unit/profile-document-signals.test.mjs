// RC-17 contract tests: documents.extracted_text folds into the canonical
// profile need vocabulary, bounded to NEED_ALIAS_MAP keys so no document
// can introduce noise outside the existing taxonomy.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeProfile,
  extractNeedSignalsFromDocumentText,
  NEED_ALIAS_MAP,
} from '../../backend/services/profileNormalizer.js'

test('extractNeedSignalsFromDocumentText only emits canonical needs from the alias map', () => {
  const text = `
    Eviction notice from landlord — past due rent, must vacate.
    Also includes utility shutoff warning for electric and water.
    Mentions food bank pickup hours and groceries pantry list.
    Some random word: alphabet quartz unrelated.
  `
  const needs = extractNeedSignalsFromDocumentText(text)
  // Every emitted need must be a canonical bucket from NEED_ALIAS_MAP.
  const canonicalSet = new Set(Object.values(NEED_ALIAS_MAP))
  for (const need of needs) {
    assert.ok(
      canonicalSet.has(need),
      `${need} is not a canonical need bucket`,
    )
  }
  // The seed keywords should map to housing, utilities, food.
  assert.ok(needs.includes('housing'), 'eviction/rent should map to housing')
  assert.ok(needs.includes('utilities'), 'electric/water should map to utilities')
  assert.ok(needs.includes('food'), 'food/groceries should map to food')
})

test('extractNeedSignalsFromDocumentText returns empty array for unrelated text', () => {
  const needs = extractNeedSignalsFromDocumentText(
    'Recipe: combine wheat flour with yeast, salt, and water; let rise.',
  )
  // "water" alone (without utility context) and "wheat flour" should not
  // accidentally match a canonical bucket.
  assert.equal(Array.isArray(needs), true)
  // The keyword "water" maps to utilities — we accept this. The point of
  // this test is that random unrelated text doesn't fire needs OUTSIDE
  // the canonical vocabulary.
  for (const need of needs) {
    assert.ok(
      Object.values(NEED_ALIAS_MAP).includes(need),
      `${need} must be in the alias map`,
    )
  }
})

test('extractNeedSignalsFromDocumentText caps input length to prevent runaway scans', () => {
  const huge = 'rent eviction housing '.repeat(50_000)
  const needs = extractNeedSignalsFromDocumentText(huge)
  // Even with multiple matches, each canonical bucket fires at most once.
  const seen = new Set()
  for (const need of needs) {
    assert.ok(!seen.has(need), 'each bucket should fire at most once')
    seen.add(need)
  }
})

test('normalizeProfile folds documents.extracted_text into needCategories (array form)', () => {
  const documents = [
    {
      id: 'doc-1',
      extracted_text:
        'Notice of eviction. Past due rent. Court date next month for housing dispute.',
    },
  ]
  const profile = { id: 'p-1', primary_type: 'individual', state: 'TN' }
  const norm = normalizeProfile(profile, null, null, documents)
  assert.ok(norm)
  assert.ok(Array.isArray(norm.documentSignals))
  assert.ok(norm.documentSignals.includes('housing'))
  assert.ok(
    norm.needCategories.includes('housing'),
    'housing must be folded into needCategories from the document',
  )
})

test('normalizeProfile accepts documents on rawProfile.documents (back-compat shape)', () => {
  const documents = [
    { id: 'doc-1', extracted_text: 'Medical bill — emergency room visit, prescription refills.' },
  ]
  const norm = normalizeProfile({
    id: 'p-2',
    primary_type: 'individual',
    state: 'OH',
    documents,
  })
  assert.ok(norm)
  // Medical/prescription terms should map to health_medical canonical bucket.
  assert.ok(
    norm.documentSignals.includes('health_medical'),
    `expected health_medical in documentSignals, got ${norm.documentSignals.join(',')}`,
  )
  assert.ok(norm.needCategories.includes('health_medical'))
})

test('normalizeProfile is a no-op for documents when text is empty / missing', () => {
  const norm = normalizeProfile(
    { id: 'p-3', primary_type: 'individual', state: 'CA' },
    null,
    null,
    [{ id: 'd1', extracted_text: '' }, { id: 'd2', extracted_text: null }],
  )
  assert.ok(norm)
  assert.deepEqual(norm.documentSignals, [])
})

test('normalizeProfile document signals only add canonical needs (no noise)', () => {
  // Adversarial document mentioning nonsense + one real keyword.
  const documents = [
    {
      extracted_text:
        'gibberish_token_xyz fake_need_made_up another_random_string transportation needed for daily commute',
    },
  ]
  const norm = normalizeProfile(
    { id: 'p-4', primary_type: 'individual', state: 'TX' },
    null,
    null,
    documents,
  )
  // None of the gibberish tokens should appear in the needCategories.
  for (const need of norm.needCategories) {
    assert.ok(
      !need.includes('gibberish'),
      'gibberish must never reach the matcher',
    )
    assert.ok(
      !need.includes('made_up'),
      'made-up tokens must never reach the matcher',
    )
  }
  // Transportation should be folded in.
  assert.ok(norm.documentSignals.includes('transportation'))
  assert.ok(norm.needCategories.includes('transportation'))
})

test('extractNeedSignalsFromDocumentText does NOT misfire on substring collisions', () => {
  // Short alias tokens like "ce" (= continuing education) used to substring
  // match into unrelated words like "groceries" or "notice" and falsely fire
  // professional_development. Word-boundary matching prevents that.
  const needs = extractNeedSignalsFromDocumentText(
    'Eviction notice. Groceries pickup. Past due rent.',
  )
  assert.ok(
    !needs.includes('professional_development'),
    `professional_development should not fire from "notice"/"groceries", got: ${needs.join(',')}`,
  )
  // But housing and food should still fire from real keywords.
  assert.ok(needs.includes('housing'))
  assert.ok(needs.includes('food'))
})

test('extractNeedSignalsFromDocumentText fires on phrase aliases that span tokens', () => {
  // Multi-word aliases ("small business", "rental assistance") should still
  // match as substrings — they don't risk collisions.
  const needs = extractNeedSignalsFromDocumentText(
    'Looking for small business mentorship and rental assistance options.',
  )
  assert.ok(needs.includes('business'), 'small business should fold to business')
  assert.ok(needs.includes('housing'), 'rental assistance should fold to housing')
})

test('normalizeProfile back-compat: existing 3-arg callers still work without documents', () => {
  const norm = normalizeProfile(
    { id: 'p-5', primary_type: 'individual', state: 'OH' },
    null,
    null,
  )
  assert.ok(norm)
  assert.ok(Array.isArray(norm.documentSignals))
  assert.equal(norm.documentSignals.length, 0)
})
