/**
 * 2026-09-05 live run: four MTSU-sponsored scholarship rows for a student
 * COMMITTED to MTSU pointed at generic mtsu.edu pages; Hamilton wandered into
 * the Slate admissions portal and parked at single sign-on. MTSU's scholarships
 * are applied for once, on the NGWeb General Application, behind PipelineMT.
 * The classifier now routes such rows to that portal and the login wall names
 * the credential.
 */
import { describe, expect, it } from 'vitest'
import { classifyFundingSource, resolveOwnInstitutionPortal } from '../services/hamilton/hamiltonAutomationClassifier.js'
import { planAuthBackup } from '../services/hamilton/hamiltonAuthBackupPlan.js'
import { resolveInstitutionScholarshipPortal, institutionPortalForUrl } from '../config/institutionScholarshipPortals.js'

const committedStudent = {
  sections: {
    education: { current_institution: 'Middle Tennessee State University', intended_major: 'Forensic Science' },
    university_applications: { applications: [{ name: 'Middle Tennessee State University', status: 'committed' }] },
  },
}

describe('own-institution scholarship portal routing', () => {
  it.each([
    ['DREAM Scholarship', 'Middle Tennessee State University', 'https://mtsu.edu/scholarships'],
    ['Archer-Johnstone Scholarship', 'Middle Tennessee State University - College of Business', 'https://www.mtsu.edu/applynow/'],
    ['HOPE Scholarship', 'Middle Tennessee State University', 'https://www.mtsu.edu/graduate/funding/'],
    ['ASPIRE to Teach Emergency Fund', null, 'https://education.mtsu.edu/scholarships/'],
  ])('%s is routed to the MTSU scholarship portal for a committed MTSU student', (title, sponsor, url) => {
    const c = classifyFundingSource({ opportunity: { title, sponsor, application_url: url }, grant: null, profile: committedStudent })
    expect(c.resolved_url).toBe('https://mtsu.scholarships.ngwebsolutions.com/')
    expect(c.own_institution_portal?.institution).toBe('Middle Tennessee State University')
    expect(c.own_institution_portal?.vault_kinds).toEqual(['sso_username', 'sso_password'])
    expect(c.reasons.some((r) => r.rule === 'own_institution.scholarship_portal')).toBe(true)
  })

  it('a scholarship APPLICATION page on the school\'s own domain is kept (it is the funder\'s own surface)', () => {
    const c = classifyFundingSource({ opportunity: { title: 'MTSU Guaranteed Scholarship', sponsor: 'Middle Tennessee State University', application_url: 'https://www.mtsu.edu/financial-aid/apply' }, profile: committedStudent })
    expect(c.resolved_url).toBe('https://www.mtsu.edu/financial-aid/apply')
    expect(c.own_institution_portal).toBeNull()
  })

  it('a row already on the scholarship platform keeps its own URL', () => {
    const c = classifyFundingSource({ opportunity: { title: 'Adams Family Foundation Scholarship in Business', sponsor: 'Middle Tennessee State University', application_url: 'https://mtsu.scholarships.ngwebsolutions.com/Scholarships/Search' }, profile: committedStudent })
    expect(c.resolved_url).toBe('https://mtsu.scholarships.ngwebsolutions.com/Scholarships/Search')
    expect(c.own_institution_portal).toBeNull()
  })

  it('another school\'s scholarship, a state program, and a student with no institution are untouched', () => {
    const tsu = classifyFundingSource({ opportunity: { title: 'TSU Scholarships', sponsor: 'Tennessee State University', application_url: 'https://tnstate.academicworks.com/users/sign_in' }, profile: committedStudent })
    expect(tsu.own_institution_portal).toBeNull()
    const tsac = classifyFundingSource({ opportunity: { title: 'Tennessee General Assembly Merit Scholarship', sponsor: 'Tennessee Student Assistance Corporation', application_url: 'https://www.collegefortn.org/general-assembly-merit-scholarship/' }, profile: committedStudent })
    expect(tsac.resolved_url).toBe('https://www.collegefortn.org/general-assembly-merit-scholarship/')
    const nobody = classifyFundingSource({ opportunity: { title: 'DREAM Scholarship', sponsor: 'Middle Tennessee State University', application_url: 'https://mtsu.edu/scholarships' }, profile: { sections: {} } })
    expect(nobody.own_institution_portal).toBeNull()
    expect(resolveOwnInstitutionPortal({ opportunity: { title: 'x' }, profile: null })).toBeNull()
  })

  it('the registry resolves names, aliases and portal hosts, and only curated schools', () => {
    expect(resolveInstitutionScholarshipPortal('Middle Tennessee State University')?.portal_host).toBe('mtsu.scholarships.ngwebsolutions.com')
    expect(resolveInstitutionScholarshipPortal('MTSU')?.institution).toBe('Middle Tennessee State University')
    expect(resolveInstitutionScholarshipPortal('Tusculum University')).toBeNull()
    expect(institutionPortalForUrl('https://mtsu.scholarships.ngwebsolutions.com/Scholarships/Search')?.institution).toBe('Middle Tennessee State University')
    expect(institutionPortalForUrl('https://www.mtsu.edu/applynow/')).toBeNull()
  })

  it('the login wall names the PipelineMT login and the vault kinds for the MTSU portal', () => {
    const plan = planAuthBackup({ blockerKind: 'login', retryCount: 0, portalUrl: 'https://mtsu.scholarships.ngwebsolutions.com/' })
    const text = JSON.stringify(plan)
    expect(text).toMatch(/PipelineMT/)
    expect(text).toMatch(/University SSO username\/password/)
    const other = planAuthBackup({ blockerKind: 'login', retryCount: 0, portalUrl: 'https://apply.tusculum.edu/account/login' })
    expect(JSON.stringify(other)).not.toMatch(/PipelineMT/)
  })
})
