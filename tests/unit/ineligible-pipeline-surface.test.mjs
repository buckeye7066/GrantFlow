import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

describe('ineligible pipeline rows are visibly quarantined', () => {
  const card = readFileSync('src/components/pipeline/GrantCard.jsx', 'utf8')
  it('badges preserved ineligible rows and excludes them from Hamilton selection', () => {
    assert.ok(card.includes('Ineligible'))
    assert.ok(card.includes('isIneligible'))
    assert.ok(card.includes('hamiltonSelection?.enabled && !isIneligible'))
    assert.ok(card.includes('excluded from pipeline dollars and Hamilton automation'))
  })
})
