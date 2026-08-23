/**
 * Funder-aware lifecycle facts — write-side normalization (owner rule 2026-08-23).
 * A value the funder did not state stays null; garbage is rejected, never coerced.
 */
import { describe, it, expect } from 'vitest'
import {
  normalizeExpectedDecisionDate,
  normalizeDecisionReviewDays,
  normalizeReportingRequirements,
} from '../config/funderLifecycleFacts.js'

describe('normalizeExpectedDecisionDate', () => {
  it('accepts a real ISO date', () => {
    expect(normalizeExpectedDecisionDate('2027-04-15')).toBe('2027-04-15')
    expect(normalizeExpectedDecisionDate('  2027-04-15  ')).toBe('2027-04-15')
  })
  it('rejects a rollover, a non-date, and non-strings', () => {
    expect(normalizeExpectedDecisionDate('2027-13-40')).toBeNull()
    expect(normalizeExpectedDecisionDate('2027-02-30')).toBeNull()
    expect(normalizeExpectedDecisionDate('April 15')).toBeNull()
    expect(normalizeExpectedDecisionDate('')).toBeNull()
    expect(normalizeExpectedDecisionDate(20270415)).toBeNull()
    expect(normalizeExpectedDecisionDate(null)).toBeNull()
  })
})

describe('normalizeDecisionReviewDays', () => {
  it('accepts a positive integer (number or plain-int string)', () => {
    expect(normalizeDecisionReviewDays(90)).toBe(90)
    expect(normalizeDecisionReviewDays('56')).toBe(56)
    expect(normalizeDecisionReviewDays(1)).toBe(1)
    expect(normalizeDecisionReviewDays(1825)).toBe(1825)
  })
  it('never coerces "" -> 0, and rejects out-of-range / junk', () => {
    expect(normalizeDecisionReviewDays('')).toBeNull()
    expect(normalizeDecisionReviewDays(0)).toBeNull()
    expect(normalizeDecisionReviewDays(-5)).toBeNull()
    expect(normalizeDecisionReviewDays(5000)).toBeNull()
    expect(normalizeDecisionReviewDays('90 days')).toBeNull()
    expect(normalizeDecisionReviewDays(null)).toBeNull()
    expect(normalizeDecisionReviewDays({})).toBeNull()
  })
})

describe('normalizeReportingRequirements', () => {
  it('keeps well-formed entries and carries the date basis', () => {
    const out = normalizeReportingRequirements([
      { label: '25% of the award spent', offset_days: 90, anchor: 'award_date' },
      { label: 'Final report', due_date: '2028-01-31' },
    ])
    expect(out).toEqual([
      { label: '25% of the award spent', offset_days: 90, anchor: 'award_date' },
      { label: 'Final report', due_date: '2028-01-31' },
    ])
  })
  it('accepts a JSON string (as the crawler stores it)', () => {
    const out = normalizeReportingRequirements(JSON.stringify([{ label: 'Progress report', offset_days: 180 }]))
    expect(out).toEqual([{ label: 'Progress report', offset_days: 180 }])
  })
  it('drops entries with no label, a bad anchor, and an out-of-range offset', () => {
    const out = normalizeReportingRequirements([
      { offset_days: 30 }, // no label -> dropped
      { label: '  ', due_date: '2028-01-31' }, // blank label -> dropped
      { label: 'Report', anchor: 'nonsense', offset_days: 99999 }, // anchor+offset dropped, label-only kept
    ])
    expect(out).toEqual([{ label: 'Report' }])
  })
  it('returns null for non-arrays, empty results, and unparseable JSON', () => {
    expect(normalizeReportingRequirements(null)).toBeNull()
    expect(normalizeReportingRequirements('{not json')).toBeNull()
    expect(normalizeReportingRequirements([])).toBeNull()
    expect(normalizeReportingRequirements([{ nope: 1 }])).toBeNull()
    expect(normalizeReportingRequirements(42)).toBeNull()
  })
  it('caps the number of entries', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ label: `Report ${i}`, offset_days: i + 1 }))
    expect(normalizeReportingRequirements(many)).toHaveLength(12)
  })
})
