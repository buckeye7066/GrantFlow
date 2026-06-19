/**
 * Hamilton portal-access schedule (tz-aware windows).
 * Uses fixed UTC instants against America/New_York in January (EST = UTC-5).
 */
import { describe, it, expect } from 'vitest'
import {
  normalizeSchedule, isWithinWindow, nextWindowStart, parseHHMM, minutesToHHMM,
} from '../services/hamilton/portalAccessSchedule.js'

const sched = normalizeSchedule({
  portal_access: { enabled: true, timezone: 'America/New_York', windows: [{ start: '09:00', end: '10:00' }] },
})

describe('parse helpers', () => {
  it('parses and formats HH:MM', () => {
    expect(parseHHMM('09:30')).toBe(570)
    expect(parseHHMM('24:00')).toBeNull()
    expect(parseHHMM('bad')).toBeNull()
    expect(minutesToHHMM(570)).toBe('09:30')
  })
})

describe('normalizeSchedule', () => {
  it('drops malformed windows and disables when none remain', () => {
    const s = normalizeSchedule({ portal_access: { enabled: true, windows: [{ start: 'x', end: 'y' }] } })
    expect(s.enabled).toBe(false)
  })
  it('defaults timezone', () => {
    expect(sched.timezone).toBe('America/New_York')
    expect(sched.windows[0]).toMatchObject({ startMin: 540, endMin: 600 })
  })
})

describe('isWithinWindow', () => {
  it('true inside the window (09:30 EST = 14:30Z)', () => {
    expect(isWithinWindow(sched, new Date('2026-01-15T14:30:00Z'))).toBe(true)
  })
  it('false before the window (07:00 EST = 12:00Z)', () => {
    expect(isWithinWindow(sched, new Date('2026-01-15T12:00:00Z'))).toBe(false)
  })
  it('false after the window (11:00 EST = 16:00Z)', () => {
    expect(isWithinWindow(sched, new Date('2026-01-15T16:00:00Z'))).toBe(false)
  })
  it('a disabled schedule is always allowed', () => {
    expect(isWithinWindow(normalizeSchedule({}), new Date('2026-01-15T16:00:00Z'))).toBe(true)
  })
})

describe('nextWindowStart', () => {
  it('returns today 09:00 EST (14:00Z) when before the window', () => {
    expect(nextWindowStart(sched, new Date('2026-01-15T12:00:00Z'))).toBe('2026-01-15T14:00:00.000Z')
  })
  it('returns tomorrow 09:00 EST (14:00Z) when after the window', () => {
    expect(nextWindowStart(sched, new Date('2026-01-15T16:00:00Z'))).toBe('2026-01-16T14:00:00.000Z')
  })
  it('returns now when already inside the window', () => {
    const now = new Date('2026-01-15T14:30:00Z')
    expect(nextWindowStart(sched, now)).toBe(now.toISOString())
  })
  it('returns null for a disabled schedule', () => {
    expect(nextWindowStart(normalizeSchedule({}), new Date())).toBeNull()
  })
})
