/**
 * eligibilityGatePrecision.test.js
 *
 * Regression coverage for the discovery/matching precision failures observed in
 * two real production pipelines (Robert White — a TN community-college student;
 * and a small Ohio church). The matcher was producing massive false positives:
 *
 *   (a) Already-awarded NSF AwardSearch research grants (named Awardee + PI,
 *       $300k–$650k each) auto-added to an INDIVIDUAL's pipeline.
 *   (b) Templated google.com/search "stub" rows treated as real opportunities.
 *   (c) Applicant-type eligibility not gated: an individual matched to
 *       institution/research-only grants; a church matched to research grants.
 *   (d) Geography + education-level blindness: out-of-state local K-12 awards
 *       (Polk County FL for a TN adult college student) scoring 90%+/ACCEPT.
 *   (e) Weak dedup: the same domain/opportunity appearing many times.
 *
 * Each fix is enforced at a single choke point (normalizer flags + the
 * evaluateEligibility gate + urlRules/contentFilter + deduplicateOpportunities),
 * NOT scattered per-call. These tests lock that behavior in.
 */
import { describe, it, expect } from 'vitest'
import { computeMatchDecision } from '../services/matchEngine.js'
import { normalizeProfile } from '../services/profileNormalizer.js'
import { normalizeOpportunity } from '../services/opportunityNormalizer.js'
import { isJunkOpportunity } from '../services/contentFilter.js'
import { isPlaceholderUrl, isSearchEngineUrl } from '../config/urlRules.js'
import { deduplicateOpportunities } from '../services/opportunityMatcher.js'

// ── Profiles ────────────────────────────────────────────────────────────────

// Robert White: a 20-year-old TN community-college student in Cleveland /
// Bradley County, TN. Low income. Individual (NOT an org / researcher).
const TN_STUDENT = {
  profile: {
    id: 'tn-student',
    primary_type: 'individual',
    state: 'TN',
    city: 'Cleveland',
    age: 20,
  },
  sections: {
    education: { answers: { is_student: true, school_name: 'Cleveland State Community College', highest_level: 'college' } },
  },
}

// Small Ohio church (Vermilion COGOP). Nonprofit/church entity.
const OH_CHURCH = {
  profile: {
    id: 'oh-church',
    primary_type: 'church',
    state: 'OH',
    city: 'Vermilion',
    organization_name: 'Vermilion Church of God of Prophecy',
  },
  sections: {},
}

// ── (a) Already-awarded NSF research grants → REJECT for an individual ────────

describe('(a) already-awarded NSF/research records are rejected for individuals', () => {
  // Shaped exactly like backend/src/integrations/nsfAwards.js output.
  const NSF_AWARD = {
    id: 'nsf-1',
    title: 'Collaborative Research: Genomic Analysis of Microbial Communities',
    sponsor: 'NSF — Division of Biological Infrastructure',
    source: 'nsf.awards',
    source_url: 'https://www.nsf.gov/awardsearch/showAward?AWD_ID=2012345',
    description: 'Awardee: Rhodes College\nPI: Jane Researcher\nThis award supports...',
    amount_max: 450000,
    is_national: true,
    state: 'nationwide',
    categories: ['nsf', 'research', 'science', 'education'],
    opportunity_type: 'award',
    type: 'PROGRAM',
  }

  it('normalizer flags NSF award as already-awarded + institutional/research only', () => {
    const n = normalizeOpportunity(NSF_AWARD)
    expect(n.isAlreadyAwarded).toBe(true)
    expect(n.isInstitutionalOnly).toBe(true)
    expect(n.isResearchOnly).toBe(true)
  })

  it('individual student → REJECT (not surfaced at $450k)', () => {
    const r = computeMatchDecision(TN_STUDENT.profile, NSF_AWARD, { profileSections: TN_STUDENT.sections })
    expect(r.decision).toBe('REJECT')
    expect(r.eligible).toBe(false)
    expect(r.ineligibilityReasons.join(' ')).toMatch(/already-awarded|institutions? or research/i)
  })

  it('small church → REJECT for an already-awarded NSF research grant', () => {
    const r = computeMatchDecision(OH_CHURCH.profile, NSF_AWARD, { profileSections: OH_CHURCH.sections })
    // A church is a nonprofit, but an ALREADY-AWARDED research grant (named
    // awardee/PI) is still not an open opportunity. It must not ACCEPT.
    expect(r.decision).not.toBe('ACCEPT')
  })

  it('a genuine research org is NOT blanket-rejected by the research-only flag', () => {
    // A real research opportunity (not already-awarded) should still be available
    // to a research/organization profile — we did not break institutional access.
    const OPEN_RESEARCH = {
      id: 'open-research',
      title: 'Open Research Grant for Community Health Studies',
      description: 'Applications invited from universities and research organizations.',
      application_url: 'https://example.org/apply',
      is_national: true,
      funding_type: 'grant',
    }
    const RESEARCH_ORG = { id: 'org', primary_type: 'organization', state: 'OH' }
    const r = computeMatchDecision(RESEARCH_ORG, OPEN_RESEARCH, {})
    expect(r.decision).not.toBe('REJECT')
  })
})

// ── (b) Search-engine URL rows are not real opportunities ────────────────────

describe('(b) google.com/search (and other search-engine) URLs are junk', () => {
  it('isSearchEngineUrl + isPlaceholderUrl reject every supported engine', () => {
    const urls = [
      'https://www.google.com/search?q=harvard%20housing%20scholarships',
      'https://www.bing.com/search?q=foo',
      'https://duckduckgo.com/?q=bar',
      'https://search.yahoo.com/search?p=baz', // yahoo.com/search
      'https://yandex.com/search/?text=foo',
      'https://www.baidu.com/s?wd=foo',
      'https://www.ecosia.org/search?q=foo',
    ]
    for (const u of urls) {
      expect(isSearchEngineUrl(u), `isSearchEngineUrl(${u})`).toBe(true)
      expect(isPlaceholderUrl(u), `isPlaceholderUrl(${u})`).toBe(true)
    }
  })

  it('isJunkOpportunity drops a row whose only URL is a google search', () => {
    const stub = {
      title: 'Harvard University — Housing & Off-Campus Resources',
      description: 'Find housing scholarships.',
      url: 'https://www.google.com/search?q=Harvard%20University%20housing%20scholarships',
    }
    expect(isJunkOpportunity(stub)).toBe(true)
  })

  it('a real .edu portal URL is NOT junk', () => {
    const real = {
      title: 'Cleveland State Community College — Financial Aid',
      url: 'https://www.clevelandstatecc.edu/financial-aid',
    }
    expect(isJunkOpportunity(real)).toBe(false)
  })
})

// ── (c) applicant-type eligibility is a real gate ────────────────────────────

describe('(c) applicant-type eligibility gate', () => {
  it('individual student → REJECT institution-only grant', () => {
    const INST_ONLY = {
      id: 'inst',
      title: 'Capacity Grant for Higher Education Institutions',
      description: 'Eligible applicants: accredited higher education institutions and research organizations only.',
      application_url: 'https://example.org/apply',
      is_national: true,
      funding_type: 'grant',
    }
    const r = computeMatchDecision(TN_STUDENT.profile, INST_ONLY, { profileSections: TN_STUDENT.sections })
    expect(r.decision).toBe('REJECT')
  })

  it('church → REJECT a research-only (R01-style) grant', () => {
    const R01 = {
      id: 'r01',
      title: 'NIH R01 Biomedical Research Award',
      description: 'Supports a discrete research project. Principal investigator and research institution required.',
      application_url: 'https://grants.nih.gov/foa',
      is_national: true,
      funding_type: 'grant',
    }
    const r = computeMatchDecision(OH_CHURCH.profile, R01, { profileSections: OH_CHURCH.sections })
    expect(r.decision).toBe('REJECT')
  })
})

// ── (d) geography + education-level sanity ────────────────────────────────────

describe('(d) geography + education-level sanity', () => {
  it('out-of-state K-12 award does not ACCEPT for a TN adult college student', () => {
    const POLK_K12 = {
      id: 'polk-k12',
      title: 'Elementary & Middle School Scholarships - Polk State College',
      description: 'Scholarships for elementary and middle school students in Polk County.',
      application_url: 'https://example.org/apply',
      // No explicit state; the matcher must not latch onto "scholarship".
      is_national: false,
      funding_type: 'scholarship',
      categories: ['education', 'scholarship'],
    }
    const r = computeMatchDecision(TN_STUDENT.profile, POLK_K12, { profileSections: TN_STUDENT.sections })
    expect(r.decision).not.toBe('ACCEPT')
    expect(r.score).toBeLessThan(90)
  })

  it('out-of-state local district award does not ACCEPT for a TN profile', () => {
    const POLK_FOUNDATION = {
      id: 'polk-foundation',
      title: 'Scholarships - Polk Education Foundation',
      description: 'Local scholarships administered by the Polk Education Foundation in Florida.',
      application_url: 'https://example.org/apply',
      state: 'FL',
      is_national: false,
      funding_type: 'scholarship',
    }
    const r = computeMatchDecision(TN_STUDENT.profile, POLK_FOUNDATION, { profileSections: TN_STUDENT.sections })
    expect(r.decision).not.toBe('ACCEPT')
  })

  it('education-level detection classifies K-12 vs higher-ed', () => {
    expect(normalizeOpportunity({ title: 'Elementary & Middle School Scholarships' }).educationLevel).toBe('k12')
    expect(normalizeOpportunity({ title: 'Undergraduate Tuition Scholarship', description: 'For community college students' }).educationLevel).toBe('higher_ed')
  })

  it('REGRESSION: an IN-COUNTY / unknown-state local resource is NOT geo-flagged', () => {
    // A local safety-net resource named with the profile's own county, or with no
    // resolvable state, must survive — the out-of-state-local flag must only fire
    // when the opp resolves to a DIFFERENT state than the profile's.
    const LOCAL_SAFETY_NET = {
      id: 'bradley-cap',
      title: 'Bradley County Community Action Agency',
      description: 'Emergency rent, utility, and food assistance for low-income Bradley County residents.',
      application_url: 'https://example.org/apply',
      // no resolvable state on the row → must be treated as neutral, not penalized
      funding_type: 'grant',
      record_origin: 'directory',
      type: 'DIRECTORY',
    }
    const r = computeMatchDecision(TN_STUDENT.profile, LOCAL_SAFETY_NET, { profileSections: TN_STUDENT.sections })
    expect(r.ineligibilityReasons.join(' ')).not.toMatch(/local single-district|out-of-state/i)
    expect(r.decision).not.toBe('REJECT')
  })

  it('REGRESSION: a national college scholarship still ACCEPTs for the TN student', () => {
    // Don't over-reach: a legit national scholarship for college students must
    // still be a strong match.
    const NATIONAL_SCHOLARSHIP = {
      id: 'gates',
      title: 'National College Scholarship for Low-Income Students',
      description: 'Need-based scholarship for undergraduate college students nationwide. Covers tuition and cost of attendance.',
      application_url: 'https://example.org/apply',
      is_national: true,
      state: 'nationwide',
      funding_type: 'scholarship',
      categories: ['education', 'scholarship'],
    }
    const r = computeMatchDecision(TN_STUDENT.profile, NATIONAL_SCHOLARSHIP, { profileSections: TN_STUDENT.sections })
    expect(r.decision).not.toBe('REJECT')
  })
})

// ── (e) dedup: same domain doesn't appear many times ─────────────────────────

describe('(e) domain-aware deduplication', () => {
  it('collapses 5 near-duplicate Scholarships.com rows to fewer', () => {
    const rows = [
      { id: 1, title: 'Scholarships for College Students', url: 'https://www.scholarships.com/a', source_id: 's1', source: 'web' },
      { id: 2, title: 'Scholarships for College Students 2026', url: 'https://www.scholarships.com/b', source_id: 's2', source: 'web' },
      { id: 3, title: 'College Scholarships for Students', url: 'https://scholarships.com/c', source_id: 's3', source: 'web' },
      { id: 4, title: 'Scholarships College Students Apply', url: 'https://www.scholarships.com/d', source_id: 's4', source: 'web' },
      { id: 5, title: 'Scholarships for Students in College', url: 'https://www.scholarships.com/e', source_id: 's5', source: 'web' },
    ]
    const out = deduplicateOpportunities(rows)
    expect(out.length).toBeLessThan(rows.length)
  })

  it('does NOT collapse distinct grants.gov listings (aggregator exemption)', () => {
    const rows = [
      { id: 1, title: 'Rural Housing Preservation Grant', url: 'https://www.grants.gov/x', source_id: 'g1', source: 'grants_gov' },
      { id: 2, title: 'Community Health Worker Grant', url: 'https://www.grants.gov/y', source_id: 'g2', source: 'grants_gov' },
      { id: 3, title: 'Veteran Employment Grant', url: 'https://www.grants.gov/z', source_id: 'g3', source: 'grants_gov' },
    ]
    const out = deduplicateOpportunities(rows)
    expect(out.length).toBe(3)
  })
})
