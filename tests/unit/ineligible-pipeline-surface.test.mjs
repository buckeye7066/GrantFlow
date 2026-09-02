import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('ineligible pipeline rows are visibly quarantined', () => {
  const card = readFileSync('src/components/pipeline/GrantCard.jsx', 'utf8')

  it('badges preserved ineligible rows and excludes them from Hamilton selection', () => {
    expect(card).toContain('Ineligible')
    expect(card).toContain('isIneligible')
    expect(card).toContain('hamiltonSelection?.enabled && !isIneligible')
    expect(card).toContain('excluded from pipeline dollars and Hamilton automation')
  })
})
