/**
 * Hamilton full-automation consent gap (2026-09-15).
 *
 * THE DEFECT. The profile owner's full-automation TOGGLE is meant to be the
 * authority for whether Hamilton may submit unattended. But the authorization
 * route only recognised that intent when the client POSTed
 * `options.allow_auto_submit === true`. A client sending `options: {}` made
 * `isFullAutomationGrant()` false, so `applyFullAutomationSweep()` never ran:
 * the legacy `require_human_review` vetoes were never cleared, per-task
 * `allow_auto_submit` never propagated, and the submit leg refused with
 * `profile_auto_submit_disabled`. A green toggle over a run that never
 * submits.
 *
 * WHY THESE TESTS DRIVE THE REAL ROUTE. The first version of this file
 * copy-pasted the route's `if` block into the test body and asserted on its
 * own local `options` object. It passed identically with the fix reverted —
 * 5/5 green against code that still had the bug — because it was testing a
 * duplicate of the logic rather than the shipped path. Every test below POSTs
 * to a mounted express app and then asserts on PERSISTED authorization state,
 * so reverting the route makes them fail.
 *
 * WHY THE PREFERENCE STORE IS THE AUTHORITY. `isFullAutomationEnabled()`
 * derives "enabled" from an active submit authorization that ALREADY carries
 * `allow_auto_submit`, so consulting it to decide whether to SET
 * `allow_auto_submit` is circular and can never fire on a first grant — the
 * exact case that was broken. The toggle lives in
 * `profile_sections.automation_preferences`, read via
 * `readAutomationPreferenceState()`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import express from 'express'
import http from 'node:http'
import { wrapSqlite } from '../../tests/helpers/sqliteTestDb.mjs'

const { _resetAuthSchemaCache, ensureHamiltonAuthorizationSchema } = await import(
  '../services/hamilton/hamiltonAuthorizationStore.js'
)
const { isFullAutomationEnabled, readAutomationPreferenceState } = await import(
  '../services/hamilton/hamiltonFullAutomationMode.js'
)

function makeDb() {
  _resetAuthSchemaCache()
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      display_name TEXT,
      tier_id TEXT
    );
    CREATE TABLE IF NOT EXISTS profile_sections (
      profile_id TEXT NOT NULL,
      section_key TEXT NOT NULL,
      data TEXT,
      updated_by TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (profile_id, section_key)
    );
  `)
  for (const [id, uid] of [['p1', 'u1'], ['p2', 'u2'], ['p3', 'u3'], ['p4', 'u4']]) {
    sqlite.prepare('INSERT OR IGNORE INTO profiles (id, user_id, display_name) VALUES (?, ?, ?)')
      .run(id, uid, `Profile ${id}`)
  }
  return wrapSqlite(sqlite)
}

/* The owner turning the toggle on in the UI writes exactly this row. */
function setToggle(db, profileId, automations) {
  return db.prepare(
    `INSERT INTO profile_sections (profile_id, section_key, data)
     VALUES (?, 'automation_preferences', ?)
     ON CONFLICT(profile_id, section_key) DO UPDATE SET data = excluded.data`,
  ).run(String(profileId), JSON.stringify({ automations }))
}

function postJson(baseUrl, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body))
    const u = new URL(baseUrl)
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: pathname,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': data.length },
    }, (res) => {
      let chunks = ''
      res.on('data', (c) => { chunks += c })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(chunks || '{}') }) }
        catch { resolve({ status: res.statusCode, text: chunks }) }
      })
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

describe('Hamilton consent gap: the owner toggle reaches the grant', () => {
  let db
  let server
  let baseUrl

  beforeEach(async () => {
    db = makeDb()
    await ensureHamiltonAuthorizationSchema(db)

    const app = express()
    app.use(express.json())
    /* `userMayAccessProfile()` short-circuits on req.ctx.isAdmin, which keeps
       this test about the consent gap rather than about access control. */
    app.use((req, _res, next) => {
      req.user = { userId: 'u1', id: 'u1', role: 'user' }
      req.ctx = { user: req.user, isAdmin: true }
      req.db = db
      next()
    })
    const { default: hamiltonRouter } = await import('../routes/hamiltonAutomation.js')
    app.use('/api/hamilton', hamiltonRouter)

    server = await new Promise((resolve, reject) => {
      const s = app.listen(0, () => resolve(s))
      s.on('error', reject)
    })
    baseUrl = `http://127.0.0.1:${server.address().port}`
  }, 60_000)

  afterEach(async () => {
    if (server) await new Promise((resolve) => server.close(resolve))
  })

  async function authorize(profileId, options) {
    return postJson(baseUrl, '/api/hamilton/authorize', {
      profile_id: profileId,
      authorization_types: ['submit_applications'],
      options,
    })
  }

  /* THE CORE CASE. Toggle on, client sends no options at all. Before the fix
     this left full automation disabled and the submit leg refused. */
  it('a toggled-on profile granting submit with options:{} ends up fully automated', async () => {
    setToggle(db, 'p1', { hamilton_auto_submit: true, hamilton_autopilot: true })
    expect((await readAutomationPreferenceState(db, 'p1')).hamilton_auto_submit).toBe(true)
    expect((await isFullAutomationEnabled(db, 'p1')).enabled).toBe(false)

    const res = await authorize('p1', {})
    expect(res.status).toBe(200)

    const after = await isFullAutomationEnabled(db, 'p1')
    expect(after.enabled).toBe(true)
    expect(after.reason).toBe('full_automation')
  })

  /* THE SAFETY NET. Without this, a fix that simply always grants unattended
     submission would look correct. A profile that never turned the toggle on
     must NOT become auto-submitting just because submit was authorised. */
  it('a profile with the toggle OFF is still not auto-submitting', async () => {
    const res = await authorize('p2', {})
    expect(res.status).toBe(200)

    const after = await isFullAutomationEnabled(db, 'p2')
    expect(after.enabled).toBe(false)
    expect(after.reason).toBe('auto_submit_not_authorized')
  })

  /* An explicit client veto outranks the toggle: turning automation on globally
     must not stop a caller from asking for review on one specific grant. */
  it('an explicit allow_auto_submit:false is respected even with the toggle on', async () => {
    setToggle(db, 'p3', { hamilton_auto_submit: true, hamilton_autopilot: true })
    const res = await authorize('p3', { allow_auto_submit: false })
    expect(res.status).toBe(200)
    expect((await isFullAutomationEnabled(db, 'p3')).enabled).toBe(false)
  })

  it('an explicit require_human_review:true is respected even with the toggle on', async () => {
    setToggle(db, 'p4', { hamilton_auto_submit: true, hamilton_autopilot: true })
    const res = await authorize('p4', { require_human_review: true })
    expect(res.status).toBe(200)
    const after = await isFullAutomationEnabled(db, 'p4')
    expect(after.enabled).toBe(false)
  })

  /* The autopilot toggle alone is enough: the two toggles are written together
     by the sweep, but a profile carrying only hamilton_autopilot still means
     "run unattended", so the grant must reflect it. */
  it('hamilton_autopilot alone also carries the intent', async () => {
    setToggle(db, 'p1', { hamilton_autopilot: true })
    const res = await authorize('p1', {})
    expect(res.status).toBe(200)
    expect((await isFullAutomationEnabled(db, 'p1')).enabled).toBe(true)
  })
})
