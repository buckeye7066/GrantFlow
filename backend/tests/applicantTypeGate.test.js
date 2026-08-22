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
    // Real federal-NOFO junk from an individual profile's "waiting for review"
    // backlog (2026-08-22) — auto-submit would otherwise have sent a student's
    // application to these. Terms of art no individual award uses.
    'FY25 Long Range Broad Agency Announcement (BAA) for Navy and Marine Corps Science and Technology',
    'Research Experiences for Undergraduates',
    'Notice of Intent to Publish a Request for Concept Notes Announcement on Capacity Development for the Reception & Placement Program',
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

  it('blocks a CDC global-health cooperative agreement (mechanism in the description)', () => {
    const opp = {
      title: 'Improving global health security in Côte d’Ivoire through collaboration with local partners',
      description: 'This cooperative agreement supports the ministry of health and local partner institutions.',
    }
    expect(evaluateApplicantTypeEligibility(opp, STUDENT).decision).toBe('mismatch')
  })

  it('blocks an SBIR/STTR small-business R&D solicitation', () => {
    const opp = {
      title: 'Component Technology Development',
      description: 'Small Business Innovation Research (SBIR) Phase I solicitation for eligible small business concerns.',
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
    // Real individual military/federal awards from the SAME backlog — a student
    // CAN receive these, so the new federal-mechanism patterns must not touch
    // them (they name "Army"/"Armed Forces"/"fellowship", never a BAA / SBIR /
    // cooperative agreement / NOFO).
    { title: 'Army ROTC Scholarships', description: 'Merit scholarships for college students pursuing an Army commission.' },
    { title: 'Armed Forces Health Professions Scholarship Program (Army)', description: 'Full-tuition scholarship for individual medical/health students.' },
    { title: 'AAUW International Fellowships', description: 'Fellowships for women pursuing graduate study.' },
    { title: 'Federal Work-Study', description: 'Part-time federal work-study aid for undergraduate and graduate students.' },
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

/**
 * 2026-08-21 — THE STRUCTURED COLUMN THIS GATE COULD NOT SEE.
 *
 * `gatherExplicitTypes` read `applicant_types` / `eligible_profile_types` /
 * `eligibility_types` / `eligible_applicants`. NONE of those is a column on
 * `funding_opportunities`; the stored column is `entity_types_allowed`. Both
 * real call sites (`matchEngine.js`, `pipelineEligibilitySweep.js`) hand this
 * gate a DB row, so the structured half never executed in production and every
 * institutional federal NOFO returned `{decision:'pass', reason:null}` for an
 * individual — the owner's 2026-08-21 report (an undergraduate holding queued
 * applications to ONR/NSF/ACL/HUD/EDA/FTA awards she cannot apply to).
 *
 * Each `entity_types_allowed` value below is a VERBATIM value measured in the
 * catalog, not a fixture invented for the test.
 */
describe('applicantTypeGate — entity_types_allowed is the column that is actually stored', () => {
  const ctx = { profile: { primary_type: 'college_student' }, sections: {} }

  const institutionalRows = [
    { title: 'Astronomy and Astrophysics Research Grants', sponsor: 'U.S. National Science Foundation', entity_types_allowed: '["nonprofit","school","government","business","vfd","farm"]' },
    { title: 'NRL Long Range Broad Agency Announcement (BAA) for Basic and Applied Research', sponsor: 'Office of Naval Research', entity_types_allowed: '["nonprofit","school","government","business","vfd","farm"]' },
    { title: 'FY 2025 EDA Public Works and Economic Adjustment Assistance Programs', sponsor: 'Economic Development Administration', entity_types_allowed: '["nonprofit","school","government","business","vfd","farm"]' },
    { title: 'Siemer Family Foundation — Foundation/Grantmaker', sponsor: 'Siemer Family Foundation', entity_types_allowed: '["nonprofit","school","church","ministry","government"]' },
    { title: 'Rural Business Development Grant', sponsor: 'USDA Rural Development', entity_types_allowed: '["farm","government","business","vfd"]' },
  ]

  for (const row of institutionalRows) {
    it(`hard-mismatches an individual: "${row.title.slice(0, 46)}…"`, () => {
      expect(evaluateApplicantTypeEligibility(row, 'college_student', ctx).decision).toBe('mismatch')
    })
    it(`still PASSES an organization: "${row.title.slice(0, 40)}…"`, () => {
      expect(evaluateApplicantTypeEligibility(row, 'nonprofit', { profile: { primary_type: 'nonprofit' }, sections: {} }).decision)
        .not.toBe('mismatch')
    })
  }

  // RECALL: the rows an individual genuinely can apply to must be untouched.
  const individualRows = [
    { title: 'Federal Pell Grant', sponsor: 'Federal Student Aid', entity_types_allowed: '["student","family"]' },
    { title: 'Federal Work-Study', sponsor: 'Federal Student Aid', entity_types_allowed: '["student","family"]' },
    { title: 'SNAP state directory', sponsor: 'USDA', entity_types_allowed: '["individual","family","student","veteran"]' },
    { title: 'Avoid foreclosure — free HUD-approved housing counseling', sponsor: 'HUD', entity_types_allowed: '["individual","family","veteran","senior"]' },
    // A narrow population token that the pre-2026-08-21 individual vocabulary
    // did NOT contain — widening it is what stops this becoming a new flood.
    { title: 'Survivor Benefits', sponsor: 'SSA', entity_types_allowed: '["veteran"]' },
    { title: 'Caregiver Respite Fund', sponsor: 'A Foundation', entity_types_allowed: '["caregiver"]' },
  ]

  for (const row of individualRows) {
    it(`keeps an individual-eligible row: "${row.title.slice(0, 40)}"`, () => {
      expect(evaluateApplicantTypeEligibility(row, 'college_student', ctx).decision).toBe('pass')
    })
  }

  it('treats the ["*"] wildcard as UNRESTRICTED, never as "excludes everyone"', () => {
    // `crawlerVocabulary.withFallback()` writes ['*'] when a lane states
    // nothing. Without this rail the gate would go from blind to hostile.
    const row = { title: 'Community Foundation Locator (national directory)', entity_types_allowed: '["*"]' }
    for (const t of ['college_student', 'nonprofit', 'small_business', 'individual']) {
      expect(evaluateApplicantTypeEligibility(row, t, { profile: { primary_type: t }, sections: {} }).decision).toBe('pass')
    }
  })

  it('an EMPTY structured list is silence, not a denial', () => {
    const row = { title: 'Catholic Charities – Lorain County Emergency Housing Assistance', entity_types_allowed: '[]' }
    expect(evaluateApplicantTypeEligibility(row, 'college_student', ctx).decision).toBe('pass')
  })

  it('SOFTENS to review — never hard-rejects — an assistance-shaped row typed from its own prose', () => {
    // `crawlerVocabulary.APPLICANT_RULES` types this ["church"] from the word
    // "Church" in the TITLE. A hard mismatch would delete a real emergency-aid
    // program from a needy student's pipeline.
    const row = {
      title: 'Emmanuel Lutheran Church – Emergency Rent Assistance',
      entity_types_allowed: '["church","ministry"]',
    }
    const res = evaluateApplicantTypeEligibility(row, 'college_student', ctx)
    expect(res.decision).toBe('review')
    expect(isHardApplicantTypeMismatch(row, 'college_student', ctx)).toBe(false)
  })

  it('the softener does NOT rescue an institutional NOFO (it is title-shaped and narrow)', () => {
    const row = {
      title: 'Research Experiences for Undergraduates (REU Sites)',
      sponsor: 'U.S. National Science Foundation',
      entity_types_allowed: '["nonprofit","school","government","business","vfd","farm"]',
    }
    expect(evaluateApplicantTypeEligibility(row, 'college_student', ctx).decision).toBe('mismatch')
  })

  it('an explicit institution-only PROSE bar still hard-rejects even on an assistance-shaped title', () => {
    // The prose patterns are evidence the FUNDER wrote; the softener only ever
    // covers types the CRAWLER inferred.
    const row = {
      title: 'Institutional Training Scholarship Program',
      description: 'Open to institutions of higher education only.',
      entity_types_allowed: '["school"]',
    }
    expect(evaluateApplicantTypeEligibility(row, 'college_student', ctx).decision).toBe('mismatch')
  })
})
