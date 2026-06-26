/**
 * Tests for the applicant-type eligibility gate, with the regression cases from
 * Anastasia's pipeline: an INDIVIDUAL (graduate student) must NOT receive
 * institution-only federal grants (OSEP personnel preparation, NRSA institutional
 * training grants, OESE comprehensive centers, NSF Space Grant) — an individual
 * cannot be the applicant. Directories and legitimate individual scholarships
 * MUST still pass (mission rule: recall over suppression; directories survive).
 */

import { describe, it, expect } from 'vitest'
import { evaluateApplicantTypeEligibility, isHardApplicantTypeMismatch } from '../services/applicantTypeGate.js'

const STUDENT = 'graduate_student'

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
