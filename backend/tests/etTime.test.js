/**
 * Unit tests for backend/utils/etTime.js — the shared America/New_York clock
 * used by the in-process schedulers in server.js.
 *
 * The load-bearing case is the Node 20 ICU midnight quirk: with hour12:false,
 * older ICU renders midnight as hour "24" (paired with the NEW day's date
 * parts). Un-clamped, every ET-window scheduler saw hour 24 ≥ any trigger hour
 * during 00:00–00:59 ET and fired the whole day's jobs at midnight (observed
 * in prod on 2026-07-02: Sam's 05:00 sweep + Anya's 09:00 owner email both ran
 * at ~00:05 ET).
 */
import { describe, it, expect } from 'vitest'
import { normalizeEtHour, etNowParts, eligibleDayKey, eligibleWeekKey } from '../utils/etTime.js'

describe('normalizeEtHour', () => {
  it('clamps the ICU h24 midnight rendering to 0', () => {
    expect(normalizeEtHour('24')).toBe(0)
    expect(normalizeEtHour(24)).toBe(0)
  })
  it('passes normal hours through', () => {
    expect(normalizeEtHour('00')).toBe(0)
    expect(normalizeEtHour('09')).toBe(9)
    expect(normalizeEtHour('23')).toBe(23)
  })
})

describe('etNowParts', () => {
  it('midnight ET reads as hour 0 of the new day (regression: never 24)', () => {
    // 2026-07-02T04:05Z = 00:05 EDT — the exact instant of the prod incident.
    const p = etNowParts(new Date('2026-07-02T04:05:00Z'))
    expect(p).toEqual({ weekday: 'Thu', hour: 0, ymd: '2026-07-02' })
  })
  it('is DST-correct at the spring-forward boundary (2026-03-08)', () => {
    // 06:59Z = 01:59 EST (UTC-5); 07:01Z = 03:01 EDT (UTC-4, 2am hour skipped).
    expect(etNowParts(new Date('2026-03-08T06:59:00Z')).hour).toBe(1)
    expect(etNowParts(new Date('2026-03-08T07:01:00Z')).hour).toBe(3)
  })
  it('is DST-correct at the fall-back boundary (2026-11-01)', () => {
    // 05:59Z = 01:59 EDT; 06:59Z = 01:59 EST — same wall hour, same day.
    const a = etNowParts(new Date('2026-11-01T05:59:00Z'))
    const b = etNowParts(new Date('2026-11-01T06:59:00Z'))
    expect(a).toEqual({ weekday: 'Sun', hour: 1, ymd: '2026-11-01' })
    expect(b).toEqual({ weekday: 'Sun', hour: 1, ymd: '2026-11-01' })
  })
})

describe('eligibleDayKey (once-per-day windows)', () => {
  it('before the trigger hour the PREVIOUS day is eligible', () => {
    expect(eligibleDayKey(5, { hour: 0, ymd: '2026-07-02' })).toBe('2026-07-01')
    expect(eligibleDayKey(5, { hour: 4, ymd: '2026-07-02' })).toBe('2026-07-01')
  })
  it('at/after the trigger hour today is eligible', () => {
    expect(eligibleDayKey(5, { hour: 5, ymd: '2026-07-02' })).toBe('2026-07-02')
    expect(eligibleDayKey(5, { hour: 23, ymd: '2026-07-02' })).toBe('2026-07-02')
  })
  it('rolls across month boundaries', () => {
    expect(eligibleDayKey(9, { hour: 3, ymd: '2026-07-01' })).toBe('2026-06-30')
  })
  it('prod incident: midnight instant is NOT eligible for the new day', () => {
    // The buggy inline helper computed hour 24 here and returned 2026-07-02.
    expect(eligibleDayKey(5, etNowParts(new Date('2026-07-02T04:05:00Z')))).toBe('2026-07-01')
  })
})

describe('eligibleWeekKey (Monday windows)', () => {
  it('Monday before the trigger hour points at the PREVIOUS Monday', () => {
    expect(eligibleWeekKey(8, { weekday: 'Mon', hour: 0, ymd: '2026-06-29' })).toBe('2026-06-22')
    expect(eligibleWeekKey(8, { weekday: 'Mon', hour: 7, ymd: '2026-06-29' })).toBe('2026-06-22')
  })
  it('Monday at/after the trigger hour opens this week', () => {
    expect(eligibleWeekKey(8, { weekday: 'Mon', hour: 8, ymd: '2026-06-29' })).toBe('2026-06-29')
  })
  it('mid-week points at this week Monday', () => {
    expect(eligibleWeekKey(9, { weekday: 'Thu', hour: 1, ymd: '2026-07-02' })).toBe('2026-06-29')
    expect(eligibleWeekKey(9, { weekday: 'Sun', hour: 23, ymd: '2026-07-05' })).toBe('2026-06-29')
  })
})
