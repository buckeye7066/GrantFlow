/**
 * Hamilton schedule/readiness service — the calendar + login-reminder backend.
 *
 * Covers: which portals need a session captured (login reminder), and that
 * scheduled runs become calendar events flagged for owner presence when a
 * portal lacks a valid saved session.
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../helpers/sqliteTestDb.mjs'
import { getHamiltonReadiness, computeHamiltonCalendarEvents, scanHamiltonSessionReadiness } from '../../backend/services/hamilton/hamiltonScheduleService.js'
import { saveCredential, _resetCredentialSchemaCache as _resetCred } from '../../backend/services/hamilton/hamiltonPortalCredentialService.js'
import { importSession, _resetCredentialSchemaCache } from '../../backend/services/hamilton/hamiltonCredentialSessionService.js'

function freshDb() {
  _resetCredentialSchemaCache?.()
  _resetCred?.()
  const db = wrapSqlite(new Database(':memory:'))
  db.exec(`CREATE TABLE IF NOT EXISTS profile_sections (
    profile_id TEXT, section_key TEXT, data TEXT, updated_by TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (profile_id, section_key)
  );`)
  // Create application_tasks directly so the test doesn't depend on
  // applicationTaskStore's module-global schema flag (which races across the
  // concurrently-run suites in this file).
  db.exec(`CREATE TABLE IF NOT EXISTS application_tasks (
    id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, user_id TEXT, opportunity_id TEXT,
    status TEXT NOT NULL DEFAULT 'queued', automation_type TEXT DEFAULT 'portal',
    mailing_instructions_json TEXT DEFAULT '{}', audit_summary_json TEXT DEFAULT '{}',
    missing_fields_json TEXT DEFAULT '[]', missing_documents_json TEXT DEFAULT '[]',
    required_user_actions_json TEXT DEFAULT '[]',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`)
  return db
}

const PID = 'p1'
const STATE = { cookies: [{ name: 'sid', value: 'x', domain: '.mtsu.edu', path: '/' }], origins: [] }

let taskSeq = 0
async function seedActiveTask(db) {
  taskSeq += 1
  db.prepare(`INSERT INTO application_tasks (id, profile_id, user_id, opportunity_id, status, automation_type)
    VALUES (?, ?, 'u1', 'opp1', 'ready_to_start', 'portal')`).run(`t${taskSeq}`, PID)
}

describe('hamilton readiness', () => {
  let db
  beforeEach(() => { db = freshDb() })

  it('flags a portal that has a saved login but no captured session', async () => {
    await saveCredential(db, { userId: 'u1', profileId: PID, portalHost: 'mtsu.edu', username: 'a@mtsu.edu', password: 'pw' })
    const r = await getHamiltonReadiness(db, { profileId: PID })
    assert.ok(r.portals.find((p) => p.host === 'mtsu.edu')?.needs_capture, 'mtsu should need a session captured')
    assert.ok(r.portals_needing_capture.includes('mtsu.edu'))
  })

  it('clears the flag once a session is imported', async () => {
    await saveCredential(db, { userId: 'u1', profileId: PID, portalHost: 'mtsu.edu', username: 'a@mtsu.edu', password: 'pw' })
    await importSession(db, { userId: 'u1', profileId: PID, portalHost: 'mtsu.edu', storageState: STATE })
    const r = await getHamiltonReadiness(db, { profileId: PID })
    assert.equal(r.portals.find((p) => p.host === 'mtsu.edu')?.needs_capture, false)
    assert.equal(r.portals_needing_capture.length, 0)
  })
})

describe('hamilton calendar events', () => {
  let db
  beforeEach(() => { db = freshDb() })

  it('returns no events when there is no active work', async () => {
    const events = await computeHamiltonCalendarEvents(db, {
      profileId: PID, rangeStart: '2026-07-01T00:00:00Z', rangeEnd: '2026-07-31T23:59:59Z',
    })
    assert.equal(events.length, 0)
  })

  it('plots scheduled windows and flags presence when a portal lacks a session', async () => {
    await saveCredential(db, { userId: 'u1', profileId: PID, portalHost: 'mtsu.edu', username: 'a@mtsu.edu', password: 'pw' })
    await seedActiveTask(db)
    // Daily 18:00–19:00 UTC window.
    db.prepare(`INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, 'automation_preferences', ?)`)
      .run(PID, JSON.stringify({ portal_access: { enabled: true, timezone: 'UTC', windows: [{ start: '18:00', end: '19:00' }] } }))

    const events = await computeHamiltonCalendarEvents(db, {
      profileId: PID, rangeStart: '2026-07-01T00:00:00Z', rangeEnd: '2026-07-03T23:59:59Z',
    })
    assert.ok(events.length >= 2, `expected a window per day, got ${events.length}`)
    assert.equal(events[0].calendar_source, 'hamilton_run')
    assert.equal(events[0].requires_presence, true, 'no session => owner must stand by for 2FA')
    assert.equal(events[0].presence_reason, 'login_2fa')
    assert.ok(events[0].deadline.includes('T18:00'))
  })

  it('marks runs unattended once a session exists', async () => {
    await saveCredential(db, { userId: 'u1', profileId: PID, portalHost: 'mtsu.edu', username: 'a@mtsu.edu', password: 'pw' })
    await importSession(db, { userId: 'u1', profileId: PID, portalHost: 'mtsu.edu', storageState: STATE })
    await seedActiveTask(db)
    db.prepare(`INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, 'automation_preferences', ?)`)
      .run(PID, JSON.stringify({ portal_access: { enabled: true, timezone: 'UTC', windows: [{ start: '18:00', end: '19:00' }] } }))
    const events = await computeHamiltonCalendarEvents(db, {
      profileId: PID, rangeStart: '2026-07-01T00:00:00Z', rangeEnd: '2026-07-02T23:59:59Z',
    })
    assert.ok(events.length >= 1)
    assert.equal(events[0].requires_presence, false)
  })
})

describe('hamilton system-wide session readiness scan (Sam/Anya monitorable)', () => {
  let db
  beforeEach(() => { db = freshDb() })

  it('emits a finding for an active profile whose portal has a login but no session', async () => {
    await saveCredential(db, { userId: 'u1', profileId: PID, portalHost: 'mtsu.edu', username: 'a@mtsu.edu', password: 'pw' })
    await seedActiveTask(db)
    const res = await scanHamiltonSessionReadiness(db)
    assert.equal(res.ok, true)
    assert.ok(Array.isArray(res.findings))
    const f = res.findings.find((x) => x.evidence?.portal_host === 'mtsu.edu')
    assert.ok(f, 'expected a finding for mtsu.edu')
    assert.equal(f.severity, 'medium')
    assert.match(f.title, /stall on login/i)
  })

  it('emits no findings once the session is captured', async () => {
    await saveCredential(db, { userId: 'u1', profileId: PID, portalHost: 'mtsu.edu', username: 'a@mtsu.edu', password: 'pw' })
    await importSession(db, { userId: 'u1', profileId: PID, portalHost: 'mtsu.edu', storageState: STATE })
    await seedActiveTask(db)
    const res = await scanHamiltonSessionReadiness(db)
    assert.equal(res.findings.length, 0)
  })
})
