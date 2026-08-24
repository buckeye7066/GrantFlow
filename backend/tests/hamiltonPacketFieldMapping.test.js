import { describe, it, expect } from 'vitest'
import { buildPacketContent, formatMailingAddress } from '../services/hamilton/hamiltonApplicationPacketGenerator.js'

// Grounded in a real student profile: its major and citizenship ARE on file
// but printed "[optional]" / "[not on file]", and the address doubled
// ("…Maple Grove, TN 37040, Maple Grove, TN").
const STUDENT_PROFILE = {
  basic_information: {
    first_name: 'Jordan', last_name: 'Sample',
    email: 'applicant@example.com', phone: '5555550142',
    address: '410 Birch Hollow Rd. NE \nMaple Grove, TN 37040',
    city: 'Maple Grove', state: 'TN',
    academic_status: { education_level: 'College Freshman (incoming)', gpa: 3.84, act_score: 28 },
  },
  education: { intended_major: 'Forensic Science', current_institution: 'Riverbend State University', highest_level: 'Associates Degree', gpa: '3.84' },
  demographics: { citizenship: 'American' },
  financial_information: { household_income: 18000, household_size: 1 },
}

const bodyOf = (sections, heading) => (sections.find((s) => s.heading === heading)?.body || '')

describe('packet field mapping (#3) + address formatting (#4)', () => {
  it('reads the major from education.intended_major (was printing [optional])', () => {
    const { sections } = buildPacketContent({ opportunity: { title: 'X Grant' }, profile: STUDENT_PROFILE, automationType: 'mail' })
    const info = bodyOf(sections, 'Applicant Information')
    expect(info).toMatch(/Forensic Science/)
    expect(info).not.toMatch(/Major \/ program:\s*\[ optional \]/)
  })

  it('reads the school and degree level from the education section', () => {
    const { sections } = buildPacketContent({ opportunity: { title: 'X Grant' }, profile: STUDENT_PROFILE, automationType: 'mail' })
    const info = bodyOf(sections, 'Applicant Information')
    expect(info).toMatch(/Riverbend State University/)
    expect(info).toMatch(/Associates Degree/)
  })

  it('reads citizenship from demographics.citizenship (was [not on file])', () => {
    const { sections } = buildPacketContent({ opportunity: { title: 'X Grant' }, profile: STUDENT_PROFILE, automationType: 'mail' })
    const elig = bodyOf(sections, 'Eligibility Explanation')
    expect(elig).toMatch(/Citizenship:\s*American/)
  })

  it('does NOT double the city/state in the address (the real Cade defect)', () => {
    const { sections } = buildPacketContent({ opportunity: { title: 'X Grant' }, profile: STUDENT_PROFILE, automationType: 'mail' })
    const info = bodyOf(sections, 'Applicant Information')
    // The doubled form was "Maple Grove, TN 37040, Maple Grove, TN".
    expect(info).not.toMatch(/Maple Grove,\s*TN\s*37040,\s*Maple Grove/)
    expect(info).toMatch(/410 Birch Hollow Rd\. NE/)
  })

  describe('formatMailingAddress', () => {
    it('collapses a full one-field blob without re-appending city/state', () => {
      const out = formatMailingAddress({ address1: '410 Birch Hollow Rd. NE \nMaple Grove, TN 37040', city: 'Maple Grove', state: 'TN' })
      expect(out).toBe('410 Birch Hollow Rd. NE, Maple Grove, TN 37040')
    })
    it('joins parts when the street line is street-only', () => {
      const out = formatMailingAddress({ address1: '123 Main St', city: 'Akron', state: 'OH', zip: '44301' })
      expect(out).toBe('123 Main St, Akron, OH, 44301')
    })
    it('returns a MISSING placeholder when there is nothing', () => {
      expect(formatMailingAddress({})).toMatch(/MISSING/)
    })
  })
})
