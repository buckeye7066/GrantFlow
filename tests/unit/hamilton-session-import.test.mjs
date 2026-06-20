/**
 * Hamilton durable session import — encrypted storageState round-trip.
 *
 * Guards the capability that lets a user hand Hamilton a live, post-2FA session
 * for ANY profile + ANY portal: the Playwright storageState must be stored
 * encrypted (never in the clear) and come back byte-identical for the engine.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../helpers/sqliteTestDb.mjs'
import {
  importSession,
  getSessionStorageState,
  findValidSession,
  listSessionsForProfile,
  _resetCredentialSchemaCache,
} from '../../backend/services/hamilton/hamiltonCredentialSessionService.js'

const SAMPLE_STATE = {
  cookies: [
    { name: 'ESTSAUTH', value: 'secret-sso-token', domain: '.login.microsoftonline.com', path: '/' },
    { name: 'sid', value: 'mtsu-portal-sid', domain: '.mtsu.edu', path: '/' },
  ],
  origins: [{ origin: 'https://www.mtsu.edu', localStorage: [{ name: 'k', value: 'v' }] }],
}

describe('hamilton durable session import', () => {
  it('stores storageState encrypted and returns it byte-identical', async () => {
    _resetCredentialSchemaCache()
    const db = wrapSqlite(new Database(':memory:'))

    const saved = await importSession(db, {
      userId: 'u1', profileId: 'p1', portalHost: 'https://www.mtsu.edu/financial-aid/',
      storageState: SAMPLE_STATE, label: 'MTSU SSO',
    })
    assert.equal(saved.portal_host, 'www.mtsu.edu')
    assert.equal(saved.has_storage_state, true)

    // Ciphertext at rest must NOT contain the raw cookie value.
    const raw = db.prepare('SELECT storage_state_encrypted FROM hamilton_saved_sessions WHERE id = ?').get(saved.id)
    assert.ok(!String(raw.storage_state_encrypted).includes('secret-sso-token'), 'cookie value must not be stored in clear')

    const back = await getSessionStorageState(db, saved.id)
    assert.deepEqual(back, SAMPLE_STATE, 'decrypted storageState must match the original exactly')
  })

  it('exposes the session via findValidSession without leaking ciphertext', async () => {
    _resetCredentialSchemaCache()
    const db = wrapSqlite(new Database(':memory:'))
    await importSession(db, { userId: 'u1', profileId: 'p1', portalHost: 'mtsu.edu', storageState: SAMPLE_STATE })

    const valid = await findValidSession(db, { profileId: 'p1', portalHost: 'mtsu.edu' })
    assert.ok(valid, 'a valid session should be found')
    assert.equal(valid.has_storage_state, true)
    assert.equal(valid.storage_state_encrypted, undefined, 'rowToSession must not expose ciphertext')

    const list = await listSessionsForProfile(db, 'p1')
    assert.equal(list.length, 1)
  })

  it('is idempotent per (user, profile, host) — re-import refreshes, not duplicates', async () => {
    _resetCredentialSchemaCache()
    const db = wrapSqlite(new Database(':memory:'))
    await importSession(db, { userId: 'u1', profileId: 'p1', portalHost: 'mtsu.edu', storageState: SAMPLE_STATE })
    const updated = { ...SAMPLE_STATE, cookies: [{ name: 'sid', value: 'rotated', domain: '.mtsu.edu', path: '/' }] }
    await importSession(db, { userId: 'u1', profileId: 'p1', portalHost: 'mtsu.edu', storageState: updated })

    const list = await listSessionsForProfile(db, 'p1')
    assert.equal(list.length, 1, 'should refresh the existing row, not add a second')
    const valid = await findValidSession(db, { profileId: 'p1', portalHost: 'mtsu.edu' })
    const back = await getSessionStorageState(db, valid.id)
    assert.equal(back.cookies[0].value, 'rotated')
  })

  it('rejects a non-storageState payload', async () => {
    _resetCredentialSchemaCache()
    const db = wrapSqlite(new Database(':memory:'))
    await assert.rejects(
      () => importSession(db, { userId: 'u1', profileId: 'p1', portalHost: 'mtsu.edu', storageState: { nope: true } }),
      /storage state/i,
    )
  })
})
