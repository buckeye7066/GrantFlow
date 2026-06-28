import test from 'node:test'
import assert from 'node:assert/strict'

import { toCanonicalResult } from '../../src/components/funding/toCanonicalResult.js'

test('canonical funding result keeps source-only URLs out of application_url', () => {
  const sourceOnly = toCanonicalResult({
    id: 'source-only',
    title: 'Source-only program page',
    url: 'https://example.org/program',
    source_url: 'https://example.org/program',
  })

  assert.equal(sourceOnly.application_url, null)
  assert.equal(sourceOnly.source_url, 'https://example.org/program')
})

test('canonical funding result preserves explicit application URLs', () => {
  const direct = toCanonicalResult({
    id: 'direct',
    title: 'Direct application',
    application_url: 'https://example.org/apply',
    source_url: 'https://example.org/program',
  })

  assert.equal(direct.application_url, 'https://example.org/apply')
  assert.equal(direct.source_url, 'https://example.org/program')
})
