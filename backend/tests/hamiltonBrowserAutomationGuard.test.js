/**
 * Hamilton browser-automation host guard — profile-aware allowlist.
 *
 * Covers browserAutomationPermittedForUrl + deriveProfilePortalHosts: the logic
 * that lets Hamilton drive any portal a profile actually requires (declared
 * portals or owner-credentialed hosts) without opening her to arbitrary hosts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  browserAutomationPermittedForUrl,
  deriveProfilePortalHosts,
} from '../services/hamilton/hamiltonAutomationOrchestrator.js'

const saved = {}
beforeEach(() => {
  saved.enabled = process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION
  saved.allow = process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST
  process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION = 'true'
  process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST = 'tn.gov'
})
afterEach(() => {
  process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION = saved.enabled
  process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST = saved.allow
})

describe('browserAutomationPermittedForUrl', () => {
  it('refuses when browser automation is disabled', () => {
    process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION = 'false'
    expect(browserAutomationPermittedForUrl('https://www.tn.gov/x')).toBe(false)
  })

  it('permits hosts on the static allowlist (incl. subdomains)', () => {
    expect(browserAutomationPermittedForUrl('https://www.tn.gov/apply')).toBe(true)
    expect(browserAutomationPermittedForUrl('https://benefits.tn.gov/apply')).toBe(true)
  })

  it('refuses an off-allowlist host with no profile authorization', () => {
    expect(browserAutomationPermittedForUrl('https://www.mtsu.edu/financial-aid/')).toBe(false)
  })

  it('permits an off-allowlist host the profile is authorized for (declared portal or credential)', () => {
    const extra = ['mtsu.edu']
    expect(browserAutomationPermittedForUrl('https://www.mtsu.edu/financial-aid/', { extraAllowedHosts: extra })).toBe(true)
    // registrable-domain match: a login subdomain is covered by the eTLD+1.
    expect(browserAutomationPermittedForUrl('https://login.mtsu.edu/', { extraAllowedHosts: extra })).toBe(true)
    // but an unrelated host is still refused.
    expect(browserAutomationPermittedForUrl('https://evil.example.com/', { extraAllowedHosts: extra })).toBe(false)
  })

  it('an empty static allowlist preserves fleet-wide behavior', () => {
    process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST = ''
    expect(browserAutomationPermittedForUrl('https://anything.example.org/')).toBe(true)
  })
})

describe('deriveProfilePortalHosts', () => {
  it('collects hosts from declared committed-college portals and the funding URL', () => {
    const hosts = deriveProfilePortalHosts({
      profile: {
        university_applications: {
          applications: [
            { status: 'committed', website_url: 'https://www.mtsu.edu',
              portals: { financial_aid_url: 'https://mtsu.edu/financial-aid/', student_portal_url: 'https://pipelinemt.mtsu.edu/' } },
          ],
        },
      },
      opportunity: { application_url: 'https://tsac.tn.gov/apply' },
    })
    expect(hosts.has('www.mtsu.edu')).toBe(true)
    expect(hosts.has('mtsu.edu')).toBe(true)
    expect(hosts.has('pipelinemt.mtsu.edu')).toBe(true)
    expect(hosts.has('tsac.tn.gov')).toBe(true)
  })

  it('ignores blank / non-URL portal values', () => {
    const hosts = deriveProfilePortalHosts({
      profile: { university_applications: { applications: [{ portals: { admissions_url: '', counseling_url: 'not a url' } }] } },
    })
    expect(hosts.size).toBe(0)
  })
})
