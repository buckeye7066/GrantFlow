/**
 * Hamilton Portal Credential Vault — generation + reveal-once semantics.
 *
 * Locks the contract for the new "Hamilton generates a login when none
 * exists" flow:
 *
 *   1. generateStrongPassword: high-entropy, mixed-class, length-bounded.
 *   2. saveGeneratedCredential: encrypts at rest, returns plaintext ONCE,
 *      flags row as generated_by='hamilton', is idempotent on (profile,
 *      portal_host).
 *   3. revealPasswordOnceById: returns the password once, then refuses
 *      forever (already_revealed:true, password:null).
 *   4. getDecryptedCredential still works after the row is created and
 *      after the one-time reveal is exhausted (Hamilton's autopilot path
 *      MUST keep working).
 *
 * Without these tests, a regression that re-shows the password (security
 * hole) or that silently overwrites an existing user-entered credential
 * (data loss) would not be caught in CI.
 */

import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../helpers/sqliteTestDb.mjs'

import {
  generateStrongPassword,
  saveCredential,
  saveGeneratedCredential,
  listCredentialsForProfile,
  getDecryptedCredential,
  revealPasswordOnceById,
  _resetCredentialSchemaCache,
} from '../../backend/services/hamilton/hamiltonPortalCredentialService.js'

// runtimeSecrets requires either RUNTIME_SECRETS_KEY or one of the JWT
// secrets to be present so encryption can derive a key.
before(() => {
  if (!process.env.RUNTIME_SECRETS_KEY && !process.env.AUTH_JWT_SECRET && !process.env.JWT_SECRET) {
    process.env.AUTH_JWT_SECRET = 'unit-test-jwt-secret-do-not-use-in-prod'
  }
})

function makeDb() {
  _resetCredentialSchemaCache()
  return wrapSqlite(new Database(':memory:'))
}

describe('generateStrongPassword', () => {
  it('produces a 28-char password by default', () => {
    const p = generateStrongPassword()
    assert.equal(p.length, 28)
  })

  it('clamps the length to [16, 64]', () => {
    assert.equal(generateStrongPassword(8).length, 16, 'lower bound')
    assert.equal(generateStrongPassword(200).length, 64, 'upper bound')
  })

  it('includes upper, lower, digit, and symbol — no portal rejects on policy', () => {
    for (let i = 0; i < 25; i += 1) {
      const p = generateStrongPassword(28)
      assert.match(p, /[A-Z]/, `iter ${i}: missing uppercase: ${p}`)
      assert.match(p, /[a-z]/, `iter ${i}: missing lowercase: ${p}`)
      assert.match(p, /[2-9]/, `iter ${i}: missing digit: ${p}`)
      assert.match(p, /[!@#$%^&*\-_=+]/, `iter ${i}: missing symbol: ${p}`)
    }
  })

  it('is unique across many invocations (high entropy)', () => {
    const seen = new Set()
    for (let i = 0; i < 200; i += 1) seen.add(generateStrongPassword(28))
    assert.equal(seen.size, 200, 'every call should produce a unique password')
  })
})

describe('saveGeneratedCredential', () => {
  it('saves a Hamilton-generated row and returns the plaintext password ONCE', async () => {
    const db = makeDb()
    const result = await saveGeneratedCredential(db, {
      userId: 'u-1',
      profileId: 'p-1',
      portalHost: 'mtsu.edu',
      username: 'anastasia@example.com',
      reason: 'no_saved_login_at_login_gate',
    })
    assert.equal(result.already_existed, false)
    assert.ok(result.password_one_time_view, 'plaintext password is returned once')
    assert.ok(result.password_one_time_view.length >= 16)
    assert.equal(result.credential.generated_by, 'hamilton')
    assert.equal(result.credential.generation_reason, 'no_saved_login_at_login_gate')
    assert.equal(result.credential.has_password, true)
    assert.ok(result.credential.username_masked)
    // Username is masked in the response — never leak the real value.
    assert.notEqual(result.credential.username_masked, 'anastasia@example.com')
  })

  it('is idempotent on (profileId, portalHost) — does NOT rotate an existing password', async () => {
    const db = makeDb()
    const first = await saveGeneratedCredential(db, {
      userId: 'u-1', profileId: 'p-1', portalHost: 'mtsu.edu', username: 'a@example.com',
    })
    const second = await saveGeneratedCredential(db, {
      userId: 'u-1', profileId: 'p-1', portalHost: 'mtsu.edu', username: 'a@example.com',
    })
    assert.equal(second.already_existed, true)
    assert.equal(second.password_one_time_view, null, 'must NOT regenerate a fresh password on re-save')
    assert.equal(second.credential.id, first.credential.id, 'returns the existing row')
  })

  it('does NOT touch a user-entered (non-generated) credential for the same host', async () => {
    const db = makeDb()
    const userOwned = await saveCredential(db, {
      userId: 'u-1', profileId: 'p-1', portalHost: 'mtsu.edu',
      username: 'real@user.com', password: 'their-own-password-123',
      label: 'My MTSU login',
    })
    assert.equal(userOwned.has_password, true)
    assert.equal(userOwned.generated_by, null)

    const gen = await saveGeneratedCredential(db, {
      userId: 'u-1', profileId: 'p-1', portalHost: 'mtsu.edu', username: 'auto@example.com',
    })
    assert.equal(gen.already_existed, true)
    assert.equal(gen.credential.id, userOwned.id, 'existing user-entered row wins')

    // Decrypted credential still resolves to the user's original password.
    const decrypted = await getDecryptedCredential(db, { profileId: 'p-1', portalHost: 'mtsu.edu' })
    assert.equal(decrypted.password, 'their-own-password-123', 'user-entered password is preserved')
  })

  it("Hamilton's autopilot path can decrypt the generated password (server-side only)", async () => {
    const db = makeDb()
    const result = await saveGeneratedCredential(db, {
      userId: 'u-1', profileId: 'p-1', portalHost: 'commonapp.org', username: 'student@example.com',
    })
    const decrypted = await getDecryptedCredential(db, {
      profileId: 'p-1', portalHost: 'app.commonapp.org', // subdomain — should still match via PSL
    })
    assert.ok(decrypted, 'decryption must succeed for autopilot')
    assert.equal(decrypted.password, result.password_one_time_view)
    assert.equal(decrypted.username, 'student@example.com')
  })

  it('list endpoint never leaks plaintext but DOES surface generated_by + masked username', async () => {
    const db = makeDb()
    await saveGeneratedCredential(db, {
      userId: 'u-1', profileId: 'p-1', portalHost: 'mtsu.edu', username: 'student@example.com',
    })
    const rows = await listCredentialsForProfile(db, 'p-1')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].generated_by, 'hamilton')
    assert.equal(rows[0].has_password, true)
    assert.ok(rows[0].username_masked.startsWith('s'), 'username is masked')
    assert.ok(!('password_ciphertext' in rows[0]), 'never leak the ciphertext')
    assert.ok(!('password' in rows[0]), 'never leak the plaintext')
  })
})

describe('TOTP (authenticator-app) seed storage', () => {
  // RFC 6238 base32 seed used across these assertions.
  const SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

  it('saves an encrypted TOTP seed and exposes only has_totp to clients', async () => {
    const db = makeDb()
    const cred = await saveCredential(db, {
      userId: 'u-1', profileId: 'p-1', portalHost: 'mtsu.edu',
      username: 'real@user.com', password: 'pw-123456', totpSecret: SEED,
    })
    assert.equal(cred.has_totp, true, 'masked row advertises the seed presence')
    assert.ok(!('totp_secret' in cred), 'never leak the seed plaintext')
    assert.ok(!('totp_secret_ciphertext' in cred), 'never leak the seed ciphertext')

    const rows = await listCredentialsForProfile(db, 'p-1')
    assert.equal(rows[0].has_totp, true)
    assert.ok(!('totp_secret' in rows[0]))
  })

  it('server-side decrypt returns the seed so the engine can derive a code', async () => {
    const db = makeDb()
    await saveCredential(db, {
      userId: 'u-1', profileId: 'p-1', portalHost: 'mtsu.edu',
      username: 'real@user.com', password: 'pw-123456', totpSecret: SEED,
    })
    const decrypted = await getDecryptedCredential(db, { profileId: 'p-1', portalHost: 'login.mtsu.edu' })
    assert.equal(decrypted.totp_secret, SEED, 'autopilot path recovers the exact seed')
  })

  it('omitting totpSecret on re-save preserves an existing seed (no silent drop)', async () => {
    const db = makeDb()
    await saveCredential(db, {
      userId: 'u-1', profileId: 'p-1', portalHost: 'mtsu.edu',
      username: 'real@user.com', password: 'pw-1', totpSecret: SEED,
    })
    // Re-save (e.g. a password change) without re-supplying the seed.
    await saveCredential(db, {
      userId: 'u-1', profileId: 'p-1', portalHost: 'mtsu.edu',
      username: 'real@user.com', password: 'pw-2',
    })
    const decrypted = await getDecryptedCredential(db, { profileId: 'p-1', portalHost: 'mtsu.edu' })
    assert.equal(decrypted.password, 'pw-2', 'password updated')
    assert.equal(decrypted.totp_secret, SEED, 'seed survived the password update')
  })

  it('credentials without a seed report has_totp:false and totp_secret:null', async () => {
    const db = makeDb()
    await saveCredential(db, {
      userId: 'u-1', profileId: 'p-1', portalHost: 'mtsu.edu',
      username: 'real@user.com', password: 'pw-1',
    })
    const rows = await listCredentialsForProfile(db, 'p-1')
    assert.equal(rows[0].has_totp, false)
    const decrypted = await getDecryptedCredential(db, { profileId: 'p-1', portalHost: 'mtsu.edu' })
    assert.equal(decrypted.totp_secret, null)
  })

  it('rejects a malformed TOTP seed at save time', async () => {
    const db = makeDb()
    await assert.rejects(
      () => saveCredential(db, {
        userId: 'u-1', profileId: 'p-1', portalHost: 'mtsu.edu',
        username: 'real@user.com', password: 'pw-1', totpSecret: 'not a real seed !!!',
      }),
      /valid authenticator/,
    )
  })
})

describe('revealPasswordOnceById', () => {
  it('returns the plaintext exactly once, then refuses forever', async () => {
    const db = makeDb()
    const generated = await saveGeneratedCredential(db, {
      userId: 'u-1', profileId: 'p-1', portalHost: 'mtsu.edu', username: 'student@example.com',
    })
    const id = generated.credential.id

    const first = await revealPasswordOnceById(db, id)
    assert.equal(first.already_revealed, false)
    assert.equal(first.password, generated.password_one_time_view, 'must reveal the same password we generated')

    const second = await revealPasswordOnceById(db, id)
    assert.equal(second.already_revealed, true)
    assert.equal(second.password, null, 'NEVER reveal the password a second time')

    const third = await revealPasswordOnceById(db, id)
    assert.equal(third.already_revealed, true)
    assert.equal(third.password, null)

    // Critical: even after the reveal is exhausted, autopilot's server-side
    // decrypt path MUST still work. Otherwise we'd silently lock Hamilton out
    // of every account he generated.
    const stillWorks = await getDecryptedCredential(db, { profileId: 'p-1', portalHost: 'mtsu.edu' })
    assert.ok(stillWorks, 'autopilot decryption must keep working after reveal-once is exhausted')
    assert.equal(stillWorks.password, generated.password_one_time_view)
  })

  it('returns null for unknown ids', async () => {
    const db = makeDb()
    const r = await revealPasswordOnceById(db, 'nope-not-a-real-id')
    assert.equal(r, null)
  })
})
