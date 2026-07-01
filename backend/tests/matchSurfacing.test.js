import { describe, it, expect } from 'vitest'
import {
  SURFACED_MATCHER_VERSIONS,
  SURFACED_MATCHER_VERSIONS_SQL,
  qualifiesForDisplay,
} from '../config/matchSurfacing.js'

describe('matchSurfacing — surfaced matcher versions', () => {
  it('includes crawler-os, cross-match, AND web-llm (the recall regression fix)', () => {
    expect(SURFACED_MATCHER_VERSIONS).toEqual([
      'crawler-os',
      'crawler-os-xmatch',
      'web-llm',
    ])
  })

  it('web-llm must be surfaced — it was persisted-but-never-read before this fix', () => {
    expect(SURFACED_MATCHER_VERSIONS).toContain('web-llm')
  })

  it('builds a valid SQL IN() fragment from the constant', () => {
    expect(SURFACED_MATCHER_VERSIONS_SQL).toBe(
      "('crawler-os','crawler-os-xmatch','web-llm')",
    )
    // Round-trip: fragment lists exactly the same versions, quoted.
    for (const v of SURFACED_MATCHER_VERSIONS) {
      expect(SURFACED_MATCHER_VERSIONS_SQL).toContain(`'${v}'`)
    }
  })
})

describe('matchSurfacing — qualifiesForDisplay', () => {
  const MIN = 75

  it('surfaces rows at or above the display floor', () => {
    expect(qualifiesForDisplay({ match_score: 75 }, MIN)).toBe(true)
    expect(qualifiesForDisplay({ match_score: 92 }, MIN)).toBe(true)
  })

  it('hides plain rows below the floor', () => {
    expect(qualifiesForDisplay({ match_score: 74, match_decision: 'review' }, MIN)).toBe(false)
    expect(qualifiesForDisplay({ match_score: 40, match_decision: 'review' }, MIN)).toBe(false)
  })

  it('ALWAYS surfaces the engine-certified ACCEPT decisions below the floor', () => {
    // Anastasia White's real case: HOPE Scholarship scored 72 (ACCEPT) but was
    // buried by the 75 display floor.
    expect(qualifiesForDisplay({ match_score: 72, match_decision: 'accept' }, MIN)).toBe(true)
    expect(qualifiesForDisplay({ match_score: 70, match_decision: 'ACCEPT' }, MIN)).toBe(true)
  })

  it('always surfaces directories regardless of score (mission rule)', () => {
    expect(qualifiesForDisplay({ is_directory: true, match_score: 5 }, MIN)).toBe(true)
  })

  it('does NOT surface REVIEW/REJECT rows below the floor', () => {
    expect(qualifiesForDisplay({ match_score: 66, match_decision: 'review' }, MIN)).toBe(false)
    expect(qualifiesForDisplay({ match_score: 60, match_decision: 'reject' }, MIN)).toBe(false)
  })

  it('handles missing/garbage rows without throwing', () => {
    expect(qualifiesForDisplay(null, MIN)).toBe(false)
    expect(qualifiesForDisplay({}, MIN)).toBe(false)
    expect(qualifiesForDisplay({ match_score: 'nan', match_decision: '' }, MIN)).toBe(false)
  })
})
