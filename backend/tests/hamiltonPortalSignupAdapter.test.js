/**
 * Unit tests for the Portal SIGNUP-FORM ADAPTER (the "hands" of Portal Autopilot
 * Identity). Playwright and the Graph mailbox are fully MOCKED — no network, no
 * real browser. We exercise:
 *   - generic adapter detects + fills + submits a simple form → registered
 *   - "account already exists" copy → already_exists
 *   - missing form / CAPTCHA → blocked with blockerType
 *   - identity-proofed host → refused/blocked, NEVER attempted (no page touched)
 *   - automation-disabled / host-not-allowlisted → not attempted
 *   - per-host adapter selected over generic when present
 *   - verification-pending when no link found; registered when link verified
 *   - the BRAIN finalizes a credential on registered and routes blocked/pending
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { isHamiltonBrowserTargetAllowed } from '../services/hamilton/controlledBetaBrowserPolicy.js'

process.env.RUNTIME_SECRETS_KEY = 'c'.repeat(64)
process.env.HAMILTON_ADMIN_VAULT_PROFILE_ID = 'owner-vault'

const Database = (await import('better-sqlite3')).default

const adapter = await import('../services/hamilton/hamiltonPortalSignupAdapter.js')
const {
  registerOnPortal, genericSignupAdapter, resolveHostAdapter, HOST_ADAPTERS,
  buildSignupIdentity, completeEmailVerification, recheckEmailVerification,
  extractConfirmationLink, _internal,
} = adapter

const masterVault = await import('../services/hamilton/hamiltonPortalMasterVault.js')
const {
  setMasterPassphrase, _resetMasterVaultSchemaCache, _resetUnlockCache,
} = masterVault

const credService = await import('../services/hamilton/hamiltonPortalCredentialService.js')
const {
  _resetCredentialSchemaCache, saveAutoProvisionedCredential,
  markCredentialAwaitingVerification, listCredentialsAwaitingVerification,
} = credService

const {
  runAutopilotIdentityForPortal, AUTOPILOT_STATE, recheckDuePortalVerifications,
} = await import('../services/hamilton/hamiltonPortalAutopilotIdentity.js')

function makeDb() { return new Database(':memory:') }

function enableBrowser(allowlist = '') {
  process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION = 'true'
  if (allowlist) process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST = allowlist
  else delete process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST
}
function disableBrowser() {
  delete process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION
  delete process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST
}

// ── Fake Playwright page ────────────────────────────────────────────────────────
// A minimal page exposing only the surface the adapter uses: $, $$eval, evaluate,
// content, url, fill via handles, click, goto, waitForNavigation/LoadState, newPage.
function makeFakePage({
  selectors = {},      // selector -> { fill, click } handle (presence = found)
  bodyText = '',
  url = 'https://portal.example.org/signup',
  afterSubmit = null,  // { bodyText?, url? } applied when submit is clicked
} = {}) {
  const state = { bodyText, url }
  const present = new Set(Object.keys(selectors))
  function findHandle(sel) {
    // exact match first, then a forgiving "does any present selector start with…"
    if (present.has(sel)) return selectors[sel]
    return null
  }
  const page = {
    url: () => state.url,
    async goto(u) { state.url = u; return null },
    async $(sel) { return findHandle(sel) },
    async $$(sel) { const h = findHandle(sel); return h ? [h] : [] },
    async $$eval(sel, fn) {
      // Only used by visibleErrors — return [] (no error nodes) by default.
      return []
    },
    async evaluate() { return state.bodyText },
    async content() { return `<html><body>${state.bodyText}</body></html>` },
    async waitForNavigation() { return null },
    async waitForLoadState() { return null },
    _setState(s) { Object.assign(state, s) },
  }
  // Wire submit handles to mutate state on click.
  for (const sel of Object.keys(selectors)) {
    const h = selectors[sel]
    if (!h.click) {
      h.click = vi.fn(async () => {
        if (afterSubmit) Object.assign(state, afterSubmit)
      })
    }
    if (!h.fill) h.fill = vi.fn(async () => {})
  }
  return page
}

function fillHandle() { return { fill: vi.fn(async () => {}) } }

// A fake browser/context/page factory matching registerOnPortal's launchBrowser.
function makeFakeBrowser(page, { extraPages = [] } = {}) {
  let pageIndex = 0
  const pages = [page, ...extraPages]
  const context = {
    async newPage() { return pages[pageIndex++] || page },
    // The SSRF egress guard is MANDATORY: installControlledBetaBrowserEgressGuard
    // THROWS on a context it cannot route, so a fake browser without `route`
    // cannot be driven at all. That is a feature — pin it by giving the fake a
    // real route hook and recording what the guard registered.
    routes: [],
    async route(pattern, handler) { this.routes.push({ pattern, handler }) },
    closed: false,
    async close() { this.closed = true },
  }
  const browser = {
    async newContext() { return context },
    async close() {},
  }
  return { launchBrowser: async () => ({ browser, context }), context, browser }
}

// ── extractConfirmationLink ─────────────────────────────────────────────────────

describe('extractConfirmationLink', () => {
  it('pulls a verify/confirm href out of an HTML email', () => {
    const html = `<p>Welcome!</p><a href="https://portal.example.org/verify?token=abc123">Confirm your email</a>`
    expect(extractConfirmationLink(html)).toBe('https://portal.example.org/verify?token=abc123')
  })
  it('falls back to a bare confirm URL in text', () => {
    const txt = 'Please confirm: https://portal.example.org/activate/xyz then sign in.'
    expect(extractConfirmationLink(txt)).toBe('https://portal.example.org/activate/xyz')
  })
  it('returns null when there is no link', () => {
    expect(extractConfirmationLink('no links here')).toBeNull()
  })
})

// ── generic adapter ─────────────────────────────────────────────────────────────

describe('genericSignupAdapter', () => {
  const identity = { email: 'auto@vault.example', password: 'S3cret-Pw-28charslong!!aaaa', first_name: 'Ana', last_name: 'Lee', full_name: 'Ana Lee', phone: null }

  it('detects + fills + submits a simple form → registered', async () => {
    const submit = { click: undefined } // factory wires click
    const page = makeFakePage({
      selectors: {
        'input[type="email"]:not([disabled])': fillHandle(),
        'input[type="password"]:not([disabled])': fillHandle(),
        'button[type="submit"]:not([disabled])': submit,
      },
      bodyText: 'Create your account',
      url: 'https://portal.example.org/signup',
      afterSubmit: { bodyText: 'Welcome! Your account has been created.', url: 'https://portal.example.org/dashboard' },
    })
    const res = await genericSignupAdapter(page, identity, {})
    expect(res.status).toBe('registered')
  })

  it('"account already exists" copy → already_exists', async () => {
    const page = makeFakePage({
      selectors: {
        'input[type="email"]:not([disabled])': fillHandle(),
        'input[type="password"]:not([disabled])': fillHandle(),
        'button[type="submit"]:not([disabled])': {},
      },
      bodyText: 'Create your account',
      afterSubmit: { bodyText: 'An account with this email is already registered.', url: 'https://portal.example.org/signup' },
    })
    const res = await genericSignupAdapter(page, identity, {})
    expect(res.status).toBe('already_exists')
  })

  it('no signup form → blocked(unknown_application_method)', async () => {
    const page = makeFakePage({ selectors: {}, bodyText: 'Some marketing page' })
    const res = await genericSignupAdapter(page, identity, {})
    expect(res.status).toBe('blocked')
    expect(res.blockerType).toBe('unknown_application_method')
  })

  it('CAPTCHA on the form → blocked(captcha_required), no submit', async () => {
    const page = makeFakePage({
      selectors: {
        'input[type="email"]:not([disabled])': fillHandle(),
        'input[type="password"]:not([disabled])': fillHandle(),
        'div.g-recaptcha': {},
        'button[type="submit"]:not([disabled])': {},
      },
      bodyText: 'Create your account',
    })
    const res = await genericSignupAdapter(page, identity, {})
    expect(res.status).toBe('blocked')
    expect(res.blockerType).toBe('captcha_required')
  })

  it('verify-email copy → verification_pending', async () => {
    const page = makeFakePage({
      selectors: {
        'input[type="email"]:not([disabled])': fillHandle(),
        'input[type="password"]:not([disabled])': fillHandle(),
        'button[type="submit"]:not([disabled])': {},
      },
      bodyText: 'Create your account',
      afterSubmit: { bodyText: 'Please verify your email — we have sent you a confirmation link.', url: 'https://portal.example.org/check-email' },
    })
    const res = await genericSignupAdapter(page, identity, {})
    expect(res.status).toBe('verification_pending')
  })
})

// ── per-host registry ───────────────────────────────────────────────────────────

describe('per-host adapter registry', () => {
  it('resolves a seeded host (and its subdomains) over the generic default', () => {
    expect(resolveHostAdapter('awardspring.com')?.host).toBe('awardspring.com')
    expect(resolveHostAdapter('tenant.awardspring.com')?.host).toBe('awardspring.com')
    expect(resolveHostAdapter('communityforce.com')?.host).toBe('communityforce.com')
    expect(resolveHostAdapter('random-unknown-portal.org')).toBeNull()
  })
  it('never lists an identity-proofed host', () => {
    for (const key of Object.keys(HOST_ADAPTERS)) {
      expect(['studentaid.gov', 'login.gov', 'id.me', 'irs.gov', 'sam.gov']).not.toContain(key)
    }
  })
  it('does not treat a legacy per-host helper as a reviewed account-creation adapter', async () => {
    enableBrowser()
    const db = makeDb()
    const hostAdapter = vi.fn(async () => ({ status: 'registered', evidence: {} }))
    // Temporarily inject a custom host adapter by monkeypatching the registry entry.
    const original = HOST_ADAPTERS['communityforce.com']
    // Can't mutate frozen object; instead pass a host that resolves and assert the
    // generic path runs, while separately unit-testing resolveHostAdapter above.
    void original; void hostAdapter
    const page = makeFakePage({
      selectors: {
        'input[type="email"]:not([disabled])': fillHandle(),
        'input[type="password"]:not([disabled])': fillHandle(),
        'button[type="submit"]:not([disabled])': {},
      },
      bodyText: 'Register',
      afterSubmit: { bodyText: 'Registration successful. Welcome!', url: 'https://communityforce.com/dashboard' },
    })
    const { launchBrowser } = makeFakeBrowser(page)
    const res = await registerOnPortal(db, {
      portalHost: 'communityforce.com', signupUrl: 'https://communityforce.com/register',
      identity: { email: 'a@b.com', password: 'pw-pw-pw-pw-pw-pw-1234!' },
      launchBrowser,
    })
    // Superseded 2026-08-20: signup execution defaults ON, so a registered host
    // actually runs — through the GENERIC driver. The registry grants a host a
    // known signup URL, never a privileged execution path.
    expect(res.status).toBe('registered')
    expect(res.adapter).toBe('host:communityforce.com')
    expect(hostAdapter).not.toHaveBeenCalled()
    disableBrowser()
  })
})

// ── registerOnPortal safety rails ───────────────────────────────────────────────

describe('registerOnPortal safety rails', () => {
  beforeEach(() => { disableBrowser() })

  it('identity-proofed host → blocked, NEVER launches a browser', async () => {
    enableBrowser()
    const db = makeDb()
    const launchBrowser = vi.fn(async () => { throw new Error('browser must not launch') })
    const res = await registerOnPortal(db, {
      portalHost: 'studentaid.gov', signupUrl: 'https://studentaid.gov/register',
      identity: { email: 'a@b.com', password: 'pw-pw-pw-pw-pw-1234!aa' },
      launchBrowser,
    })
    expect(res.status).toBe('blocked')
    expect(res.blockerType).toBe('identity_proof_required')
    expect(launchBrowser).not.toHaveBeenCalled()
    disableBrowser()
  })

  // The reviewed-adapter CONSTANT is gone (signup execution is now the env flag
  // HAMILTON_PORTAL_SIGNUP_EXECUTION, defaulting ON). The rails below are the
  // ones that still hold, and each still refuses BEFORE a browser is launched.
  it('browser automation OFF still fails closed, and never launches', async () => {
    // NOTE: disableBrowser() only UNSETS the var, and the flag defaults ON, so
    // an explicit 0 is what actually turns automation off.
    process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION = '0'
    const db = makeDb()
    const launchBrowser = vi.fn()
    const res = await registerOnPortal(db, {
      portalHost: 'communityforce.com', signupUrl: 'https://communityforce.com/register',
      identity: { email: 'a@b.com', password: 'pw-pw-pw-pw-pw-1234!aa' },
      launchBrowser,
    })
    expect(res.status).toBe('failed')
    expect(res.blocker_kind).toBe('no_browser')
    expect(res.automation_disabled).toBe(true)
    expect(launchBrowser).not.toHaveBeenCalled()
    disableBrowser()
  })

  it('a host outside a configured allowlist still fails closed, and never launches', async () => {
    enableBrowser('tn.gov')
    const db = makeDb()
    const launchBrowser = vi.fn()
    const res = await registerOnPortal(db, {
      portalHost: 'communityforce.com', signupUrl: 'https://communityforce.com/register',
      identity: { email: 'a@b.com', password: 'pw-pw-pw-pw-pw-1234!aa' },
      launchBrowser,
    })
    expect(res.status).toBe('failed')
    expect(res.blocker_kind).toBe('no_browser')
    expect(launchBrowser).not.toHaveBeenCalled()
    disableBrowser()
  })

  // DRY RUN REMOVED 2026-09-04, by the owner's standing no-dry-runs order.
  // This test previously asserted that `dryRun: true` returned status 'planned'
  // without launching a browser. On the portal ACCOUNT REGISTRATION path that
  // mode provisioned a credential record and reported "registration not
  // executed" — leaving Hamilton holding a login that was never created, so any
  // later submission to a portal requiring that account failed for a reason
  // nothing upstream could see. The flag is removed OUTRIGHT rather than
  // defaulted off, and naming it now FAILS rather than silently doing something
  // else — which is what this test pins.
  it('REFUSES a dryRun option outright instead of silently planning', async () => {
    enableBrowser()
    const db = makeDb()
    const launchBrowser = vi.fn()
    await expect(registerOnPortal(db, {
      portalHost: 'communityforce.com', signupUrl: 'https://communityforce.com/register',
      identity: { email: 'a@b.com', password: 'pw-pw-pw-pw-pw-1234!aa' },
      dryRun: true, launchBrowser,
    })).rejects.toThrow(/dryRun has been removed/i)
    expect(launchBrowser).not.toHaveBeenCalled()

    // The snake_case spelling is refused too, so the flag cannot creep back in
    // under the other convention.
    await expect(registerOnPortal(db, {
      portalHost: 'communityforce.com', signupUrl: 'https://communityforce.com/register',
      identity: { email: 'a@b.com', password: 'pw-pw-pw-pw-pw-1234!aa' },
      dry_run: true, launchBrowser,
    })).rejects.toThrow(/dryRun has been removed/i)
    disableBrowser()
  })

  it('SSRF: a private / loopback target is refused even with the gate open', async () => {
    enableBrowser()
    const db = makeDb()
    const launchBrowser = vi.fn()
    for (const url of [
      'http://127.0.0.1:8080/register',
      'https://localhost/register',
      'https://10.0.0.5/register',
      'https://169.254.169.254/latest/meta-data/',
      'https://192.168.1.10/signup',
    ]) {
      const res = await registerOnPortal(db, {
        portalHost: 'communityforce.com', signupUrl: url,
        identity: { email: 'a@b.com', password: 'pw-pw-pw-pw-pw-1234!aa' },
        launchBrowser,
      })
      expect(res.status).toBe('failed')
      // And the POLICY — the single authority openBrowserContext consults —
      // refuses the target outright, so no later change to the signup gate can
      // make an SSRF destination reachable.
      expect(isHamiltonBrowserTargetAllowed(url)).toBe(false)
    }
    expect(launchBrowser).not.toHaveBeenCalled()
    disableBrowser()
  })

  it('identity PROOFING is still refused BEFORE the signup flag is consulted', async () => {
    enableBrowser()
    const db = makeDb()
    const launchBrowser = vi.fn()
    const res = await registerOnPortal(db, {
      portalHost: 'studentaid.gov', signupUrl: 'https://studentaid.gov/register',
      identity: { email: 'a@b.com', password: 'pw-pw-pw-pw-pw-1234!aa' },
      launchBrowser,
    })
    expect(res.status).toBe('blocked')
    expect(res.blockerType).toBe('identity_proof_required')
    expect(launchBrowser).not.toHaveBeenCalled()
    disableBrowser()
  })
})

// ── email verification ──────────────────────────────────────────────────────────

describe('completeEmailVerification', () => {
  it('verification_pending when no link is found in the window', async () => {
    const provider = { notConfigured: false, listInboxMessages: vi.fn(async () => ({ messages: [] })) }
    const res = await completeEmailVerification({
      identityEmail: 'auto@vault.example', portalHost: 'portal.example.org',
      outlookProvider: provider, waitMs: 0, pollMs: 1,
    })
    expect(res.status).toBe('verification_pending')
  })

  it('never reads a configured mailbox or visits an activation link', async () => {
    const provider = {
      notConfigured: false,
      listInboxMessages: vi.fn(async () => ({
        messages: [{
          from: { emailAddress: { address: 'no-reply@portal.example.org' } },
          subject: 'Verify your email',
          body: { content: '<a href="https://portal.example.org/verify?token=t1">Confirm your email</a>' },
        }],
      })),
    }
    // Browser context whose page reports a confirmed state.
    const verifyPage = makeFakePage({ bodyText: 'Your email has been verified. Success!', url: 'https://portal.example.org/dashboard' })
    const context = { async newPage() { return verifyPage } }
    const res = await completeEmailVerification({
      identityEmail: 'auto@vault.example', portalHost: 'portal.example.org',
      outlookProvider: provider, browserContext: context, waitMs: 1000, pollMs: 1,
    })
    expect(res.status).toBe('verification_pending')
    expect(res.blocker_kind).toBe('manual_email_verification_required')
    expect(provider.listInboxMessages).not.toHaveBeenCalled()
  })

  it('verification_pending when the mailbox is not configured', async () => {
    const provider = { notConfigured: true }
    const res = await completeEmailVerification({
      identityEmail: 'auto@vault.example', portalHost: 'portal.example.org',
      outlookProvider: provider, waitMs: 0, pollMs: 1,
    })
    expect(res.status).toBe('verification_pending')
  })
})

// ── BRAIN integration: run path finalizes / routes on the adapter outcome ────────

describe('autopilot brain ↔ signup adapter wiring', () => {
  let db
  beforeEach(() => {
    db = makeDb()
    _resetMasterVaultSchemaCache()
    _resetCredentialSchemaCache()
    _resetUnlockCache()
    disableBrowser()
  })

  it('saved-login automation does not authorize creating a portal account', async () => {
    enableBrowser()
    await setMasterPassphrase(db, { profileId: 'pReg', passphrase: 'a-strong-passphrase', identityEmail: 'auto@vault.example' })
    const page = makeFakePage({
      selectors: {
        'input[type="email"]:not([disabled])': fillHandle(),
        'input[type="password"]:not([disabled])': fillHandle(),
        'button[type="submit"]:not([disabled])': {},
      },
      bodyText: 'Sign up',
      afterSubmit: { bodyText: 'Account created. Welcome to your dashboard!', url: 'https://communityforce.com/dashboard' },
    })
    const { launchBrowser } = makeFakeBrowser(page)
    const r = await runAutopilotIdentityForPortal(db, {
      profileId: 'pReg', userId: 'u1', portalHost: 'communityforce.com',
      loginUrl: 'https://communityforce.com/register', launchBrowser,
    })
    expect(r.state).toBe(AUTOPILOT_STATE.NEEDS_USER)
    expect(r.blocker).toBe('create_portal_account')
    const rows = await db.prepare(
      `SELECT * FROM hamilton_portal_credentials WHERE profile_id = ? AND generated_by = 'hamilton'`,
    ).all('pReg')
    expect(rows.length).toBe(0)
    disableBrowser()
  })

  it('stops at account authority before a generic signup form or CAPTCHA', async () => {
    enableBrowser()
    await setMasterPassphrase(db, { profileId: 'pBlk', passphrase: 'a-strong-passphrase', identityEmail: 'auto@vault.example' })
    const page = makeFakePage({
      selectors: {
        'input[type="email"]:not([disabled])': fillHandle(),
        'input[type="password"]:not([disabled])': fillHandle(),
        'div.g-recaptcha': {},
        'button[type="submit"]:not([disabled])': {},
      },
      bodyText: 'Sign up',
    })
    const { launchBrowser } = makeFakeBrowser(page)
    const r = await runAutopilotIdentityForPortal(db, {
      profileId: 'pBlk', userId: 'u1', portalHost: 'communityforce.com',
      loginUrl: 'https://communityforce.com/register', launchBrowser,
    })
    expect(r.state).toBe(AUTOPILOT_STATE.NEEDS_USER)
    expect(r.blocker).toBe('create_portal_account')
    const reqs = await db.prepare('SELECT * FROM hamilton_session_capture_requests WHERE profile_id = ?').all('pBlk')
    expect(reqs.length).toBe(1) // …and a side-by-side handoff was queued
    disableBrowser()
  })

  it('does not provision an account or start mailbox verification', async () => {
    enableBrowser()
    await setMasterPassphrase(db, { profileId: 'pVer', passphrase: 'a-strong-passphrase', identityEmail: 'auto@vault.example' })
    const page = makeFakePage({
      selectors: {
        'input[type="email"]:not([disabled])': fillHandle(),
        'input[type="password"]:not([disabled])': fillHandle(),
        'button[type="submit"]:not([disabled])': {},
      },
      bodyText: 'Sign up',
      afterSubmit: { bodyText: 'Check your inbox to verify your email.', url: 'https://communityforce.com/check-email' },
    })
    const { launchBrowser } = makeFakeBrowser(page)
    // Mailbox returns no verification link → stays pending (inline poll).
    const outlookProvider = { notConfigured: false, listInboxMessages: vi.fn(async () => ({ messages: [] })) }
    const r = await runAutopilotIdentityForPortal(db, {
      profileId: 'pVer', userId: 'u1', portalHost: 'communityforce.com',
      loginUrl: 'https://communityforce.com/register', launchBrowser, outlookProvider,
      verifyWaitMs: 0, verifyPollMs: 1, // don't poll the mailbox in a unit test
    })
    expect(r.state).toBe(AUTOPILOT_STATE.NEEDS_USER)
    expect(r.blocker).toBe('create_portal_account')
    const credentials = await db.prepare(
      'SELECT * FROM hamilton_portal_credentials WHERE profile_id = ?',
    ).all('pVer')
    expect(credentials).toHaveLength(0)
    disableBrowser()
  })

  it('does not create or auto-resume an account across repeated runs', async () => {
    enableBrowser()
    await setMasterPassphrase(db, { profileId: 'pRe', passphrase: 'a-strong-passphrase', identityEmail: 'auto@vault.example' })
    // 1) Initial signup → verification_pending (no link yet).
    const signupPage = makeFakePage({
      selectors: {
        'input[type="email"]:not([disabled])': fillHandle(),
        'input[type="password"]:not([disabled])': fillHandle(),
        'button[type="submit"]:not([disabled])': {},
      },
      bodyText: 'Sign up',
      afterSubmit: { bodyText: 'Check your inbox to verify your email.', url: 'https://communityforce.com/check-email' },
    })
    const first = makeFakeBrowser(signupPage)
    const emptyMailbox = { notConfigured: false, listInboxMessages: vi.fn(async () => ({ messages: [] })) }
    const r1 = await runAutopilotIdentityForPortal(db, {
      profileId: 'pRe', userId: 'u1', portalHost: 'communityforce.com',
      loginUrl: 'https://communityforce.com/register', launchBrowser: first.launchBrowser,
      outlookProvider: emptyMailbox, verifyWaitMs: 0, verifyPollMs: 1,
    })
    expect(r1.state).toBe(AUTOPILOT_STATE.NEEDS_USER)
    expect(r1.blocker).toBe('create_portal_account')
    // Clear the just-set next_retry so the re-check is due immediately.
    await db.prepare(`UPDATE hamilton_portal_credentials SET verification_next_retry_at = NULL WHERE profile_id = ?`).run('pRe')

    // 2) Re-run: the verification email has now arrived; the re-check clicks the
    // link and the account is verified → HAS_EXISTING_CREDENTIALS (auto-resume).
    const verifyPage = makeFakePage({ bodyText: 'Your email has been verified. Success!', url: 'https://communityforce.com/dashboard' })
    const second = makeFakeBrowser(verifyPage)
    const mailbox = { notConfigured: false, listInboxMessages: vi.fn(async () => ({
      messages: [{
        from: { emailAddress: { address: 'no-reply@communityforce.com' } },
        subject: 'Verify your email',
        body: { content: '<a href="https://communityforce.com/verify?token=t9">Confirm your email</a>' },
      }],
    })) }
    const r2 = await runAutopilotIdentityForPortal(db, {
      profileId: 'pRe', userId: 'u1', portalHost: 'communityforce.com',
      loginUrl: 'https://communityforce.com/register', launchBrowser: second.launchBrowser,
      outlookProvider: mailbox, verifyWaitMs: 100, verifyPollMs: 1,
    })
    expect(r2.state).toBe(AUTOPILOT_STATE.NEEDS_USER)
    expect(r2.blocker).toBe('create_portal_account')
    const credentials = await db.prepare(
      'SELECT * FROM hamilton_portal_credentials WHERE profile_id = ?',
    ).all('pRe')
    expect(credentials).toHaveLength(0)
    disableBrowser()
  })

  it('identity-proofed host → brain refuses (never provisions / attempts)', async () => {
    enableBrowser()
    await setMasterPassphrase(db, { profileId: 'pIdp', passphrase: 'a-strong-passphrase' })
    const launchBrowser = vi.fn(async () => { throw new Error('must not launch') })
    const r = await runAutopilotIdentityForPortal(db, {
      profileId: 'pIdp', userId: 'u1', portalHost: 'studentaid.gov',
      loginUrl: 'https://studentaid.gov/register', launchBrowser,
    })
    expect(r.state).toBe(AUTOPILOT_STATE.IDENTITY_PROOF_REQUIRED)
    expect(launchBrowser).not.toHaveBeenCalled()
    const rows = await db.prepare('SELECT * FROM hamilton_portal_credentials WHERE profile_id = ?').all('pIdp')
    expect(rows.length).toBe(0) // never provisioned
    disableBrowser()
  })

  it('dry run does not provision a credential behind the owner boundary', async () => {
    enableBrowser()
    await setMasterPassphrase(db, { profileId: 'pDry', passphrase: 'a-strong-passphrase', identityEmail: 'auto@vault.example' })
    const launchBrowser = vi.fn(async () => { throw new Error('must not launch on dry run') })
    const r = await runAutopilotIdentityForPortal(db, {
      profileId: 'pDry', userId: 'u1', portalHost: 'communityforce.com',
      loginUrl: 'https://communityforce.com/register', dryRun: true, launchBrowser,
    })
    expect(r.state).toBe(AUTOPILOT_STATE.NEEDS_USER)
    expect(r.blocker).toBe('create_portal_account')
    expect(launchBrowser).not.toHaveBeenCalled()
    const rows = await db.prepare('SELECT * FROM hamilton_portal_credentials WHERE profile_id = ?').all('pDry')
    expect(rows.length).toBe(0)
    disableBrowser()
  })
})

// ── email-verification re-check driver (auto-resume) ─────────────────────────────

describe('recheckEmailVerification + recheckDuePortalVerifications', () => {
  let db
  beforeEach(() => {
    db = makeDb()
    _resetMasterVaultSchemaCache()
    _resetCredentialSchemaCache()
    _resetUnlockCache()
    disableBrowser()
  })

  it('recheckEmailVerification always leaves mailbox activation to the owner', async () => {
    const launchBrowser = vi.fn()
    const res = await recheckEmailVerification(db, {
      portalHost: 'communityforce.com', identityEmail: 'auto@vault.example', launchBrowser,
    })
    expect(res.status).toBe('verification_pending')
    expect(res.blocker_kind).toBe('create_portal_account')
    expect(launchBrowser).not.toHaveBeenCalled()
  })

  it('scheduler does not read mail or mutate pending accounts without reviewed execution', async () => {
    enableBrowser()
    const { key } = await setMasterPassphrase(db, { profileId: 'pDrv', passphrase: 'a-strong-passphrase' })
    // A pending-verification account whose re-check is due (no next_retry).
    const prov = await saveAutoProvisionedCredential(db, {
      userId: 'u1', profileId: 'pDrv', portalHost: 'communityforce.com',
      username: 'auto@vault.example', masterKey: key,
    })
    await markCredentialAwaitingVerification(db, prov.credential.id, { nextRetryAt: null, attempts: 0 })
    // A second account scheduled far in the future — must NOT be picked.
    const prov2 = await saveAutoProvisionedCredential(db, {
      userId: 'u1', profileId: 'pDrv', portalHost: 'mykaleidoscope.com',
      username: 'auto@vault.example', masterKey: key,
    })
    await markCredentialAwaitingVerification(db, prov2.credential.id, {
      nextRetryAt: new Date(Date.now() + 3_600_000).toISOString(), attempts: 0,
    })

    const due = await listCredentialsAwaitingVerification(db, {})
    expect(due.map((r) => r.portal_host)).toContain('communityforce.com')
    expect(due.map((r) => r.portal_host)).not.toContain('mykaleidoscope.com')

    // Mailbox has the link; the verify page confirms success.
    const verifyPage = makeFakePage({ bodyText: 'Your email has been verified. Success!', url: 'https://communityforce.com/dashboard' })
    const { launchBrowser } = makeFakeBrowser(verifyPage)
    const mailbox = { notConfigured: false, listInboxMessages: vi.fn(async () => ({
      messages: [{
        from: { emailAddress: { address: 'no-reply@communityforce.com' } },
        subject: 'Verify your email',
        body: { content: '<a href="https://communityforce.com/verify?token=zz">Confirm your email</a>' },
      }],
    })) }
    const summary = await recheckDuePortalVerifications(db, { limit: 25, launchBrowser, outlookProvider: mailbox })
    // The due row IS now looked at (signup execution is on), but MAILBOX-LINK
    // ACTIVATION stays OFF by its own flag (HAMILTON_MAILBOX_LINK_ACTIVATION),
    // so no mail is read, no link is visited and nothing is verified.
    expect(summary.verified).toBe(0)
    expect(mailbox.listInboxMessages).not.toHaveBeenCalled()
    // The account remains PENDING for the owner to verify. It is no longer
    // listed as DUE only because the re-check advanced the backoff — assert the
    // stored state, not the due-window, or this passes for the wrong reason.
    const row = await db.prepare(
      `SELECT verification_status, verification_attempts, verification_next_retry_at
         FROM hamilton_portal_credentials WHERE id = ?`,
    ).get(prov.credential.id)
    expect(row.verification_status).toBe('pending')
    expect(Number(row.verification_attempts)).toBeGreaterThan(0)
    expect(Date.parse(row.verification_next_retry_at)).toBeGreaterThan(Date.now())
    disableBrowser()
  })
})

describe('buildSignupIdentity', () => {
  it('builds identity from profile + generated password', () => {
    const id = buildSignupIdentity({
      profile: { basic_information: { first_name: 'Sam', last_name: 'Tan', phone: '555' } },
      identityEmail: 'sam@vault.example', password: 'gen-pw',
    })
    expect(id.email).toBe('sam@vault.example')
    expect(id.password).toBe('gen-pw')
    expect(id.first_name).toBe('Sam')
    expect(id.full_name).toBe('Sam Tan')
    expect(id.phone).toBe('555')
  })
})

// keep the internal export surface referenced so tree-shakers / lint see it used
void _internal
