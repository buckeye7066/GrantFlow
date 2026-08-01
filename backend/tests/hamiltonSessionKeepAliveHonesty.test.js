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

import { describe, it, expect, beforeEach } from 'vitest'

process.env.RUNTIME_SECRETS_KEY = 'f'.repeat(64)

const Database = (await import('better-sqlite3')).default

const { importSession, _resetCredentialSchemaCache, getSessionById } =
  await import('../services/hamilton/hamiltonCredentialSessionService.js')
const { runSessionKeepAliveSweep } = await import('../services/hamilton/hamiltonSessionKeepAlive.js')
const { loadLifetimeLedger, summarizeHostLifetime } =
  await import('../services/hamilton/portalSessionLifetime.js')

// Real innerText captured from the live public homepage, signed OUT.
const STUDENTAID_PUBLIC_HOME = 'Manage and Repay Your Federal Student Loans Get Repayment Tips '
  + 'View Your Loans POPULAR TOPICS Compare Plans With Our Repayment Calculator Find Your Student '
  + 'Loan Servicer Apply for an Income-Driven Repayment Plan Complete Your FAFSA Form'
// Real innerText captured from the sign-in landing the auth-gated path 302s to.
const STUDENTAID_SIGNIN = 'Log In Email Address or Username Forgot email address or username? '
  + 'Continue Create an Account'
// Signed-IN account content.
const STUDENTAID_MY_ACTIVITY = 'My Activity Anastasia Your recent activity 2026-2027 FAFSA Form '
  + 'Submitted View your aid summary and servicer details below.'

/**
 * Fake Playwright surface. `pages` maps a requested URL to
 * { finalUrl, text } so a test can encode a real redirect.
 */
function makeLauncher(pages, { record = {} } = {}) {
  return async ({ storageState }) => {
    record.storageStateSeen = storageState
    const context = {
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

  it('a PUBLIC page can never be scored "refreshed" — the exact prod false positive', async () => {
    // leic.tennessee.edu has NO auth-gated probe path in the registry, so the
    // only page we can reach is public and tells us nothing.
    const est = new Date(Date.now() - 3 * 86_400_000).toISOString()
    await seedSession(db, { host: 'leic.tennessee.edu', establishedAt: est })

    const record = {}
    const launchBrowser = makeLauncher({
      'https://leic.tennessee.edu/': {
        finalUrl: 'https://leic.tennessee.edu/',
        text: 'University of Tennessee Institute for Public Service Give To IPS Forensics & '
          + 'Investigative Communication Leadership Specialized Training About',
      },
    }, { record })

    const out = await runSessionKeepAliveSweep(db, { launchBrowser })

    // PRE-FIX this was `refreshed: 1`. Cookies are still re-saved, but no
    // liveness is claimed.
    expect(out.refreshed).toBe(0)
    expect(out.unverified).toBe(1)
    expect(out.expired).toBe(0)
    expect(out.results[0].outcome).toBe('unverified')

    // And nothing enters the lifetime ledger from a probe that could not tell.
    const s = summarizeHostLifetime(await loadLifetimeLedger(db), 'leic.tennessee.edu')
    expect(s.samples).toBe(0)
    expect(out.observed).toBe(0)

    // The row must NOT carry a confirmed-alive stamp.
    const meta = JSON.parse(
      db.prepare('SELECT metadata_json FROM hamilton_saved_sessions WHERE portal_host = ?')
        .get('leic.tennessee.edu').metadata_json,
    )
    expect(meta.keepalive_confirmed_alive_at).toBeUndefined()
    expect(meta.keepalive_refreshes).toBe(1) // cookie jar did get refreshed
  })

  it('probes the AUTH-GATED path for a registered host, not the homepage', async () => {
    const est = new Date(Date.now() - 86_400_000).toISOString()
    await seedSession(db, { host: 'studentaid.gov', establishedAt: est })

    const record = {}
    const launchBrowser = makeLauncher({
      'https://studentaid.gov/my-activity/': {
        finalUrl: 'https://studentaid.gov/my-activity/',
        text: STUDENTAID_MY_ACTIVITY,
      },
      'https://studentaid.gov/': { finalUrl: 'https://studentaid.gov/', text: STUDENTAID_PUBLIC_HOME },
    }, { record })

    const out = await runSessionKeepAliveSweep(db, { launchBrowser })

    expect(record.requested).toBe('https://studentaid.gov/my-activity/')
    expect(out.refreshed).toBe(1)
    expect(out.observed).toBe(1)

    // A CONFIRMED-alive observation lands as a measured LOWER bound.
    const s = summarizeHostLifetime(await loadLifetimeLedger(db), 'studentaid.gov')
    expect(s.aliveSamples).toBe(1)
    expect(s.measured).toBe(true)
    expect(s.confirmedAliveMaxMs).toBeGreaterThan(0)

    const meta = JSON.parse(
      db.prepare('SELECT metadata_json FROM hamilton_saved_sessions WHERE portal_host = ?')
        .get('studentaid.gov').metadata_json,
    )
    expect(meta.keepalive_confirmed_alive_at).toBeTruthy()
  })

  it('an auth-gated redirect to the sign-in surface EXPIRES the session and is recorded as a death', async () => {
    const est = new Date(Date.now() - 2 * 86_400_000).toISOString()
    const row = await seedSession(db, { host: 'studentaid.gov', establishedAt: est })

    const launchBrowser = makeLauncher({
      'https://studentaid.gov/my-activity/': {
        // The REAL redirect measured live.
        finalUrl: 'https://studentaid.gov/fsa-id/sign-in/landing?redirectTo=%2Fmy-activity',
        text: STUDENTAID_SIGNIN,
      },
    })

    const out = await runSessionKeepAliveSweep(db, { launchBrowser })

    // PRE-FIX: this sign-in page classifies as `unknown`, so the old rule
    // scored it "refreshed" — a login wall read as a healthy session.
    expect(out.expired).toBe(1)
    expect(out.refreshed).toBe(0)
    expect(out.results[0].detail).toMatch(/sign-in/i)

    const session = await getSessionById(db, row.id)
    expect(session.status).toBe('expired')
    // markSessionExpired MERGES: the consent/establishment record survives, so
    // the death observation has something to be measured against.
    expect(session.metadata.session_established_at).toBe(est)
    expect(session.metadata.expired_reason).toMatch(/sign-in/i)

    const s = summarizeHostLifetime(await loadLifetimeLedger(db), 'studentaid.gov')
    expect(s.deadSamples).toBe(1)
    expect(s.confirmedDeadMinMs).toBeGreaterThan(0)
    expect(s.estimateSource).toBe('measured')
  })

  it('a WALL or an OUTAGE never burns a working session and never records an observation', async () => {
    const est = new Date(Date.now() - 86_400_000).toISOString()
    const row = await seedSession(db, { host: 'studentaid.gov', establishedAt: est })

    // Akamai-class refusal: navigation throws, nothing is readable.
    const launchBrowser = async () => ({
      browser: { close: async () => {} },
      context: {
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
    expect(summarizeHostLifetime(await loadLifetimeLedger(db), 'studentaid.gov').samples).toBe(0)
  })

  it('a keep-alive refresh does NOT move the human establishment clock', async () => {
    // Prod row 9d9f6b55 showed 11 days of drift: created 2026-07-21, but
    // established_at dragged to 2026-08-01 by 11 cookie refreshes. The
    // establishment stamp must survive a refresh, or every measured age is wrong.
    const est = new Date(Date.now() - 5 * 86_400_000).toISOString()
    await seedSession(db, { host: 'studentaid.gov', establishedAt: est })

    const launchBrowser = makeLauncher({
      'https://studentaid.gov/my-activity/': {
        finalUrl: 'https://studentaid.gov/my-activity/', text: STUDENTAID_MY_ACTIVITY,
      },
    })
    await runSessionKeepAliveSweep(db, { launchBrowser })

    const meta = JSON.parse(
      db.prepare('SELECT metadata_json FROM hamilton_saved_sessions WHERE portal_host = ?')
        .get('studentaid.gov').metadata_json,
    )
    expect(meta.imported_via).toBe('session_keepalive_refresh')
    expect(meta.session_established_at).toBe(est) // unchanged by the refresh

    // …so the recorded age reflects 5 days of real session life, not ~0.
    const s = summarizeHostLifetime(await loadLifetimeLedger(db), 'studentaid.gov')
    expect(s.confirmedAliveMaxMs).toBeGreaterThan(4.5 * 86_400_000)
  })
})
