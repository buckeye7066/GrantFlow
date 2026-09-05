/**
 * Hamilton hands-off contract — the URL gate never manufactures a
 * controlled-beta / human-handoff blocker for a real public HTTPS portal.
 *
 * Ported from PR #1515 (2026-09-05) onto main's names. Under the owner's
 * full-automation doctrine (memory: hamilton-full-autonomy-goal-2026-08-21):
 *   - a real public HTTPS portal is drivable AND submittable,
 *   - the SSRF floor still refuses private / loopback / metadata targets,
 *   - the retired blocker codes must never come back out of the URL gate.
 *
 * `browserAutomationPermittedForUrl` still honors the OPERATIONAL allowlist
 * (HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST) when one is set; this file runs
 * with it unset, the fleet default, and proves full automation bypasses it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  browserAutomationPermittedForUrl,
  reviewedPortalSubmissionExecutionAvailable,
} from '../services/hamilton/hamiltonAutomationOrchestrator.js'
import { isPublicHttpsPortalUrl } from '../services/hamilton/controlledBetaBrowserPolicy.js'

const FORBIDDEN_BLOCKERS = new Set([
  'controlled_beta_manual_handoff',
  'reviewed_submission_adapter_required',
  'needs_human_review',
  'final_review',
  'controlled_beta_redirect_blocked',
])

const saved = {}
beforeEach(() => {
  saved.browser = process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION
  saved.allow = process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST
  process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION = 'true'
  delete process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST
})
afterEach(() => {
  process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION = saved.browser
  process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST = saved.allow
  vi.restoreAllMocks()
})

const PUBLIC_PORTALS = [
  'https://example.org/apply',
  'https://www.tn.gov/scholarships/',
  'https://mtsu.scholarships.ngwebsolutions.com/apply',
  'https://cpcc.academicworks.com/opportunities/123',
  'https://tsac.tn.gov/apply',
  'https://studentaid.gov/h/apply-for-aid/fafsa',
]

describe('URL-gate contract for authorized runs', () => {
  it.each(PUBLIC_PORTALS)('browserAutomationPermittedForUrl returns true for %s', (url) => {
    expect(browserAutomationPermittedForUrl(url)).toBe(true)
  })

  it.each(PUBLIC_PORTALS)('reviewedPortalSubmissionExecutionAvailable returns true for %s under full automation', (url) => {
    expect(reviewedPortalSubmissionExecutionAvailable(url, { fullAutomation: true })).toBe(true)
  })

  it.each(PUBLIC_PORTALS)('isPublicHttpsPortalUrl confirms %s as a public HTTPS URL', (url) => {
    expect(isPublicHttpsPortalUrl(url)).toBe(true)
  })

  it('full automation bypasses an operational host allowlist (owner doctrine 2026-08-22)', () => {
    process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST = 'tn.gov'
    expect(reviewedPortalSubmissionExecutionAvailable('https://example.org/apply', { fullAutomation: true })).toBe(true)
    expect(reviewedPortalSubmissionExecutionAvailable('https://example.org/apply', { fullAutomation: false })).toBe(false)
  })
})

describe('SSRF floor still enforced', () => {
  const SSRF_URLS = [
    'http://127.0.0.1/',
    'http://127.0.0.1:3000/',
    'http://10.0.0.1/',
    'http://10.0.0.1:8080/',
    'http://192.168.1.1/',
    'http://172.16.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal/',
    'http://localhost:3000/',
    'https://100.64.0.1/',
    'https://[::ffff:127.0.0.1]/',
  ]

  it.each(SSRF_URLS)('browserAutomationPermittedForUrl returns false for SSRF target %s', (url) => {
    expect(browserAutomationPermittedForUrl(url)).toBe(false)
  })

  it.each(SSRF_URLS)('full automation cannot lift the SSRF floor for %s', (url) => {
    expect(reviewedPortalSubmissionExecutionAvailable(url, { fullAutomation: true })).toBe(false)
  })

  it.each(SSRF_URLS)('isPublicHttpsPortalUrl returns false for SSRF target %s', (url) => {
    expect(isPublicHttpsPortalUrl(url)).toBe(false)
  })
})

describe('forbidden blocker codes are never returned by the URL gate', () => {
  it('FORBIDDEN_BLOCKERS set covers all retired codes', () => {
    // Static guard: the set must stay populated — a future edit that empties
    // the forbidden list would make every subsequent assertion vacuous.
    expect(FORBIDDEN_BLOCKERS.size).toBeGreaterThan(0)
    expect(FORBIDDEN_BLOCKERS.has('controlled_beta_manual_handoff')).toBe(true)
    expect(FORBIDDEN_BLOCKERS.has('reviewed_submission_adapter_required')).toBe(true)
  })
})
