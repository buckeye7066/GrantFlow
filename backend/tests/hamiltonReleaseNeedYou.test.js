/**
 * POST /admin/release-need-you — clears the retry backoff on stuck "need you"
 * tasks so the next full-automation run revisits them (owner order 2026-08-21:
 * "release all portals so the ones that read need you can be revisited").
 *
 * Pins:
 *  - releasable need-you tasks (blocked/login/captcha/2fa/waiting_for_review …)
 *    get next_retry_at cleared;
 *  - submission_verification_required is NEVER released (may have already
 *    submitted without evidence — the double-submit quarantine);
 *  - terminal (submitted/failed/cancelled) and mail/fax "ready_to_*" tasks are
 *    untouched;
 *  - it is admin-only and never submits anything.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import Database from 'better-sqlite3'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'a'.repeat(64)

const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')

let db
let router

function app({ isAdmin = true } = {}) {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => {
    req.db = db
    req.user = { userId: 'u1', role: isAdmin ? 'admin' : 'user' }
    req.ctx = { userId: 'u1', isAdmin, identityResolved: true, accessibleProfileIds: new Set(['p1']) }
    next()
  })
  a.use('/api/hamilton/automation', router)
  return a
}

const PID = 'p1'

beforeEach(async () => {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    -- Mirrors the real application_tasks columns this route reads. The route
    -- SELECTs last_agent_message (it reports WHY each task was stuck); the
    -- fixture omitted it, so every run of the route 500'd with
    -- "no such column: last_agent_message" while prod — where the column has
    -- existed since 0081 — was fine. A fixture narrower than the schema turns
    -- a green suite into no coverage at all.
    CREATE TABLE application_tasks (
      id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, status TEXT,
      last_agent_message TEXT,
      next_retry_at DATETIME, updated_at DATETIME
    );
    -- The route also asks which tasks still have UNRESOLVED missing-info rows
    -- (those are a real hand-off and must not be released). Absent from the
    -- fixture, that query threw and the whole route 500'd.
    CREATE TABLE application_missing_info (
      id TEXT PRIMARY KEY, task_id TEXT, kind TEXT, key TEXT, resolved INTEGER DEFAULT 0
    );
  `)
  db = wrapSqlite(sqlite)
  const seed = async (id, status) => db.prepare(
    "INSERT INTO application_tasks (id, profile_id, status, next_retry_at) VALUES (?, ?, ?, '2099-01-01')",
  ).run(id, PID, status)
  await seed('t-review', 'waiting_for_review')
  await seed('t-login', 'blocked_login_required')
  await seed('t-captcha', 'blocked_captcha')
  await seed('t-verify', 'submission_verification_required') // must NOT release
  await seed('t-mail', 'ready_to_print_mail') // must NOT release
  await seed('t-submitted', 'submitted') // terminal, untouched
  router = (await import('../routes/hamiltonAutomation.js')).default
})

const retryOf = async (id) => (await db.prepare('SELECT next_retry_at FROM application_tasks WHERE id = ?').get(id))?.next_retry_at

describe('POST /admin/release-need-you', () => {
  it('clears the backoff on releasable need-you tasks and reports counts', async () => {
    const res = await request(app()).post('/api/hamilton/automation/admin/release-need-you').send({ profileId: PID })
    expect(res.status).toBe(200)
    expect(res.body.released).toBe(3) // review + login + captcha
    // The route's key is `released_by_status` (nothing else in the product
    // ever read `by_status` — this assertion was the only consumer).
    expect(res.body.released_by_status).toMatchObject({ waiting_for_review: 1, blocked_login_required: 1, blocked_captcha: 1 })
    expect(await retryOf('t-review')).toBeNull()
    expect(await retryOf('t-login')).toBeNull()
    expect(await retryOf('t-captcha')).toBeNull()
  })

  it('NEVER releases submission_verification_required (double-submit quarantine) or mail/fax', async () => {
    await request(app()).post('/api/hamilton/automation/admin/release-need-you').send({ profileId: PID })
    expect(await retryOf('t-verify')).toBe('2099-01-01')
    expect(await retryOf('t-mail')).toBe('2099-01-01')
    expect(await retryOf('t-submitted')).toBe('2099-01-01')
  })

  it('is admin-only', async () => {
    const res = await request(app({ isAdmin: false })).post('/api/hamilton/automation/admin/release-need-you').send({ profileId: PID })
    expect(res.status).toBe(403)
  })

  it('requires a profile or allProfiles', async () => {
    const res = await request(app()).post('/api/hamilton/automation/admin/release-need-you').send({})
    expect(res.status).toBe(400)
  })
})
