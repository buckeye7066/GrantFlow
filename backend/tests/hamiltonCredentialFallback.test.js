/**
 * Unit tests for the multi-tenant safeguard in getDecryptedCredentialWithFallback
 * (backend/services/hamilton/hamiltonPortalCredentialService.js).
 *
 * The shared "admin vault" lets the OWNER's profiles reuse the owner's logins.
 * But when MORE THAN ONE profile uses the same portal (e.g. two MTSU students),
 * silently applying the owner's login to a profile that has none would risk
 * acting in the wrong account. The safeguard suppresses the fallback in that
 * case and forces a per-profile login instead.
 */

import { describe, it, expect, beforeEach } from 'vitest'

// Encryption key must exist before the service module derives one.
// Must be a 32-byte value as 64 hex chars (runtimeSecrets refuses weak keys).
process.env.RUNTIME_SECRETS_KEY = 'a'.repeat(64)
process.env.HAMILTON_ADMIN_VAULT_PROFILE_ID = 'owner-vault'

const Database = (await import('better-sqlite3')).default
const { saveCredential, getDecryptedCredentialWithFallback } = await import(
  '../services/hamilton/hamiltonPortalCredentialService.js'
)

function makeDb() {
  return new Database(':memory:') // saveCredential.ensureSchema creates the table
}

describe('getDecryptedCredentialWithFallback multi-tenant safeguard', () => {
  let db
  beforeEach(() => { db = makeDb() })

  it('uses the admin vault for a single-tenant portal (only the owner uses it)', async () => {
    await saveCredential(db, {
      userId: 'u-owner', profileId: 'owner-vault', portalHost: 'gates.org',
      username: 'owner@example.com', password: 'pw-owner',
    })
    const cred = await getDecryptedCredentialWithFallback(db, { profileId: 'pA', portalHost: 'gates.org' })
    expect(cred).not.toBeNull()
    expect(cred.source).toBe('admin_vault')
    expect(cred.password).toBe('pw-owner')
  })

  it('suppresses the admin-vault fallback when another profile already uses the host', async () => {
    // Owner vault has an MTSU login...
    await saveCredential(db, {
      userId: 'u-owner', profileId: 'owner-vault', portalHost: 'mtsu.edu',
      username: 'owner@example.com', password: 'pw-owner',
    })
    // ...and student B has their OWN MTSU login → mtsu.edu is shared.
    await saveCredential(db, {
      userId: 'u-b', profileId: 'studentB', portalHost: 'mtsu.edu',
      username: 'studentB@mtmail.mtsu.edu', password: 'pw-b',
    })
    // Student A (no own login) must NOT receive the owner's MTSU login.
    const cred = await getDecryptedCredentialWithFallback(db, { profileId: 'studentA', portalHost: 'mtsu.edu' })
    expect(cred).toBeNull()
  })

  it('still returns a profile\'s OWN login regardless of sharing', async () => {
    await saveCredential(db, {
      userId: 'u-a', profileId: 'studentA', portalHost: 'mtsu.edu',
      username: 'studentA@mtmail.mtsu.edu', password: 'pw-a',
    })
    await saveCredential(db, {
      userId: 'u-b', profileId: 'studentB', portalHost: 'mtsu.edu',
      username: 'studentB@mtmail.mtsu.edu', password: 'pw-b',
    })
    const cred = await getDecryptedCredentialWithFallback(db, { profileId: 'studentA', portalHost: 'mtsu.edu' })
    expect(cred).not.toBeNull()
    expect(cred.source).toBe('profile')
    expect(cred.password).toBe('pw-a')
  })
})
