import { describe, it, expect } from 'vitest'
import {
  SURFACED_MATCHER_VERSIONS,
  SURFACED_MATCHER_VERSIONS_SQL,
  DIRECTORY_MIN_SCORE,
  isOpportunityLifecycleVisible,
  opportunityLifecycleVisibility,
  opportunityLifecycleVisibilitySql,
  qualifiesForDisplay,
  pointerDisplayRefusal,
} from '../config/matchSurfacing.js'
import {
  ACCEPT_SCORE,
  REVIEW_SCORE,
  STRONG_MATCH_SCORE,
} from '../config/matchThresholds.js'

describe('matchSurfacing — surfaced matcher versions', () => {
  it('includes every reconcile-surviving version, in order', () => {
    expect(SURFACED_MATCHER_VERSIONS).toEqual([
      'crawler-os',
      'crawler-os-xmatch',
      'web-llm',
      'institution-link',
      'profile-discovery-link',
      'field-of-study-link',
      'student-aid-instate-link',
      'county-crisis-need-link',
      'catalog-rescore-link',
      'funder-behavior-link',
      'national-assistance-link',
      'canonical-rescore-link',
    ])
  })

  it('funder-behavior-link must be surfaced — the funder\'s own filed giving', () => {
    // The funder-behavior recall net (enforceFunderBehaviorRecall) links a
    // profile to a `propublica_990` funder whose itemized 990 grant list
    // demonstrates in-state giving for a declared need, engine-ACCEPT only.
    // Persisting under a reconcile-surviving version and then not reading it
    // back would repeat the web-llm regression exactly.
    expect(SURFACED_MATCHER_VERSIONS).toContain('funder-behavior-link')
  })

  it('catalog-rescore-link must be surfaced — the continuous re-matching sweep', () => {
    // Prod 2026-08-03: 641 of 11,050 active non-pointer catalog rows have EVER
    // carried a match row for ANY profile — the rolling snapshot erases what a
    // run does not re-find and nothing ever re-offers the rest. The sweep
    // persists engine ACCEPTs under its own version precisely so the reconcile
    // cannot erase them; not reading them back would repeat the web-llm
    // regression exactly.
    expect(SURFACED_MATCHER_VERSIONS).toContain('catalog-rescore-link')
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

  it('field-of-study-link must be surfaced — the profile DECLARED the subject', () => {
    // `education.intended_major` / `education.interests` are facts the applicant
    // typed about themselves. Prod 2026-08-02: a forensic-science student
    // carried 1 of 13 active forensic catalog rows, and the unscored pair
    // "AFTE Forensic Science Scholarship" replays as ACCEPT 83. Persisting under
    // a reconcile-surviving version and then not reading it back would repeat
    // the web-llm regression exactly.
    expect(SURFACED_MATCHER_VERSIONS).toContain('field-of-study-link')
  })

  it('student-aid-instate-link must be surfaced — a student\'s own state\'s aid', () => {
    // Prod 2026-08-02: the catalog held 21 active TN HOPE rows and a TN
    // dual-enrolled senior matched ZERO; the unscored pair replays as
    // ACCEPT 100. Persisting under a reconcile-surviving version and then
    // not reading it back would repeat the web-llm regression exactly.
    expect(SURFACED_MATCHER_VERSIONS).toContain('student-aid-instate-link')
  })

  it('county-crisis-need-link must be surfaced — the household\'s OWN county\'s help', () => {
    // Prod 2026-08-02: 416 active eviction/rental rows carried 16 match rows
    // between them, and a family in Lorain County OH had NO row at all for
    // "Love INC Lorain County — Emergency Housing & Rent Assistance", which
    // replays as ACCEPT 100. Persisting under a reconcile-surviving version
    // and then not reading it back would repeat the web-llm regression exactly.
    expect(SURFACED_MATCHER_VERSIONS).toContain('county-crisis-need-link')
  })

  it('builds a valid SQL IN() fragment from the constant', () => {
    expect(SURFACED_MATCHER_VERSIONS_SQL).toBe(
      "('crawler-os','crawler-os-xmatch','web-llm','institution-link','profile-discovery-link','field-of-study-link','student-aid-instate-link','county-crisis-need-link','catalog-rescore-link','funder-behavior-link','national-assistance-link','canonical-rescore-link')",
    )
    // Round-trip: fragment lists exactly the same versions, quoted.
    for (const v of SURFACED_MATCHER_VERSIONS) {
      expect(SURFACED_MATCHER_VERSIONS_SQL).toContain(`'${v}'`)
    }
  })
})

describe('matchSurfacing — qualifiesForDisplay', () => {
  const MIN = STRONG_MATCH_SCORE
  const positiveProof = {
    direct_funding: true,
    all_passed: true,
    real: {
      passed: true,
      reality_status: 'VERIFIED',
      evidence_url: 'https://funder.example/program',
      evidence_captured_at: '2026-09-03T00:00:00.000Z',
      content_hash_present: true,
    },
    relatable: { passed: true, canonical_decision: 'ACCEPT' },
    meets_profile_need: {
      passed: true,
      matched_needs: ['housing'],
      profile_needs_defaulted: false,
    },
    profile_qualifies: { passed: true, eligibility: 'yes' },
  }
  const direct = (overrides = {}) => ({
    match_score: MIN,
    match_decision: 'ACCEPT',
    match_explain: { four_truth_proof: positiveProof },
    ...overrides,
  })

  it('never treats a score by itself as four-truth funding proof', () => {
    expect(qualifiesForDisplay({ match_score: MIN }, MIN)).toBe(false)
    expect(qualifiesForDisplay({ match_score: MIN + 3, match_decision: 'REVIEW' }, MIN)).toBe(false)
  })

  it('hides plain rows below the floor', () => {
    expect(qualifiesForDisplay({ match_score: MIN - 1, match_decision: 'review' }, MIN)).toBe(false)
    expect(qualifiesForDisplay({ match_score: REVIEW_SCORE, match_decision: 'review' }, MIN)).toBe(false)
  })

  it('surfaces a direct ACCEPT only with independently valid four-truth proof', () => {
    expect(qualifiesForDisplay(direct({ match_score: ACCEPT_SCORE }), MIN)).toBe(true)
    expect(qualifiesForDisplay({ match_score: ACCEPT_SCORE, match_decision: 'ACCEPT' }, MIN)).toBe(false)
    expect(qualifiesForDisplay(direct({
      match_explain: {
        four_truth_proof: {
          ...positiveProof,
          profile_qualifies: { passed: false, eligibility: 'no' },
        },
      },
    }), MIN)).toBe(false)
  })

  // A pointer that CARRIES the four gates in their pointer sense: tied to this
  // profile geographically, serving a recorded need, scored against the
  // profile's own data points. Shaped like a real crawler-os explain row.
  const provenPointer = (extra = {}) => ({
    is_directory: true,
    url: 'https://example.gov/locator',
    match_decision: 'REVIEW',
    match_explain: {
      matched_location: 'state',
      matched_profile_type: true,
      matched_needs: ['housing'],
      matched_profile_facts: ['Profile signal: geo:state'],
    },
    ...extra,
  })

  it('surfaces a PROVEN directory past the display floor (mission rule), but not one the engine scored irrelevant', () => {
    // A review-worthy directory below the requested display floor still surfaces.
    expect(qualifiesForDisplay(provenPointer({ match_score: REVIEW_SCORE }), MIN)).toBe(true)
    expect(qualifiesForDisplay(provenPointer({ match_score: DIRECTORY_MIN_SCORE }), MIN)).toBe(true)
    // ...but a directory the engine affirmatively judged irrelevant stays hidden
    // (demo_senior_family's real case: federal student-aid directory scored 0 for a senior citizen).
    expect(qualifiesForDisplay(provenPointer({ match_score: 0 }), MIN)).toBe(false)
    expect(qualifiesForDisplay(provenPointer({ match_score: 5 }), MIN)).toBe(false)
    expect(qualifiesForDisplay(provenPointer({ match_score: DIRECTORY_MIN_SCORE - 1 }), MIN)).toBe(false)
  })

  it('a pointer NOBODY scored against this profile no longer surfaces - unknown is not relevant', () => {
    // Owner report 2026-09-06 (one student profile's crawl): the pointer arm
    // return true for an UNSCORED pointer unconditionally, and for any scored
    // one that merely reached the REVIEW band, so nothing about the profile was
    // required. That is how "Scholarships & Grants - Bradley University"
    // (bradley.edu, Peoria IL) reached a Cleveland, TN student carrying
    // `dataPointEvidence.total_credit: 0` and no matched needs or signals.
    expect(qualifiesForDisplay({ is_directory: true }, MIN)).toBe(false)
    expect(qualifiesForDisplay({ is_directory: true, match_score: null }, MIN)).toBe(false)
    expect(qualifiesForDisplay({ is_directory: true, match_score: REVIEW_SCORE }, MIN)).toBe(false)
    expect(qualifiesForDisplay({
      is_directory: true,
      match_score: 26,
      url: 'https://www.bradley.edu/admissions/cost/scholarships/',
      match_decision: 'REVIEW',
      match_explain_json: JSON.stringify({
        gate: 'recorded_discovery_provenance',
        source: 'web_search',
        dataPointEvidence: { bonus_credit: 0, total_credit: 0 },
      }),
    }, MIN)).toBe(false)
  })

  it('a pointer matched on CATEGORY but on nothing geographic is not relatable', () => {
    // The five 990 grantmakers the owner named (Kresge/Troy MI, Community
    // Foundation for Southeast Michigan/Detroit, Mott/Flint MI, Edward Jones/MO,
    // Muncrief/OK) all surfaced for a Tennessee student carrying exactly
    // `matchedSignals: ["category","needs"]` - no geographic leg at all.
    const michiganFoundation = {
      is_directory: true,
      match_score: 24,
      url: 'https://projects.propublica.org/nonprofits/organizations/381403160',
      match_decision: 'REVIEW',
      match_explain_json: JSON.stringify({
        matchedNeeds: ['education', 'housing'],
        matchedSignals: ['category', 'needs'],
      }),
    }
    expect(qualifiesForDisplay(michiganFoundation, MIN)).toBe(false)
    expect(pointerDisplayRefusal(michiganFoundation, MIN)).toEqual({
      reason: 'pointer_four_gates',
      failed: ['relatable'],
    })
    // The same row, once the engine ties it to the profile's own state, surfaces.
    expect(qualifiesForDisplay({
      ...michiganFoundation,
      match_explain_json: JSON.stringify({
        matchedNeeds: ['education', 'housing'],
        matchedSignals: ['geo:state', 'category', 'needs'],
      }),
    }, MIN)).toBe(true)
  })

  it('recognizes directory resources and typed referrals without route-local flags', () => {
    expect(qualifiesForDisplay(provenPointer({ is_directory: undefined, is_directory_resource: true, match_score: REVIEW_SCORE }), MIN)).toBe(true)
    expect(qualifiesForDisplay(provenPointer({ is_directory: undefined, opportunity_kind: 'referral', match_score: REVIEW_SCORE }), MIN)).toBe(true)
  })

  it('names the failed gates so a pointer drop is never silent', () => {
    expect(pointerDisplayRefusal(provenPointer({ match_score: REVIEW_SCORE }), MIN)).toBeNull()
    expect(pointerDisplayRefusal({ match_decision: 'ACCEPT', match_score: 90 }, MIN)).toBeNull()
    expect(pointerDisplayRefusal({ is_directory: true, match_score: 26 }, MIN)).toEqual({
      reason: 'pointer_four_gates',
      failed: ['real', 'relatable', 'meets_profile_need', 'profile_qualifies'],
    })
    expect(pointerDisplayRefusal(provenPointer({ match_score: 1 }), MIN)).toEqual({
      reason: 'pointer_below_review_band',
      failed: ['score'],
    })
  })

  it('never lets ACCEPT or pointer preservation override explicit lifecycle quarantine', () => {
    expect(qualifiesForDisplay({
      is_hidden: 1,
      is_active: 1,
      match_score: MIN,
      match_decision: 'ACCEPT',
      match_explain: { four_truth_proof: positiveProof },
    }, MIN)).toBe(false)
    expect(qualifiesForDisplay({
      ...provenPointer({ match_score: REVIEW_SCORE }),
      is_directory: undefined,
      is_hidden: 0,
      is_active: 0,
      opportunity_kind: 'referral',
    }, MIN)).toBe(false)
  })

  it('DIRECTORY_MIN_SCORE stays in sync with the engine REVIEW band', () => {
    expect(DIRECTORY_MIN_SCORE).toBe(REVIEW_SCORE)
  })

  it('does NOT surface REVIEW/REJECT rows below the floor', () => {
    expect(qualifiesForDisplay({ match_score: REVIEW_SCORE, match_decision: 'review' }, MIN)).toBe(false)
    expect(qualifiesForDisplay({ match_score: MIN + 3, match_decision: 'reject' }, MIN)).toBe(false)
  })

  it('handles missing/garbage rows without throwing', () => {
    expect(qualifiesForDisplay(null, MIN)).toBe(false)
    expect(qualifiesForDisplay({}, MIN)).toBe(false)
    expect(qualifiesForDisplay({ match_score: 'nan', match_decision: '' }, MIN)).toBe(false)
  })
})

describe('matchSurfacing — opportunity lifecycle visibility', () => {
  it('accepts visible and legacy-unset rows, but fails closed for quarantine and invalid flags', () => {
    expect(isOpportunityLifecycleVisible({ is_active: true, is_hidden: false })).toBe(true)
    expect(isOpportunityLifecycleVisible({ is_active: '1', is_hidden: '0' })).toBe(true)
    expect(isOpportunityLifecycleVisible({})).toBe(true)
    expect(opportunityLifecycleVisibility({ is_active: 1, is_hidden: 1 })).toEqual({
      visible: false,
      reason: 'lifecycle_hidden',
    })
    expect(opportunityLifecycleVisibility({ is_active: false, is_hidden: false })).toEqual({
      visible: false,
      reason: 'lifecycle_inactive',
    })
    expect(opportunityLifecycleVisibility({ is_active: 'unknown', is_hidden: 0 })).toEqual({
      visible: false,
      reason: 'lifecycle_invalid_flag',
    })
  })

  it('builds dialect-correct SQL from code-owned aliases only', () => {
    expect(opportunityLifecycleVisibilitySql({ tableAlias: 'fo', dialect: 'postgres' }))
      .toBe('(COALESCE(fo.is_active, TRUE) = TRUE AND COALESCE(fo.is_hidden, FALSE) = FALSE)')
    expect(opportunityLifecycleVisibilitySql())
      .toBe('(COALESCE(is_active, 1) = 1 AND COALESCE(is_hidden, 0) = 0)')
    expect(() => opportunityLifecycleVisibilitySql({ tableAlias: 'fo; DROP TABLE x' }))
      .toThrow(/invalid table alias/)
  })
})
