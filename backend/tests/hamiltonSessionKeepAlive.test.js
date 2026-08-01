/**
 * Hamilton session KEEP-ALIVE — the sweep that stops captured portal sessions
 * (MTSU/AcademicWorks, studentaid.gov) from lapsing by pure inactivity and
 * regressing tiles to "Can't auto-merge — open side-by-side login".
 *
 * Correctness rules under test:
 *   - probe on a host with NO auth-gated path → storage state RE-PERSISTED, but
 *     the outcome is UNVERIFIED, not "refreshed" (see below)
 *   - real auth challenge   → session expired + household notified once
 *   - bot wall / outage / thin page → INCONCLUSIVE: the session is NEVER touched
 *     (an outage never burns — expiring on a datacenter wall would kill a
 *     working session, the studentaid.gov Akamai class)
 *   - cadence: a freshly-refreshed session is not re-probed
 *
 * NOTE (2026-08-01): this file used to assert that a page which merely FAILED to
 * look like a login wall proved the session was alive ("still signed in →
 * REFRESHES"). It does not. `landing_url` was never written by anything, so the
 * probe hit the PUBLIC homepage, and `classifyBlocker` returns `unknown` for any
 * page it has no rule for — so a cookie-less browser scored "refreshed" on
 * studentaid.gov, collegefortn.org and leic.tennessee.edu alike (verified live).
 * `mtsu.edu` has no registered auth-gated probe path, so the honest outcome here
 * is UNVERIFIED. Confirmed-alive/confirmed-dead behavior is covered in
 * `hamiltonSessionKeepAliveHonesty.test.js`.
 *
 * Playwright is fully mocked — no network, no real browser.
 */

import { describe, it, expect, beforeEach } from 'vitest'

process.env.RUNTIME_SECRETS_KEY = 'a'.repeat(64)

const Database = (await import('better-sqlite3')).default

const {
  importSession, findValidSession, _resetCredentialSchemaCache,
} = await import('../services/hamilton/hamiltonCredentialSessionService.js')
const {
  runSessionKeepAliveSweep, isSessionDueForKeepAlive,
} = await import('../services/hamilton/hamiltonSessionKeepAlive.js')

function makeDb() { return new Database(':memory:') }

const STORAGE_STATE = { cookies: [{ name: 'session', value: 'abc', domain: '.mtsu.edu' }], origins: [] }
const OLD = '2020-01-01T00:00:00.000Z'

async function seedSession(db, { host = 'mtsu.edu', keepaliveAt = OLD, profileId = 'p1' } = {}) {
  return importSession(db, {
    userId: 'u1', profileId, portalHost: host,
    storageState: STORAGE_STATE,
    metadata: { keepalive_at: keepaliveAt },
  })
}

// Fake Playwright surface: launcher returns { browser, context }; context yields
// one page whose goto/evaluate behavior the test controls.
function makeFakeLauncher({ bodyText = '', url = 'https://mtsu.edu/dashboard', gotoError = null } = {}) {
  const calls = { storageStateReads: 0, closed: 0 }
  const page = {
    goto: async () => { if (gotoError) throw new Error(gotoError) },
    waitForLoadState: async () => {},
    evaluate: async () => bodyText,
    url: () => url,
  }
  const context = {
    newPage: async () => page,
    storageState: async () => { calls.storageStateReads += 1; return { ...STORAGE_STATE, cookies: [...STORAGE_STATE.cookies, { name: 'refreshed', value: 'yes', domain: '.mtsu.edu' }] } },
  }
  const browser = { close: async () => { calls.closed += 1 } }
  return { launcher: async () => ({ browser, context }), calls }
}

beforeEach(() => { _resetCredentialSchemaCache() })

describe('isSessionDueForKeepAlive', () => {
  it('due when never touched or stale; not due when freshly refreshed', () => {
    const interval = 24 * 60 * 60 * 1000
    const now = Date.now()
    expect(isSessionDueForKeepAlive({ metadata_json: '{}' }, now, interval)).toBe(true)
    expect(isSessionDueForKeepAlive({ metadata_json: JSON.stringify({ keepalive_at: OLD }) }, now, interval)).toBe(true)
    expect(isSessionDueForKeepAlive({ metadata_json: JSON.stringify({ keepalive_at: new Date(now - 1000).toISOString() }) }, now, interval)).toBe(false)
  })
})

describe('runSessionKeepAliveSweep', () => {
  it('no auth-gated probe path → UNVERIFIED: cookies re-persisted, liveness NOT claimed', async () => {
    const db = makeDb()
    await seedSession(db)
    // Account-looking copy on a page we reached WITHOUT requesting anything
    // auth-gated. It reads like a dashboard, but a signed-out visitor to the
    // same URL sees a page that scores identically — so this is not evidence.
    const { launcher, calls } = makeFakeLauncher({
      bodyText: 'Welcome back, Anastasia. Your scholarship dashboard. Awards overview. Messages.',
    })
    const out = await runSessionKeepAliveSweep(db, { launchBrowser: launcher })
    expect(out.checked).toBe(1)
    expect(out.unverified).toBe(1)
    expect(out.refreshed).toBe(0)   // liveness is never claimed without proof
    expect(out.observed).toBe(0)    // …and nothing enters the lifetime ledger
    // The cookie jar IS still refreshed — that is free and useful either way.
    expect(calls.storageStateReads).toBe(1)
    expect(calls.closed).toBe(1)
    const sess = await findValidSession(db, { profileId: 'p1', portalHost: 'mtsu.edu' })
    expect(sess).not.toBeNull()
    expect(sess.metadata.keepalive_refreshes).toBe(1)
    expect(sess.metadata.imported_via).toBe('session_keepalive_refresh')
    expect(sess.metadata.keepalive_confirmed_alive_at).toBeUndefined()
  })

  it('auth challenge → EXPIRES the session and notifies once', async () => {
    const db = makeDb()
    const seeded = await seedSession(db)
    const { launcher } = makeFakeLauncher({
      bodyText: 'Please sign in to continue. Enter your password. Forgot your password?',
      url: 'https://mtsu.edu/login',
    })
    const out = await runSessionKeepAliveSweep(db, { launchBrowser: launcher })
    expect(out.expired).toBe(1)
    const row = db.prepare('SELECT status FROM hamilton_saved_sessions WHERE id = ?').get(seeded.id)
    expect(row.status).toBe('expired')
    expect(await findValidSession(db, { profileId: 'p1', portalHost: 'mtsu.edu' })).toBeNull()
    // Household got the precise ask (best-effort table; type is the contract).
    const notif = db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE type = 'hamilton_session_capture_needed'").get()
    expect(Number(notif.c)).toBeGreaterThanOrEqual(1)
  })

  it('datacenter bot wall (Akamai class) → INCONCLUSIVE: session untouched', async () => {
    const db = makeDb()
    const seeded = await seedSession(db, { host: 'studentaid.gov' })
    const { launcher } = makeFakeLauncher({ gotoError: 'page.goto: net::ERR_HTTP2_PROTOCOL_ERROR' })
    const out = await runSessionKeepAliveSweep(db, { launchBrowser: launcher })
    expect(out.inconclusive).toBe(1)
    expect(out.expired).toBe(0)
    const row = db.prepare('SELECT status FROM hamilton_saved_sessions WHERE id = ?').get(seeded.id)
    expect(row.status).toBe('valid')
  })

  it('anti-bot interstitial page text → INCONCLUSIVE: session untouched', async () => {
    const db = makeDb()
    const seeded = await seedSession(db)
    const { launcher } = makeFakeLauncher({
      bodyText: 'Checking your browser before accessing. Cloudflare Ray ID: 123abc. Please wait while we verify you are a human.',
    })
    const out = await runSessionKeepAliveSweep(db, { launchBrowser: launcher })
    expect(out.inconclusive).toBe(1)
    const row = db.prepare('SELECT status FROM hamilton_saved_sessions WHERE id = ?').get(seeded.id)
    expect(row.status).toBe('valid')
  })

  it('thin/blank page (JS shell) → INCONCLUSIVE: never expires on silence', async () => {
    const db = makeDb()
    const seeded = await seedSession(db)
    const { launcher } = makeFakeLauncher({ bodyText: '' })
    const out = await runSessionKeepAliveSweep(db, { launchBrowser: launcher })
    expect(out.inconclusive).toBe(1)
    const row = db.prepare('SELECT status FROM hamilton_saved_sessions WHERE id = ?').get(seeded.id)
    expect(row.status).toBe('valid')
  })

  it('a freshly-refreshed session is NOT re-probed (cadence)', async () => {
    const db = makeDb()
    await seedSession(db, { keepaliveAt: new Date().toISOString() })
    const { launcher, calls } = makeFakeLauncher({ bodyText: 'irrelevant' })
    const out = await runSessionKeepAliveSweep(db, { launchBrowser: launcher })
    expect(out.checked).toBe(0)
    expect(calls.storageStateReads).toBe(0)
  })

  it('bounded by limit', async () => {
    const db = makeDb()
    await seedSession(db, { host: 'mtsu.edu', profileId: 'p1' })
    await seedSession(db, { host: 'studentaid.gov', profileId: 'p1' })
    await seedSession(db, { host: 'collegefortn.org', profileId: 'p2' })
    const { launcher } = makeFakeLauncher({
      bodyText: 'Welcome back. Your scholarship dashboard. Awards overview.',
    })
    const out = await runSessionKeepAliveSweep(db, { launchBrowser: launcher, limit: 2 })
    expect(out.checked).toBe(2)
  })
})
