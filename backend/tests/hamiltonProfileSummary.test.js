/**
 * Tests for GET /api/hamilton/automation/profile-summary — the data behind the
 * profile-page "Hamilton" button: WHAT he's working on (working_on) and WHERE
 * the owner must add information for him to finish (needs_you).
 *
 * Verifies the classification contract:
 *   - a live (queued/in_progress) task lands in working_on
 *   - a needs_user task becomes a needs_you "task_blocked" item
 *   - unresolved missing-info becomes a needs_you "missing_field"/"missing_document"
 *   - a profile with no master passphrase surfaces a "vault" set prompt
 * and that the route is profile-access scoped (403 for inaccessible profiles).
 */

import express from 'express'
import request from 'supertest'
import { describe, expect, it, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'b'.repeat(64)

const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')
const hamiltonRouter = (await import('../routes/hamiltonAutomation.js')).default
const { attachRequestContext } = await import('../middleware/requestContext.js')
const {
  ensureApplicationTask,
  updateApplicationTask,
  setMissingInfo,
  _resetSchemaCache,
} = await import('../services/hamilton/applicationTaskStore.js')
const { _resetMasterVaultSchemaCache } = await import('../services/hamilton/hamiltonPortalMasterVault.js')

const PROFILE_ID = 'profile-summary-test-1'

function createApp(db, user = { role: 'admin', id: 'admin-1' }) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.db = db
    req.user = user
    next()
  })
  // Mirror prod: admin authority is DB-backed via attachRequestContext.
  app.use(attachRequestContext())
  app.use('/api/hamilton/automation', hamiltonRouter)
  return app
}

describe('GET /api/hamilton/automation/profile-summary', () => {
  let db
  beforeEach(() => {
    const sqlite = new Database(':memory:')
    sqlite.dialect = 'sqlite'
    // Minimal profiles table so the non-admin access check (getAccessibleProfileIds
    // → SELECT ... FROM profiles) resolves to an empty set instead of throwing.
    sqlite.exec('CREATE TABLE profiles (id TEXT PRIMARY KEY, user_id TEXT, created_by TEXT)')
    db = wrapSqlite(sqlite)
    // These stores cache "schema ensured" in a module-global flag; reset it so a
    // fresh in-memory db per test actually gets its tables created.
    _resetSchemaCache()
    _resetMasterVaultSchemaCache()
  })

  it('classifies live work, blocked tasks, and missing info; flags a vault that needs setup', async () => {
    // Live task with an unresolved missing field.
    const t1 = await ensureApplicationTask(db, {
      profileId: PROFILE_ID, grantId: 'g1', automationType: 'pdf_docx', initialStatus: 'in_progress',
    })
    await setMissingInfo(db, t1.id, [
      { kind: 'field', key: 'ein', label: 'EIN / Tax ID', description: 'Needed for the application', required: true },
    ])
    // Blocked task that needs the owner (canonical blocked_* status).
    const t2 = await ensureApplicationTask(db, {
      profileId: PROFILE_ID, grantId: 'g2', automationType: 'portal', initialStatus: 'queued',
    })
    await updateApplicationTask(db, t2.id, { status: 'blocked_login_required' })

    const res = await request(createApp(db))
      .get(`/api/hamilton/automation/profile-summary?profileId=${PROFILE_ID}`)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)

    // working_on contains the live task (not the blocked one).
    const workingIds = res.body.working_on.map((t) => t.id)
    expect(workingIds).toContain(t1.id)
    expect(workingIds).not.toContain(t2.id)

    // needs_you contains the missing field, the blocked task, and a vault prompt.
    const needs = res.body.needs_you
    expect(needs.some((n) => n.kind === 'missing_field' && /EIN/.test(n.title))).toBe(true)
    expect(needs.some((n) => n.kind === 'task_blocked' && n.task_id === t2.id)).toBe(true)
    expect(needs.some((n) => n.kind === 'vault')).toBe(true)

    expect(res.body.counts.working).toBe(res.body.working_on.length)
    expect(res.body.counts.needs).toBe(res.body.needs_you.length)
  })

  it('omits resolved missing info and terminal tasks', async () => {
    const done = await ensureApplicationTask(db, {
      profileId: PROFILE_ID, grantId: 'g3', automationType: 'pdf_docx', initialStatus: 'queued',
    })
    await updateApplicationTask(db, done.id, { status: 'submitted' })

    const res = await request(createApp(db))
      .get(`/api/hamilton/automation/profile-summary?profileId=${PROFILE_ID}`)
    expect(res.status).toBe(200)
    expect(res.body.working_on.map((t) => t.id)).not.toContain(done.id)
    expect(res.body.needs_you.some((n) => n.task_id === done.id)).toBe(false)
  })

  it('requires profileId and is access-scoped (403 for non-accessible profiles)', async () => {
    const missing = await request(createApp(db)).get('/api/hamilton/automation/profile-summary')
    expect(missing.status).toBe(400)

    // A non-admin user with no accessible profiles is forbidden.
    const scopedApp = createApp(db, { role: 'user', id: 'user-9' })
    const forbidden = await request(scopedApp)
      .get(`/api/hamilton/automation/profile-summary?profileId=${PROFILE_ID}`)
    expect(forbidden.status).toBe(403)
  })
})
