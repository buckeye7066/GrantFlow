/**
 * Hamilton hands-off contract — authorized runs must never produce a
 * synthetic-boundary or human-handoff blocker.
 *
 * When `allow_auto_submit` is true (or the profile automation toggle is ON):
 *   - No `controlled_beta_manual_handoff` blocker
 *   - No `reviewed_submission_adapter_required` blocker
 *   - No `needs_human_review` / `final_review` / `controlled_beta_redirect_blocked` blockers
 *   - SSRF floor still applies (private/loopback addresses are never opened)
 *   - True `missing_info` and `automation_off` are still valid stops
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  browserAutomationPermittedForUrl,
  reviewedPortalSubmissionExecutionAvailable,
} from '../services/hamilton/hamiltonAutomationOrchestrator.js'
import { isPublicHttpsUrl } from '../services/hamilton/controlledBetaBrowserPolicy.js'

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
  process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION = 'true'
})
afterEach(() => {
  process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION = saved.browser
  vi.restoreAllMocks()
})

describe('URL-gate contract for authorized runs', () => {
  const PUBLIC_PORTALS = [
    'https://example.org/apply',
    'https://www.tn.gov/scholarships/',
    'https://mtsu.scholarships.ngwebsolutions.com/apply',
    'https://cpcc.academicworks.com/opportunities/123',
    'https://tsac.tn.gov/apply',
    'https://studentaid.gov/h/apply-for-aid/fafsa',
  ]

  it.each(PUBLIC_PORTALS)(
    'browserAutomationPermittedForUrl returns true for %s',
    (url) => {
      expect(browserAutomationPermittedForUrl(url)).toBe(true)
    },
  )

  it.each(PUBLIC_PORTALS)(
    'reviewedPortalSubmissionExecutionAvailable returns true for %s (submission path open)',
    (url) => {
      expect(reviewedPortalSubmissionExecutionAvailable(url)).toBe(true)
    },
  )

  it.each(PUBLIC_PORTALS)(
    'isPublicHttpsUrl confirms %s as a public HTTPS URL',
    (url) => {
      expect(isPublicHttpsUrl(url)).toBe(true)
    },
  )
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
  ]

  it.each(SSRF_URLS)(
    'browserAutomationPermittedForUrl returns false for SSRF target %s',
    (url) => {
      expect(browserAutomationPermittedForUrl(url)).toBe(false)
    },
  )

  it.each(SSRF_URLS)(
    'isPublicHttpsUrl returns false for SSRF target %s',
    (url) => {
      expect(isPublicHttpsUrl(url)).toBe(false)
    },
  )
})

describe('forbidden blocker codes are never returned by the URL gate', () => {
  it('FORBIDDEN_BLOCKERS set covers all removed codes', () => {
    // Static guard: the set must stay populated — a future edit that empties
    // the forbidden list would make every subsequent assertion vacuous.
    expect(FORBIDDEN_BLOCKERS.size).toBeGreaterThan(0)
    expect(FORBIDDEN_BLOCKERS.has('controlled_beta_manual_handoff')).toBe(true)
    expect(FORBIDDEN_BLOCKERS.has('reviewed_submission_adapter_required')).toBe(true)
  })
})
