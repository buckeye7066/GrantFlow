/**
 * Bulk triage: categorize Hamilton tasks by what happened, and act on many at
 * once (acknowledge / delete) individually or by category.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import Database from 'better-sqlite3'
import { categorizeHamiltonTask } from '../../shared/hamiltonTaskCategory.js'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'a'.repeat(64)
const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')

describe('categorizeHamiltonTask', () => {
  const cases = [
    ['submitted', '', 'submitted'],
    ['waiting_for_review', 'Hamilton Autopilot switched to the manual pathway: No clear application URL', 'no_application'],
    ['waiting_for_review', 'Hamilton decomposed this listing: 0 award(s) found', 'directory_listing'],
    ['waiting_for_review', 'Hamilton produced a printable packet instead of browser automation', 'mail_packet'],
    ['waiting_for_review', 'This funder awards based on FAFSA / institutional records / nomination', 'nomination_based'],
    ['waiting_for_login', 'Hamilton needs you to sign in to this portal once', 'needs_login'],
    ['waiting_for_captcha', 'The portal triggered CAPTCHA', 'needs_captcha'],
    ['blocked', 'Hamilton Autopilot stopped at preflight: Funding source does not meet GrantFlow rules', 'ineligible'],
    ['waiting_for_review', 'Hamilton finished filling the application and saved a draft.', 'drafted'],
    ['failed', 'Hamilton Autopilot failed: could not reach www.tn.gov', 'unreachable'],
  ]
  for (const [status, msg, key] of cases) {
    it(`${status} / "${msg.slice(0, 30)}" → ${key}`, () => {
      expect(categorizeHamiltonTask({ status, last_agent_message: msg }).key).toBe(key)
    })
  }
})

let db
let router
const PID = 'p1'
const app = ({ isAdmin = true } = {}) => {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => {
    req.db = db
    req.user = { userId: 'u1', role: isAdmin ? 'admin' : 'user' }
    req.ctx = { userId: 'u1', isAdmin, identityResolved: true, accessibleProfileIds: new Set([PID]) }
    next()
  })
  a.use('/api/hamilton/automation', router)
  return a
}

beforeEach(async () => {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, is_admin INTEGER DEFAULT 1);
    CREATE TABLE profiles (id TEXT PRIMARY KEY, user_id TEXT);
    CREATE TABLE application_tasks (
      id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, user_id TEXT, status TEXT, last_agent_message TEXT,
      opportunity_id TEXT, grant_id TEXT, current_pipeline_stage TEXT, selected_from_stage TEXT,
      allow_auto_submit INTEGER DEFAULT 0, auto_submit_enabled INTEGER DEFAULT 0, retry_count INTEGER DEFAULT 0,
      current_step TEXT, outcome_reason TEXT,
      next_retry_at DATETIME, started_at DATETIME, submitted_at DATETIME, completed_at DATETIME,
      cancelled_at DATETIME, updated_at DATETIME
    );
    CREATE TABLE application_task_events (
      id TEXT PRIMARY KEY, task_id TEXT, event_type TEXT, status TEXT, step TEXT, message TEXT,
      actor_user_id TEXT, actor_role TEXT, details_json TEXT, created_at DATETIME
    );
  `)
  db = wrapSqlite(sqlite)
  await db.prepare('INSERT INTO users (id, is_admin) VALUES (?, 1)').run('u1')
  await db.prepare('INSERT INTO profiles (id, user_id) VALUES (?, ?)').run(PID, 'u1')
  const seed = (id, status, msg) => db.prepare(
    'INSERT INTO application_tasks (id, profile_id, status, last_agent_message, opportunity_id) VALUES (?, ?, ?, ?, ?)',
  ).run(id, PID, status, msg, `opp-${id}`)
  await seed('t-noapp1', 'waiting_for_review', 'Hamilton Autopilot switched to the manual pathway: No clear application URL')
  await seed('t-noapp2', 'waiting_for_review', 'Hamilton Autopilot switched to the manual pathway: No clear application URL')
  await seed('t-dir', 'waiting_for_review', 'Hamilton decomposed this listing: 0 award(s) found')
  await seed('t-submitted', 'submitted', 'submitted')
  router = (await import('../routes/hamiltonAutomation.js')).default
})

const statusOf = async (id) => (await db.prepare('SELECT status FROM application_tasks WHERE id = ?').get(id))?.status

describe('POST /admin/tasks/bulk', () => {
  it('acknowledges an explicit set of tasks (→ completed)', async () => {
    const res = await request(app()).post('/api/hamilton/automation/admin/tasks/bulk')
      .send({ action: 'acknowledge', taskIds: ['t-noapp1', 't-noapp2'] })
    expect(res.status).toBe(200)
    expect(res.body.done).toBe(2)
    expect(await statusOf('t-noapp1')).toBe('completed')
    expect(await statusOf('t-noapp2')).toBe('completed')
  })

  it('acknowledges a whole CATEGORY for a profile (en masse)', async () => {
    const res = await request(app()).post('/api/hamilton/automation/admin/tasks/bulk')
      .send({ action: 'acknowledge', profileId: PID, category: 'no_application' })
    expect(res.status).toBe(200)
    expect(res.body.done).toBe(2) // both no_application tasks
    expect(await statusOf('t-dir')).toBe('waiting_for_review') // untouched (different category)
  })

  it('deletes (cancels) selected tasks', async () => {
    const res = await request(app()).post('/api/hamilton/automation/admin/tasks/bulk')
      .send({ action: 'delete', taskIds: ['t-dir'] })
    expect(res.status).toBe(200)
    expect(await statusOf('t-dir')).toBe('cancelled')
  })

  it('purge hard-deletes a FINISHED task from the archive', async () => {
    const res = await request(app()).post('/api/hamilton/automation/admin/tasks/bulk')
      .send({ action: 'purge', taskIds: ['t-submitted'] })
    expect(res.status).toBe(200)
    expect(res.body.done).toBe(1)
    expect(await db.prepare('SELECT id FROM application_tasks WHERE id = ?').get('t-submitted')).toBeFalsy()
  })

  it('purge REFUSES to remove an active (non-terminal) task', async () => {
    const res = await request(app()).post('/api/hamilton/automation/admin/tasks/bulk')
      .send({ action: 'purge', taskIds: ['t-noapp1'] })
    expect(res.status).toBe(200)
    expect(res.body.done).toBe(0)
    expect(res.body.skipped).toBe(1)
    expect(await statusOf('t-noapp1')).toBe('waiting_for_review') // still there, untouched
  })

  it('is admin-only, needs a valid action and a target', async () => {
    expect((await request(app({ isAdmin: false })).post('/api/hamilton/automation/admin/tasks/bulk').send({ action: 'acknowledge', taskIds: ['t-dir'] })).status).toBe(403)
    expect((await request(app()).post('/api/hamilton/automation/admin/tasks/bulk').send({ action: 'nope', taskIds: ['t-dir'] })).status).toBe(400)
    expect((await request(app()).post('/api/hamilton/automation/admin/tasks/bulk').send({ action: 'acknowledge' })).status).toBe(400)
  })
})
