/**
 * Condition 2 loop-close: answering a global custom field saves it to the
 * profile, resolves the ask on every task that raised it, and clears the retry
 * backoff so those tasks resume.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import Database from 'better-sqlite3'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'a'.repeat(64)
const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')

let db
let router
const PID = 'p1'
const app = () => {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => {
    req.db = db
    req.user = { userId: 'u1', role: 'admin' }
    req.ctx = { userId: 'u1', isAdmin: true, identityResolved: true }
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
    CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT, updated_by TEXT, updated_at DATETIME);
    CREATE TABLE application_tasks (
      id TEXT PRIMARY KEY, profile_id TEXT, user_id TEXT, status TEXT, last_agent_message TEXT,
      opportunity_id TEXT, grant_id TEXT, next_retry_at DATETIME, updated_at DATETIME
    );
    CREATE TABLE application_missing_info (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL,
      label TEXT, description TEXT, required INTEGER DEFAULT 1, resolved INTEGER DEFAULT 0,
      resolved_at DATETIME, resolved_by TEXT, resolved_value_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)
  db = wrapSqlite(sqlite)
  await db.prepare('INSERT INTO users (id) VALUES (?)').run('u1')
  await db.prepare('INSERT INTO profiles (id, user_id) VALUES (?, ?)').run(PID, 'u1')
  const reg = await import('../services/hamilton/hamiltonCustomFieldRegistry.js')
  await reg.ensureGlobalCustomField(db, { label: 'Are you the oldest sibling?' })
  await db.prepare('INSERT INTO application_tasks (id, profile_id, status, next_retry_at) VALUES (?, ?, ?, ?)')
    .run('t1', PID, 'waiting_for_missing_info', '2099-01-01')
  await db.prepare('INSERT INTO application_missing_info (id, task_id, kind, key, label) VALUES (?, ?, ?, ?, ?)')
    .run('m1', 't1', 'field', 'custom_fields.are_you_the_oldest_sibling', 'Are you the oldest sibling?')
  router = (await import('../routes/hamiltonAutomation.js')).default
})

describe('GET /custom-fields', () => {
  it('lists the global fields + this profile values', async () => {
    const res = await request(app()).get(`/api/hamilton/automation/custom-fields?profileId=${PID}`)
    expect(res.status).toBe(200)
    expect(res.body.fields.map((f) => f.field_key)).toContain('are_you_the_oldest_sibling')
    expect(res.body.values).toEqual({})
  })
})

describe('PUT /custom-fields', () => {
  it('saves the answer, resolves the ask, and clears retry backoff so the task resumes', async () => {
    const res = await request(app()).put('/api/hamilton/automation/custom-fields')
      .send({ profileId: PID, fieldKey: 'are_you_the_oldest_sibling', value: 'Yes' })
    expect(res.status).toBe(200)
    expect(res.body.tasks_resolved).toBe(1)
    // value persisted
    const section = await db.prepare('SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = ?').get(PID, 'custom_fields')
    expect(JSON.parse(section.data)).toEqual({ are_you_the_oldest_sibling: 'Yes' })
    // ask resolved
    const mi = await db.prepare('SELECT resolved FROM application_missing_info WHERE id = ?').get('m1')
    expect(Boolean(mi.resolved)).toBe(true)
    // backoff cleared
    const task = await db.prepare('SELECT next_retry_at FROM application_tasks WHERE id = ?').get('t1')
    expect(task.next_retry_at).toBeNull()
  })

  it('rejects an empty value', async () => {
    const res = await request(app()).put('/api/hamilton/automation/custom-fields')
      .send({ profileId: PID, fieldKey: 'are_you_the_oldest_sibling', value: '  ' })
    expect(res.status).toBe(400)
  })
})
