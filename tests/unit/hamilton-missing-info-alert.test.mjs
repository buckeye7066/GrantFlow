/**
 * emitMissingInfoAlert — a missing FIELD must produce a precise, field-deep-
 * linking toast (hamilton_missing_info with data.field), so even a single
 * missing detail drops the user on the exact field; the toast bridge resolves
 * the deep-link from data.field.
 */

import { describe, it, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../helpers/sqliteTestDb.mjs'

import {
  emitMissingInfoAlert, _resetNotificationsSchemaCache, _resetAdminAccountCache,
} from '../../backend/services/hamilton/hamiltonNotifications.js'

before(() => {
  if (!process.env.RUNTIME_SECRETS_KEY && !process.env.AUTH_JWT_SECRET && !process.env.JWT_SECRET) {
    process.env.AUTH_JWT_SECRET = 'unit-test-jwt-secret-do-not-use-in-prod'
  }
})

let db
beforeEach(() => {
  _resetNotificationsSchemaCache()
  _resetAdminAccountCache?.()
  db = wrapSqlite(new Database(':memory:'))
})

async function notifsFor(userId) {
  // The notifications table is created lazily on first emit; when nothing was
  // emitted it won't exist yet, which legitimately means "no notifications".
  try {
    return db.prepare('SELECT type, title, message, data FROM notifications WHERE user_id = ?').all(userId)
  } catch {
    return []
  }
}

describe('emitMissingInfoAlert', () => {
  it('emits a field-deep-linking missing_info alert for one missing field', async () => {
    const ids = await emitMissingInfoAlert(db, {
      profileId: 'p1', profileUserId: 'u1', taskId: 't1',
      missing: [{ kind: 'field', key: 'ein', label: 'EIN' }],
      fundingSourceTitle: 'Rural Fire Grant',
    })
    assert.equal(ids.length >= 1, true)
    const rows = await notifsFor('u1')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].type, 'hamilton_missing_info')
    assert.match(rows[0].title, /one detail/)
    assert.match(rows[0].title, /Rural Fire Grant/)
    const data = JSON.parse(rows[0].data)
    assert.equal(data.field, 'ein', 'deep-link key present for the toast bridge')
    assert.equal(data.missing_count, 1)
  })

  it('counts multiple items and targets the first FIELD for the deep-link', async () => {
    await emitMissingInfoAlert(db, {
      profileId: 'p1', profileUserId: 'u1', taskId: 't1',
      missing: [
        { kind: 'document', key: 'irs_letter', label: 'IRS letter' },
        { kind: 'field', key: 'annual_budget', label: 'Annual budget' },
      ],
    })
    const rows = await notifsFor('u1')
    assert.equal(rows.length, 1)
    const data = JSON.parse(rows[0].data)
    assert.match(rows[0].title, /2 details/)
    assert.equal(data.field, 'annual_budget', 'prefers a field as the deep-link target')
    assert.equal(data.missing_count, 2)
  })

  it('returns [] (no toast) when there is nothing the user can supply', async () => {
    const ids = await emitMissingInfoAlert(db, {
      profileId: 'p1', profileUserId: 'u1', taskId: 't1',
      missing: [{ kind: 'other', key: 'portal_quirk', label: 'Portal quirk' }],
    })
    assert.deepEqual(ids, [])
    assert.equal((await notifsFor('u1')).length, 0)
  })

  it('returns [] for empty missing list', async () => {
    assert.deepEqual(await emitMissingInfoAlert(db, { profileId: 'p1', profileUserId: 'u1', taskId: 't1', missing: [] }), [])
  })
})
