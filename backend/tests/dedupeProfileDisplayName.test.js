/**
 * Unit tests for dedupeProfileDisplayName, the shared collapser that undoes a
 * doubled personal display name such as "Jordan Lane Jordan Michael Lane".
 */

import { describe, it, expect } from 'vitest'
import { dedupeProfileDisplayName } from '../../shared/nameParsing.js'

describe('dedupeProfileDisplayName - positive (collapses clear doubles)', () => {
  it('collapses a production-style doubled name, keeping the fuller half', () => {
    expect(dedupeProfileDisplayName('Jordan Lane Jordan Michael Lane')).toBe('Jordan Michael Lane')
  })

  it('collapses the newline-joined stored form', () => {
    expect(dedupeProfileDisplayName('Jordan Lane\nJordan Michael Lane')).toBe('Jordan Michael Lane')
  })

  it('keeps the fuller half regardless of which half is longer', () => {
    expect(dedupeProfileDisplayName('Jordan Michael Lane Jordan Lane')).toBe('Jordan Michael Lane')
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
    expect(dedupeProfileDisplayName('Jordan Michael\nLane')).toBe('Jordan Michael Lane')
  })

  it('collapses internal multi-space to single spaces', () => {
    expect(dedupeProfileDisplayName('Jordan   Michael   Lane')).toBe('Jordan Michael Lane')
  })
})

describe('dedupeProfileDisplayName - negative (leaves legitimate names alone)', () => {
  const leaveAlone = [
    'Jordan Lane',
    'Jordan Michael Lane',
    'Mary Jane Watson',
    'John Q. Public',
    'Anna Maria Anna',
    'Sarah Lee Lee Park',
    'Jean-Luc Picard',
    'Mary-Kate Olsen',
    'Church of God of Prophecy',
    'Helping Hands Foundation',
    'Smith Smith Industries Inc',
    'Jordan Jordan',
  ]

  for (const name of leaveAlone) {
    it(`leaves "${name}" unchanged`, () => {
      expect(dedupeProfileDisplayName(name)).toBe(name)
    })
  }

  it('does not collapse two different people who share a surname', () => {
    expect(dedupeProfileDisplayName('Jordan Lane Casey Lane')).toBe('Jordan Lane Casey Lane')
  })

  it('passes through null/undefined/empty safely', () => {
    expect(dedupeProfileDisplayName(null)).toBe(null)
    expect(dedupeProfileDisplayName(undefined)).toBe(undefined)
    expect(dedupeProfileDisplayName('')).toBe('')
    expect(dedupeProfileDisplayName('   ')).toBe('')
  })
})
