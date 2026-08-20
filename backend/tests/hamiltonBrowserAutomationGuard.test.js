/**
 * Hamilton browser automation guard — hands-off mode.
 *
 * Covers browserAutomationPermittedForUrl + deriveProfilePortalHosts.
 *
 * The controlled-beta synthetic-only boundary has been replaced with an SSRF
 * floor.  Real public HTTPS portals are now permitted when browser automation
 * is enabled.  Private IPs, loopback, and cloud-metadata addresses are still
 * hard-blocked.
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
    expect(browserAutomationPermittedForUrl('https://example.org/apply')).toBe(false)
  })

  it('permits the exact reserved synthetic fixture origin', () => {
    expect(browserAutomationPermittedForUrl('https://hamilton-submit-fixture.invalid/apply')).toBe(true)
  })

  it('permits real public HTTPS portals when browser automation is enabled', () => {
    // These are no longer blocked — the hands-off requirement means real portals
    // must be reachable when the owner has authorized automation.
    expect(browserAutomationPermittedForUrl('https://www.tn.gov/apply')).toBe(true)
    expect(browserAutomationPermittedForUrl('https://benefits.tn.gov/apply')).toBe(true)
    expect(browserAutomationPermittedForUrl('https://www.mtsu.edu/financial-aid/')).toBe(true)
    expect(browserAutomationPermittedForUrl('https://example.org/')).toBe(true)
  })

  it('still blocks private IP ranges and loopback (SSRF floor)', () => {
    expect(browserAutomationPermittedForUrl('http://127.0.0.1:3000/')).toBe(false)
    expect(browserAutomationPermittedForUrl('http://10.0.0.1/')).toBe(false)
    expect(browserAutomationPermittedForUrl('http://169.254.169.254/latest/meta-data/')).toBe(false)
    expect(browserAutomationPermittedForUrl('http://192.168.1.10/')).toBe(false)
  })

  it('blocks non-HTTPS (http://) real-host URLs', () => {
    expect(browserAutomationPermittedForUrl('http://hamilton-submit-fixture.invalid/apply')).toBe(false)
    expect(browserAutomationPermittedForUrl('http://example.org/')).toBe(false)
  })

  it('an empty static allowlist does not prevent real-portal access (allowlist is no longer the gate)', () => {
    process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST = ''
    expect(browserAutomationPermittedForUrl('https://anything.example.org/')).toBe(true)
    // SSRF floor still applies.
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

