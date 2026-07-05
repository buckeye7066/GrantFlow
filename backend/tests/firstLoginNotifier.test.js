/**
 * firstLoginNotifier — the one-time "new user just signed in for the first
 * time" owner email, hooked at the createSessionAndTokens choke point.
 * Contract:
 *   1. The atomic NULL→set transition of users.last_login_at sends exactly one
 *      owner email — a double call (racing logins) can never send twice.
 *   2. Subsequent sign-ins re-stamp last_login_at but never re-notify.
 *   3. Admin / owner sign-ins are stamped but NEVER notify.
 *   4. Recipient: FIRST_LOGIN_REPORT_EMAIL > ERROR_REPORT_EMAIL > owner.
 *   5. The helper never throws (fire-and-forget safety).
 *   6. ensureUsersLastLoginAtColumn backfills ONLY when it adds the column, so
 *      pre-existing users never read as "new" and a re-run never re-stamps a
 *      genuinely-never-signed-in user.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { recordSuccessfulLogin } from '../services/firstLoginNotifier.js'
import { ensureUsersLastLoginAtColumn } from '../startup/ensureSchemaInvariants.js'

function makeDb({ withColumn = true } = {}) {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      display_name TEXT,
      primary_email TEXT,
      is_admin BOOLEAN DEFAULT 0,
      metadata TEXT${withColumn ? ',\n      last_login_at DATETIME' : ''}
    );
  `)
  raw.dialect = 'sqlite'
  return raw
}

function seedUser(db, { id = 'u1', email = 'newbie@example.com', name = 'Newbie', lastLoginAt = null } = {}) {
  db.prepare('INSERT INTO users (id, primary_email, display_name, last_login_at) VALUES (?, ?, ?, ?)')
    .run(id, email, name, lastLoginAt)
  return { id, primary_email: email, display_name: name, last_login_at: lastLoginAt }
}

describe('firstLoginNotifier.recordSuccessfulLogin', () => {
  let db
  let sendEmail
  const envKeys = ['FIRST_LOGIN_REPORT_EMAIL', 'ERROR_REPORT_EMAIL']
  const savedEnv = {}

  beforeEach(() => {
    db = makeDb()
    sendEmail = vi.fn(async () => ({ ok: true, id: 'em_test' }))
    for (const k of envKeys) { savedEnv[k] = process.env[k]; delete process.env[k] }
  })
  afterEach(() => {
    db.close()
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
  })

  const call = (user, extra = {}) =>
    recordSuccessfulLogin({ db, user, deps: { sendEmail }, ...extra })

  it('first sign-in stamps last_login_at and emails the owner exactly once (atomic)', async () => {
    const user = seedUser(db)
    const res = await call(user, { method: 'password' })
    expect(res).toMatchObject({ ok: true, firstLogin: true, notified: true })
    expect(db.prepare('SELECT last_login_at FROM users WHERE id = ?').get('u1').last_login_at).toBeTruthy()
    expect(sendEmail).toHaveBeenCalledTimes(1)
    const args = sendEmail.mock.calls[0][0]
    expect(args.to).toBe('dr.johnwhite@axiombiolabs.org')
    expect(args.subject).toContain('newbie@example.com')
    expect(args.subject).toContain('GrantFlow')

    // Second call (repeat login OR a lost race) must not re-notify.
    const again = await call(user)
    expect(again).toMatchObject({ ok: true, firstLogin: false })
    expect(sendEmail).toHaveBeenCalledTimes(1)
  })

  it('admin and owner sign-ins are stamped but never notify', async () => {
    // isAdminEmail's hardcoded default includes buckeye7066@gmail.com.
    const admin = seedUser(db, { id: 'a1', email: 'buckeye7066@gmail.com' })
    const res = await call(admin)
    expect(res).toMatchObject({ ok: true, firstLogin: true, notified: false })
    expect(sendEmail).not.toHaveBeenCalled()
    expect(db.prepare('SELECT last_login_at FROM users WHERE id = ?').get('a1').last_login_at).toBeTruthy()
  })

  it('a phone-only user (no email) still notifies, using the identifier', async () => {
    const user = seedUser(db, { id: 'p1', email: null })
    const res = await call(user, { identifier: '+14235551234', method: 'phone' })
    expect(res).toMatchObject({ firstLogin: true, notified: true })
    expect(sendEmail.mock.calls[0][0].subject).toContain('+14235551234')
  })

  it('recipient override order: FIRST_LOGIN_REPORT_EMAIL > ERROR_REPORT_EMAIL', async () => {
    process.env.ERROR_REPORT_EMAIL = 'errors@example.com'
    await call(seedUser(db, { id: 'u2', email: 'a@b.com' }))
    expect(sendEmail.mock.calls[0][0].to).toBe('errors@example.com')

    process.env.FIRST_LOGIN_REPORT_EMAIL = 'firstlogins@example.com'
    await call(seedUser(db, { id: 'u3', email: 'c@d.com' }))
    expect(sendEmail.mock.calls[1][0].to).toBe('firstlogins@example.com')
  })

  it('never throws — degraded inputs and a throwing sender are swallowed', async () => {
    expect(await recordSuccessfulLogin({})).toMatchObject({ skipped: true })
    expect(await recordSuccessfulLogin({ db })).toMatchObject({ skipped: true })

    sendEmail.mockRejectedValueOnce(new Error('resend down'))
    const res = await call(seedUser(db, { id: 'u9', email: 'x@y.com' }))
    expect(res.ok).toBe(false) // reported, not thrown
  })
})

describe('ensureUsersLastLoginAtColumn — backfill-only-on-add', () => {
  it('adds the column and backfills existing users to created_at, once', async () => {
    const db = makeDb({ withColumn: false })
    db.prepare('INSERT INTO users (id, primary_email) VALUES (?, ?)').run('old1', 'old@x.com')

    await ensureUsersLastLoginAtColumn(db, { logger: { log() {}, warn() {}, error() {} } })
    const backfilled = db.prepare('SELECT last_login_at, created_at FROM users WHERE id = ?').get('old1')
    expect(backfilled.last_login_at).toBe(backfilled.created_at)

    // A user created AFTER introduction stays NULL across re-runs (no re-stamp).
    db.prepare('INSERT INTO users (id, primary_email) VALUES (?, ?)').run('new1', 'new@x.com')
    await ensureUsersLastLoginAtColumn(db, { logger: { log() {}, warn() {}, error() {} } })
    expect(db.prepare('SELECT last_login_at FROM users WHERE id = ?').get('new1').last_login_at).toBeNull()
    db.close()
  })
})
