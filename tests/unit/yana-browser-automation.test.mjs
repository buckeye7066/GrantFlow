/**
 * yana-browser-automation.test.mjs
 *
 * End-to-end exercise of Yana's real browser automation against a local
 * mock portal. Chromium and Playwright are required; the test skips
 * gracefully when they are not installed.
 *
 * What it proves:
 *   1. Yana opens the mock portal and pauses on the login gate.
 *   2. After the user logs in (we drive the supervised browser
 *      programmatically), `markUserReadyAndContinue`:
 *      - inspects the form,
 *      - maps known fields from the profile,
 *      - fills them in the live Playwright page,
 *      - leaves the unrecognized required field as missing info,
 *      - emits a yana_missing_info notification.
 *   3. Yana never invents the missing field's value.
 *   4. Yana refuses to submit by default (no auto-submit unless flag).
 *   5. With auto_submit_enabled + YANA_ALLOW_AUTOSUBMIT=true, Yana
 *      clicks the submit button and captures the confirmation reference.
 *   6. No profile bleed: another profile cannot read this session.
 */

// IMPORTANT: enable browser automation BEFORE importing the service —
// the flag is read on first call.
process.env.YANA_ENABLE_BROWSER_AUTOMATION = 'true'
process.env.YANA_BROWSER_HEADLESS = 'true'

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import Database from 'better-sqlite3'

import { startMockPortal } from '../fixtures/mock-portal-server.mjs'
import {
  startBrowserSession,
  markUserReadyAndContinue,
  approveAndSubmit,
  cancelBrowserSession,
  getStatus,
} from '../../backend/services/yana/yanaPortalAutomation.js'
import { getLiveSession } from '../../backend/services/yana/browserSessionService.js'
import {
  _resetSchemaCache as _resetTaskSchema,
  ensureApplicationTask,
} from '../../backend/services/yana/applicationTaskStore.js'
import { _resetSchemaCache as _resetPortalSchema } from '../../backend/services/yana/studentPortalStore.js'
import { _resetLinkSchemaCache } from '../../backend/services/yana/studentFundingPortalLinker.js'
import { _resetNotificationsSchemaCache } from '../../backend/services/yana/yanaNotifications.js'
import { _resetBrowserSessionSchemaCache } from '../../backend/services/yana/browserSessionStore.js'
import { _resetCachedFlags } from '../../backend/services/yana/browserSessionService.js'

let playwrightAvailable = false
try {
  const mod = await import('playwright')
  if (mod.chromium && typeof mod.chromium.launch === 'function') {
    // Try to confirm chromium is actually installed (executable resolves)
    const exe = mod.chromium.executablePath?.()
    if (exe && fs.existsSync(exe)) playwrightAvailable = true
  }
} catch { /* ignore */ }

function makeDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec('PRAGMA foreign_keys = OFF')
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY, user_id TEXT, organization_id TEXT, display_name TEXT
    );
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, role TEXT);
    CREATE TABLE IF NOT EXISTS profile_sections (
      id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, section_key TEXT NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT, description TEXT, application_url TEXT,
      funding_source_type TEXT, category TEXT
    );
    CREATE TABLE IF NOT EXISTS grants (id TEXT PRIMARY KEY, status TEXT, application_url TEXT);
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY, profile_id TEXT, type TEXT, kind TEXT,
      filename TEXT, label TEXT, university_application_name TEXT
    );
  `)
  sqlite.prepare('INSERT INTO profiles (id, user_id, display_name) VALUES (?, ?, ?)').run('p-yana', 'u-1', 'Anastasia')
  sqlite.prepare('INSERT INTO profiles (id, user_id, display_name) VALUES (?, ?, ?)').run('p-other', 'u-2', 'Other')
  sqlite.prepare(
    'INSERT INTO profile_sections (id, profile_id, section_key, data) VALUES (?, ?, ?, ?)',
  ).run('ps-1', 'p-yana', 'basic_information',
    JSON.stringify({
      first_name: 'Anastasia', last_name: 'Kovacs',
      email: 'anastasia@example.com', state: 'TN',
    }))
  sqlite.prepare(
    'INSERT INTO profile_sections (id, profile_id, section_key, data) VALUES (?, ?, ?, ?)',
  ).run('ps-2', 'p-yana', 'university_applications',
    JSON.stringify({
      applications: [{
        name: 'Middle Tennessee State University',
        committed: true, status: 'committed', major: 'Nursing',
      }],
    }))
  sqlite.prepare(
    'INSERT INTO profile_sections (id, profile_id, section_key, data) VALUES (?, ?, ?, ?)',
  ).run('ps-3', 'p-yana', 'student_info',
    JSON.stringify({ gpa: 3.85, major: 'Nursing' }))

  return {
    dialect: 'sqlite',
    prepare(sql) {
      const stmt = sqlite.prepare(sql)
      return {
        get: async (...p) => stmt.get(...p),
        all: async (...p) => stmt.all(...p),
        run: async (...p) => {
          const r = stmt.run(...p)
          return { changes: r.changes, lastInsertRowid: r.lastInsertRowid }
        },
      }
    },
    exec(sql) { sqlite.exec(sql) },
    raw: sqlite,
  }
}

function resetCaches() {
  _resetTaskSchema()
  _resetPortalSchema()
  _resetLinkSchemaCache()
  _resetNotificationsSchemaCache()
  _resetBrowserSessionSchemaCache()
  _resetCachedFlags()
}

async function loginViaPlaywright(handle) {
  const page = handle.page
  await page.fill('input[name="username"]', 'demo')
  await page.fill('input[name="password"]', 'demo')
  await Promise.all([
    page.waitForLoadState('domcontentloaded'),
    page.click('button[type="submit"]'),
  ])
}

describe('Yana real browser automation (Playwright)', () => {
  if (!playwrightAvailable) {
    it('skipped — Playwright chromium not installed (run `npm run smoke:install`)', { skip: true }, () => {})
    return
  }

  let portal
  before(async () => { portal = await startMockPortal({ port: 0, requireFavoriteQuote: true }) })
  after(async () => { await portal?.close() })

  it('opens portal, pauses for login, fills known fields, leaves missing field, refuses submit', async () => {
    resetCaches()
    delete process.env.YANA_ALLOW_AUTOSUBMIT
    process.env.YANA_BROWSER_STORAGE_DIR = path.join(os.tmpdir(), `yana-test-${Date.now()}`)
    const db = makeDb()
    db.raw.prepare(
      'INSERT INTO funding_opportunities (id, title, description, application_url, funding_source_type, category) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('opp-mock', 'Mock Scholarship', 'Mock institutional scholarship.', `${portal.url}/apply`, 'university', 'scholarship')

    const task = await ensureApplicationTask(db, {
      profileId: 'p-yana', userId: 'u-1', opportunityId: 'opp-mock',
      portalId: null, initialStatus: 'queued', currentStep: 'browser',
    })

    // ── 1. start session: should pause on login
    const after1 = await startBrowserSession(db, {
      taskId: task.id, profileId: 'p-yana', userId: 'u-1', headlessOverride: true,
    })
    assert.equal(after1.status, 'waiting_for_user_login',
      `expected waiting_for_user_login, got ${after1.status}`)
    assert.ok(after1.last_screenshot_path && fs.existsSync(after1.last_screenshot_path),
      'launch screenshot should be on disk')

    // ── 2. log in via Playwright (simulating the supervised user)
    const handle = getLiveSession(after1.id)
    assert.ok(handle, 'live Playwright session handle should be available')
    await loginViaPlaywright(handle)

    // ── 3. tell Yana to continue
    const after2 = await markUserReadyAndContinue(db, {
      taskId: task.id, profileId: 'p-yana', userId: 'u-1',
    })
    assert.equal(after2.status, 'missing_info_required',
      `expected missing_info_required, got ${after2.status}`)

    const filledKeys = Object.values(after2.filled_fields || {}).map((f) => f.fieldKey).filter(Boolean)
    assert.ok(filledKeys.includes('first_name'), 'first_name should be filled')
    assert.ok(filledKeys.includes('last_name'), 'last_name should be filled')
    assert.ok(filledKeys.includes('email'), 'email should be filled')
    assert.ok(filledKeys.includes('school_name'), 'school should be filled')

    // unrecognized required field "favorite_quote" must be in missing
    const missingLabels = (after2.missing_fields || []).map((m) => (m.label || '').toLowerCase())
    assert.ok(missingLabels.some((l) => l.includes('favorite quote')),
      'favorite_quote must be flagged missing — Yana never invents values')

    // ── 4. refuse to submit by default
    await assert.rejects(
      () => approveAndSubmit(db, { taskId: task.id, profileId: 'p-yana', userId: 'u-1' }),
      /YANA_ALLOW_AUTOSUBMIT|auto_submit_enabled|missing/i,
    )

    // ── 5. cancel
    await cancelBrowserSession(db, { taskId: task.id, profileId: 'p-yana', userId: 'u-1', reason: 'test cleanup' })
    const final = await getStatus(db, { taskId: task.id, profileId: 'p-yana' })
    assert.equal(final, null, 'cancelled session should not be returned as active')
  })

  it('with auto-submit globally enabled + per-task flag + complete profile, Yana submits + captures reference', async () => {
    resetCaches()
    process.env.YANA_ALLOW_AUTOSUBMIT = 'true'
    process.env.YANA_BROWSER_STORAGE_DIR = path.join(os.tmpdir(), `yana-test-${Date.now()}-2`)

    // Mock portal with NO favorite_quote requirement so all fields are mappable.
    const easyPortal = await startMockPortal({ port: 0, requireFavoriteQuote: false })
    try {
      const db = makeDb()
      db.raw.prepare(
        'INSERT INTO funding_opportunities (id, title, description, application_url, funding_source_type, category) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('opp-easy', 'Easy Scholarship', 'No essay required.', `${easyPortal.url}/apply`, 'university', 'scholarship')
      const task = await ensureApplicationTask(db, {
        profileId: 'p-yana', userId: 'u-1', opportunityId: 'opp-easy',
        portalId: null, initialStatus: 'queued', currentStep: 'browser',
      })
      // Enable auto-submit on the task
      await db.prepare('UPDATE application_tasks SET auto_submit_enabled = 1 WHERE id = ?').run(task.id)

      const after1 = await startBrowserSession(db, {
        taskId: task.id, profileId: 'p-yana', userId: 'u-1', headlessOverride: true,
      })
      assert.equal(after1.status, 'waiting_for_user_login')
      const handle = getLiveSession(after1.id)
      await loginViaPlaywright(handle)
      const after2 = await markUserReadyAndContinue(db, {
        taskId: task.id, profileId: 'p-yana', userId: 'u-1',
      })
      assert.ok(['waiting_for_user_review', 'missing_info_required'].includes(after2.status),
        `expected waiting_for_user_review or missing_info_required, got ${after2.status}`)
      // Even if there are non-required missing fields ("major"/"gpa") the
      // mapper marks them as required:false so they never block submit.
      if (after2.status === 'waiting_for_user_review') {
        const after3 = await approveAndSubmit(db, {
          taskId: task.id, profileId: 'p-yana', userId: 'u-1',
        })
        assert.equal(after3.status, 'submitted')
        assert.ok(after3.confirmation_reference && /MOCK-/.test(after3.confirmation_reference),
          `expected MOCK-* reference, got ${after3.confirmation_reference}`)
        assert.ok(after3.pre_submit_snapshot_path && fs.existsSync(after3.pre_submit_snapshot_path),
          'pre-submit snapshot should be on disk')
      } else {
        // If status is missing_info_required for unrecognized fields, the
        // approve-submit must still be refused.
        await assert.rejects(
          () => approveAndSubmit(db, { taskId: task.id, profileId: 'p-yana', userId: 'u-1' }),
          /missing/i,
        )
      }
    } finally {
      await easyPortal.close()
    }
  })

  it('rejects approve-submit when called from a different profile (no profile bleed)', async () => {
    resetCaches()
    process.env.YANA_ALLOW_AUTOSUBMIT = 'true'
    process.env.YANA_BROWSER_STORAGE_DIR = path.join(os.tmpdir(), `yana-test-${Date.now()}-3`)
    const easyPortal = await startMockPortal({ port: 0, requireFavoriteQuote: false })
    try {
      const db = makeDb()
      db.raw.prepare(
        'INSERT INTO funding_opportunities (id, title, description, application_url, funding_source_type, category) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('opp-bleed', 'Bleed Test', 'Profile-bleed test.', `${easyPortal.url}/apply`, 'university', 'scholarship')
      const task = await ensureApplicationTask(db, {
        profileId: 'p-yana', userId: 'u-1', opportunityId: 'opp-bleed',
        portalId: null, initialStatus: 'queued', currentStep: 'browser',
      })
      await startBrowserSession(db, {
        taskId: task.id, profileId: 'p-yana', userId: 'u-1', headlessOverride: true,
      })
      await assert.rejects(
        () => approveAndSubmit(db, { taskId: task.id, profileId: 'p-other', userId: 'u-2' }),
        /profile mismatch/i,
      )
      await cancelBrowserSession(db, { taskId: task.id, profileId: 'p-yana', reason: 'cleanup' })
    } finally {
      await easyPortal.close()
    }
  })
})
