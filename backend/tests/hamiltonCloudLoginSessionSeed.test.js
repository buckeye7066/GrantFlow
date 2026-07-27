/**
 * Cloud-login / watched-open session SEEDING — the "side-by-side open takes the
 * portal offline" regression.
 *
 * ROOT CAUSE GUARDED HERE: startCloudLogin launched every live co-browse
 * context COLD (no storageState), even when Hamilton already held a valid
 * captured session for that profile + portal. So:
 *   1. the side-by-side window rendered the portal SIGNED OUT ("it went
 *      offline the moment I opened it with Hamilton"), and
 *   2. clicking "Done — I've finished logging in" captured that signed-out
 *      cookie jar (real portals always set tracker/CSRF cookies, so the
 *      empty_session guard passed) and the complete route's importSession
 *      OVERWROTE the existing valid row in place — destroying the agent's
 *      working session. The next keepalive probe / automation run hit the
 *      login wall, markSessionExpired fired, and the tile flipped to "Can't
 *      auto-merge — open side-by-side login": Hamilton went offline for that
 *      portal, reproducibly, caused by the flow meant to keep it fresh.
 *
 * THE FIX: startCloudLogin({ ..., db }) seeds the self_hosted context with the
 * profile's existing valid saved session (findValidSession +
 * getSessionStorageState — the exact reuse path the keepalive sweep proves
 * works), so the co-browse lands signed in and "Done" re-captures a refreshed
 * SUPERSET of the same session (the keepalive "refresh, never replace"
 * semantic). Every test in this file fails on the pre-fix code.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

process.env.RUNTIME_SECRETS_KEY = 'e'.repeat(64)
process.env.HAMILTON_CLOUD_LOGIN_PROVIDER = 'self_hosted'

const Database = (await import('better-sqlite3')).default
const {
  importSession, getSessionStorageState, listSessionsForProfile,
  _resetCredentialSchemaCache,
} = await import('../services/hamilton/hamiltonCredentialSessionService.js')
const { startCloudLogin, completeCloudLogin, cancelCloudLogin } =
  await import('../services/hamilton/hamiltonCloudLogin.js')

function makeDb() { return new Database(':memory:') }

// The agent's working, authenticated session for the portal.
const AGENT_STATE = {
  cookies: [{ name: 'sid', value: 'agent-authenticated', domain: 'mtsu.edu', path: '/' }],
  origins: [],
}
// What a COLD (signed-out) visit to a real portal yields: never empty — portals
// always set tracker/CSRF cookies, which is exactly why the empty_session guard
// could not catch the old overwrite.
const COLD_JAR = {
  cookies: [{ name: 'csrf', value: 'anonymous-visitor', domain: 'mtsu.edu', path: '/' }],
  origins: [],
}

/**
 * Fake injected launcher (the runSessionKeepAliveSweep convention). The fake
 * context ECHOES back the storageState it was created with — modelling a real
 * portal visit, which only ADDS cookies on top of what the context carried.
 */
function makeFakeLaunch() {
  const newContext = vi.fn(async (opts = {}) => {
    const ctx = {
      opts,
      newPage: async () => ({
        goto: vi.fn(async () => {}),
        url: () => 'https://mtsu.edu/landing',
        viewportSize: () => ({ width: 1280, height: 900 }),
        context: () => ctx,
      }),
      storageState: async () => opts.storageState || COLD_JAR,
    }
    return ctx
  })
  const browser = { newContext, close: vi.fn(async () => {}) }
  const launchBrowser = vi.fn(async () => ({ browser, engine: 'fake' }))
  return { launchBrowser, browser, newContext }
}

let liveIds = []
async function startWatched(db, launchBrowser, overrides = {}) {
  const res = await startCloudLogin({
    userId: 'u1',
    profileId: 'pA',
    portalHost: 'mtsu.edu',
    loginUrl: 'https://mtsu.edu/login',
    label: 'MTSU',
    db,
    launchBrowser,
    ...overrides,
  })
  if (res?.liveSessionId) liveIds.push(res.liveSessionId)
  return res
}

describe('startCloudLogin seeds the live context from the saved session', () => {
  let db
  beforeEach(() => { db = makeDb(); _resetCredentialSchemaCache(); liveIds = [] })
  afterEach(async () => {
    // Never leak live sessions into the module-global map across tests.
    for (const id of liveIds) await cancelCloudLogin(id)
    vi.clearAllMocks()
  })

  it('a watched open of a portal with an EXISTING valid session launches SIGNED IN (storageState seeded)', async () => {
    await importSession(db, {
      userId: 'u1', profileId: 'pA', portalHost: 'mtsu.edu', storageState: AGENT_STATE,
    })
    const { launchBrowser, newContext } = makeFakeLaunch()

    const res = await startWatched(db, launchBrowser)

    expect(res.ok).toBe(true)
    expect(res.seeded).toBe(true)
    expect(newContext).toHaveBeenCalledTimes(1)
    // The live co-browse context carries the agent's authenticated cookies —
    // the portal renders signed in, not "offline".
    expect(newContext.mock.calls[0][0].storageState).toEqual(AGENT_STATE)
  })

  it('"Done" after a seeded watched open REFRESHES the saved session — the agent cookie survives (the offline-portal regression)', async () => {
    await importSession(db, {
      userId: 'u1', profileId: 'pA', portalHost: 'mtsu.edu', storageState: AGENT_STATE,
    })
    const { launchBrowser } = makeFakeLaunch()
    const res = await startWatched(db, launchBrowser)
    expect(res.ok).toBe(true)

    // The user clicks "Done" — the route captures the live context's state and
    // imports it over the same (user, profile, host) row.
    const captured = await completeCloudLogin(res.liveSessionId)
    expect(captured.ok).toBe(true)
    await importSession(db, {
      userId: 'u1', profileId: 'pA', portalHost: 'mtsu.edu',
      storageState: captured.storageState,
      metadata: { imported_via: 'cloud_interactive_login' },
    })

    // ON THE OLD CODE the context started cold, so the capture was the
    // signed-out COLD_JAR and this import DESTROYED the agent session — the
    // portal then went offline for Hamilton on the next run. With seeding the
    // re-import is a refresh: the authenticated cookie is still there.
    const rows = await listSessionsForProfile(db, 'pA')
    expect(rows).toHaveLength(1)
    const stored = await getSessionStorageState(db, rows[0].id)
    expect(stored.cookies.map((c) => c.name)).toContain('sid')
    expect(stored.cookies.find((c) => c.name === 'sid').value).toBe('agent-authenticated')
  })

  it('no saved session → honest cold start (no storageState), reported seeded:false', async () => {
    const { launchBrowser, newContext } = makeFakeLaunch()
    const res = await startWatched(db, launchBrowser)
    expect(res.ok).toBe(true)
    expect(res.seeded).toBe(false)
    expect(newContext.mock.calls[0][0].storageState).toBeUndefined()
  })

  it('another profile\'s session for the same host is NEVER seeded (profile-scoped lookup)', async () => {
    await importSession(db, {
      userId: 'u2', profileId: 'pOTHER', portalHost: 'mtsu.edu', storageState: AGENT_STATE,
    })
    const { launchBrowser, newContext } = makeFakeLaunch()
    const res = await startWatched(db, launchBrowser)
    expect(res.ok).toBe(true)
    expect(res.seeded).toBe(false)
    expect(newContext.mock.calls[0][0].storageState).toBeUndefined()
  })

  it('a broken seed lookup never blocks the login start (best-effort degrade to cold)', async () => {
    const brokenDb = {
      prepare: () => { throw new Error('boom') },
      exec: () => { throw new Error('boom') },
    }
    const { launchBrowser, newContext } = makeFakeLaunch()
    const res = await startWatched(brokenDb, launchBrowser)
    expect(res.ok).toBe(true)
    expect(res.seeded).toBe(false)
    expect(newContext).toHaveBeenCalledTimes(1)
  })
})

describe('route wiring tripwire — /sessions/cloud-login/start must pass the db', () => {
  it('the start route hands req.db to startCloudLogin (seeding silently dies without it)', async () => {
    const { readFile } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const path = await import('node:path')
    const here = path.dirname(fileURLToPath(import.meta.url))
    const src = await readFile(path.join(here, '..', 'routes', 'hamiltonAutomation.js'), 'utf8')
    const startIdx = src.indexOf("'/sessions/cloud-login/start'")
    const endIdx = src.indexOf("'/sessions/cloud-login/:liveSessionId/stream'")
    expect(startIdx).toBeGreaterThan(-1)
    expect(endIdx).toBeGreaterThan(startIdx)
    const handler = src.slice(startIdx, endIdx)
    expect(handler).toContain('db: req.db')
  })
})
