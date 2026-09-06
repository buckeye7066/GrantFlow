import { describe, it, expect } from 'vitest'
import { auditProfileResultCoverageFromData, MIN_HEALTHY_SURFACED } from '../services/coverageAudit/profileResultCoverageAudit.js'
import { withVerifiedFourTruth } from './helpers/fourTruthFixture.js'

const student = (schools, county = 'Bradley County') => ({
  is_student: true,
  schools,
  location: { state: 'TN', county },
})

function accept(title, sponsor = '') {
  return withVerifiedFourTruth({ match_score: 80, match_decision: 'accept', title, sponsor })
}

describe('profileResultCoverageAudit — detection', () => {
  it('flags a surfacing regression when matches sit in an UNSURFACED matcher_version', () => {
    const a = auditProfileResultCoverageFromData({
      profileId: 'p1',
      surfacedRows: [accept('X'), accept('Y'), accept('Z')],
      unsurfacedCount: 82, // the exact web-llm-dropped shape
      // No schools, no county → isolate the surfacing regression from acquisition gaps.
      thesis: { is_student: false, schools: [], location: {} },
    })
    expect(a.surfacing_gap).toBe(true)
    expect(a.gaps.some((g) => g.startsWith('surfacing_regression'))).toBe(true)
    // A code bug is NOT healable by re-crawl.
    expect(a.needs_rediscovery).toBe(false)
  })

  it('flags an institution gap when a named school has no matching result', () => {
    const a = auditProfileResultCoverageFromData({
      profileId: 'p2',
      surfacedRows: [accept('Generic State Scholarship'), accept('Pell Grant'), accept('Local award')],
      unsurfacedCount: 0,
      thesis: student(['Middle Tennessee State University']),
    })
    expect(a.institution_gap).toBe(true)
    expect(a.missing_schools).toContain('Middle Tennessee State University')
    expect(a.needs_rediscovery).toBe(true)
  })

  it('does NOT flag institution gap when the school is referenced by full name', () => {
    const a = auditProfileResultCoverageFromData({
      profileId: 'p3',
      surfacedRows: [
        accept('Julia W. Powell Endowed Scholarship', 'Middle Tennessee State University'),
        accept('Pell Grant'),
        accept('HOPE Scholarship'),
      ],
      unsurfacedCount: 0,
      thesis: student(['Middle Tennessee State University']),
    })
    expect(a.institution_gap).toBe(false)
  })

  it('does NOT flag institution gap when the school is referenced only by acronym', () => {
    const a = auditProfileResultCoverageFromData({
      profileId: 'p3b',
      surfacedRows: [accept('MTSU Freshman Guaranteed Scholarship'), accept('Pell Grant'), accept('HOPE')],
      unsurfacedCount: 0,
      thesis: student(['Middle Tennessee State University']),
    })
    expect(a.institution_gap).toBe(false)
  })

  it('flags a hyperlocal gap when no result references the county', () => {
    const a = auditProfileResultCoverageFromData({
      profileId: 'p4',
      surfacedRows: [accept('National Scholarship'), accept('State Grant'), accept('Federal Aid')],
      unsurfacedCount: 0,
      thesis: student(['Some College'], 'Bradley County'),
    })
    expect(a.hyperlocal_gap).toBe(true)
  })

  it('clears the hyperlocal gap when a county award is present', () => {
    const a = auditProfileResultCoverageFromData({
      profileId: 'p5',
      surfacedRows: [accept('Bradley County Community Foundation Scholarship'), accept('State Grant'), accept('X')],
      unsurfacedCount: 0,
      thesis: student(['Some College'], 'Bradley County'),
    })
    expect(a.hyperlocal_gap).toBe(false)
  })

  it('flags low results below the healthy minimum', () => {
    const a = auditProfileResultCoverageFromData({
      profileId: 'p6',
      surfacedRows: [accept('Only one')],
      unsurfacedCount: 0,
      thesis: student([]),
    })
    expect(a.low_results).toBe(true)
    expect(a.surfaced_qualifying).toBeLessThan(MIN_HEALTHY_SURFACED)
    expect(a.needs_rediscovery).toBe(true)
  })

  it('only counts ACCEPT/directory/at-floor rows toward qualifying (matches surfacing rule)', () => {
    const a = auditProfileResultCoverageFromData({
      profileId: 'p7',
      surfacedRows: [
        { match_score: 60, match_decision: 'review', title: 'weak' }, // below floor, not accept → hidden
        withVerifiedFourTruth({ match_score: 72, match_decision: 'accept', title: 'HOPE' }), // accept below 75 → surfaced
        // A directory the engine PROVED against this profile → surfaced. A
        // pointer faces the same four gates in their pointer sense
        // (crawler-os/pointerTruthPolicy.js), so it must carry that evidence.
        {
          is_directory: true,
          title: 'dir',
          match_score: 40,
          match_decision: 'review',
          url: 'https://example.gov/dir',
          match_explain: {
            matched_location: 'state',
            matched_profile_type: true,
            matched_needs: ['housing'],
            matched_profile_facts: ['Profile signal: geo:state'],
          },
        },
        // A directory the engine affirmatively scored irrelevant (< REVIEW band)
        // no longer surfaces — 2026-07-05 rule (student-aid directory scored 0
        // for a senior citizen was showing in the matches view).
        { is_directory: true, match_score: 5, title: 'irrelevant dir' },
        // A directory NOBODY scored against this profile no longer surfaces
        // either (2026-09-06): the pointer arm used to admit an unscored pointer
        // unconditionally, which is how a Peoria, IL scholarship page reached a
        // Cleveland, TN student. Unknown is not relevant.
        { is_directory: true, title: 'unscored dir' },
      ],
      unsurfacedCount: 0,
      thesis: student([]),
      floor: 75,
    })
    expect(a.surfaced_qualifying).toBe(2)
  })

  it('flags low_results when the count is padded ONLY by templated geo-stubs', () => {
    // 3 qualifying rows, but every one is a "United Way near X" locator stub — a
    // client can apply to none of them. Old behaviour: qualifying=3 → "healthy".
    const a = auditProfileResultCoverageFromData({
      profileId: 'p-geostub',
      surfacedRows: [
        accept('United Way near Antioch, TN'),
        accept('Community Action Agency near Brentwood, TN'),
        accept('Food Bank resources near Chattanooga, TN'),
      ],
      unsurfacedCount: 0,
      thesis: student([]),
    })
    expect(a.surfaced_qualifying).toBe(3)
    expect(a.surfaced_actionable).toBe(0)
    expect(a.geo_stub_count).toBe(3)
    expect(a.low_results).toBe(true)
    expect(a.needs_rediscovery).toBe(true)
  })

  it('excludes deadline-passed rows from the actionable count', () => {
    const past = withVerifiedFourTruth({ match_score: 80, match_decision: 'accept', title: 'Expired Grant', deadline_at: '2020-01-01T00:00:00Z' })
    const a = auditProfileResultCoverageFromData({
      profileId: 'p-expired',
      surfacedRows: [past, past, accept('Live Grant')],
      unsurfacedCount: 0,
      thesis: student([]),
    })
    expect(a.surfaced_qualifying).toBe(3)
    expect(a.deadline_passed_count).toBe(2)
    expect(a.surfaced_actionable).toBe(1)
    expect(a.low_results).toBe(true)
  })

  it('treats a rolling/ongoing deadline in the past as still open (actionable)', () => {
    const rolling = withVerifiedFourTruth({ match_score: 80, match_decision: 'accept', title: 'Rolling Grant', deadline: '2020-01-01', deadline_type: 'rolling' })
    const a = auditProfileResultCoverageFromData({
      profileId: 'p-rolling',
      surfacedRows: [rolling, accept('B'), accept('C')],
      unsurfacedCount: 0,
      thesis: student([]),
    })
    expect(a.surfaced_actionable).toBe(3)
    expect(a.low_results).toBe(false)
  })

  it('a county geo-stub does NOT clear the hyperlocal gap', () => {
    const a = auditProfileResultCoverageFromData({
      profileId: 'p-geo-county',
      surfacedRows: [
        accept('Community Action Agency near Bradley County'),
        accept('State Grant'),
        accept('Federal Aid'),
      ],
      unsurfacedCount: 0,
      thesis: student(['Some College'], 'Bradley County'),
    })
    expect(a.hyperlocal_gap).toBe(true)
  })

  it('a healthy profile has no gaps', () => {
    const a = auditProfileResultCoverageFromData({
      profileId: 'p8',
      surfacedRows: [
        accept('MTSU Julia Powell Endowed Scholarship', 'Middle Tennessee State University'),
        accept('Bradley County Community Foundation Award'),
        accept('Forensic Science Scholarship'),
        accept('HOPE Scholarship'),
      ],
      unsurfacedCount: 0,
      thesis: student(['Middle Tennessee State University'], 'Bradley County'),
    })
    expect(a.has_gap).toBe(false)
    expect(a.needs_rediscovery).toBe(false)
  })
})
