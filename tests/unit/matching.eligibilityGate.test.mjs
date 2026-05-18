// Unit tests for the hard applicant-type eligibility gate (Goal 4 in
// PROFILE_SCOPING.md). Verifies the standalone helper used by:
//   • routes/matching.js  GET /api/matching/profile/:id/opportunities
//   • routes/grants.js    POST /api/grants/from-opportunity
//   • services/opportunityMatcher.js  saveToProfilePipeline()

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateApplicantTypeEligibility,
  isHardApplicantTypeMismatch,
} from '../../backend/services/applicantTypeGate.js'

test('applicantTypeGate — drops NSF research-institution opportunities for individual profiles', () => {
  const opp = {
    title: 'NSF CyberTraining',
    description:
      'This program supports principal investigators at accredited US institutions of higher education to pursue training in cyberinfrastructure.',
  }
  const result = evaluateApplicantTypeEligibility(opp, 'individual_need')
  assert.equal(result.decision, 'mismatch')
  assert.equal(result.reason, 'institution_only_excludes_individual')
  assert.equal(isHardApplicantTypeMismatch(opp, 'individual_need'), true)
})

test('applicantTypeGate — drops federal-agency-only programs for individual profiles', () => {
  const opp = {
    title: 'U.S. Mission to Argentina Cultural Grant',
    description:
      'Eligible applicants: federal agencies only. The U.S. Mission to Argentina announces this notice of funding opportunity.',
  }
  const result = evaluateApplicantTypeEligibility(opp, 'individual')
  assert.equal(result.decision, 'mismatch')
})

test('applicantTypeGate — drops 501(c)(3)-only programs for individual profiles', () => {
  const opp = {
    title: 'Community Capacity Grant',
    description:
      '501(c)(3) status required. Nonprofit organizations only.',
  }
  const result = evaluateApplicantTypeEligibility(opp, 'individual_need')
  assert.equal(result.decision, 'mismatch')
  assert.ok(
    ['institution_only_excludes_individual', 'nonprofit_only_excludes_business'].includes(result.reason),
    `unexpected reason: ${result.reason}`,
  )
})

test('applicantTypeGate — keeps individual-eligible opportunities for individual profiles', () => {
  const opp = {
    title: 'Emergency Rental Assistance',
    description:
      'Direct cash assistance for individuals and families experiencing housing insecurity.',
  }
  const result = evaluateApplicantTypeEligibility(opp, 'individual_need')
  assert.notEqual(result.decision, 'mismatch')
})

test('applicantTypeGate — keeps directory-style opportunities even with sparse eligibility text', () => {
  const opp = {
    title: 'Scholarships.com',
    description: 'Search engine for scholarships.',
    source: 'scholarships.com',
    record_origin: 'live_crawl',
  }
  const result = evaluateApplicantTypeEligibility(opp, 'student')
  // Either pass or review — never mismatch for a generic platform.
  assert.notEqual(result.decision, 'mismatch')
})

test('applicantTypeGate — rejects org-only programs for individual_need profile', () => {
  const opp = {
    title: 'Community Capacity Building',
    description: 'Eligible applicants: nonprofits',
    applicant_types: ['nonprofit', 'organization'],
  }
  const result = evaluateApplicantTypeEligibility(opp, 'individual_need')
  assert.equal(result.decision, 'mismatch')
  assert.equal(result.reason, 'explicit_applicant_types_mismatch')
})

test('applicantTypeGate — accepts org programs when profile is a nonprofit', () => {
  const opp = {
    title: 'Capacity Grant',
    description: 'For 501(c)(3) nonprofits.',
    applicant_types: ['nonprofit', 'organization'],
  }
  const result = evaluateApplicantTypeEligibility(opp, 'nonprofit')
  assert.equal(result.decision, 'pass')
})

test('applicantTypeGate — accepts business programs when profile is small_business', () => {
  const opp = {
    title: 'Small Business Innovation Grant',
    description: 'Funds startups.',
    applicant_types: ['small_business', 'startup'],
  }
  const result = evaluateApplicantTypeEligibility(opp, 'small_business')
  assert.equal(result.decision, 'pass')
})

test('applicantTypeGate — returns review when the profile applicant type is missing', () => {
  const opp = {
    title: 'Some grant',
    description: 'Open to applicants.',
  }
  const result = evaluateApplicantTypeEligibility(opp, null)
  assert.equal(result.decision, 'review')
  assert.equal(result.reason, 'profile_applicant_type_missing')
})

test('applicantTypeGate — parses applicant_types stored as a JSON string', () => {
  const opp = {
    title: 'Research Program',
    description: '',
    applicant_types: JSON.stringify(['institution', 'university']),
  }
  assert.equal(isHardApplicantTypeMismatch(opp, 'individual_need'), true)
})

test('applicantTypeGate — does not hard-mismatch on a soft mismatch (national crawler row with no exclusivity text)', () => {
  const opp = {
    title: 'Federal Capacity Building Grant',
    description: 'Funding to support program development.',
  }
  const result = evaluateApplicantTypeEligibility(opp, 'individual_need')
  assert.notEqual(result.decision, 'mismatch')
})
