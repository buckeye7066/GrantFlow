/**
 * The three Hamilton consent toggles must be operable by BOTH the profile user
 * AND an admin — grant AND revoke.
 *
 * The routes always ALLOWED an admin through (`userMayAccessProfile` returns
 * true on `req.ctx.isAdmin`), so this looked fine. It was not: every READ of
 * `hamilton_authorizations` keys on (profile_id, scope, target) with NO user
 * filter — `listActiveAuthorizations`, `isAuthorizationActive`,
 * `readAuthorizations`, `resolveSubmissionDecision` and therefore
 * `hasFullAutomation` — while `recordAuthorizations` WROTE and revoked with an
 * extra `user_id = ?` predicate.
 *
 * Consequence for an admin operating an owner's profile: the omitted-type
 * revoke matched ZERO rows, the profile-scoped read still returned the owner's
 * grant, the toggle snapped straight back on, and the admin's call inserted a
 * DUPLICATE active row. Turning full automation OFF was the worst case — the
 * owner's `allow_auto_submit: true` survived, so Hamilton kept full submission
 * authority after an admin had switched it off.
 *
 * The fix keys the write the way the read is keyed. These tests fail on the
 * pre-fix store.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../../tests/helpers/sqliteTestDb.mjs'
import {
  _resetAuthSchemaCache,
  listActiveAuthorizations,
  resolveSubmissionDecision,
} from '../services/hamilton/hamiltonAuthorizationStore.js'
import { hasFullAutomation } from '../config/hamiltonIdentity.js'

const PROFILE_ID = 'profile-1'
const OWNER = 'user-owner'
const ADMIN = 'user-admin'

// Mirrors the consent card: LOGIN_TYPES + SUBMIT_TYPE, with the full-automation
// intent flag carried as an OPTION (it is not an authorization type).
const LOGIN_TYPE = 'use_saved_credentials_reference'
const SUBMIT_TYPE = 'submit_applications'

let db
let hamiltonRouter

/**
 * `req.ctx` injection — the pattern hamiltonManualSubmissionReceipt.test.js
 * uses. An admin is given an EMPTY accessible set on purpose, so a pass proves
 * the admin bypass rather than incidental ownership.
 */
function createApp(userId, { isAdmin = false, accessibleProfileIds = [] } = {}) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.db = db
    req.user = { userId, role: isAdmin ? 'admin' : 'user' }
    req.ctx = {
      userId,
      isAdmin,
      identityResolved: true,
      accessibleProfileIds: new Set(accessibleProfileIds),
    }
    next()
  })
  app.use('/api/hamilton/automation', hamiltonRouter)
  return app
}

const ownerApp = () => createApp(OWNER, { accessibleProfileIds: [PROFILE_ID] })
const adminApp = () => createApp(ADMIN, { isAdmin: true, accessibleProfileIds: [] })
const strangerApp = () => createApp('user-stranger', { accessibleProfileIds: [] })

function authorize(app, { types, options }) {
  return request(app).post('/api/hamilton/automation/authorize').send({
    profile_id: PROFILE_ID,
    scope: 'profile',
    authorization_types: types,
    ...(options ? { options } : {}),
  })
}

const listAuthorizations = (app) =>
  request(app).get(`/api/hamilton/automation/authorizations?profile_id=${PROFILE_ID}`)

async function fullAutomationOn() {
  return hasFullAutomation(await listActiveAuthorizations(db, { profileId: PROFILE_ID }))
}

beforeAll(async () => {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, primary_email TEXT, is_admin INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE profiles (id TEXT PRIMARY KEY, user_id TEXT, created_by TEXT, display_name TEXT);
  `)
  db = wrapSqlite(sqlite)
  await db.prepare('INSERT INTO users (id, is_admin) VALUES (?, 0)').run(OWNER)
  await db.prepare('INSERT INTO users (id, is_admin) VALUES (?, 1)').run(ADMIN)
  await db.prepare('INSERT INTO profiles (id, user_id) VALUES (?, ?)').run(PROFILE_ID, OWNER)
  hamiltonRouter = (await import('../routes/hamiltonAutomation.js')).default
})

beforeEach(async () => {
  _resetAuthSchemaCache()
  try { await db.prepare('DELETE FROM hamilton_authorizations').run() } catch { /* first run */ }
})

describe('a stranger is still refused', () => {
  it('403s on read and on write', async () => {
    expect((await listAuthorizations(strangerApp())).status).toBe(403)
    expect((await authorize(strangerApp(), { types: [SUBMIT_TYPE] })).status).toBe(403)
  })
})

describe.each([
  ['the profile user', () => ownerApp()],
  ['an admin on someone else\'s profile', () => adminApp()],
])('%s can operate all three toggles', (_label, appFor) => {
  it('can GRANT sign-in, submit, and full automation', async () => {
    const res = await authorize(appFor(), {
      types: [LOGIN_TYPE, SUBMIT_TYPE],
      options: { allow_auto_submit: true, require_human_review: false },
    })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)

    const list = await listAuthorizations(appFor())
    expect(list.status).toBe(200)
    const types = list.body.active.map((a) => a.authorization_type).sort()
    expect(types).toEqual([SUBMIT_TYPE, LOGIN_TYPE].sort())
    expect(await fullAutomationOn()).toBe(true)
  })

  it('can REVOKE full automation while leaving sign-in on', async () => {
    // Seed the grant as the OWNER, which is the real-world case that broke:
    // an admin then cannot match the owner's row on a user-keyed write.
    await authorize(ownerApp(), {
      types: [LOGIN_TYPE, SUBMIT_TYPE],
      options: { allow_auto_submit: true, require_human_review: false },
    })
    expect(await fullAutomationOn()).toBe(true)

    // The card's "turn full automation off" call: resend the remaining types
    // with the intent flag cleared.
    const res = await authorize(appFor(), { types: [LOGIN_TYPE], options: { allow_auto_submit: false } })
    expect(res.status).toBe(200)

    const active = await listActiveAuthorizations(db, { profileId: PROFILE_ID })
    const types = active.map((a) => a.authorization_type)
    expect(types).toContain(LOGIN_TYPE)
    // THE ASSERTION THAT FAILS ON THE PRE-FIX STORE for the admin: the owner's
    // submit grant must actually be revoked, not left alive under another
    // user_id while the UI reports the toggle as off.
    expect(types).not.toContain(SUBMIT_TYPE)
    expect(await fullAutomationOn()).toBe(false)

    // And the authority that actually gates a portal click agrees.
    const decision = await resolveSubmissionDecision(db, { profileId: PROFILE_ID, taskAllowAutoSubmit: true })
    expect(decision.allow_auto_submit).toBe(false)
    expect(decision.reason).toBe('missing_submit_authorization')
  })

  it('never leaves DUPLICATE active grants for the same capability', async () => {
    await authorize(ownerApp(), { types: [LOGIN_TYPE, SUBMIT_TYPE], options: { allow_auto_submit: true } })
    await authorize(appFor(), { types: [LOGIN_TYPE, SUBMIT_TYPE], options: { allow_auto_submit: true } })
    const active = await listActiveAuthorizations(db, { profileId: PROFILE_ID })
    const counts = active.reduce((acc, a) => ({ ...acc, [a.authorization_type]: (acc[a.authorization_type] || 0) + 1 }), {})
    expect(counts[LOGIN_TYPE]).toBe(1)
    expect(counts[SUBMIT_TYPE]).toBe(1)
  })

  it('can REVOKE the last remaining toggle by row id', async () => {
    await authorize(ownerApp(), { types: [LOGIN_TYPE] })
    const active = await listActiveAuthorizations(db, { profileId: PROFILE_ID })
    const res = await request(appFor())
      .post(`/api/hamilton/automation/authorizations/${active[0].id}/revoke`)
      .send({ reason: 'user_toggled_off' })
    expect(res.status).toBe(200)
    expect(await listActiveAuthorizations(db, { profileId: PROFILE_ID })).toHaveLength(0)
  })
})

describe('the audit trail survives an admin acting on an owner\'s consent', () => {
  it('records WHO changed it without erasing who accepted it', async () => {
    await authorize(ownerApp(), { types: [LOGIN_TYPE, SUBMIT_TYPE], options: { allow_auto_submit: true } })
    await authorize(adminApp(), { types: [LOGIN_TYPE], options: { allow_auto_submit: false } })
    const rows = await db.prepare(
      `SELECT user_id, metadata_json FROM hamilton_authorizations
        WHERE profile_id = ? AND authorization_type = ? AND revoked_at IS NULL`,
    ).all(PROFILE_ID, LOGIN_TYPE)
    expect(rows).toHaveLength(1)
    // The row still records the principal who ACCEPTED the authorization text…
    expect(rows[0].user_id).toBe(OWNER)
    // …and the admin who last changed it is not lost.
    expect(JSON.parse(rows[0].metadata_json).last_modified_by).toBe(ADMIN)
  })
})
