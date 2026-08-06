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
    const launchBrowser = vi.fn(async () => { throw new Error('must not launch') })
    const res = await registerOnPortal(db, {
      portalHost: 'communityforce.com', signupUrl: 'https://communityforce.com/register',
      identity: { email: 'a@b.com', password: 'pw-pw-pw-pw-pw-pw-1234!' },
      launchBrowser,
    })
    expect(res.status).toBe('blocked')
    expect(res.blockerType).toBe('create_portal_account')
    expect(res.evidence?.signal).toBe('reviewed_signup_adapter_required')
    expect(launchBrowser).not.toHaveBeenCalled()
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

  it('fails closed at the reviewed-adapter gate before browser settings matter', async () => {
    disableBrowser()
    const db = makeDb()
    const launchBrowser = vi.fn()
    const res = await registerOnPortal(db, {
      portalHost: 'communityforce.com', signupUrl: 'https://communityforce.com/register',
      identity: { email: 'a@b.com', password: 'pw-pw-pw-pw-pw-1234!aa' },
      launchBrowser,
    })
    expect(res.status).toBe('blocked')
    expect(res.blockerType).toBe('create_portal_account')
    expect(launchBrowser).not.toHaveBeenCalled()
  })

  it('fails closed before an allowlisted-browser decision can launch', async () => {
    enableBrowser('tn.gov')
    const db = makeDb()
    const launchBrowser = vi.fn()
    const res = await registerOnPortal(db, {
      portalHost: 'communityforce.com', signupUrl: 'https://communityforce.com/register',
      identity: { email: 'a@b.com', password: 'pw-pw-pw-pw-pw-1234!aa' },
      launchBrowser,
    })
    expect(res.status).toBe('blocked')
    expect(res.blockerType).toBe('create_portal_account')
    expect(launchBrowser).not.toHaveBeenCalled()
    disableBrowser()
  })

  it('does not let dry-run bypass the reviewed account-creation boundary', async () => {
    enableBrowser()
    const db = makeDb()
    const launchBrowser = vi.fn()
    const res = await registerOnPortal(db, {
      portalHost: 'communityforce.com', signupUrl: 'https://communityforce.com/register',
      identity: { email: 'a@b.com', password: 'pw-pw-pw-pw-pw-1234!aa' },
      dryRun: true, launchBrowser,
    })
    expect(res.status).toBe('blocked')
    expect(res.blockerType).toBe('create_portal_account')
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

// ── Production brain boundary ─────────────────────────────────────────────────

describe('autopilot brain account-creation boundary', () => {
  let db
  beforeEach(() => {
    db = makeDb()
    _resetMasterVaultSchemaCache()
    _resetCredentialSchemaCache()
    _resetUnlockCache()
    disableBrowser()
  })

  it('does not infer account-creation authority from saved-login automation', async () => {
    enableBrowser()
    const launchBrowser = vi.fn(async () => { throw new Error('must not launch') })
    const r = await runAutopilotIdentityForPortal(db, {
      profileId: 'pNoAuthority', userId: 'u1', portalHost: 'communityforce.com',
      loginUrl: 'https://communityforce.com/register', launchBrowser,
    })
    expect(r.state).toBe(AUTOPILOT_STATE.NEEDS_USER)
    expect(r.blocker).toBe('create_portal_account')
    expect(r.detail).toMatch(/does not authorize/i)
    expect(launchBrowser).not.toHaveBeenCalled()
    const credentials = db.prepare('SELECT * FROM hamilton_portal_credentials WHERE profile_id = ?').all('pNoAuthority')
    expect(credentials).toHaveLength(0)
  })

  it('still requires an enabled reviewed adapter after separate authority is present', async () => {
    enableBrowser()
    const launchBrowser = vi.fn(async () => { throw new Error('must not launch') })
    const r = await runAutopilotIdentityForPortal(db, {
      profileId: 'pSeparateAuthority', userId: 'u1', portalHost: 'communityforce.com',
      loginUrl: 'https://communityforce.com/register', launchBrowser,
      createPortalAccountAuthorized: true,
      reviewedSignupAdapter: { reviewed: true, id: 'forged-review' },
    })
    expect(r.state).toBe(AUTOPILOT_STATE.NEEDS_USER)
    expect(r.blocker).toBe('create_portal_account')
    expect(r.detail).toMatch(/no reviewed account-creation adapter is enabled/i)
    expect(launchBrowser).not.toHaveBeenCalled()
    const credentials = db.prepare('SELECT * FROM hamilton_portal_credentials WHERE profile_id = ?').all('pSeparateAuthority')
    expect(credentials).toHaveLength(0)
  })

  it('keeps identity-proofed portals on their more specific human boundary', async () => {
    enableBrowser()
    const launchBrowser = vi.fn(async () => { throw new Error('must not launch') })
    const r = await runAutopilotIdentityForPortal(db, {
      profileId: 'pIdp', userId: 'u1', portalHost: 'studentaid.gov',
      loginUrl: 'https://studentaid.gov/register', launchBrowser,
      createPortalAccountAuthorized: true,
    })
    expect(r.state).toBe(AUTOPILOT_STATE.IDENTITY_PROOF_REQUIRED)
    expect(launchBrowser).not.toHaveBeenCalled()
    const credentials = db.prepare('SELECT * FROM hamilton_portal_credentials WHERE profile_id = ?').all('pIdp')
    expect(credentials).toHaveLength(0)
  })
})

describe('manual email-verification boundary', () => {
  it('does not launch a browser for a verification recheck', async () => {
    const db = makeDb()
    const launchBrowser = vi.fn()
    const mailbox = { listInboxMessages: vi.fn() }
    const res = await recheckEmailVerification(db, {
      portalHost: 'communityforce.com', identityEmail: 'auto@vault.example',
      launchBrowser, outlookProvider: mailbox,
    })
    expect(res.status).toBe('verification_pending')
    expect(res.blocker_kind).toBe('manual_email_verification_required')
    expect(launchBrowser).not.toHaveBeenCalled()
    expect(mailbox.listInboxMessages).not.toHaveBeenCalled()
  })

  it('scheduler leaves pending accounts for the owner and reads no mailbox', async () => {
    const db = makeDb()
    _resetMasterVaultSchemaCache()
    _resetCredentialSchemaCache()
    _resetUnlockCache()
    const { key } = await setMasterPassphrase(db, {
      profileId: 'pDrv', passphrase: 'a-strong-passphrase',
    })
    const provisioned = await saveAutoProvisionedCredential(db, {
      userId: 'u1', profileId: 'pDrv', portalHost: 'communityforce.com',
      username: 'auto@vault.example', masterKey: key,
    })
    await markCredentialAwaitingVerification(db, provisioned.credential.id, {
      nextRetryAt: null, attempts: 0,
    })
    const launchBrowser = vi.fn()
    const mailbox = { listInboxMessages: vi.fn() }
    const summary = await recheckDuePortalVerifications(db, {
      limit: 25, launchBrowser, outlookProvider: mailbox,
    })
    expect(summary).toMatchObject({ checked: 0, verified: 0 })
    expect(launchBrowser).not.toHaveBeenCalled()
    expect(mailbox.listInboxMessages).not.toHaveBeenCalled()
    const stillPending = await listCredentialsAwaitingVerification(db, {})
    expect(stillPending.map((row) => row.portal_host)).toContain('communityforce.com')
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
