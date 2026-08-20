/**
 * Hamilton browser automation guard — real portals now permitted.
 *
 * Covers browserAutomationPermittedForUrl + deriveProfilePortalHosts: the logic
 * now permits ANY public HTTPS portal URL (not just the synthetic fixture), while
 * still refusing when automation is disabled and refusing private/unsafe targets.
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
  it('refuses when browser automation is globally disabled', () => {
    process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION = 'false'
    expect(browserAutomationPermittedForUrl('https://hamilton-submit-fixture.invalid/x')).toBe(false)
    expect(browserAutomationPermittedForUrl('https://www.tn.gov/apply')).toBe(false)
  })

  it('permits the exact reserved synthetic fixture origin', () => {
    expect(browserAutomationPermittedForUrl('https://hamilton-submit-fixture.invalid/apply')).toBe(true)
    // Wrong protocol, wrong port, wrong subdomain — all refused
    expect(browserAutomationPermittedForUrl('http://hamilton-submit-fixture.invalid/apply')).toBe(false)
    expect(browserAutomationPermittedForUrl('https://sub.hamilton-submit-fixture.invalid/apply')).toBe(false)
    expect(browserAutomationPermittedForUrl('https://hamilton-submit-fixture.invalid:8443/apply')).toBe(false)
  })

  it('now permits real public HTTPS portals (not gated by an allowlist)', () => {
    expect(browserAutomationPermittedForUrl('https://www.tn.gov/apply')).toBe(true)
    expect(browserAutomationPermittedForUrl('https://benefits.tn.gov/apply')).toBe(true)
    expect(browserAutomationPermittedForUrl('https://www.mtsu.edu/financial-aid/')).toBe(true)
    expect(browserAutomationPermittedForUrl('https://scholarships.com/')).toBe(true)
    // The extraAllowedHosts option is no longer a gate — public HTTPS just works
    expect(browserAutomationPermittedForUrl('https://www.mtsu.edu/financial-aid/', { extraAllowedHosts: ['mtsu.edu'] })).toBe(true)
  })

  it('refuses private/loopback/metadata IPs regardless of allowlist', () => {
    expect(browserAutomationPermittedForUrl('http://127.0.0.1:3000/')).toBe(false)
    expect(browserAutomationPermittedForUrl('http://10.0.0.1/')).toBe(false)
    expect(browserAutomationPermittedForUrl('https://169.254.169.254/')).toBe(false)
    expect(browserAutomationPermittedForUrl('https://127.0.0.1/')).toBe(false)
  })

  it('refuses non-HTTPS real portals', () => {
    // HTTP real portals are not permitted — portals must use TLS
    expect(browserAutomationPermittedForUrl('http://www.tn.gov/apply')).toBe(false)
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
