/**
 * Hamilton browser-automation guard — real public portals + the SSRF floor.
 *
 * SUPERSEDED CONTRACT: this file used to pin the 2026-08-06 controlled-beta
 * boundary, where `hamilton-submit-fixture.invalid` was the ONLY origin
 * Hamilton could ever open and every real host was refused no matter what the
 * allowlist, the profile, or a saved credential said. The owner retired that
 * boundary on 2026-08-20 ("full automation means full automation";
 * docs/agent-sync/2026-08-20-hamilton-real-portal-submit.md: "Do not re-impose
 * fixture-only controlled-beta refuse for real public HTTPS"), and
 * controlledBetaBrowserPolicy.js now permits any public HTTPS portal.
 *
 * What is pinned NOW:
 *   - the reserved fixture still works (irreversible-boundary tests need it),
 *   - `HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST` is an operational NARROW:
 *     when set, only those hosts (plus profile/credential hosts) are drivable;
 *     when empty, any public HTTPS portal is,
 *   - the SSRF floor is NOT negotiable — loopback / RFC1918 / link-local /
 *     metadata and plain http:// are refused whatever the allowlist says.
 * Every assertion below is written so that re-imposing the fixture-only refuse,
 * OR dropping the SSRF floor, fails this file.
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

  it('still permits the reserved synthetic fixture origin, and only over https', () => {
    // The fixture short-circuits the allowlist so irreversible-boundary tests
    // keep a drivable origin even under the narrowest operational narrow.
    expect(browserAutomationPermittedForUrl('https://hamilton-submit-fixture.invalid/apply')).toBe(true)
    // http:// is not a portal target, fixture or not (SSRF floor).
    expect(browserAutomationPermittedForUrl('http://hamilton-submit-fixture.invalid/apply')).toBe(false)
    // A .invalid subdomain/port is NOT the reserved origin, so it falls through
    // to the allowlist ('tn.gov' here) and is refused on that basis.
    expect(browserAutomationPermittedForUrl('https://sub.hamilton-submit-fixture.invalid/apply')).toBe(false)
    expect(browserAutomationPermittedForUrl('https://hamilton-submit-fixture.invalid:8443/apply')).toBe(false)
  })

  // OWNER 2026-08-20 (supersedes the 2026-08-06 controlled-beta refuse): a real
  // public host named by the operational allowlist IS drivable. Hamilton must
  // reach real public HTTPS portals to fill and submit.
  it('drives a real public host the static allowlist names', () => {
    expect(browserAutomationPermittedForUrl('https://www.tn.gov/apply')).toBe(true)
    expect(browserAutomationPermittedForUrl('https://benefits.tn.gov/apply')).toBe(true)
    // …and the allowlist still NARROWS: a host it does not name stays refused.
    expect(browserAutomationPermittedForUrl('https://evil.example.com/apply')).toBe(false)
  })

  // Same supersession: profile-declared portals and saved-credential domains are
  // authorized targets, not a widening of a fixture-only boundary.
  it('drives a host profile data or a saved credential names, and nothing else', () => {
    const extra = ['mtsu.edu']
    expect(browserAutomationPermittedForUrl('https://www.mtsu.edu/financial-aid/', { extraAllowedHosts: extra })).toBe(true)
    expect(browserAutomationPermittedForUrl('https://login.mtsu.edu/', { extraAllowedHosts: extra })).toBe(true)
    // An unrelated host is NOT admitted just because extras were supplied.
    expect(browserAutomationPermittedForUrl('https://evil.example.com/', { extraAllowedHosts: extra })).toBe(false)
  })

  // The allowlist is an operational override, NOT the compliance boundary:
  // empty means "any public HTTPS portal". ToS-forbidden hosts are stopped by
  // hamiltonPortalPolicyRegistry at launch, and SSRF is stopped right here.
  it('an empty static allowlist means fleet-wide PUBLIC HTTPS — and never more', () => {
    process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST = ''
    expect(browserAutomationPermittedForUrl('https://anything.example.org/')).toBe(true)
    // The SSRF floor survives a fleet-wide allowlist. If any of these ever flip
    // to true, an empty allowlist has become an internal-network hole.
    for (const target of [
      'http://127.0.0.1:3000/',
      'http://10.0.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'https://192.168.1.10/apply',
      'http://anything.example.org/',
    ]) {
      expect(browserAutomationPermittedForUrl(target), target).toBe(false)
    }
  })

  it('the master switch still disarms everything, allowlist or not', () => {
    process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION = 'false'
    process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST = ''
    expect(browserAutomationPermittedForUrl('https://www.tn.gov/apply')).toBe(false)
    expect(browserAutomationPermittedForUrl('https://anything.example.org/')).toBe(false)
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
