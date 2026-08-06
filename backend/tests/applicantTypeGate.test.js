/**
 * Tests for the applicant-type eligibility gate, with the regression cases from
 * Demo Student's pipeline: an INDIVIDUAL (graduate student) must NOT receive
 * institution-only federal grants (OSEP personnel preparation, NRSA institutional
 * training grants, OESE comprehensive centers, NSF Space Grant) — an individual
 * cannot be the applicant. Directories and legitimate individual scholarships
 * MUST still pass (mission rule: recall over suppression; directories survive).
 */

import { describe, it, expect } from 'vitest'
import { evaluateApplicantTypeEligibility, isHardApplicantTypeMismatch, __testables } from '../services/applicantTypeGate.js'

const STUDENT = 'graduate_student'
const INDIVIDUAL = 'individual'

describe('applicantTypeGate — institution-only federal mechanisms vs an individual', () => {
  const institutionOnlyTitles = [
    'Office of Special Education and Rehabilitative Services (OSERS): Personnel Preparation of Special Education, Early Intervention, and Related Services Personnel, ALN 84.325K',
    'Ruth L. Kirschstein National Research Service Award Institutional Research Training Grant (NRSA)',
    'Office of Elementary and Secondary Education (OESE): Comprehensive Centers Program: National Comprehensive Center, ALN 84.283D',
    'National Space Grant College and Fellowship Program - Opportunities in NASA STEM',
  ]

  for (const title of institutionOnlyTitles) {
    it(`blocks institution-only title for an individual: "${title.slice(0, 48)}…"`, () => {
      const res = evaluateApplicantTypeEligibility({ title }, STUDENT)
      expect(res.decision).toBe('mismatch')
      expect(isHardApplicantTypeMismatch({ title }, STUDENT)).toBe(true)
    })
  }

  it('blocks an opportunity whose explicit applicant_types are org-only', () => {
    const opp = {
      title: 'Some Federal Training Program',
      applicant_types: ['Public and State controlled institutions of higher education', 'Nonprofits'],
    }
    expect(evaluateApplicantTypeEligibility(opp, STUDENT).decision).toBe('mismatch')
  })

  it('blocks "eligible applicants: institutions of higher education" free text', () => {
    const opp = {
      title: 'National Professional Development Program',
      eligibility: 'Eligible applicants: institutions of higher education in partnership with high-need LEAs.',
    }
    expect(evaluateApplicantTypeEligibility(opp, STUDENT).decision).toBe('mismatch')
  })
})

describe('applicantTypeGate — legitimate individual funding still passes', () => {
  const passingScholarships = [
    { title: 'Coca-Cola Scholars', description: 'Merit scholarship for graduating high school seniors.' },
    { title: 'Federal Pell Grant', description: 'Need-based federal grant for undergraduate students.' },
    { title: 'Tennessee Promise — Free Community College', description: 'Last-dollar scholarship for TN students.' },
    { title: 'NASW Foundation — Social Work CE & Professional Development Funds', description: 'Continuing education funds for social workers.' },
    // Demographic mismatch must NOT hard-block (rule: reduce score, not discard).
    { title: 'Hispanic Scholarship Fund (HSF)', description: 'Scholarships for students of Hispanic heritage.' },
    { title: 'Society of Women Engineers (SWE) Scholarships', description: 'Scholarships for women in engineering.' },
  ]

  for (const opp of passingScholarships) {
    it(`passes individual-eligible source: "${opp.title}"`, () => {
      expect(evaluateApplicantTypeEligibility(opp, STUDENT).decision).not.toBe('mismatch')
    })
  }

  it('does not hard-block "Personnel" used outside the institutional term of art', () => {
    // "personnel preparation" is the gated phrase; lone "personnel" must not trip it.
    const opp = { title: 'Healthcare Personnel Tuition Scholarship', description: 'Tuition aid for individual healthcare workers.' }
    expect(evaluateApplicantTypeEligibility(opp, STUDENT).decision).not.toBe('mismatch')
  })
})

describe('applicantTypeGate — org profiles still get institutional grants', () => {
  it('allows OSEP personnel preparation for a school/org profile', () => {
    const opp = { title: 'OSEP Personnel Preparation Grant' }
    // The institution-only patterns only mismatch INDIVIDUAL buckets.
    expect(evaluateApplicantTypeEligibility(opp, 'school').decision).not.toBe('mismatch')
    expect(evaluateApplicantTypeEligibility(opp, 'nonprofit').decision).not.toBe('mismatch')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ReDoS hardening (js/polynomial-redos, 2026-08-01)
//
// The `501(c)(3)` spelling tolerance in INSTITUTION_ONLY_PATTERNS used ADJACENT
// UNBOUNDED whitespace quantifiers (`\s*\(?\s*`, and in the "must be …" pattern
// a three-deep `\s*\)?\s*\(?\s*`). An optional literal cannot separate two
// `\s*`, so a whitespace run can be split between them in O(n) ways at each of
// O(n) start positions. Measured on the SHIPPED patterns:
//
//   /\b501\s*\(?\s*c…/            "501" + \t×n         2k→3.5ms  16k→212.9ms
//   /\bmust\s+be\s+…501\(?\s*c…/  "must be 501c" + \t×n 2k→2.1s   8k→137.4s
//
// Opportunity text is attacker-influenced — a crawled page's title/description
// flows into this gate via routes/grants.js and routes/nofo.js — so a single
// hostile page could pin a worker. Every `\s*` INSIDE the token is now bounded
// (`\s{0,4}`): a legal-entity designation never contains a 5-char whitespace
// run, so the worst case is constant instead of polynomial. The `\s+` word
// separators are untouched — they were never ambiguous.
// ─────────────────────────────────────────────────────────────────────────────

describe('applicantTypeGate — 501(c)(3) recognition must not go inert', () => {
  // The fix cannot be allowed to "work" by simply failing to match. Every real
  // spelling must still hard-mismatch an individual.
  it.each([
    '501(c)(3) status required',
    '501(c)(3) required',
    '501c3 required',
    '501 (c) (3) only',
    '501(c)3 required',
    '501 c 3 status required',
    'Applicants must be a 501(c)(3)',
    'must be a 501c3',
    'must be an institution',
    'must be a nonprofit',
  ])('still hard-mismatches an individual on: %s', (text) => {
    const res = evaluateApplicantTypeEligibility({ title: 'Program', description: text }, INDIVIDUAL)
    expect(res.decision).toBe('mismatch')
  })

  it('does not over-match text that merely MENTIONS 501(c)(3) alongside individuals', () => {
    const opp = { title: 'Program', description: 'We fund 501(c)(3) organizations and individuals alike.' }
    expect(evaluateApplicantTypeEligibility(opp, INDIVIDUAL).decision).not.toBe('mismatch')
  })
})

describe('applicantTypeGate — pathological input completes in linear time', () => {
  // Each of these hangs for MINUTES on the pre-fix patterns (the second case
  // took 137s at only 8k chars); post-fix both are sub-millisecond. The budget
  // is deliberately loose — it is detecting a complexity-class regression, not
  // micro-benchmarking, so it cannot flake on a slow CI runner.
  const BUDGET_MS = 2000

  it.each([
    ['501-required (quadratic pre-fix)', '501'],
    ['must-be-501c (super-quadratic pre-fix)', 'must be 501c'],
  ])('%s: 200k adversarial whitespace chars finish fast', (_label, prefix) => {
    const description = `${prefix}${'\t'.repeat(200_000)}!`
    const started = Date.now()
    evaluateApplicantTypeEligibility({ title: 'x', description }, INDIVIDUAL)
    expect(Date.now() - started).toBeLessThan(BUDGET_MS)
  })

})

describe('applicantTypeGate — no eligibility pattern may regrow the ReDoS shape', () => {
  // A STATIC tripwire. The timing tests above prove today's patterns are fast,
  // but sub-millisecond timings are noisy and the 137-second pattern was only a
  // one-character edit away. This asserts the STRUCTURE that caused it:
  // two UNBOUNDED whitespace quantifiers that an optional element cannot keep
  // apart, so a whitespace run can be split between them in O(n) ways.
  // Matched against a regex's SOURCE text, so `\\s` here means the two literal
  // characters `\` `s`. Reads as: an unbounded `\s*`/`\s+`, then AT MOST an
  // optional single escaped literal (`\(?`, `\)?` — the thing that failed to
  // separate them), then another unbounded `\s*`/`\s+`.
  // A REQUIRED separator (e.g. `\s*[:\-—]\s*`) is deterministic and not matched.
  const ADJACENT_UNBOUNDED_WHITESPACE = /\\s[*+](?:\\.\?)?\\s[*+]/

  const allPatterns = Object.entries(__testables.ELIGIBILITY_PATTERNS)
    .flatMap(([group, patterns]) => patterns.map((re, i) => [`${group}[${i}]`, re]))

  it('has patterns to check (the guard cannot pass vacuously)', () => {
    expect(allPatterns.length).toBeGreaterThan(15)
  })

  it.each(allPatterns)('%s has no adjacent unbounded whitespace quantifiers', (_name, re) => {
    expect(ADJACENT_UNBOUNDED_WHITESPACE.test(re.source)).toBe(false)
  })
})
