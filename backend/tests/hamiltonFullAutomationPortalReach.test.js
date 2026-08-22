/**
 * Owner doctrine (2026-08-22): under FULL AUTOMATION the profile user has
 * consented, so Hamilton submits on ANY public HTTPS portal — the host
 * allowlist (a controlled-beta throttle) no longer gates it. The SSRF floor
 * (public HTTPS only) still applies to everyone.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { reviewedPortalSubmissionExecutionAvailable } from '../services/hamilton/hamiltonAutomationOrchestrator.js'

describe('reviewedPortalSubmissionExecutionAvailable — full-automation portal reach', () => {
  const saved = {}
  beforeEach(() => {
    saved.enable = process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION
    saved.allow = process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST
    process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION = 'true'
    // A restrictive allowlist that does NOT include the funder host below.
    process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST = 'only-this-host.example.gov'
  })
  afterEach(() => {
    if (saved.enable === undefined) delete process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION
    else process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION = saved.enable
    if (saved.allow === undefined) delete process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST
    else process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST = saved.allow
  })

  const funderUrl = 'https://apply.somefunder.org/scholarship/form'

  it('WITHOUT full automation, a host off the allowlist is NOT executable', () => {
    expect(reviewedPortalSubmissionExecutionAvailable(funderUrl)).toBe(false)
  })

  it('WITH full automation, any public HTTPS portal IS executable (allowlist bypassed)', () => {
    expect(reviewedPortalSubmissionExecutionAvailable(funderUrl, { fullAutomation: true })).toBe(true)
  })

  it('the SSRF floor still holds under full automation — a private/local target is refused', () => {
    expect(reviewedPortalSubmissionExecutionAvailable('https://localhost/apply', { fullAutomation: true })).toBe(false)
    expect(reviewedPortalSubmissionExecutionAvailable('http://apply.somefunder.org/form', { fullAutomation: true })).toBe(false) // not HTTPS
  })

  it('with browser automation globally OFF, even full automation cannot submit', () => {
    process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION = 'false'
    expect(reviewedPortalSubmissionExecutionAvailable(funderUrl, { fullAutomation: true })).toBe(false)
  })
})
