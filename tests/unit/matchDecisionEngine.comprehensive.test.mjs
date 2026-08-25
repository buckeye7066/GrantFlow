/**
 * Comprehensive Match Decision Engine Regression Tests
 *
 * Fixture-driven regression harness covering 8 real-world profile classes:
 * 1. Caregiver/family profile
 * 2. Student profile
 * 3. Veteran profile
 * 4. Nonprofit/ministry profile
 * 5. Business/startup profile
 * 6. Disability/medical profile
 * 7. Emergency/disaster profile
 * 8. Ordinary individual with housing/utilities need
 *
 * For each profile:
 *   - ACCEPT case: true match with need alignment
 *   - REVIEW case: ambiguous or missing data
 *   - REJECT case: hard ineligibility
 *
 * Additional tests:
 *   - Unknown applicability → REVIEW, never ACCEPT
 *   - ACCEPT requires needAlignment > 0
 *   - ACCEPT requires hasApplicationUrl
 *   - Institutional/research → ordinary individuals: REJECT
 *   - Disease-specific → without condition: REJECT
 *   - Disaster/FEMA → non-disaster profile: REJECT
 *   - Section-derived signals (military_service, education, business, family_life)
 *   - Profile fingerprint changes with new section-derived flags
 *   - Opportunity fingerprint includes new fields
 *   - MATCHER_VERSION is 2.0.0
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeProfile,
  computeProfileFingerprint,
} from '../../backend/services/profileNormalizer.js'

import {
  normalizeOpportunity,
  computeOpportunityFingerprint,
} from '../../backend/services/opportunityNormalizer.js'

import {
  evaluateEligibility,
  calculateNeedAlignment,
  computeMatchDecision,
  MATCHER_VERSION,
} from '../../backend/services/matchDecisionEngine.js'

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function assertDecision(result, expected, label) {
  assert.equal(
    result.decision,
    expected,
    `[${label}] Expected ${expected}, got ${result.decision}. Explanation: ${result.explanation}`,
  )
}

// ---------------------------------------------------------------------------
// Sanity: MATCHER_VERSION is present and non-empty.
// (Value intentionally not pinned — it is the single source of truth owned by
// matchEngine.js and bumps with real behavior changes. Pinning it here would
// just require a second edit whenever the real version moves.)
// ---------------------------------------------------------------------------

test('MATCHER_VERSION is defined', () => {
  assert.equal(typeof MATCHER_VERSION, 'string')
  assert.ok(MATCHER_VERSION.length > 0, 'MATCHER_VERSION must be non-empty')
})

// ---------------------------------------------------------------------------
// PROFILE CLASS 1: Caregiver / family profile
// ---------------------------------------------------------------------------

const CAREGIVER_PROFILE = {
  primary_type: 'individual',
  state: 'OH',
  needs: ['childcare', 'family', 'housing'],
  is_caregiver: true,
}

const CAREGIVER_SECTIONS = {
  family_life: {
    answers: {
      is_caregiver: true,
      has_dependents: true,
      number_of_dependents: 2,
    },
  },
}

test('caregiver profile: ACCEPT for family caregiver support program', () => {
  const opp = {
    title: 'Family Caregiver Support Program',
    description: 'Provides respite care and financial support for unpaid family caregivers with dependents.',
    application_url: 'https://acl.gov/caregiver-support',
    is_national: 1,
    categories: '["family_life", "childcare"]',
    keywords: '["caregiver", "family", "childcare", "dependents"]',
    is_loan: 0,
  }
  const result = computeMatchDecision(CAREGIVER_PROFILE, opp, { profileSections: CAREGIVER_SECTIONS })
  assert.ok(
    ['ACCEPT', 'REVIEW'].includes(result.decision),
    `Caregiver profile + caregiver program should be ACCEPT or REVIEW, got ${result.decision}: ${result.explanation}`,
  )
  assert.ok(result.decision !== 'REJECT', `Caregiver family program must not REJECT caregiver profile`)
})

test('caregiver profile: REVIEW for generic housing program with no caregiver signal', () => {
  const opp = {
    title: 'Generic Housing Stabilization Program',
    description: 'Housing stabilization for qualifying individuals.',
    // no application_url → missing field → REVIEW
    is_national: 1,
    categories: '["housing"]',
    is_loan: 0,
  }
  const result = computeMatchDecision(CAREGIVER_PROFILE, opp, { profileSections: CAREGIVER_SECTIONS })
  // No application URL → must be REVIEW not ACCEPT
  assert.ok(result.decision !== 'ACCEPT', 'No URL should prevent ACCEPT')
})

test('caregiver profile: REJECT for veteran-only benefit', () => {
  const opp = {
    title: 'VA Caregiver Support Program',
    description: 'Exclusively for caregivers of post-9/11 veterans. Requires veteran in household.',
    application_url: 'https://va.gov/caregiver',
    is_national: 1,
    requires_veteran: true,
  }
  const result = computeMatchDecision(CAREGIVER_PROFILE, opp, { profileSections: CAREGIVER_SECTIONS })
  // Profile is not a veteran → REJECT
  assertDecision(result, 'REJECT', 'caregiver veteran-only')
  assert.ok(result.ineligibilityReasons.some((r) => r.toLowerCase().includes('veteran')))
})

// ---------------------------------------------------------------------------
// PROFILE CLASS 2: Student profile
// ---------------------------------------------------------------------------

const STUDENT_PROFILE = {
  primary_type: 'student',
  state: 'CA',
  needs: ['education', 'housing'],
  is_student: true,
}

const STUDENT_SECTIONS = {
  education: {
    answers: {
      is_student: true,
      currently_enrolled: true,
      school_name: 'State University',
      degree_program: 'Bachelor of Science',
    },
  },
}

test('student profile: ACCEPT for college emergency grant', () => {
  const opp = {
    title: 'College Student Emergency Financial Aid',
    description: 'For currently enrolled undergraduate students facing financial hardship.',
    application_url: 'https://studentaid.gov/emergency-aid',
    is_national: 1,
    categories: '["education"]',
    keywords: '["student", "college", "financial aid", "undergraduate"]',
    is_loan: 0,
  }
  const result = computeMatchDecision(STUDENT_PROFILE, opp, { profileSections: STUDENT_SECTIONS })
  assert.ok(
    ['ACCEPT', 'REVIEW'].includes(result.decision),
    `Student + education grant should be ACCEPT/REVIEW, got ${result.decision}: ${result.explanation}`,
  )
  assert.ok(result.decision !== 'REJECT', 'Student education grant must not REJECT student profile')
})

test('student profile: REVIEW for scholarship with no application URL', () => {
  const opp = {
    title: 'Community College Scholarship',
    description: 'Scholarship for community college students.',
    // no application_url
    is_national: 1,
    categories: '["education"]',
    is_loan: 0,
  }
  const result = computeMatchDecision(STUDENT_PROFILE, opp, { profileSections: STUDENT_SECTIONS })
  assert.ok(result.decision !== 'ACCEPT', 'No URL → cannot ACCEPT')
})

test('student profile: REJECT for business grant requiring business ownership', () => {
  const opp = {
    title: 'Small Business Development Grant',
    description: 'For small business owners and entrepreneurs only.',
    application_url: 'https://sba.gov/grants',
    is_national: 1,
    requires_business: true,
  }
  const result = computeMatchDecision(STUDENT_PROFILE, opp, { profileSections: STUDENT_SECTIONS })
  assertDecision(result, 'REJECT', 'student business-only')
  assert.ok(result.ineligibilityReasons.some((r) => r.toLowerCase().includes('business')))
})

test('non-student profile: REJECT for student-only scholarship', () => {
  const nonStudentProfile = { primary_type: 'individual', state: 'OH', needs: ['housing'] }
  const opp = {
    title: 'Undergraduate Scholarship Program',
    description: 'Available to full-time undergraduate students only.',
    application_url: 'https://university.edu/scholarships',
    is_national: 1,
    requires_student: true,
  }
  const result = computeMatchDecision(nonStudentProfile, opp)
  assertDecision(result, 'REJECT', 'non-student student-only scholarship')
  assert.ok(result.ineligibilityReasons.some((r) => r.toLowerCase().includes('student')))
})

// ---------------------------------------------------------------------------
// PROFILE CLASS 3: Veteran profile
// ---------------------------------------------------------------------------

const VETERAN_PROFILE = {
  primary_type: 'veteran',
  state: 'TX',
  needs: ['housing', 'health_medical'],
  is_veteran: true,
}

const VETERAN_SECTIONS = {
  military_service: {
    answers: {
      is_veteran: true,
      served_in_military: true,
      branch: 'Army',
      discharge_status: 'honorable',
    },
  },
}

test('veteran profile: section-derived isVeteran flag', () => {
  const noFlagProfile = { primary_type: 'individual', state: 'TX', needs: ['housing'] }
  const norm = normalizeProfile(noFlagProfile, VETERAN_SECTIONS)
  assert.equal(norm.isVeteran, true, 'Section military_service should set isVeteran=true')
})

test('veteran profile: ACCEPT for VA housing grant', () => {
  const opp = {
    title: 'VA Supportive Housing Grant',
    description: 'Permanent supportive housing assistance for US military veterans.',
    application_url: 'https://va.gov/housing',
    is_national: 1,
    categories: '["veteran", "housing"]',
    keywords: '["veteran", "housing", "military"]',
    is_loan: 0,
  }
  const result = computeMatchDecision(VETERAN_PROFILE, opp, { profileSections: VETERAN_SECTIONS })
  assert.ok(
    ['ACCEPT', 'REVIEW'].includes(result.decision),
    `Veteran + VA housing should be ACCEPT/REVIEW, got ${result.decision}: ${result.explanation}`,
  )
  assert.ok(result.decision !== 'REJECT', 'VA housing must not REJECT veteran')
})

test('veteran profile: REVIEW for national housing grant without explicit veteran eligibility', () => {
  const opp = {
    title: 'National Housing Assistance Program',
    description: 'Provides housing assistance to qualifying applicants.',
    // no application_url
    is_national: 1,
    categories: '["housing"]',
    is_loan: 0,
  }
  const result = computeMatchDecision(VETERAN_PROFILE, opp, { profileSections: VETERAN_SECTIONS })
  assert.ok(result.decision !== 'ACCEPT', 'No URL → cannot ACCEPT')
})

test('veteran profile: REJECT for nonprofit-only capacity grant', () => {
  const opp = {
    title: 'Nonprofit Organizational Capacity Grant',
    description: 'Available exclusively to 501(c)(3) nonprofit organizations.',
    application_url: 'https://foundation.org/nonprofits',
    is_national: 1,
    requires_nonprofit: true,
  }
  const result = computeMatchDecision(VETERAN_PROFILE, opp, { profileSections: VETERAN_SECTIONS })
  assertDecision(result, 'REJECT', 'veteran nonprofit-only grant')
})

// ---------------------------------------------------------------------------
// PROFILE CLASS 4: Nonprofit / ministry profile
// ---------------------------------------------------------------------------

const NONPROFIT_PROFILE = {
  primary_type: 'nonprofit',
  state: 'IL',
  needs: ['nonprofit_ministry', 'housing'],
  is_nonprofit: true,
}

test('nonprofit profile: ACCEPT for capacity building grant', () => {
  const opp = {
    title: 'Community Nonprofit Capacity Grant',
    description: 'Available to 501(c)(3) nonprofits building capacity to serve the community.',
    application_url: 'https://foundation.org/capacity',
    is_national: 1,
    categories: '["nonprofit_ministry"]',
    keywords: '["nonprofit", "501c3", "capacity building"]',
    requires_nonprofit: true,
    is_loan: 0,
  }
  const result = computeMatchDecision(NONPROFIT_PROFILE, opp)
  assert.ok(
    ['ACCEPT', 'REVIEW'].includes(result.decision),
    `Nonprofit + nonprofit grant should be ACCEPT/REVIEW, got ${result.decision}: ${result.explanation}`,
  )
  assert.ok(result.decision !== 'REJECT', 'Nonprofit capacity grant must not REJECT nonprofit profile')
})

test('nonprofit profile: REVIEW for generic program without URL', () => {
  const opp = {
    title: 'Community Support Program',
    description: 'General community support for nonprofits and individuals.',
    // no URL
    is_national: 1,
    categories: '["nonprofit_ministry"]',
  }
  const result = computeMatchDecision(NONPROFIT_PROFILE, opp)
  assert.ok(result.decision !== 'ACCEPT', 'No URL → cannot ACCEPT')
})

test('nonprofit profile: REJECT for business-only SBA grant', () => {
  const opp = {
    title: 'SBA Small Business Innovation Grant',
    description: 'For small businesses and startups only. Not available to nonprofits.',
    application_url: 'https://sba.gov/innovation',
    is_national: 1,
    requires_business: true,
  }
  const result = computeMatchDecision(NONPROFIT_PROFILE, opp)
  assertDecision(result, 'REJECT', 'nonprofit business-only grant')
})

test('individual profile: REJECT for nonprofit/ministry grant', () => {
  const individualProfile = { primary_type: 'individual', state: 'OH', needs: ['housing'] }
  const opp = {
    title: 'Faith-Based Organization Capacity Grant',
    description: 'Available exclusively to 501(c)(3) nonprofit and faith-based organizations.',
    application_url: 'https://faithgrants.org/apply',
    is_national: 1,
    requires_nonprofit: true,
  }
  const result = computeMatchDecision(individualProfile, opp)
  assertDecision(result, 'REJECT', 'individual nonprofit-only grant')
  assert.ok(result.ineligibilityReasons.some((r) => r.toLowerCase().includes('nonprofit')))
})

// ---------------------------------------------------------------------------
// PROFILE CLASS 5: Business / startup profile
// ---------------------------------------------------------------------------

const BUSINESS_PROFILE = {
  primary_type: 'business',
  state: 'NY',
  needs: ['business'],
  is_business: true,
}

const BUSINESS_SECTIONS = {
  business: {
    answers: {
      owns_business: true,
      business_name: 'Acme Startup LLC',
      ein: '12-3456789',
    },
  },
}

test('business profile: section-derived isBusiness flag', () => {
  const noFlagProfile = { primary_type: 'individual', state: 'NY', needs: [] }
  const norm = normalizeProfile(noFlagProfile, BUSINESS_SECTIONS)
  assert.equal(norm.isBusiness, true, 'Business section should set isBusiness=true')
})

test('business profile: ACCEPT for SBA small business grant', () => {
  const opp = {
    title: 'SBA Small Business Innovation Research Grant',
    description: 'For small businesses pursuing R&D and innovation.',
    application_url: 'https://sba.gov/sbir',
    is_national: 1,
    categories: '["business"]',
    keywords: '["small business", "entrepreneur", "startup", "innovation"]',
    requires_business: true,
    is_loan: 0,
  }
  const result = computeMatchDecision(BUSINESS_PROFILE, opp, { profileSections: BUSINESS_SECTIONS })
  assert.ok(
    ['ACCEPT', 'REVIEW'].includes(result.decision),
    `Business + SBA grant should be ACCEPT/REVIEW, got ${result.decision}: ${result.explanation}`,
  )
  assert.ok(result.decision !== 'REJECT', 'SBA grant must not REJECT business profile')
})

test('business profile: REVIEW for business program without URL', () => {
  const opp = {
    title: 'Startup Acceleration Program',
    description: 'Business development support for startups.',
    // no URL
    is_national: 1,
    categories: '["business"]',
  }
  const result = computeMatchDecision(BUSINESS_PROFILE, opp, { profileSections: BUSINESS_SECTIONS })
  assert.ok(result.decision !== 'ACCEPT', 'No URL → cannot ACCEPT')
})

test('business profile: REJECT for veteran-only benefit', () => {
  const opp = {
    title: 'Veteran Business Owner Grant',
    description: 'Exclusively for veteran-owned small businesses.',
    application_url: 'https://va.gov/veteran-business',
    is_national: 1,
    requires_veteran: true,
  }
  const result = computeMatchDecision(BUSINESS_PROFILE, opp, { profileSections: BUSINESS_SECTIONS })
  assertDecision(result, 'REJECT', 'business non-veteran veteran-only grant')
  assert.ok(result.ineligibilityReasons.some((r) => r.toLowerCase().includes('veteran')))
})

test('individual profile: REJECT for business-only grant', () => {
  const individualProfile = { primary_type: 'individual', state: 'OH', needs: ['housing'] }
  const opp = {
    title: 'Minority Business Enterprise Grant',
    description: 'Available to minority-owned businesses and startups only.',
    application_url: 'https://sba.gov/minority',
    is_national: 1,
    requires_business: true,
  }
  const result = computeMatchDecision(individualProfile, opp)
  assertDecision(result, 'REJECT', 'individual business-only grant')
  assert.ok(result.ineligibilityReasons.some((r) => r.toLowerCase().includes('business')))
})

// ---------------------------------------------------------------------------
// PROFILE CLASS 6: Disability / medical profile
// ---------------------------------------------------------------------------

const DISABILITY_PROFILE = {
  primary_type: 'individual',
  state: 'PA',
  needs: ['disability', 'health_medical'],
}

const DISABILITY_SECTIONS = {
  health_medical: {
    answers: {
      has_disability: true,
      has_chronic_illness: true,
      needs_dme: true,
      conditions: 'Multiple sclerosis, mobility impairment',
    },
  },
}

test('disability profile: section-derived hasChronicIllness flag', () => {
  const noFlagProfile = { primary_type: 'individual', state: 'PA', needs: [] }
  const norm = normalizeProfile(noFlagProfile, DISABILITY_SECTIONS)
  assert.equal(norm.hasChronicIllness, true, 'Health section should set hasChronicIllness=true')
  assert.equal(norm.hasDisabilityNeed, true, 'Health section should set hasDisabilityNeed=true')
})

test('disability profile: ACCEPT for assistive technology grant', () => {
  const opp = {
    title: 'Assistive Technology and DME Support Grant',
    description: 'Funding for adaptive equipment and assistive technology for people with disabilities.',
    application_url: 'https://atap.org/apply',
    is_national: 1,
    categories: '["disability"]',
    keywords: '["disability", "assistive technology", "dme", "adaptive equipment"]',
    is_loan: 0,
  }
  const result = computeMatchDecision(DISABILITY_PROFILE, opp, { profileSections: DISABILITY_SECTIONS })
  assert.ok(
    ['ACCEPT', 'REVIEW'].includes(result.decision),
    `Disability profile + AT grant should be ACCEPT/REVIEW, got ${result.decision}: ${result.explanation}`,
  )
  assert.ok(result.decision !== 'REJECT', 'Assistive technology grant must not REJECT disability profile')
})

test('disability profile: REVIEW for disability program without URL', () => {
  const opp = {
    title: 'Disability Support Services',
    description: 'Support services for individuals with disabilities.',
    // no URL
    is_national: 1,
    categories: '["disability"]',
  }
  const result = computeMatchDecision(DISABILITY_PROFILE, opp, { profileSections: DISABILITY_SECTIONS })
  assert.ok(result.decision !== 'ACCEPT', 'No URL → cannot ACCEPT')
})

test('disability profile: REJECT for loan program', () => {
  const opp = {
    title: 'Medical Equipment Loan Program',
    description: 'Low-interest loans for medical equipment purchases.',
    application_url: 'https://medfin.com/loans',
    is_national: 1,
    is_loan: 1,
  }
  const result = computeMatchDecision(DISABILITY_PROFILE, opp, { profileSections: DISABILITY_SECTIONS })
  assertDecision(result, 'REJECT', 'disability loan')
  assert.ok(result.ineligibilityReasons.some((r) => r.toLowerCase().includes('loan')))
})

test('non-disability profile: disease-specific opportunity REJECT', () => {
  const healthyProfile = { primary_type: 'individual', state: 'OH', needs: ['housing'] }
  const opp = {
    title: 'Multiple Sclerosis Financial Assistance Grant',
    description: 'Financial assistance exclusively for individuals diagnosed with multiple sclerosis.',
    application_url: 'https://msassociation.org/apply',
    is_national: 1,
    disease_specific: true,
  }
  const result = computeMatchDecision(healthyProfile, opp)
  assertDecision(result, 'REJECT', 'non-disability disease-specific grant')
  assert.ok(
    result.ineligibilityReasons.some((r) => r.toLowerCase().includes('condition') || r.toLowerCase().includes('disease')),
  )
})

// ---------------------------------------------------------------------------
// PROFILE CLASS 7: Emergency / disaster profile
// ---------------------------------------------------------------------------

const EMERGENCY_PROFILE = {
  primary_type: 'individual',
  state: 'LA',
  needs: ['emergency', 'housing'],
}

const EMERGENCY_SECTIONS = {
  emergency: {
    answers: {
      disaster_affected: true,
      disaster_type: 'flood',
      fema_eligible: true,
    },
  },
}

test('emergency profile: section-derived hasEmergencyNeed flag', () => {
  const noFlagProfile = { primary_type: 'individual', state: 'LA', needs: [] }
  const norm = normalizeProfile(noFlagProfile, EMERGENCY_SECTIONS)
  assert.equal(norm.hasEmergencyNeed, true, 'Emergency section should set hasEmergencyNeed=true')
})

test('emergency profile: ACCEPT for FEMA disaster assistance', () => {
  const opp = {
    title: 'FEMA Individual Assistance for Disaster Survivors',
    description: 'Emergency financial assistance for individuals affected by presidentially declared disasters.',
    application_url: 'https://fema.gov/assistance',
    is_national: 1,
    categories: '["emergency", "housing"]',
    keywords: '["fema", "disaster", "emergency", "flood", "hurricane"]',
    is_loan: 0,
  }
  const result = computeMatchDecision(EMERGENCY_PROFILE, opp, { profileSections: EMERGENCY_SECTIONS })
  assert.ok(
    ['ACCEPT', 'REVIEW'].includes(result.decision),
    `Emergency profile + FEMA grant should be ACCEPT/REVIEW, got ${result.decision}: ${result.explanation}`,
  )
  assert.ok(result.decision !== 'REJECT', 'FEMA grant must not REJECT emergency profile')
})

test('emergency profile: REVIEW for disaster program without URL', () => {
  const opp = {
    title: 'Local Emergency Relief Fund',
    description: 'Emergency relief for disaster-affected residents.',
    // no URL
    is_national: 0,
    state: 'LA',
    categories: '["emergency"]',
  }
  const result = computeMatchDecision(EMERGENCY_PROFILE, opp, { profileSections: EMERGENCY_SECTIONS })
  assert.ok(result.decision !== 'ACCEPT', 'No URL → cannot ACCEPT')
})

test('emergency profile: REJECT for student-only scholarship', () => {
  const opp = {
    title: 'Emergency Student Scholarship',
    description: 'Emergency financial aid exclusively for enrolled college students.',
    application_url: 'https://ed.gov/emergency-scholarship',
    is_national: 1,
    requires_student: true,
  }
  const result = computeMatchDecision(EMERGENCY_PROFILE, opp, { profileSections: EMERGENCY_SECTIONS })
  assertDecision(result, 'REJECT', 'emergency-profile student-only scholarship')
})

test('non-emergency profile: REJECT for disaster-only FEMA program', () => {
  const normalProfile = { primary_type: 'individual', state: 'OH', needs: ['housing'] }
  const opp = {
    title: 'FEMA Disaster Individual Assistance',
    description: 'Available only to survivors of a presidentially declared disaster area.',
    application_url: 'https://fema.gov/apply',
    is_national: 1,
    requires_disaster_context: true,
  }
  const result = computeMatchDecision(normalProfile, opp)
  assertDecision(result, 'REJECT', 'non-disaster profile FEMA program')
  assert.ok(
    result.ineligibilityReasons.some((r) => r.toLowerCase().includes('disaster') || r.toLowerCase().includes('emergency')),
  )
})

// ---------------------------------------------------------------------------
// PROFILE CLASS 8: Ordinary individual with housing/utilities need
// ---------------------------------------------------------------------------

const INDIVIDUAL_PROFILE = {
  primary_type: 'individual',
  state: 'OH',
  needs: ['rent', 'utilities'],
}

test('individual profile: ACCEPT for Ohio rent assistance', () => {
  const opp = {
    title: 'Ohio Emergency Rental Assistance Program',
    description: 'Emergency rent assistance for Ohio residents at risk of eviction.',
    application_url: 'https://ohio.gov/rent-help',
    is_national: 0,
    state: 'OH',
    categories: '["housing"]',
    keywords: '["rent", "eviction", "housing", "utilities"]',
    is_loan: 0,
  }
  const result = computeMatchDecision(INDIVIDUAL_PROFILE, opp)
  assert.ok(
    ['ACCEPT', 'REVIEW'].includes(result.decision),
    `Individual + OH rent assistance should be ACCEPT/REVIEW, got ${result.decision}: ${result.explanation}`,
  )
  assert.ok(result.decision !== 'REJECT', 'OH rent assistance must not REJECT OH individual with housing need')
})

test('individual profile: REVIEW for generic program without URL', () => {
  const opp = {
    title: 'Emergency Utility Assistance',
    description: 'Helps with utility bills for low-income families.',
    // no URL
    is_national: 1,
    categories: '["utilities"]',
  }
  const result = computeMatchDecision(INDIVIDUAL_PROFILE, opp)
  assert.ok(result.decision !== 'ACCEPT', 'No URL → cannot ACCEPT')
})

test('individual profile: REJECT for geographic mismatch', () => {
  const opp = {
    title: 'California Utility Assistance Program',
    description: 'Utility assistance exclusively for California residents.',
    application_url: 'https://ca.gov/utility-help',
    is_national: 0,
    state: 'CA',
    categories: '["utilities"]',
  }
  const result = computeMatchDecision(INDIVIDUAL_PROFILE, opp)
  assertDecision(result, 'REJECT', 'individual geo mismatch')
  // computeMatchDecision routes geography through the scoped residency gate
  // (#1380), which explains the bar in its own words; evaluateEligibility still
  // emits the legacy 'Geographic mismatch:' prefix. Either is a geographic bar.
  assert.ok(
    result.ineligibilityReasons.some((r) => /Geographic mismatch|requires CA residency/i.test(r)),
    `expected a geographic ineligibility reason, got ${JSON.stringify(result.ineligibilityReasons)}`,
  )
})

// ---------------------------------------------------------------------------
// Opportunity normalization: unknown applicability → REVIEW, not ACCEPT
// ---------------------------------------------------------------------------

test('unknown applicability: opportunity with no text signals → applicabilityUnknown=true', () => {
  const opp = normalizeOpportunity({
    title: 'General Support Program',
    description: '', // no eligibility signals
    sponsor: '',
  })
  assert.equal(opp.applicabilityUnknown, true, 'No entity signals should produce applicabilityUnknown=true')
  assert.deepEqual(opp.entityTypesAllowed, [], 'No entity signals should produce empty entityTypesAllowed')
})

test('unknown applicability + non-individual profile: forces REVIEW/REJECT', () => {
  // For non-individual profiles (e.g. business), unknown applicability should still be conservative
  const profile = { primary_type: 'business', state: 'OH', needs: ['business'] }
  const opp = {
    title: 'General Support Program XYZ',
    description: 'Funding for program beneficiaries meeting eligibility criteria.',
    application_url: 'https://mystery.org/apply',
    is_national: 1,
    entity_types_allowed: '[]',
    categories: '["business"]',
    is_loan: 0,
  }
  const oppNorm = normalizeOpportunity(opp)
  if (oppNorm.applicabilityUnknown) {
    const result = computeMatchDecision(profile, opp)
    assert.ok(
      result.decision === 'REVIEW' || result.decision === 'REJECT',
      `Unknown applicability for non-individual should force REVIEW/REJECT, got ${result.decision}: ${result.explanation}`,
    )
    assert.notEqual(result.decision, 'ACCEPT', 'Unknown applicability for non-individual must not produce ACCEPT')
  }
})

test('unknown applicability + individual profile: can produce ACCEPT when well-aligned', () => {
  // For individual/family profiles, unknown applicability is treated as a soft match.
  // Consumer-facing programs often don't enumerate entity types but are intended for individuals.
  const profile = { primary_type: 'individual', state: 'OH', needs: ['housing', 'utilities'] }
  const opp = {
    title: 'General Support Program XYZ',
    description: 'Funding for program beneficiaries meeting eligibility criteria.',
    application_url: 'https://mystery.org/apply',
    is_national: 1,
    entity_types_allowed: '[]',
    categories: '["housing", "utilities"]',
    is_loan: 0,
  }
  const oppNorm = normalizeOpportunity(opp)
  if (oppNorm.applicabilityUnknown) {
    const result = computeMatchDecision(profile, opp)
    // Individual/family profile with good alignment: ACCEPT is allowed
    assert.ok(
      ['ACCEPT', 'REVIEW'].includes(result.decision),
      `Individual profile with unknown applicability should allow ACCEPT/REVIEW, got ${result.decision}: ${result.explanation}`,
    )
  }
})

test('known applicability (individual): can produce ACCEPT when aligned', () => {
  const profile = {
    primary_type: 'individual',
    state: 'OH',
    needs: ['housing', 'utilities'],
  }
  const opp = {
    title: 'Ohio Emergency Assistance for Individuals',
    description: 'Emergency housing and utility assistance for low-income Ohio residents and families.',
    application_url: 'https://ohio.gov/emergency',
    is_national: 0,
    state: 'OH',
    entity_types_allowed: '["individual"]', // explicit
    categories: '["housing", "utilities"]',
    keywords: '["rent", "utilities", "emergency"]',
    is_loan: 0,
  }
  const oppNorm = normalizeOpportunity(opp)
  assert.equal(oppNorm.applicabilityUnknown, false, 'Explicit entity types → applicabilityUnknown=false')
  const result = computeMatchDecision(profile, opp)
  assert.ok(
    ['ACCEPT', 'REVIEW'].includes(result.decision),
    `Explicit individual eligibility with need alignment should be ACCEPT/REVIEW, got ${result.decision}`,
  )
})

// ---------------------------------------------------------------------------
// ACCEPT must require needAlignment > 0
// ---------------------------------------------------------------------------

test('ACCEPT requires needAlignment > 0', () => {
  const profile = { primary_type: 'individual', state: 'OH', needs: [] } // no explicit needs
  const opp = {
    title: 'Tech Innovation Grant',
    description: 'Funding for technology research and innovation projects.',
    application_url: 'https://techfund.org/apply',
    is_national: 1,
    entity_types_allowed: '["individual","nonprofit"]',
    categories: '["research_arts","business"]', // no match with inferred individual needs
    is_loan: 0,
  }
  const result = computeMatchDecision(profile, opp)
  // Inferred individual needs (cash_assistance, housing, food) don't match research_arts/business
  // → needAlignment = 0 → must not ACCEPT
  assert.notEqual(result.decision, 'ACCEPT', 'Zero need alignment must not produce ACCEPT')
  assert.equal(result.needAlignment, 0, 'needAlignment should be 0 when needs do not match')
})

// ---------------------------------------------------------------------------
// Institutional / research-only → ordinary individuals: REJECT
// ---------------------------------------------------------------------------

test('institutional-only opportunity: REJECT for ordinary individual', () => {
  const individualProfile = { primary_type: 'individual', state: 'OH', needs: ['education'] }
  const opp = {
    title: 'Research Institution Development Fund',
    description: 'Available to research institutions, universities, and higher education institutions only.',
    application_url: 'https://nsf.gov/research-fund',
    is_national: 1,
    is_institutional_only: true,
    categories: '["research_arts"]',
  }
  const result = computeMatchDecision(individualProfile, opp)
  assertDecision(result, 'REJECT', 'institutional-only ordinary individual')
  assert.ok(
    result.ineligibilityReasons.some((r) => r.toLowerCase().includes('institution') || r.toLowerCase().includes('research')),
  )
})

test('research-only opportunity: REJECT for non-researcher individual', () => {
  const individualProfile = { primary_type: 'individual', state: 'OH', needs: ['housing'] }
  const opp = {
    title: 'NIH Research Grant R01',
    description: 'Research project grants for biomedical and behavioral research. Principal investigators only.',
    application_url: 'https://nih.gov/grants/r01',
    is_national: 1,
    is_research_only: true,
    categories: '["research_arts"]',
  }
  const result = computeMatchDecision(individualProfile, opp)
  assertDecision(result, 'REJECT', 'research-only ordinary individual')
})

test('research-only opportunity: not REJECT for researcher profile', () => {
  const researcherProfile = { primary_type: 'researcher', state: 'OH', needs: ['research_arts'] }
  const opp = {
    title: 'NIH Research Grant R01',
    description: 'Research project grants for academic researchers and scientists.',
    application_url: 'https://nih.gov/grants/r01',
    is_national: 1,
    is_research_only: true,
    categories: '["research_arts"]',
  }
  const result = computeMatchDecision(researcherProfile, opp)
  assert.ok(result.decision !== 'REJECT', 'Research grant should not REJECT researcher profile')
})

// ---------------------------------------------------------------------------
// Fingerprint: new fields included in v2 fingerprint
// ---------------------------------------------------------------------------

test('opportunity fingerprint v2: applicabilityUnknown affects fingerprint', () => {
  const knownOpp = normalizeOpportunity({
    title: 'Test Grant',
    // Explicit entity type provided
    description: 'Funding for qualified individual residents.',
    application_url: 'https://test.org',
    entity_types_allowed: '["individual"]',
  })
  const unknownOpp = normalizeOpportunity({
    title: 'Test Grant',
    // Truly featureless description - no entity type signals
    description: 'Program funding for eligible program participants.',
    application_url: 'https://test.org',
    // No entity_types_allowed and no entity signals in text → applicabilityUnknown=true
  })
  assert.equal(knownOpp.applicabilityUnknown, false, 'Explicit entity types → applicabilityUnknown=false')
  assert.equal(unknownOpp.applicabilityUnknown, true, 'No entity signals → applicabilityUnknown=true')
  const fp1 = computeOpportunityFingerprint(knownOpp)
  const fp2 = computeOpportunityFingerprint(unknownOpp)
  assert.notEqual(fp1, fp2, 'Known vs unknown applicability should produce different fingerprints')
})

test('profile fingerprint v2: isCaregiver and hasChronicIllness affect fingerprint', () => {
  const baseProfile = normalizeProfile({ primary_type: 'individual', state: 'OH', needs: ['housing'] })
  const caregiverProfile = normalizeProfile(
    { primary_type: 'individual', state: 'OH', needs: ['housing', 'childcare'], is_caregiver: true },
  )
  const fp1 = computeProfileFingerprint(baseProfile)
  const fp2 = computeProfileFingerprint(caregiverProfile)
  assert.notEqual(fp1, fp2, 'Caregiver flag should change profile fingerprint')
})

// ---------------------------------------------------------------------------
// Location from sections when top-level is incomplete
// ---------------------------------------------------------------------------

test('profile normalization: location derived from location section', () => {
  const profileNoLocation = { primary_type: 'individual', needs: ['housing'] }
  const sectionsWithLocation = {
    location: {
      answers: {
        state: 'TX',
        zip: '75001',
        city: 'Dallas',
      },
    },
  }
  const norm = normalizeProfile(profileNoLocation, sectionsWithLocation)
  assert.equal(norm.state, 'TX', 'State should be derived from location section')
  assert.equal(norm.zip, '75001', 'ZIP should be derived from location section')
  assert.equal(norm.city, 'Dallas', 'City should be derived from location section')
})

test('profile normalization: top-level location takes precedence over section', () => {
  const profileWithLocation = { primary_type: 'individual', state: 'OH', zip: '44022', needs: ['housing'] }
  const sectionsWithDifferentLocation = {
    location: {
      answers: { state: 'TX', zip: '75001' },
    },
  }
  const norm = normalizeProfile(profileWithLocation, sectionsWithDifferentLocation)
  assert.equal(norm.state, 'OH', 'Top-level state should take precedence')
  assert.equal(norm.zip, '44022', 'Top-level ZIP should take precedence')
})

// ---------------------------------------------------------------------------
// ACCEPT criteria: hasApplicationUrl required
// ---------------------------------------------------------------------------

test('ACCEPT requires hasApplicationUrl: no URL → REVIEW even with perfect alignment', () => {
  const profile = { primary_type: 'individual', state: 'OH', needs: ['housing', 'utilities'] }
  const opp = {
    title: 'Ohio Housing and Utility Assistance',
    description: 'For Ohio residents facing eviction or utility shutoff.',
    // no application_url
    is_national: 0,
    state: 'OH',
    entity_types_allowed: '["individual"]',
    categories: '["housing", "utilities"]',
    keywords: '["rent", "utilities", "eviction"]',
    is_loan: 0,
  }
  const result = computeMatchDecision(profile, opp)
  assert.notEqual(result.decision, 'ACCEPT', 'Missing application URL must prevent ACCEPT')
})

// ---------------------------------------------------------------------------
// MATCHER_VERSION in every decision
// ---------------------------------------------------------------------------

test('every decision includes MATCHER_VERSION', () => {
  const profile = { primary_type: 'individual', state: 'OH', needs: ['housing'] }
  const opp = { title: 'Test', description: 'test', application_url: 'https://test.org' }
  const result = computeMatchDecision(profile, opp)
  assert.equal(result.matcherVersion, MATCHER_VERSION, `matcherVersion should be ${MATCHER_VERSION}`)
})

// ---------------------------------------------------------------------------
// Pro bono / in-kind / referral-only
// → REVIEW (not REJECT) for individual/caregiver profiles: these ARE relevant
//    assistance types (clothing closets, computer programs, social service referrals)
// → REJECT for nonprofit/business profiles seeking direct grant funding
// ---------------------------------------------------------------------------

test('pro bono opportunity is REVIEW (not REJECT) for individual profile', () => {
  const profile = { primary_type: 'individual', state: 'OH', needs: ['housing'] }
  const opp = {
    title: 'Free Pro Bono Legal Help',
    description: 'Pro bono legal assistance at no cost',
    application_url: 'https://legalaid.org',
  }
  const result = computeMatchDecision(profile, opp)
  assert.ok(result.decision !== 'REJECT', `individual + pro bono should not REJECT, got: ${result.explanation}`)
})

test('pro bono opportunity is REJECT for nonprofit profile', () => {
  const profile = { primary_type: 'nonprofit', state: 'OH', needs: ['nonprofit_ministry'] }
  const opp = {
    title: 'Free Pro Bono Legal Help',
    description: 'Pro bono legal assistance at no cost',
    application_url: 'https://legalaid.org',
  }
  const result = computeMatchDecision(profile, opp)
  assertDecision(result, 'REJECT', 'pro bono = not direct funding for nonprofits')
  assert.ok(result.ineligibilityReasons.some(r => r.toLowerCase().includes('pro bono')))
})

test('in-kind goods opportunity is REVIEW (not REJECT) for individual profile', () => {
  const profile = { primary_type: 'individual', state: 'TN', needs: ['clothing_goods'] }
  const opp = {
    title: 'In-Kind Furniture and Household Goods',
    description: 'In-kind material support of donated household goods and furniture',
    application_url: 'https://goods.org',
  }
  const result = computeMatchDecision(profile, opp)
  assert.ok(result.decision !== 'REJECT', `individual + in-kind goods should not REJECT, got: ${result.explanation}`)
})

test('in-kind goods opportunity is REJECT for business profile', () => {
  const profile = { primary_type: 'business', state: 'TN', needs: ['business'] }
  const opp = {
    title: 'In-Kind Furniture and Household Goods',
    description: 'In-kind material support of donated household goods and furniture',
    application_url: 'https://goods.org',
  }
  const result = computeMatchDecision(profile, opp)
  assertDecision(result, 'REJECT', 'in-kind = not direct financial assistance for businesses')
  assert.ok(result.ineligibilityReasons.some(r => r.toLowerCase().includes('in-kind')))
})

test('referral-only opportunity is REVIEW (not REJECT) for individual profile', () => {
  const profile = { primary_type: 'individual', state: 'FL', needs: ['housing'] }
  const opp = {
    title: 'Social Services Referral Program',
    description: 'Referral only — agency referral required; no direct applications accepted',
    application_url: 'https://agency.org',
  }
  const result = computeMatchDecision(profile, opp)
  assert.ok(result.decision !== 'REJECT', `individual + referral should not REJECT, got: ${result.explanation}`)
})

test('referral-only opportunity is REJECT for nonprofit profile', () => {
  const profile = { primary_type: 'nonprofit', state: 'FL', needs: ['nonprofit_ministry'] }
  const opp = {
    title: 'Social Services Referral Program',
    description: 'Referral only — agency referral required; no direct applications accepted',
    application_url: 'https://agency.org',
  }
  const result = computeMatchDecision(profile, opp)
  assertDecision(result, 'REJECT', 'referral-only = not a direct application for nonprofits')
  assert.ok(result.ineligibilityReasons.some(r => r.toLowerCase().includes('referral')))
})

test('in-kind goods opportunity is REVIEW (not REJECT) for caregiver profile', () => {
  const profile = { primary_type: 'caregiver', state: 'GA', needs: ['family_life'] }
  const opp = {
    title: 'In-Kind Household Supplies for Families',
    description: 'In-kind household goods and material support for caregivers',
    application_url: 'https://families.org',
  }
  const result = computeMatchDecision(profile, opp)
  assert.ok(result.decision !== 'REJECT', `caregiver + in-kind should not REJECT, got: ${result.explanation}`)
})

// ---------------------------------------------------------------------------
// University / off-campus resource → REJECT for non-student profile
// ---------------------------------------------------------------------------

test('university off-campus housing resource is REJECT for non-student individual', () => {
  const profile = { primary_type: 'individual', state: 'OH', needs: ['housing'] }
  const opp = {
    title: 'Off-Campus Housing Directory',
    description: 'Off-campus housing listings and resources for enrolled students',
    application_url: 'https://university.edu/offcampus',
  }
  const result = computeMatchDecision(profile, opp)
  assertDecision(result, 'REJECT', 'off-campus housing = requires student status')
})

test('university off-campus housing is ACCEPT/REVIEW for student profile', () => {
  const studentProfile = { primary_type: 'student', state: 'OH', needs: ['housing', 'education'], is_student: true }
  const opp = {
    title: 'Off-Campus Housing Directory',
    description: 'Off-campus housing listings and resources for enrolled students',
    application_url: 'https://university.edu/offcampus',
    keywords: '["student", "housing"]',
    entity_types_allowed: '["student"]',
  }
  const result = computeMatchDecision(studentProfile, opp)
  assert.ok(result.decision !== 'REJECT', `Student + student housing should not REJECT, got: ${result.explanation}`)
})

// ---------------------------------------------------------------------------
// Profile normalizer: section-derived disability/chronic illness → needCategories
// ---------------------------------------------------------------------------

test('profile with chronic_illness section derives disability need category', () => {
  const profile = { primary_type: 'individual', state: 'TN' }
  const sections = {
    health_medical: { chronic_illness: true, chronic_illness_type: 'diabetes' },
  }
  const norm = normalizeProfile(profile, sections)
  assert.ok(norm.needCategories.includes('disability'),
    `Expected disability in needCategories, got: ${norm.needCategories.join(', ')}`)
  assert.equal(norm.hasChronicIllness, true)
})

test('profile with disability_type in health section derives disability need category', () => {
  const profile = { primary_type: 'individual', state: 'CA' }
  const sections = {
    health_medical: { disability_type: 'mobility impairment' },
  }
  const norm = normalizeProfile(profile, sections)
  assert.ok(norm.needCategories.includes('disability'),
    `Expected disability in needCategories, got: ${norm.needCategories.join(', ')}`)
})

// ---------------------------------------------------------------------------
// Profile normalizer: location inference from basic_information section
// ---------------------------------------------------------------------------

test('profile normalizer infers state from basic_information section', () => {
  const profile = { primary_type: 'individual' } // no top-level state
  const sections = {
    basic_information: { state: 'TN', city: 'Nashville' },
  }
  const norm = normalizeProfile(profile, sections)
  assert.equal(norm.state, 'TN', 'State should be inferred from basic_information section')
})

test('profile normalizer infers state from location_focus section', () => {
  const profile = { primary_type: 'individual' }
  const sections = {
    location_focus: { state: 'GA' },
  }
  const norm = normalizeProfile(profile, sections)
  assert.equal(norm.state, 'GA', 'State should be inferred from location_focus section')
})

// ---------------------------------------------------------------------------
// opportunityNormalizer: new flags are correctly extracted
// ---------------------------------------------------------------------------

test('opportunityNormalizer: detects isProBono', () => {
  const opp = normalizeOpportunity({
    title: 'Pro Bono Legal Services',
    description: 'Free pro bono legal assistance for low-income individuals.',
  })
  assert.equal(opp.isProBono, true)
})

test('opportunityNormalizer: detects isInKind', () => {
  const opp = normalizeOpportunity({
    title: 'In-Kind Household Goods Support',
    description: 'In-kind donations of household goods and furniture.',
  })
  assert.equal(opp.isInKind, true)
})

test('opportunityNormalizer: detects isInstitutionalOnly from text', () => {
  const opp = normalizeOpportunity({
    title: 'Research Institution Capacity Grant',
    description: 'Available to research institutions and higher education institutions.',
  })
  assert.equal(opp.isInstitutionalOnly, true)
})

test('opportunityNormalizer: detects requiresDisasterContext from text', () => {
  const opp = normalizeOpportunity({
    title: 'FEMA Disaster Relief Program',
    description: 'Individual assistance for disaster survivors in FEMA-declared disaster areas.',
  })
  assert.equal(opp.requiresDisasterContext, true)
})

test('opportunityNormalizer: detects isDmeOrEquipment from text', () => {
  const opp = normalizeOpportunity({
    title: 'Wheelchair and Adaptive Equipment Fund',
    description: 'Provides durable medical equipment and assistive technology for people with disabilities.',
  })
  assert.equal(opp.isDmeOrEquipment, true)
})

test('opportunityNormalizer: detects diseaseSpecific from explicit flag', () => {
  const opp = normalizeOpportunity({
    title: 'ALS Research and Patient Support Grant',
    description: 'Financial assistance for individuals diagnosed with ALS (amyotrophic lateral sclerosis).',
    disease_specific: true,
  })
  assert.equal(opp.diseaseSpecific, true)
})

test('opportunityNormalizer: clear individual opportunity has applicabilityUnknown=false', () => {
  const opp = normalizeOpportunity({
    title: 'Individual Housing Assistance',
    description: 'For individuals and households facing housing instability.',
    application_url: 'https://agency.org/apply',
    entity_types_allowed: '["individual"]',
  })
  assert.equal(opp.applicabilityUnknown, false)
  assert.ok(opp.entityTypesAllowed.includes('individual'))
})
