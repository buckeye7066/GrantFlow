/**
 * Hamilton credential vault — provenance + admin management.
 *
 * Locks the contract for the admin vault:
 *   1. Multiple logins per (profile, host) coexist (uniqueness is now
 *      (profile, host, username)); re-saving the SAME login updates in place.
 *   2. managed_by provenance: admin imports are 'admin', user saves 'user',
 *      Hamilton generates 'hamilton'.
 *   3. listManagedCredentials returns ONLY admin-placed rows.
 *   4. move / copy / delete management ops refuse non-admin-managed rows, so an
 *      admin can never touch a profile user's own self-entered login.
 */

import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../helpers/sqliteTestDb.mjs'

import {
  saveCredential,
  saveGeneratedCredential,
  listCredentialsForProfile,
  listManagedCredentials,
  moveManagedCredential,
  copyManagedCredentialToProfile,
  deleteManagedCredential,
  getDecryptedCredential,
  _resetCredentialSchemaCache,
} from '../../backend/services/hamilton/hamiltonPortalCredentialService.js'

before(() => {
  if (!process.env.RUNTIME_SECRETS_KEY && !process.env.AUTH_JWT_SECRET && !process.env.JWT_SECRET) {
    process.env.AUTH_JWT_SECRET = 'unit-test-jwt-secret-do-not-use-in-prod'
  }
})

function makeDb() {
  _resetCredentialSchemaCache()
  return wrapSqlite(new Database(':memory:'))
}

describe('multiple logins per host', () => {
  it('keeps two different usernames on the same host', async () => {
    const db = makeDb()
    await saveCredential(db, { userId: 'u1', profileId: 'p1', portalHost: 'paypal.com', username: 'a@x.com', password: 'pw1', managedBy: 'admin' })
    await saveCredential(db, { userId: 'u1', profileId: 'p1', portalHost: 'paypal.com', username: 'b@x.com', password: 'pw2', managedBy: 'admin' })
    const list = await listCredentialsForProfile(db, 'p1')
    assert.equal(list.length, 2)
  })

  it('re-saving the same (host, username) updates in place, no duplicate', async () => {
    const db = makeDb()
    await saveCredential(db, { userId: 'u1', profileId: 'p1', portalHost: 'paypal.com', username: 'a@x.com', password: 'pw1', managedBy: 'admin' })
    await saveCredential(db, { userId: 'u1', profileId: 'p1', portalHost: 'paypal.com', username: 'a@x.com', password: 'pw2', managedBy: 'admin' })
    const list = await listCredentialsForProfile(db, 'p1')
    assert.equal(list.length, 1)
    const dec = await getDecryptedCredential(db, { profileId: 'p1', portalHost: 'paypal.com' })
    assert.equal(dec.password, 'pw2')
  })
})

describe('provenance', () => {
  it('tags admin / user / hamilton correctly and lists only admin-managed', async () => {
    const db = makeDb()
    await saveCredential(db, { userId: 'admin', profileId: 'p1', portalHost: 'a.com', username: 'admin@x.com', password: 'pw', managedBy: 'admin' })
    await saveCredential(db, { userId: 'realuser', profileId: 'p1', portalHost: 'b.com', username: 'user@x.com', password: 'pw', managedBy: 'user' })
    await saveGeneratedCredential(db, { userId: 'sys', profileId: 'p1', portalHost: 'c.com', username: 'gen@x.com' })

    const managed = await listManagedCredentials(db, { managedBy: 'admin' })
    assert.equal(managed.length, 1)
    assert.equal(managed[0].portal_host, 'a.com')
    assert.equal(managed[0].managed_by, 'admin')

    const all = await listCredentialsForProfile(db, 'p1')
    const byHost = Object.fromEntries(all.map((c) => [c.portal_host, c.managed_by]))
    assert.equal(byHost['a.com'], 'admin')
    assert.equal(byHost['b.com'], 'user')
    assert.equal(byHost['c.com'], 'hamilton')
  })

  it('defaults unknown managedBy to user', async () => {
    const db = makeDb()
    await saveCredential(db, { userId: 'u', profileId: 'p1', portalHost: 'a.com', username: 'x@x.com', password: 'pw', managedBy: 'bogus' })
    const list = await listCredentialsForProfile(db, 'p1')
    assert.equal(list[0].managed_by, 'user')
  })
})

describe('admin move / copy / delete', () => {
  it('moves an admin login out of one profile and into another', async () => {
    const db = makeDb()
    const c = await saveCredential(db, { userId: 'admin', profileId: 'admin-vault', portalHost: 'a.com', username: 'x@x.com', password: 'pw', managedBy: 'admin' })
    const res = await moveManagedCredential(db, { id: c.id, toProfileId: 'p-john' })
    assert.equal(res.moved, true)
    assert.equal((await listCredentialsForProfile(db, 'admin-vault')).length, 0)
    assert.equal((await listCredentialsForProfile(db, 'p-john')).length, 1)
  })

  it('copy leaves the original and grants a profile its own row', async () => {
    const db = makeDb()
    const c = await saveCredential(db, { userId: 'admin', profileId: 'admin-vault', portalHost: 'a.com', username: 'x@x.com', password: 'secret', managedBy: 'admin' })
    const res = await copyManagedCredentialToProfile(db, { id: c.id, toProfileId: 'p-john' })
    assert.equal(res.copied, true)
    assert.equal((await listCredentialsForProfile(db, 'admin-vault')).length, 1)
    // Copied row carries the same (decryptable) password into the new profile.
    const dec = await getDecryptedCredential(db, { profileId: 'p-john', portalHost: 'a.com' })
    assert.equal(dec.password, 'secret')
  })

  it('refuses to move/copy/delete a user-managed login', async () => {
    const db = makeDb()
    const c = await saveCredential(db, { userId: 'realuser', profileId: 'p1', portalHost: 'a.com', username: 'x@x.com', password: 'pw', managedBy: 'user' })
    assert.equal((await moveManagedCredential(db, { id: c.id, toProfileId: 'p2' })).reason, 'not_admin_managed')
    assert.equal((await copyManagedCredentialToProfile(db, { id: c.id, toProfileId: 'p2' })).reason, 'not_admin_managed')
    assert.equal((await deleteManagedCredential(db, c.id)).reason, 'not_admin_managed')
    // Untouched.
    assert.equal((await listCredentialsForProfile(db, 'p1')).length, 1)
  })

  it('deletes an admin login', async () => {
    const db = makeDb()
    const c = await saveCredential(db, { userId: 'admin', profileId: 'p1', portalHost: 'a.com', username: 'x@x.com', password: 'pw', managedBy: 'admin' })
    assert.equal((await deleteManagedCredential(db, c.id)).deleted, true)
    assert.equal((await listCredentialsForProfile(db, 'p1')).length, 0)
  })

  it('merges when moving into a profile that already has the same login', async () => {
    const db = makeDb()
    const a = await saveCredential(db, { userId: 'admin', profileId: 'admin-vault', portalHost: 'a.com', username: 'x@x.com', password: 'pw', managedBy: 'admin' })
    await saveCredential(db, { userId: 'admin', profileId: 'p-john', portalHost: 'a.com', username: 'x@x.com', password: 'pw', managedBy: 'admin' })
    const res = await moveManagedCredential(db, { id: a.id, toProfileId: 'p-john' })
    assert.equal(res.moved, true)
    assert.equal(res.reason, 'merged_into_existing')
    assert.equal((await listCredentialsForProfile(db, 'admin-vault')).length, 0)
    assert.equal((await listCredentialsForProfile(db, 'p-john')).length, 1)
  })
})
