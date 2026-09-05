/**
 * 2026-09-05 live crawl for a real 18-year-old Tennessee student: resources and
 * benefits that positively exclude the profile (survivor benefits, the Iraq &
 * Afghanistan Service Grant, an aging-services locator, foreclosure counseling,
 * homeschool grants) were STORED at REVIEW because the policy's resource branch
 * skipped every population rule. A resource is still a claim that THIS profile
 * can use it, so it is held to the same positive-fact rules as a direct award.
 * Silence stays neutral: a profile that states no age, housing, or school keeps
 * every resource.
 */
import { describe, expect, it } from 'vitest'
import { evaluateNeedFirstMatchPolicy } from '../services/matching/needFirstMatchPolicy.js'

const studentNorm = {
  isStudent: true,
  entityType: 'student',
  education: { intendedMajor: 'Forensic Science' },
  academics: { gpa: 3.84 },
  needCategories: ['education'],
  effectiveFacets: ['student', 'individual'],
}

const liveStudentContext = {
  profile: { id: 'live_tn_student', primary_type: 'student' },
  sections: {
    basic_information: { date_of_birth: '2008-07-19', state: 'TN', city: 'Cleveland' },
    education: {
      current_institution: 'Middle Tennessee State University',
      intended_major: 'Forensic Science',
      schools: { name: 'Cleveland State Community College', type: 'Community College' },
    },
    university_applications: { applications: [{ name: 'Middle Tennessee State University', status: 'committed' }] },
    housing: { status: 'With family', type: 'Rural' },
    family_life: { caregiver: true, orphan: false, foster_youth: false, homeless: false },
    military_service: { veteran: false, gold_star_family: false },
    occupation: {},
    demographics: { age_group: 'Youth' },
  },
}

function livePolicyFor(opportunity, points = [], context = liveStudentContext, norm = { ...studentNorm, isCaregiver: true }) {
  return evaluateNeedFirstMatchPolicy({
    profileContext: context,
    profileNorm: norm,
    opportunity,
    dataPointEval: { matched: points, credit: points.length },
    matchedNeeds: ['education'],
  })
}

describe('resources and benefits are held to the positive population rules', () => {
  it.each([
    ['Social Security survivors benefits', 'benefit',
      'Survivor benefits from Social Security for widows, widowers, and children of a deceased worker.'],
    ['Iraq and Afghanistan Service Grant', 'benefit',
      'For students whose parent or guardian died as a result of military service in Iraq or Afghanistan after 9/11.'],
    ['Area Agency on Aging & Eldercare Locator', 'DIRECTORY',
      'Find local aging services for older adults age 60 and older through your Area Agency on Aging.'],
    ['Avoid foreclosure — free HUD-approved housing counseling', 'benefit',
      'Free counseling for homeowners facing foreclosure or struggling with mortgage payments.'],
    ['HSLDA Compassion Grants (homeschool families)', 'DIRECT_GRANT',
      'Grants for homeschooling families facing financial hardship.'],
    // Live phrasings from the 2026-09-05 crawl that the first rule set missed.
    ['Scholarships and grants for youth from foster care', 'DIRECT_GRANT',
      'Direct scholarships and grants for young people who spent their teen years in foster care: college scholarships, Education & Training Voucher administration, and student support funds.'],
    ['Social Security survivors benefits', 'benefit',
      'Official Social Security survivor-benefits information for eligible surviving spouses, children, and families. This is a benefits lane, not a grant.'],
    ['Tennessee Reconnect Scholarship', 'DIRECT_GRANT',
      'Last-dollar scholarship for adult learners returning to earn an associate degree or technical certificate.'],
    ['Tennessee HOPE Scholarship - Nontraditional', 'DIRECT_GRANT',
      'HOPE award for nontraditional students age 25 or older who are independent students.'],
    ['Katie Beckett Waiver', 'benefit',
      'Discovered from TennCare Employment and Community First CHOICES (ECF CHOICES): Katie Beckett Waiver'],
  ])('rejects %s for the 18-year-old who lives with family and declares her school', (title, kind, description) => {
    const result = livePolicyFor({ title, opportunity_kind: kind, description })
    expect(result.decision).toBe('REJECT')
    expect(result.hardMismatch).toBe(true)
  })

  it.each([
    ['Cleveland, TN — Local assistance programs near you (findhelp)', 'DIRECTORY', 'Search local assistance programs.'],
    ['National Family Caregiver Support Program (NFCSP)', 'BENEFIT',
      'Support services for family caregivers of older adults, including respite care.'],
    ['Federal Pell Grant', 'benefit', 'Need-based grant for undergraduate students.'],
  ])('keeps %s (a source the profile can use): no hard mismatch, never REJECT', (title, kind, description) => {
    const result = livePolicyFor({ title, opportunity_kind: kind, description })
    expect(result.decision).not.toBe('REJECT')
    expect(result.hardMismatch).toBe(false)
    // A DIRECTORY is the resource shape; a benefit/grant row runs the direct path.
    if (kind === 'DIRECTORY') expect(result.resource).toBe(true)
  })

  it('never rejects on silence: no age, housing, or school stated keeps every resource', () => {
    const silent = {
      profile: { id: 'silent', primary_type: 'student' },
      sections: { family_life: {}, occupation: {}, demographics: {} },
    }
    for (const [title, kind, description] of [
      ['Area Agency on Aging & Eldercare Locator', 'DIRECTORY', 'Services for older adults age 60 and older.'],
      ['Avoid foreclosure — free HUD-approved housing counseling', 'benefit', 'Counseling for homeowners facing foreclosure.'],
      ['HSLDA Compassion Grants (homeschool families)', 'DIRECTORY', 'Grants for homeschooling families.'],
    ]) {
      const result = livePolicyFor({ title, opportunity_kind: kind, description }, [], silent, studentNorm)
      expect(result.decision).not.toBe('REJECT')
      expect(result.hardMismatch).toBe(false)
    }
  })

  it('a child-only program (Katie Beckett) is rejected for a 62+ senior and kept for a 15-year-old', () => {
    const seniorContext = {
      profile: { id: 'live_tn_senior', primary_type: 'individual' },
      sections: { demographics: { age_group: 'Senior 62+', disability_status: 'Has disability' }, family_life: { caregiver: false } },
    }
    const senior = livePolicyFor(
      { title: 'Katie Beckett Program', opportunity_kind: 'benefit', description: 'Discovered from TennCare Employment and Community First CHOICES (ECF CHOICES): Katie Beckett Program' },
      [], seniorContext, { ...studentNorm, isStudent: false, entityType: 'individual' },
    )
    expect(senior.decision).toBe('REJECT')
    expect(senior.hardMismatch).toBe(true)

    const childContext = {
      profile: { id: 'live_tn_child', primary_type: 'individual' },
      sections: { basic_information: { date_of_birth: '2011-03-02' }, family_life: {} },
    }
    const child = livePolicyFor(
      { title: 'Katie Beckett Program', opportunity_kind: 'benefit', description: 'Medicaid for children under 18 with disabilities.' },
      [], childContext, { ...studentNorm, isStudent: false, entityType: 'individual' },
    )
    expect(child.decision).not.toBe('REJECT')
  })

  it('a senior keeps the aging locator; a high-school "senior" scholarship is not an older-adult program', () => {
    const senior = {
      profile: { id: 'senior', primary_type: 'senior' },
      sections: { basic_information: { date_of_birth: '1950-01-01' }, family_life: {}, occupation: {}, demographics: {} },
    }
    const aging = livePolicyFor(
      { title: 'Area Agency on Aging & Eldercare Locator', opportunity_kind: 'DIRECTORY', description: 'Services for older adults age 60 and older.' },
      [], senior, { entityType: 'senior', effectiveFacets: ['senior', 'individual'] },
    )
    expect(aging.decision).not.toBe('REJECT')
    expect(aging.hardMismatch).toBe(false)

    const hsSenior = livePolicyFor(
      { title: 'High School Senior Scholarship', opportunity_kind: 'SCHOLARSHIP', description: 'For graduating high school seniors in Tennessee.' },
      [{ kind: 'academic', value: 'GPA 3.84', credit: 1 }],
    )
    expect(hsSenior.hardMismatch).toBe(false)
  })
})
