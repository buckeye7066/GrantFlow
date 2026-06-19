/**
 * resumeTaskAfterMissingInfo — "automation is king" for the missing-info loop.
 *
 * Once the user supplies everything Hamilton flagged, the task must re-queue
 * itself (status 'ready') so the periodic runner picks it back up and Hamilton
 * continues to completion/submission — no manual relaunch. It must NOT resume
 * while items remain, when nothing was resolved, or from terminal/in-flight
 * states.
 */

import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../helpers/sqliteTestDb.mjs'

import {
  ensureApplicationTaskSchema, ensureApplicationTask, updateApplicationTask,
  getApplicationTask, resumeTaskAfterMissingInfo, _resetSchemaCache,
} from '../../backend/services/hamilton/applicationTaskStore.js'

before(() => {
  if (!process.env.RUNTIME_SECRETS_KEY && !process.env.AUTH_JWT_SECRET && !process.env.JWT_SECRET) {
    process.env.AUTH_JWT_SECRET = 'unit-test-jwt-secret-do-not-use-in-prod'
  }
})

function makeDb() {
  _resetSchemaCache()
  return wrapSqlite(new Database(':memory:'))
}

async function blockedTask(db, opp = 'opp1', status = 'blocked') {
  await ensureApplicationTaskSchema(db)
  const t = await ensureApplicationTask(db, { profileId: 'p1', opportunityId: opp, userId: 'u1' })
  await updateApplicationTask(db, t.id, { status })
  return t.id
}

describe('resumeTaskAfterMissingInfo', () => {
  it('re-queues a blocked task when all items are supplied', async () => {
    const db = makeDb()
    const id = await blockedTask(db)
    const r = await resumeTaskAfterMissingInfo(db, id, { resolvedCount: 2, remainingCount: 0 })
    assert.equal(r.resumed, true)
    assert.equal((await getApplicationTask(db, id)).status, 'ready')
  })

  it('resumes from each waiting-on-user state', async () => {
    for (const s of ['waiting_for_missing_info', 'waiting_for_user', 'waiting_for_admin']) {
      const db = makeDb()
      const id = await blockedTask(db, `opp-${s}`, s)
      const r = await resumeTaskAfterMissingInfo(db, id, { resolvedCount: 1, remainingCount: 0 })
      assert.equal(r.resumed, true, s)
      assert.equal((await getApplicationTask(db, id)).status, 'ready', s)
    }
  })

  it('does NOT resume while items remain', async () => {
    const db = makeDb()
    const id = await blockedTask(db)
    const r = await resumeTaskAfterMissingInfo(db, id, { resolvedCount: 1, remainingCount: 2 })
    assert.equal(r.resumed, false)
    assert.equal((await getApplicationTask(db, id)).status, 'blocked')
  })

  it('does NOT resume when nothing was resolved', async () => {
    const db = makeDb()
    const id = await blockedTask(db)
    const r = await resumeTaskAfterMissingInfo(db, id, { resolvedCount: 0, remainingCount: 0 })
    assert.equal(r.resumed, false)
  })

  it('does NOT resume terminal or in-flight tasks', async () => {
    for (const s of ['submitted', 'completed', 'cancelled', 'filling_portal']) {
      const db = makeDb()
      const id = await blockedTask(db, `opp-${s}`, s)
      const r = await resumeTaskAfterMissingInfo(db, id, { resolvedCount: 3, remainingCount: 0 })
      assert.equal(r.resumed, false, s)
      assert.equal((await getApplicationTask(db, id)).status, s, s)
    }
  })
})
