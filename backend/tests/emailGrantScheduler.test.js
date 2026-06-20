/**
 * Unit tests for the nightly email→grant scheduler's timezone matching.
 *
 * The whole point is that "21:00 Eastern" stays 21:00 Eastern across the
 * EDT/EST switch — so we assert a UTC instant that is 9 PM ET in summer (UTC-4)
 * AND a different UTC instant that is 9 PM ET in winter (UTC-5) both match the
 * `0 21 * * *` cron.
 */

import { describe, it, expect } from 'vitest'
import { parseCron } from '../services/john/johnScheduler.js'
import { _internal } from '../services/emailGrants/emailGrantScheduler.js'

const { zonedParts, cronMatchesZoned } = _internal
const TZ = 'America/New_York'
const NINE_PM = parseCron('0 21 * * *')

describe('email→grant scheduler timezone matching', () => {
  it('matches 21:00 ET during EDT (summer, UTC-4)', () => {
    // 2026-07-01T01:00:00Z === 2026-06-30 21:00 EDT
    const parts = zonedParts(new Date('2026-07-01T01:00:00Z'), TZ)
    expect(parts.hour).toBe(21)
    expect(parts.minute).toBe(0)
    expect(cronMatchesZoned(NINE_PM, parts)).toBe(true)
  })

  it('matches 21:00 ET during EST (winter, UTC-5)', () => {
    // 2026-01-01T02:00:00Z === 2025-12-31 21:00 EST
    const parts = zonedParts(new Date('2026-01-01T02:00:00Z'), TZ)
    expect(parts.hour).toBe(21)
    expect(parts.minute).toBe(0)
    expect(cronMatchesZoned(NINE_PM, parts)).toBe(true)
  })

  it('does NOT match 21:00 UTC (which is not 21:00 ET)', () => {
    const parts = zonedParts(new Date('2026-07-01T21:00:00Z'), TZ) // 17:00 EDT
    expect(parts.hour).toBe(17)
    expect(cronMatchesZoned(NINE_PM, parts)).toBe(false)
  })
})
