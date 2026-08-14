/**
 * runPortalSync END-TO-END: when a connector's read PROVES the saved session
 * never cleared the portal's sign-in wall, markSessionDeadAfterWall() is
 * called — but the run used to fall through to finishRun(..., 'completed')
 * anyway. Three surfaces read that status as success: a dead portal showed
 * green on Mission Control (portalSyncHealth.js), and its login prompt was
 * suppressed for 7 days (portalSyncStaleness.js's loadLastSuccessfulSyncByHost
 * explicitly filters status='completed').
 *
 * This test drives the REAL runPortalSync orchestration (not just the
 * isolated markSessionDeadAfterWall helper, which portalSyncSessionWall.test.js
 * already covers) through a signin_wall read, using the one host controlled
 * beta permits (CONTROLLED_BETA_SYNTHETIC_BROWSER_HOST) with a fully mocked
 * Playwright/browser layer and a fake connector, and asserts the PERSISTED
 * portal_sync_runs row is never 'completed'.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'e'.repeat(64)

const savedEnv = {}

// Fake chromium: executablePath must point at a file that actually exists on
// disk (fs.existsSync is a real check) — process.execPath (the node binary)
// always does, with no need to also mock node:fs.
vi.mock('playwright', () => ({
  chromium: {
    executablePath: () => process.execPath,
    launch: vi.fn(),
  },
}))

const fakePage = { url: () => 'about:blank' }
const fakeContext = {
  route: vi.fn(async () => {}),
  newPage: vi.fn(async () => fakePage),
}
const fakeBrowser = {
  newContext: vi.fn(async () => fakeContext),
  close: vi.fn(async () => {}),
}
vi.mock('../services/hamilton/browserLaunch.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    launchPortalBrowser: vi.fn(async () => ({ browser: fakeBrowser, engine: 'test-fake' })),
  }
})

// A connector whose read() PROVES it never cleared the sign-in wall — this is
// the fact markSessionDeadAfterWall() and the finishRun status decision both
// key off (readResult.access === 'signin_wall').
const wallConnector = {
  id: 'wall-test-connector',
  label: 'Wall Test Connector',
  requiresSession: false,
  read: vi.fn(async () => ({
    reached: true,
    access: 'signin_wall',
    fields: [],
    awards: [],
    raw: { pages: [{ url: 'https://fixture/signin', landed: 'signin', title: 'Sign in', chars: 40, access: 'signin_wall' }] },
  })),
}
vi.mock('../services/hamilton/portalSync/registry.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, resolveConnector: vi.fn(() => wallConnector) }
})

vi.mock('../services/hamilton/hamiltonCredentialSessionService.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    findValidSession: vi.fn(async () => ({ id: 'sess-wall-1', has_storage_state: true })),
    getSessionStorageState: vi.fn(async () => ({ cookies: [], origins: [] })),
  }
})

const Database = (await import('better-sqlite3')).default
const {
  CONTROLLED_BETA_SYNTHETIC_BROWSER_HOST,
} = await import('../services/hamilton/controlledBetaBrowserPolicy.js')
const { runPortalSync, listRuns, ensurePortalSyncSchema } =
  await import('../services/hamilton/portalSync/index.js')

const PROFILE_ID = 'wall-status-profile'
const HOST = CONTROLLED_BETA_SYNTHETIC_BROWSER_HOST

function makeDb() {
  const db = new Database(':memory:')
  db.dialect = 'sqlite'
  db.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY, display_name TEXT);
    CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT);
  `)
  db.prepare('INSERT INTO profiles (id, display_name) VALUES (?, ?)').run(PROFILE_ID, 'Wall Test Student')
  // hamilton_saved_sessions is intentionally left to markSessionExpired's own
  // self-healing ensureSchema() — a hand-built stub here would drift from the
  // real column set (portal_host etc.) and mask real schema errors.
  return db
}

beforeEach(() => {
  savedEnv.browser = process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION
  process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION = 'true'
  vi.clearAllMocks()
})

afterEach(() => {
  process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION = savedEnv.browser
})

describe('runPortalSync — a proven sign-in wall is never recorded as a completed sync', () => {
  it('finishes the run status NOT completed, so portalSyncStaleness treats it as unsynced', async () => {
    const db = makeDb()

    const result = await runPortalSync(db, {
      profileId: PROFILE_ID, portalHost: HOST, direction: 'read', actorUserId: 'u1',
    })

    // The orchestration reached the connector and recorded a run — this
    // confirms the test actually exercised the signin_wall branch, not some
    // earlier fail-closed gate.
    expect(wallConnector.read).toHaveBeenCalledOnce()
    expect(result.runId).toBeTruthy()

    await ensurePortalSyncSchema(db)
    const runs = await listRuns(db, { profileId: PROFILE_ID, portalHost: HOST })
    expect(runs).toHaveLength(1)
    // THE BUG: this used to be 'completed'. loadLastSuccessfulSyncByHost in
    // portalSyncStaleness.js explicitly filters status='completed' to decide
    // "just synced" — a completed row here means a dead session's login
    // prompt gets suppressed for 7 days, and portalSyncHealth.js's Mission
    // Control view shows the portal green.
    expect(runs[0].status).not.toBe('completed')
  })
})
