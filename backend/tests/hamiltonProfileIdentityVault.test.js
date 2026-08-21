/**
 * THE IDENTITY VAULT: use-from-vault, ask-when-missing, never fabricate, never leak.
 *
 * Owner directive 2026-08-21: "The identity proofing and SSO's can be done by
 * Hamilton if they are saved in the vault. If Hamilton needs them, let him ask
 * for them from the profile's user."
 *
 * These pin the store's security contract (encrypted at rest, only a masked
 * hint in clear, plaintext never echoed by the route), the round-trip the fill
 * path relies on, and the ask payload naming exactly what is missing.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../../tests/helpers/sqliteTestDb.mjs'
import {
  _resetIdentityVaultSchemaCache,
  setIdentitySecret,
  hasIdentitySecret,
  listIdentitySecrets,
  getIdentitySecretValue,
  loadIdentityValuesForFill,
  revokeIdentitySecret,
  isKnownIdentityKind,
} from '../services/hamilton/hamiltonProfileIdentityVault.js'
import { identityRequestNotice } from '../services/hamilton/hamiltonIdentityRequest.js'

// The vault encrypts with runtimeSecrets. With no key configured it uses the
// legacy-dev fallback (the same path CI uses), which encrypts and decrypts
// consistently within a run — no env setup required for this test.

const PROFILE = 'p-identity'
const OWNER = 'user-owner'
let db
let hamiltonRouter

function createApp(userId = OWNER, { isAdmin = false, accessibleProfileIds = [PROFILE] } = {}) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.db = db
    req.user = { userId, role: isAdmin ? 'admin' : 'user' }
    req.ctx = { userId, isAdmin, identityResolved: true, accessibleProfileIds: new Set(accessibleProfileIds) }
    next()
  })
  app.use('/api/hamilton/automation', hamiltonRouter)
  return app
}

beforeAll(async () => {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, is_admin INTEGER DEFAULT 0);
    CREATE TABLE profiles (id TEXT PRIMARY KEY, user_id TEXT, display_name TEXT);
  `)
  db = wrapSqlite(sqlite)
  await db.prepare('INSERT INTO users (id) VALUES (?)').run(OWNER)
  await db.prepare('INSERT INTO profiles (id, user_id) VALUES (?, ?)').run(PROFILE, OWNER)
  hamiltonRouter = (await import('../routes/hamiltonAutomation.js')).default
})

beforeEach(async () => {
  _resetIdentityVaultSchemaCache()
  try { await db.prepare('DELETE FROM hamilton_profile_identity_secrets').run() } catch { /* first run */ }
})

describe('the store — encrypted at rest, masked in clear', () => {
  it('round-trips a value the fill path can read, but never stores it in clear', async () => {
    const { display_hint } = await setIdentitySecret(db, { profileId: PROFILE, kind: 'ssn', value: '123-45-6789', userId: OWNER })
    expect(display_hint).toBe('••••6789')
    expect(await getIdentitySecretValue(db, { profileId: PROFILE, kind: 'ssn' })).toBe('123-45-6789')

    const raw = await db.prepare('SELECT value_ciphertext, display_hint FROM hamilton_profile_identity_secrets WHERE profile_id = ? AND secret_kind = ?').get(PROFILE, 'ssn')
    expect(raw.value_ciphertext).not.toContain('123')
    expect(raw.value_ciphertext).not.toContain('6789')
    expect(raw.display_hint).toBe('••••6789')
  })

  it('a date of birth is masked to the year only', async () => {
    const { display_hint } = await setIdentitySecret(db, { profileId: PROFILE, kind: 'date_of_birth', value: '2004-07-15' })
    expect(display_hint).toBe('••••2004')
  })

  it('a password-type field stores NO hint at all', async () => {
    const { display_hint } = await setIdentitySecret(db, { profileId: PROFILE, kind: 'sso_password', value: 'hunter2secret' })
    expect(display_hint).toBeNull()
  })

  it('replaces in place (one row per profile+kind) and can be revoked', async () => {
    await setIdentitySecret(db, { profileId: PROFILE, kind: 'ssn', value: '111-11-1111' })
    await setIdentitySecret(db, { profileId: PROFILE, kind: 'ssn', value: '222-22-2222' })
    const rows = await db.prepare('SELECT COUNT(*) AS n FROM hamilton_profile_identity_secrets WHERE profile_id = ? AND secret_kind = ?').get(PROFILE, 'ssn')
    expect(Number(rows.n)).toBe(1)
    expect(await getIdentitySecretValue(db, { profileId: PROFILE, kind: 'ssn' })).toBe('222-22-2222')
    expect(await revokeIdentitySecret(db, { profileId: PROFILE, kind: 'ssn' })).toBe(1)
    expect(await hasIdentitySecret(db, { profileId: PROFILE, kind: 'ssn' })).toBe(false)
  })

  it('refuses an unknown kind, an empty value, and never invents one', async () => {
    await expect(setIdentitySecret(db, { profileId: PROFILE, kind: 'favourite_colour', value: 'blue' })).rejects.toThrow()
    await expect(setIdentitySecret(db, { profileId: PROFILE, kind: 'ssn', value: '   ' })).rejects.toThrow()
    // A kind never stored returns null — never a fabricated value.
    expect(await getIdentitySecretValue(db, { profileId: PROFILE, kind: 'passport_number' })).toBeNull()
  })

  it('loadIdentityValuesForFill returns only what is on file, keyed by kind', async () => {
    await setIdentitySecret(db, { profileId: PROFILE, kind: 'ssn', value: '123-45-6789' })
    await setIdentitySecret(db, { profileId: PROFILE, kind: 'fsa_id_username', value: 'jane.applicant' })
    const values = await loadIdentityValuesForFill(db, PROFILE)
    expect(values).toEqual({ ssn: '123-45-6789', fsa_id_username: 'jane.applicant' })
  })

  it('accepts a namespaced free-form portal proofing field', () => {
    expect(isKnownIdentityKind('identity:tribal_enrollment_number')).toBe(true)
    expect(isKnownIdentityKind('random')).toBe(false)
  })
})

describe('the ask — names exactly what is missing, never a value', () => {
  it('builds a specific request for one or many kinds', () => {
    const one = identityRequestNotice({ profileId: PROFILE, kinds: ['ssn'], host: 'studentaid.gov', fundingTitle: 'Pell Grant' })
    expect(one.type).toBe('hamilton_identity_needed')
    expect(one.message).toContain('Social Security Number')
    expect(one.message).toContain('studentaid.gov')
    expect(one.data.kinds).toEqual(['ssn'])
    expect(JSON.stringify(one)).not.toContain('123')

    const many = identityRequestNotice({ profileId: PROFILE, kinds: ['fsa_id_username', 'fsa_id_password'] })
    expect(many.message).toContain('FSA ID username')
    expect(many.message).toContain('and')
  })
})

describe('the routes — never echo a value', () => {
  it('stores via POST and lists via GET without ever returning plaintext', async () => {
    const post = await request(createApp()).post('/api/hamilton/automation/identity-vault').send({ profileId: PROFILE, kind: 'ssn', value: '123-45-6789' })
    expect(post.status).toBe(200)
    expect(post.body.stored.display_hint).toBe('••••6789')
    expect(JSON.stringify(post.body)).not.toContain('123-45-6789')

    const get = await request(createApp()).get(`/api/hamilton/automation/identity-vault?profileId=${PROFILE}`)
    expect(get.status).toBe(200)
    expect(get.body.on_file.map((r) => r.kind)).toContain('ssn')
    expect(JSON.stringify(get.body)).not.toContain('123-45-6789')
    // The catalogue of offerable kinds is present.
    expect(get.body.kinds.some((k) => k.kind === 'sso_password')).toBe(true)
  })

  it('an admin on another profile can store; a stranger cannot', async () => {
    const admin = createApp('admin-1', { isAdmin: true, accessibleProfileIds: [] })
    expect((await request(admin).post('/api/hamilton/automation/identity-vault').send({ profileId: PROFILE, kind: 'ssn', value: '9' })).status).toBe(200)
    const stranger = createApp('stranger', { accessibleProfileIds: [] })
    expect((await request(stranger).get(`/api/hamilton/automation/identity-vault?profileId=${PROFILE}`)).status).toBe(403)
  })

  it('rejects an unknown kind and an empty value at the route', async () => {
    expect((await request(createApp()).post('/api/hamilton/automation/identity-vault').send({ profileId: PROFILE, kind: 'nope', value: 'x' })).status).toBe(400)
    expect((await request(createApp()).post('/api/hamilton/automation/identity-vault').send({ profileId: PROFILE, kind: 'ssn', value: '' })).status).toBe(400)
  })
})
