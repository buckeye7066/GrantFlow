/**
 * The two gates that made the full-automation wiring UNREACHABLE, and the rails
 * that must survive opening them.
 *
 * Before 2026-08-20 `registerOnPortal` short-circuited on
 * `reviewedPortalSignupExecutionEnabled()`, a function whose entire body was
 * `return false`, and `openBrowserContext` refused any origin that was not the
 * reserved `hamilton-submit-fixture.invalid` — even though the policy module
 * beside it had already been opened to public HTTPS. So the identity wiring, the
 * phone-number fill and the verification-code gate could all be exercised in a
 * unit test and NONE of them could ever run in production: the wired-but-
 * unreachable class this repo names by name.
 *
 * These tests pin BOTH halves: that the gates are open, and that opening them
 * moved nothing else. The rails below are asserted here because they are what
 * makes opening the gates defensible, not because they are new.
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  reviewedPortalSignupExecutionEnabled,
  automaticMailboxVerificationEnabled,
  registerOnPortal,
} from '../services/hamilton/hamiltonPortalSignupAdapter.js'
import {
  isHamiltonBrowserTargetAllowed,
  isHamiltonBrowserRequestAllowed,
  isPrivateOrLocalHostname,
  CONTROLLED_BETA_SYNTHETIC_BROWSER_ORIGIN,
} from '../services/hamilton/controlledBetaBrowserPolicy.js'

const SIGNUP_FLAG = 'HAMILTON_PORTAL_SIGNUP_EXECUTION'
const MAILBOX_FLAG = 'HAMILTON_MAILBOX_LINK_ACTIVATION'
const stubDb = { prepare: () => ({ get: async () => null, all: async () => [], run: async () => ({}) }) }

afterEach(() => {
  delete process.env[SIGNUP_FLAG]
  delete process.env[MAILBOX_FLAG]
  delete process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION
  delete process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST
})

describe('GATE 1 — signup execution', () => {
  it('is ON by default (it used to be a constant false)', () => {
    expect(reviewedPortalSignupExecutionEnabled()).toBe(true)
  })

  it('can be shut off again with one env var', () => {
    for (const off of ['0', 'false', 'off', 'no', 'FALSE']) {
      process.env[SIGNUP_FLAG] = off
      expect(reviewedPortalSignupExecutionEnabled()).toBe(false)
    }
    process.env[SIGNUP_FLAG] = '1'
    expect(reviewedPortalSignupExecutionEnabled()).toBe(true)
  })

  it('with the flag OFF, registration is refused exactly the way it used to be', async () => {
    process.env[SIGNUP_FLAG] = '0'
    process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION = 'true'
    const launchBrowser = () => { throw new Error('must not launch') }
    const res = await registerOnPortal(stubDb, {
      portalHost: 'communityforce.com',
      signupUrl: 'https://communityforce.com/register',
      identity: { email: 'a@b.com', password: 'pw-pw-pw-pw-1234!aa' },
      launchBrowser,
    })
    expect(res.status).toBe('blocked')
    expect(res.blockerType).toBe('create_portal_account')
  })

  it('MAILBOX-LINK activation is a SEPARATE flag and stays OFF', () => {
    // Reading a one-time CODE addressed to Hamilton and typing it is not the
    // same act as opening an activation LINK embedded in a message. Opening the
    // signup gate must not open this one as a side effect.
    expect(automaticMailboxVerificationEnabled()).toBe(false)
    process.env[SIGNUP_FLAG] = '1'
    expect(automaticMailboxVerificationEnabled()).toBe(false)
  })
})

describe('GATE 2 — the browser target policy is the SINGLE authority', () => {
  it('permits a real public HTTPS portal', () => {
    for (const url of [
      'https://communityforce.com/register',
      'https://mtsu.scholarships.ngwebsolutions.com/',
      'https://awardspring.com/signup',
    ]) {
      expect(isHamiltonBrowserTargetAllowed(url)).toBe(true)
    }
  })

  it('still permits the reserved synthetic fixture', () => {
    expect(isHamiltonBrowserTargetAllowed(`${CONTROLLED_BETA_SYNTHETIC_BROWSER_ORIGIN}/apply`)).toBe(true)
  })

  it('SSRF: private, loopback, link-local and metadata targets stay refused FOREVER', () => {
    for (const host of [
      'localhost', '127.0.0.1', '0.0.0.0', '::1',
      '10.0.0.5', '192.168.1.10', '172.16.0.9', '169.254.169.254',
    ]) {
      expect(isPrivateOrLocalHostname(host)).toBe(true)
      expect(isHamiltonBrowserTargetAllowed(`https://${host}/register`)).toBe(false)
      expect(isHamiltonBrowserRequestAllowed(`https://${host}/x`)).toBe(false)
    }
  })

  it('refuses non-HTTPS and credential-bearing targets', () => {
    expect(isHamiltonBrowserTargetAllowed('http://communityforce.com/register')).toBe(false)
    expect(isHamiltonBrowserTargetAllowed('https://user:pw@communityforce.com/register')).toBe(false)
    expect(isHamiltonBrowserTargetAllowed('file:///etc/passwd')).toBe(false)
  })

  it('a private target is refused even with BOTH gates open and no allowlist', async () => {
    process.env[SIGNUP_FLAG] = '1'
    process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION = 'true'
    let launched = false
    for (const url of [
      'https://127.0.0.1/register',
      'https://169.254.169.254/latest/meta-data/',
      'https://10.1.2.3/signup',
    ]) {
      const res = await registerOnPortal(stubDb, {
        portalHost: 'communityforce.com',
        signupUrl: url,
        identity: { email: 'a@b.com', password: 'pw-pw-pw-pw-1234!aa' },
        launchBrowser: () => { launched = true; return {} },
      })
      expect(res.status).toBe('failed')
    }
    expect(launched).toBe(false)
  })
})

describe('the rails opening the gates did NOT move', () => {
  it('identity PROOFING still hands off to a human, gates open or not', async () => {
    process.env[SIGNUP_FLAG] = '1'
    process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION = 'true'
    let launched = false
    for (const host of ['studentaid.gov', 'login.gov', 'id.me']) {
      const res = await registerOnPortal(stubDb, {
        portalHost: host,
        signupUrl: `https://${host}/register`,
        identity: { email: 'a@b.com', password: 'pw-pw-pw-pw-1234!aa' },
        launchBrowser: () => { launched = true; return {} },
      })
      expect(res.status).toBe('blocked')
      expect(res.blockerType).toBe('identity_proof_required')
      expect(res.message).toMatch(/will not fabricate identity proofing/i)
    }
    expect(launched).toBe(false)
  })

  it('registration NEVER submits an application — it has no submit surface at all', async () => {
    // The whole point of the create-account lane is that it cannot submit. If
    // registerOnPortal ever grows a path into the auto-submit / lease /
    // confirmation-proof protocol, this reads it back out of the source.
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../services/hamilton/hamiltonPortalSignupAdapter.js', import.meta.url), 'utf8'))
    for (const forbidden of [
      'evaluateAutoSubmitGate',
      'resolveSubmissionDecision',
      'assessSubmissionEvidence',
      'acquireSubmissionLease',
      'registerConfirmationArtifact',
      'markSubmitted',
    ]) {
      expect(src).not.toContain(forbidden)
    }
  })

  it('the SSRF egress guard is MANDATORY — a context it cannot route is refused', async () => {
    const { installControlledBetaBrowserEgressGuard } = await import('../services/hamilton/controlledBetaBrowserPolicy.js')
    await expect(installControlledBetaBrowserEgressGuard({})).rejects.toThrow(/guard_unavailable/)
    await expect(installControlledBetaBrowserEgressGuard(null)).rejects.toThrow(/guard_unavailable/)
  })
})
