import { describe, expect, it } from 'vitest'
import {
  normalizeValue,
  fuzzyRuleMatches,
  MATCH_TYPE,
} from '../services/blocklist/ownerBlocklistService.js'

// These cases pin the OWNER's blocklist matching decisions. The fuzzy predicate
// is the one piece with real trade-offs (false-positive vs miss), so it gets the
// most coverage here. See docs/OWNER_BLOCKLIST.md.

describe('normalizeValue', () => {
  it('lowercases + trims emails', () => {
    expect(normalizeValue(MATCH_TYPE.EMAIL, '  Foo@Bar.COM ')).toBe('foo@bar.com')
  })

  it('extracts the domain from a full address, strips @', () => {
    expect(normalizeValue(MATCH_TYPE.DOMAIN, 'a@Example.com')).toBe('example.com')
    expect(normalizeValue(MATCH_TYPE.DOMAIN, '@Example.com')).toBe('example.com')
    expect(normalizeValue(MATCH_TYPE.DOMAIN, 'Example.com')).toBe('example.com')
  })

  it('reduces a phone to its last 10 digits (country code / formatting agnostic)', () => {
    expect(normalizeValue(MATCH_TYPE.PHONE, '+1 (931) 314-0866')).toBe('9313140866')
    expect(normalizeValue(MATCH_TYPE.PHONE, '931.314.0866')).toBe('9313140866')
    expect(normalizeValue(MATCH_TYPE.PHONE, '19313140866')).toBe('9313140866')
  })
})

describe('fuzzyRuleMatches — surname (Kemper)', () => {
  const rule = { match_type: MATCH_TYPE.LAST_NAME, match_value: 'kemper' }

  it('matches a person whose name contains the surname', () => {
    expect(fuzzyRuleMatches(rule, { name: 'Dana Kemper' })).toBe(true)
    expect(fuzzyRuleMatches(rule, { name: 'KEMPER, JOHN' })).toBe(true)
  })

  it('matches when the surname appears in the organization', () => {
    expect(fuzzyRuleMatches(rule, { organization: 'Kemper & Associates' })).toBe(true)
  })

  it('does NOT match a different word that merely contains the letters', () => {
    expect(fuzzyRuleMatches(rule, { name: 'Sally Kemperton' })).toBe(false)
    expect(fuzzyRuleMatches(rule, { name: 'Bob Smith' })).toBe(false)
  })
})

describe('fuzzyRuleMatches — organization (containment)', () => {
  const rule = { match_type: MATCH_TYPE.ORGANIZATION, match_value: 'mcminnville ems' }

  it('matches longer official names that contain the blocked org', () => {
    expect(fuzzyRuleMatches(rule, { organization: 'McMinnville EMS Department' })).toBe(true)
    expect(fuzzyRuleMatches(rule, { organization: 'McMinnville EMS' })).toBe(true)
  })

  it('matches when the subject org is a shorter form of the blocked value', () => {
    const r2 = { match_type: MATCH_TYPE.ORGANIZATION, match_value: 'van buren county sheriff' }
    expect(fuzzyRuleMatches(r2, { organization: 'Van Buren County Sheriff' })).toBe(true)
  })

  it('does not match an unrelated organization', () => {
    expect(fuzzyRuleMatches(rule, { organization: 'Nashville Fire Department' })).toBe(false)
  })
})
