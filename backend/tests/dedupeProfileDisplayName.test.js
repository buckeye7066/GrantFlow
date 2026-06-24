/**
 * Unit tests for dedupeProfileDisplayName — the single shared collapser that
 * undoes the profile name-doubling bug ("Robert White Robert Michael White").
 *
 * It is used both by the producer (services/profileDedupeService.js mergeValues)
 * and by the boot sweep (startup/enforceInvariants.js
 * enforceProfileDisplayNameNotDoubled), so its behavior is load-bearing in both
 * places. We prove BOTH that it collapses real doubles (positive cases) and that
 * it leaves legitimate names alone (negative cases) — collapsing a real name
 * would be a worse bug than the double.
 */

import { describe, it, expect } from 'vitest'
import { dedupeProfileDisplayName } from '../../shared/nameParsing.js'

describe('dedupeProfileDisplayName — positive (collapses real doubles)', () => {
  it('collapses the production Robert case, keeping the fuller half', () => {
    expect(dedupeProfileDisplayName('Robert White Robert Michael White')).toBe('Robert Michael White')
  })

  it('collapses the NEWLINE-joined production form (the real stored value)', () => {
    // profiles.display_name was literally "Robert White\nRobert Michael White".
    expect(dedupeProfileDisplayName('Robert White\nRobert Michael White')).toBe('Robert Michael White')
  })

  it('keeps the fuller half regardless of which half is longer (long first)', () => {
    expect(dedupeProfileDisplayName('Robert Michael White Robert White')).toBe('Robert Michael White')
  })

  it('collapses exact whole-string repetition', () => {
    expect(dedupeProfileDisplayName('Jane Doe Jane Doe')).toBe('Jane Doe')
  })

  it('collapses exact repetition joined by a newline', () => {
    expect(dedupeProfileDisplayName('Jane Doe\nJane Doe')).toBe('Jane Doe')
  })

  it('collapses a three-token name doubled against itself', () => {
    expect(dedupeProfileDisplayName('Mary Jane Watson Mary Jane Watson')).toBe('Mary Jane Watson')
  })

  it('removes a stray internal newline from an otherwise-single name', () => {
    // A display name must never contain a literal newline even when not doubled.
    expect(dedupeProfileDisplayName('Robert Michael\nWhite')).toBe('Robert Michael White')
  })

  it('collapses internal multi-space to single spaces', () => {
    expect(dedupeProfileDisplayName('Robert   Michael   White')).toBe('Robert Michael White')
  })
})

describe('dedupeProfileDisplayName — negative (leaves legitimate names alone)', () => {
  const leaveAlone = [
    'Robert White',
    'Robert Michael White',
    'Mary Jane Watson',
    'John Q. Public',
    'Anna Maria Anna',            // no shared surname across a clean split
    'Sarah Lee Lee Park',         // first tokens differ between halves
    'Jean-Luc Picard',            // hyphenated given name
    'Mary-Kate Olsen',
    'Church of God of Prophecy',  // org: repeated "of" is legitimate
    'Helping Hands Foundation',   // org marker
    'Smith Smith Industries Inc', // org marker short-circuits
    'Robert Robert',              // 2 tokens — below the doubling threshold, untouched
  ]
  for (const name of leaveAlone) {
    it(`leaves "${name}" unchanged`, () => {
      expect(dedupeProfileDisplayName(name)).toBe(name)
    })
  }

  it('does not collapse two DIFFERENT people who share a surname', () => {
    // Distinct given names, not a doubling of one person.
    expect(dedupeProfileDisplayName('Robert White James White')).toBe('Robert White James White')
  })

  it('passes through null/undefined/empty safely', () => {
    expect(dedupeProfileDisplayName(null)).toBe(null)
    expect(dedupeProfileDisplayName(undefined)).toBe(undefined)
    expect(dedupeProfileDisplayName('')).toBe('')
    expect(dedupeProfileDisplayName('   ')).toBe('')
  })
})
