/**
 * THE KEEP-ALIVE MUST NOT MANUFACTURE LIVENESS (2026-08-01).
 *
 * The sweep decided a session was alive like this:
 *
 *     goto( meta.landing_url || `https://${portal_host}/` )
 *     if classifyBlocker(...) is an auth challenge -> expired
 *     else                                         -> "refreshed"  (alive!)
 *
 * Both halves were broken:
 *   - `landing_url` is READ in hamiltonSessionKeepAlive.js and WRITTEN NOWHERE
 *     in the backend, so the probe always hit the PUBLIC HOMEPAGE;
 *   - `classifyBlocker` returns `unknown` for any page it has no rule for, and
 *     `unknown` was treated as POSITIVE PROOF that we were signed in.
 *
 * Live evidence (repo's own launchPortalBrowser + classifyBlocker, ZERO-cookie
 * context, 2026-08-01):
 *
 *   https://studentaid.gov/       -> 1914 chars of "Manage and Repay Your
 *                                    Federal Student Loans", classify=unknown
 *   https://collegefortn.org/     -> classify=missing_required_document
 *   https://leic.tennessee.edu/   -> classify=unknown
 *
 * All three would be scored "refreshed" while holding NO session. Prod carries
 * `keepalive_refreshes: 11` on studentaid.gov from exactly this.
 *
 * And the signal that DOES mean something, same run:
 *   https://studentaid.gov/my-activity/
 *     -> https://studentaid.gov/fsa-id/sign-in/landing?redirectTo=%2Fmy-activity
 *
 * The page bodies below are the REAL captured text.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

process.env.RUNTIME_SECRETS_KEY = 'f'.repeat(64)

const Database = (await import('better-sqlite3')).default

const { importSession, _resetCredentialSchemaCache, getSessionById } =
  await import('../services/hamilton/hamiltonCredentialSessionService.js')
const { runSessionKeepAliveSweep } = await import('../services/hamilton/hamiltonSessionKeepAlive.js')
const { loadLifetimeLedger, summarizeHostLifetime } =
  await import('../services/hamilton/portalSessionLifetime.js')

const FIXTURE_HOST = 'hamilton-submit-fixture.invalid'
const FIXTURE_ORIGIN = `https://${FIXTURE_HOST}`
// Real innerText captured from the sign-in landing the auth-gated path 302s to.
const STUDENTAID_SIGNIN = 'Log In Email Address or Username Forgot email address or username? '
  + 'Continue Create an Account'
// Signed-IN account content.
const STUDENTAID_MY_ACTIVITY = 'My Activity Demo Student Your recent activity 2026-2027 FAFSA Form '
  + 'Submitted View your aid summary and servicer details below.'

/**
 * Fake Playwright surface. `pages` maps a requested URL to
 * { finalUrl, text } so a test can encode a real redirect.
 */
function makeLauncher(pages, { record = {} } = {}) {
  return async ({ storageState }) => {
    record.storageStateSeen = storageState
    const context = {
      route: async () => {},
      newPage: async () => {
        let current = null
        return {
          goto: async (url) => { record.requested = url; current = pages[url] || null },
          waitForLoadState: async () => {},
          evaluate: async () => (current ? current.text : ''),
          url: () => (current ? (current.finalUrl || record.requested) : 'about:blank'),
        }
      },
      storageState: async () => ({ cookies: [{ name: 'refreshed', value: '1' }], origins: [] }),
    }
    return { browser: { close: async () => {} }, context }
  }
}

async function seedSession(db, { host, establishedAt }) {
  await importSession(db, {
    userId: 'u1', profileId: 'p1', portalHost: host,
    storageState: { cookies: [{ name: 'sid', value: 'abc' }], origins: [] },
    label: `${host} session`,
    metadata: { imported_via: 'cloud_interactive_login', session_established_at: establishedAt },
  })
  // Make the row DUE for a keep-alive (default interval is 24h).
  db.prepare("UPDATE hamilton_saved_sessions SET updated_at = '2020-01-01T00:00:00.000Z'").run()
  return db.prepare('SELECT * FROM hamilton_saved_sessions WHERE portal_host = ?').get(host)
}

describe('keep-alive liveness verdict', () => {
  let db
  beforeEach(() => {
    db = new Database(':memory:')
    _resetCredentialSchemaCache()
  })

  it('a real-domain session is PROBED (not skipped) — Hamilton is now hands-off on real portals', async () => {
    const est = new Date(Date.now() - 3 * 86_400_000).toISOString()
    await seedSession(db, { host: 'leic.tennessee.edu', establishedAt: est })

    // With the controlled-beta boundary removed, Hamilton now attempts to probe
    // real domains.  A launcher that throws causes an `inconclusive` result, NOT
    // `skipped` — the key difference from the old controlled-beta behavior.
    const launchBrowser = vi.fn(async () => { throw new Error('simulated browser-launch failure') })

    const out = await runSessionKeepAliveSweep(db, { launchBrowser })

    // launchBrowser IS called now (real domains are no longer skipped).
    expect(launchBrowser).toHaveBeenCalledOnce()

    // A failed launch is inconclusive, not a permanent skip.
    expect(out.results[0].outcome).toBe('inconclusive')
    // An inconclusive probe contributes neither a refreshed nor an expired count.
    expect(out.refreshed).toBe(0)
    expect(out.expired).toBe(0)

    // Nothing enters the lifetime ledger from an inconclusive probe.
    const s = summarizeHostLifetime(await loadLifetimeLedger(db), 'leic.tennessee.edu')
    expect(s.samples).toBe(0)
    expect(out.observed).toBe(0)

    // The row must NOT carry a confirmed-alive stamp.
    const meta = JSON.parse(
      db.prepare('SELECT metadata_json FROM hamilton_saved_sessions WHERE portal_host = ?')
        .get('leic.tennessee.edu').metadata_json,
    )
    expect(meta.keepalive_confirmed_alive_at).toBeUndefined()
    expect(meta.keepalive_refreshes).toBeUndefined()
  })

  it('probes the auth-gated reserved fixture path without real egress', async () => {
    const est = new Date(Date.now() - 86_400_000).toISOString()
    await seedSession(db, { host: FIXTURE_HOST, establishedAt: est })

    const record = {}
    const launchBrowser = makeLauncher({
      [`${FIXTURE_ORIGIN}/authenticated`]: {
        finalUrl: `${FIXTURE_ORIGIN}/authenticated`,
        text: STUDENTAID_MY_ACTIVITY,
      },
    }, { record })

    const out = await runSessionKeepAliveSweep(db, { launchBrowser })

    expect(record.requested).toBe(`${FIXTURE_ORIGIN}/authenticated`)
    expect(out.refreshed).toBe(1)
    expect(out.observed).toBe(1)

    // A CONFIRMED-alive observation lands as a measured LOWER bound.
    const s = summarizeHostLifetime(await loadLifetimeLedger(db), FIXTURE_HOST)
    expect(s.aliveSamples).toBe(1)
    expect(s.measured).toBe(true)
    expect(s.confirmedAliveMaxMs).toBeGreaterThan(0)

    const meta = JSON.parse(
      db.prepare('SELECT metadata_json FROM hamilton_saved_sessions WHERE portal_host = ?')
        .get(FIXTURE_HOST).metadata_json,
    )
    expect(meta.keepalive_confirmed_alive_at).toBeTruthy()
  })

  it('an auth challenge on the reserved fixture expires the session and records a death', async () => {
    const est = new Date(Date.now() - 2 * 86_400_000).toISOString()
    const row = await seedSession(db, { host: FIXTURE_HOST, establishedAt: est })

    const launchBrowser = makeLauncher({
      [`${FIXTURE_ORIGIN}/authenticated`]: {
        finalUrl: `${FIXTURE_ORIGIN}/login`,
        text: STUDENTAID_SIGNIN,
      },
    })

    const out = await runSessionKeepAliveSweep(db, { launchBrowser })

    // PRE-FIX: this sign-in page classifies as `unknown`, so the old rule
    // scored it "refreshed" — a login wall read as a healthy session.
    expect(out.expired).toBe(1)
    expect(out.refreshed).toBe(0)
    expect(out.results[0].detail).toMatch(/login|sign-in/i)

    const session = await getSessionById(db, row.id)
    expect(session.status).toBe('expired')
    // markSessionExpired MERGES: the consent/establishment record survives, so
    // the death observation has something to be measured against.
    expect(session.metadata.session_established_at).toBe(est)
    expect(session.metadata.expired_reason).toMatch(/login|sign-in/i)

    const s = summarizeHostLifetime(await loadLifetimeLedger(db), FIXTURE_HOST)
    expect(s.deadSamples).toBe(1)
    expect(s.confirmedDeadMinMs).toBeGreaterThan(0)
    expect(s.estimateSource).toBe('measured')
  })

  it('a WALL or an OUTAGE never burns a working session and never records an observation', async () => {
    const est = new Date(Date.now() - 86_400_000).toISOString()
    const row = await seedSession(db, { host: FIXTURE_HOST, establishedAt: est })

    // Akamai-class refusal: navigation throws, nothing is readable.
    const launchBrowser = async () => ({
      browser: { close: async () => {} },
      context: {
        route: async () => {},
        newPage: async () => ({
          goto: async () => { throw new Error('page.goto: net::ERR_HTTP2_PROTOCOL_ERROR') },
          waitForLoadState: async () => {},
          evaluate: async () => '',
          url: () => 'about:blank',
        }),
        storageState: async () => ({ cookies: [], origins: [] }),
      },
    })

    const out = await runSessionKeepAliveSweep(db, { launchBrowser })
    expect(out.inconclusive).toBe(1)
    expect(out.expired).toBe(0)
    expect(out.observed).toBe(0)
    expect((await getSessionById(db, row.id)).status).toBe('valid')
    expect(summarizeHostLifetime(await loadLifetimeLedger(db), FIXTURE_HOST).samples).toBe(0)
  })

  it('a keep-alive refresh does NOT move the human establishment clock', async () => {
    // Prod row 9d9f6b55 showed 11 days of drift: created 2026-07-21, but
    // established_at dragged to 2026-08-01 by 11 cookie refreshes. The
    // establishment stamp must survive a refresh, or every measured age is wrong.
    const est = new Date(Date.now() - 5 * 86_400_000).toISOString()
    await seedSession(db, { host: FIXTURE_HOST, establishedAt: est })

    const launchBrowser = makeLauncher({
      [`${FIXTURE_ORIGIN}/authenticated`]: {
        finalUrl: `${FIXTURE_ORIGIN}/authenticated`, text: STUDENTAID_MY_ACTIVITY,
      },
    })
    await runSessionKeepAliveSweep(db, { launchBrowser })

    const meta = JSON.parse(
      db.prepare('SELECT metadata_json FROM hamilton_saved_sessions WHERE portal_host = ?')
        .get(FIXTURE_HOST).metadata_json,
    )
    expect(meta.imported_via).toBe('session_keepalive_refresh')
    expect(meta.session_established_at).toBe(est) // unchanged by the refresh

    // …so the recorded age reflects 5 days of real session life, not ~0.
    const s = summarizeHostLifetime(await loadLifetimeLedger(db), FIXTURE_HOST)
    expect(s.confirmedAliveMaxMs).toBeGreaterThan(4.5 * 86_400_000)
  })
})
