/**
 * Hamilton controlled-beta browser guard — synthetic fixture only.
 *
 * Covers browserAutomationPermittedForUrl + deriveProfilePortalHosts: the logic
 * Environment allowlists and profile/credential-derived hosts must never widen
 * the release boundary to a real domain.
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
    expect(browserAutomationPermittedForUrl('https://hamilton-submit-fixture.invalid/x')).toBe(false)
  })

  it('permits only the exact reserved synthetic fixture origin', () => {
    expect(browserAutomationPermittedForUrl('https://hamilton-submit-fixture.invalid/apply')).toBe(true)
    expect(browserAutomationPermittedForUrl('http://hamilton-submit-fixture.invalid/apply')).toBe(false)
    expect(browserAutomationPermittedForUrl('https://sub.hamilton-submit-fixture.invalid/apply')).toBe(false)
    expect(browserAutomationPermittedForUrl('https://hamilton-submit-fixture.invalid:8443/apply')).toBe(false)
  })

  it('refuses a real host even when the static allowlist names it', () => {
    expect(browserAutomationPermittedForUrl('https://www.tn.gov/apply')).toBe(false)
    expect(browserAutomationPermittedForUrl('https://benefits.tn.gov/apply')).toBe(false)
  })

  it('refuses a real host even when profile data or a saved credential names it', () => {
    const extra = ['mtsu.edu']
    expect(browserAutomationPermittedForUrl('https://www.mtsu.edu/financial-aid/', { extraAllowedHosts: extra })).toBe(false)
    expect(browserAutomationPermittedForUrl('https://login.mtsu.edu/', { extraAllowedHosts: extra })).toBe(false)
    expect(browserAutomationPermittedForUrl('https://evil.example.com/', { extraAllowedHosts: extra })).toBe(false)
  })

  it('an empty static allowlist cannot enable fleet-wide behavior', () => {
    process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST = ''
    expect(browserAutomationPermittedForUrl('https://anything.example.org/')).toBe(false)
    expect(browserAutomationPermittedForUrl('http://127.0.0.1:3000/')).toBe(false)
    expect(browserAutomationPermittedForUrl('http://10.0.0.1/')).toBe(false)
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
