import { describe, it, expect } from 'vitest'
import {
  pointerTruthVerdict,
  hasPositivePointerTruth,
  pointerGeoEvidence,
  pointerMatchedNeeds,
  pointerProfileEvidence,
} from '../config/pointerTruthPolicy.js'

/**
 * The fixtures below are REAL rows from the owner's 2026-09-06 report: profile
 * c4a92724 (a Cleveland, TN student) as surfaced on the Discover page, read
 * read-only from prod. Titles, sponsors, scores, `match_explain_json` shapes and
 * the wrong `state` values are verbatim — the point of this file is that the
 * gates separate them the way a person reading the page would.
 */
const prodRow = (over = {}) => ({
  is_directory: true,
  match_decision: 'review',
  link_status: 'ok',
  reality_status: 'verified',
  ...over,
})

// ── The rows the owner named as junk ────────────────────────────────────────

const kresge = prodRow({
  title: 'Kresge Foundation — Foundation/Grantmaker',
  state: 'MI',
  match_score: 24,
  source_url: 'https://projects.propublica.org/nonprofits/organizations/381451097',
  match_explain_json: JSON.stringify({
    matchedNeeds: ['health_medical', 'employment', 'housing', 'education'],
    matchedSignals: ['category', 'needs'],
  }),
})

const southeastMichigan = prodRow({
  title: 'Community Foundation For Southeast Michigan — Foundation/Grantmaker',
  state: 'MI',
  match_score: 24,
  source_url: 'https://projects.propublica.org/nonprofits/organizations/382530980',
  match_explain_json: JSON.stringify({
    matchedNeeds: ['health_medical', 'employment', 'housing', 'education'],
    matchedSignals: ['category', 'needs'],
  }),
})

// Peoria, Illinois — and the row's own `state` column says TN, which is exactly
// why the relatable leg reads the MATCH evidence and never that column.
const bradleyUniversity = prodRow({
  title: 'Scholarships & Grants - Bradley University',
  sponsor: 'bradley.edu',
  state: 'TN',
  match_score: 26,
  opportunity_kind: 'school_portal',
  reality_status: 'downgraded',
  source_url: 'https://www.bradley.edu/admissions/cost/scholarships/',
  match_explain_json: JSON.stringify({
    gate: 'recorded_discovery_provenance',
    source: 'web_search',
    scoring_policy_version: 'need_first_v2',
    dataPointEvidence: { bonus_credit: 0, total_credit: 0 },
    scoreBreakdown: { total: 26 },
  }),
})

// A DEGREE PROGRAM page, not funding — and the row's `state` column says GA for
// a Middle Tennessee State University page.
const forensicScienceDegree = prodRow({
  title: 'Forensic Science, B.S.',
  sponsor: 'Middle Tennessee State University',
  state: 'GA',
  match_score: 8,
  source_url: 'https://www.mtsu.edu/programs/forensic-science/',
  match_explain_json: JSON.stringify({}),
})

// ── The rows that SHOULD keep surfacing ─────────────────────────────────────

const tsuScholarships = prodRow({
  title: 'TSU Scholarships',
  sponsor: 'Tennessee State University',
  state: 'TN',
  match_score: 79,
  source_url: 'https://www.tnstate.edu/scholarships/',
  match_explain_json: JSON.stringify({
    matchedNeeds: ['education', 'student_aid', 'scholarship'],
    matchedSignals: ['geo:state', 'applicant_type', 'keywords', 'category', 'needs'],
  }),
})

const hudLocator = prodRow({
  title: 'Cleveland, TN — Local housing help — HUD Resource Locator',
  sponsor: 'U.S. Department of Housing and Urban Development',
  state: 'TN',
  match_score: 21,
  reality_status: 'directory',
  source_url: 'https://resources.hud.gov/',
  // The crawler-os explain shape: no matchedSignals array at all.
  match_explain_json: JSON.stringify({
    matched_profile_type: true,
    matched_location: 'state',
    eligibility_fit: 'maybe',
    matched_needs: ['housing', 'emergency', 'veteran', 'individual'],
    matched_profile_facts: ['Need: housing', 'Profile signal: geo:state'],
  }),
})

const mtsuOffCampusHousing = prodRow({
  title: 'Middle Tennessee State University — Off-Campus Housing & Rent Assistance',
  sponsor: 'Middle Tennessee State University',
  is_national: true,
  match_score: 36,
  reality_status: 'downgraded',
  source_url: 'https://www.mtsu.edu/housing/',
  match_explain_json: JSON.stringify({
    matchedNeeds: ['housing', 'education', 'utilities'],
    // No applicant_type signal — a locator's contract is its service area, not
    // an applicant-type statement, so this must NOT be required.
    matchedSignals: ['geo:national', 'keywords', 'category', 'needs'],
  }),
})

describe('pointerTruthPolicy — the four gates in their pointer sense', () => {
  it('refuses an out-of-area grantmaker that matched only on CATEGORY', () => {
    for (const row of [kresge, southeastMichigan]) {
      expect(hasPositivePointerTruth(row)).toBe(false)
      expect(pointerTruthVerdict(row).failed).toEqual(['relatable'])
      // Its needs and profile evidence are real — geography is the whole story.
      expect(pointerMatchedNeeds(row).length).toBeGreaterThan(0)
      expect(pointerProfileEvidence(row)).toBe(true)
      expect(pointerGeoEvidence(row)).toBe(false)
    }
  })

  it('refuses a row re-offered on DISCOVERY PROVENANCE alone', () => {
    // `gate: recorded_discovery_provenance` with total_credit 0 means the engine
    // never matched anything about this profile; the row surfaced because a
    // crawl run for her happened to return it.
    expect(hasPositivePointerTruth(bradleyUniversity)).toBe(false)
    expect(pointerTruthVerdict(bradleyUniversity).failed).toEqual([
      'relatable', 'meets_profile_need', 'profile_qualifies',
    ])
  })

  it('refuses a degree-program page carrying no match evidence at all', () => {
    expect(hasPositivePointerTruth(forensicScienceDegree)).toBe(false)
    expect(pointerTruthVerdict(forensicScienceDegree).failed).toEqual([
      'relatable', 'meets_profile_need', 'profile_qualifies',
    ])
  })

  it('NEVER reads the row\'s own state column as geographic evidence', () => {
    // bradley.edu is in Peoria, Illinois and the column says TN; the MTSU
    // program page's column says GA. The column is crawl provenance.
    expect(bradleyUniversity.state).toBe('TN')
    expect(forensicScienceDegree.state).toBe('GA')
    expect(pointerGeoEvidence(bradleyUniversity)).toBe(false)
    expect(pointerGeoEvidence(forensicScienceDegree)).toBe(false)
  })

  it('keeps the in-state, in-city and national locators that DID match her', () => {
    for (const row of [tsuScholarships, hudLocator, mtsuOffCampusHousing]) {
      expect(pointerTruthVerdict(row)).toMatchObject({ pass: true, failed: [] })
    }
  })

  it('reads both persisted explain shapes, not just the canonical one', () => {
    // crawler-os writes matched_location / matched_needs / matched_profile_facts;
    // the canonical engine writes matchedSignals / matchedNeeds. Both are proof.
    expect(pointerGeoEvidence(hudLocator)).toBe(true)
    expect(pointerGeoEvidence(tsuScholarships)).toBe(true)
    expect(pointerMatchedNeeds(hudLocator)).toContain('housing')
    expect(pointerMatchedNeeds(tsuScholarships)).toContain('education')
  })

  it('does not require an applicant-type signal — a locator serves its area', () => {
    const signals = JSON.parse(mtsuOffCampusHousing.match_explain_json).matchedSignals
    expect(signals).not.toContain('applicant_type')
    expect(hasPositivePointerTruth(mtsuOffCampusHousing)).toBe(true)
  })

  it('refuses a REJECT and an affirmative eligibility NO, but not silence', () => {
    expect(pointerTruthVerdict({ ...hudLocator, match_decision: 'reject' }).failed)
      .toEqual(['profile_qualifies'])
    const explain = JSON.parse(hudLocator.match_explain_json)
    expect(pointerTruthVerdict({
      ...hudLocator,
      match_explain_json: JSON.stringify({ ...explain, eligibility_fit: 'no' }),
    }).failed).toEqual(['profile_qualifies'])
    // 'maybe' / absent is UNKNOWN, and unknown is never a denial.
    expect(hasPositivePointerTruth({
      ...hudLocator,
      match_explain_json: JSON.stringify({ ...explain, eligibility_fit: undefined }),
    })).toBe(true)
  })

  it('refuses a row with nowhere to go, or one the reality gate rejected', () => {
    const noUrl = { ...hudLocator, source_url: null }
    expect(pointerTruthVerdict(noUrl).failed).toEqual(['real'])
    expect(pointerTruthVerdict({ ...hudLocator, reality_status: 'expired' }).failed).toEqual(['real'])
    expect(pointerTruthVerdict({ ...hudLocator, reality_status: 'rejected' }).failed).toEqual(['real'])
    // A broken LINK is deliberately not this gate's business — the canonical
    // enricher already shows such a pointer carrying `trust_downgrade`.
    expect(hasPositivePointerTruth({ ...hudLocator, link_status: 'broken' })).toBe(true)
  })

  it('treats a pointer nobody scored as unknown, never as relevant', () => {
    expect(hasPositivePointerTruth({ is_directory: true })).toBe(false)
    expect(hasPositivePointerTruth({})).toBe(false)
    expect(hasPositivePointerTruth(null)).toBe(false)
  })
})
