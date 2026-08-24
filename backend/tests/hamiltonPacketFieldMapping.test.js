import { describe, it, expect } from 'vitest'
import { buildPacketContent, formatMailingAddress } from '../services/hamilton/hamiltonApplicationPacketGenerator.js'

// Grounded in the real Anastasia White (c4a92724) profile: her major and
// citizenship ARE on file but printed "[optional]" / "[not on file]", and her
// address doubled ("…Cleveland, TN 37312, Cleveland, TN").
const ANASTASIA = {
  basic_information: {
    first_name: 'Anastasia', last_name: 'White',
    email: 'tishka1201@icloud.com', phone: '4234752124',
    address: '3940 Eveningside Dr. NE \nCleveland, TN 37312',
    city: 'Cleveland', state: 'TN',
    academic_status: { education_level: 'College Freshman (incoming)', gpa: 3.84, act_score: 28 },
  },
  education: { intended_major: 'Forensic Science', current_institution: 'Middle Tennessee State University', highest_level: 'Associates Degree', gpa: '3.84' },
  demographics: { citizenship: 'American' },
  financial_information: { household_income: 12000, household_size: 1 },
}

const bodyOf = (sections, heading) => (sections.find((s) => s.heading === heading)?.body || '')

describe('packet field mapping (#3) + address formatting (#4)', () => {
  it('reads the major from education.intended_major (was printing [optional])', () => {
    const { sections } = buildPacketContent({ opportunity: { title: 'X Grant' }, profile: ANASTASIA, automationType: 'mail' })
    const info = bodyOf(sections, 'Applicant Information')
    expect(info).toMatch(/Forensic Science/)
    expect(info).not.toMatch(/Major \/ program:\s*\[ optional \]/)
  })

  it('reads the school and degree level from the education section', () => {
    const { sections } = buildPacketContent({ opportunity: { title: 'X Grant' }, profile: ANASTASIA, automationType: 'mail' })
    const info = bodyOf(sections, 'Applicant Information')
    expect(info).toMatch(/Middle Tennessee State University/)
    expect(info).toMatch(/Associates Degree/)
  })

  it('reads citizenship from demographics.citizenship (was [not on file])', () => {
    const { sections } = buildPacketContent({ opportunity: { title: 'X Grant' }, profile: ANASTASIA, automationType: 'mail' })
    const elig = bodyOf(sections, 'Eligibility Explanation')
    expect(elig).toMatch(/Citizenship:\s*American/)
  })

  it('does NOT double the city/state in the address (the real Cade defect)', () => {
    const { sections } = buildPacketContent({ opportunity: { title: 'X Grant' }, profile: ANASTASIA, automationType: 'mail' })
    const info = bodyOf(sections, 'Applicant Information')
    // The doubled form was "Cleveland, TN 37312, Cleveland, TN".
    expect(info).not.toMatch(/Cleveland,\s*TN\s*37312,\s*Cleveland/)
    expect(info).toMatch(/3940 Eveningside Dr\. NE/)
  })

  describe('formatMailingAddress', () => {
    it('collapses a full one-field blob without re-appending city/state', () => {
      const out = formatMailingAddress({ address1: '3940 Eveningside Dr. NE \nCleveland, TN 37312', city: 'Cleveland', state: 'TN' })
      expect(out).toBe('3940 Eveningside Dr. NE, Cleveland, TN 37312')
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
