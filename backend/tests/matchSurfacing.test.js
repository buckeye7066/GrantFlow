import { describe, it, expect } from 'vitest'
import {
  SURFACED_MATCHER_VERSIONS,
  SURFACED_MATCHER_VERSIONS_SQL,
  DIRECTORY_MIN_SCORE,
  qualifiesForDisplay,
} from '../config/matchSurfacing.js'
import { REVIEW_SCORE } from '../config/matchThresholds.js'

describe('matchSurfacing — surfaced matcher versions', () => {
  it('includes crawler-os, cross-match, web-llm, institution-link AND profile-discovery-link', () => {
    expect(SURFACED_MATCHER_VERSIONS).toEqual([
      'crawler-os',
      'crawler-os-xmatch',
      'web-llm',
      'institution-link',
      'profile-discovery-link',
    ])
  })

  it('web-llm must be surfaced — it was persisted-but-never-read before this fix', () => {
    expect(SURFACED_MATCHER_VERSIONS).toContain('web-llm')
  })

  it('institution-link must be surfaced — a student\'s OWN school\'s aid', () => {
    // The reconcile-surviving versions exist precisely because the match store
    // is a rolling snapshot. Persisting under one of them and then NOT reading
    // it back is the exact web-llm regression this file was written for
    // (institution_recall_miss: 52 active MTSU rows, 0 match rows, 2026-08-01).
    expect(SURFACED_MATCHER_VERSIONS).toContain('institution-link')
  })

  it('profile-discovery-link must be surfaced — the row NAMES the profile', () => {
    // `funding_opportunities.profile_id` records the profile a row was
    // discovered FOR. The rolling-snapshot reconcile deleted those matches
    // (prod 2026-08-01: web_search rows created in August 37% matched, June and
    // July 3-4%). Persisting under a reconcile-surviving version and then not
    // reading it back would repeat the web-llm regression exactly.
    expect(SURFACED_MATCHER_VERSIONS).toContain('profile-discovery-link')
  })

  it('builds a valid SQL IN() fragment from the constant', () => {
    expect(SURFACED_MATCHER_VERSIONS_SQL).toBe(
      "('crawler-os','crawler-os-xmatch','web-llm','institution-link','profile-discovery-link')",
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

  it('surfaces directories past the display floor (mission rule), but not ones the engine scored irrelevant', () => {
    // A directory below the requested floor (75) still surfaces...
    expect(qualifiesForDisplay({ is_directory: true, match_score: 50 }, MIN)).toBe(true)
    expect(qualifiesForDisplay({ is_directory: true, match_score: DIRECTORY_MIN_SCORE }, MIN)).toBe(true)
    // ...and an UNSCORED directory always surfaces (never scored ≠ scored irrelevant)...
    expect(qualifiesForDisplay({ is_directory: true }, MIN)).toBe(true)
    expect(qualifiesForDisplay({ is_directory: true, match_score: null }, MIN)).toBe(true)
    // ...but a directory the engine affirmatively judged irrelevant stays hidden
    // (Liubov's real case: federal student-aid directory scored 0 for a senior citizen).
    expect(qualifiesForDisplay({ is_directory: true, match_score: 0 }, MIN)).toBe(false)
    expect(qualifiesForDisplay({ is_directory: true, match_score: 5 }, MIN)).toBe(false)
    expect(qualifiesForDisplay({ is_directory: true, match_score: DIRECTORY_MIN_SCORE - 1 }, MIN)).toBe(false)
  })

  it('DIRECTORY_MIN_SCORE stays in sync with the engine REVIEW band', () => {
    expect(DIRECTORY_MIN_SCORE).toBe(REVIEW_SCORE)
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
