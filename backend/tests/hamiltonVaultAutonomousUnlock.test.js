/**
 * Autonomous vault unlock (escrow) — lets scheduled/background Hamilton runs
 * unlock the master vault WITHOUT a human, by escrowing the derived wrapping key
 * under the server key. Opt-in and revocable.
 *
 * Pins: escrow survives a "process restart" (cache cleared) and still decrypts a
 * master-wrapped secret; it's OFF unless enabled; unlock-with-flag enables it;
 * clearEscrow disables it; a wrong passphrase never escrows.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'b'.repeat(64)

const {
  setMasterPassphrase,
  unlockVault,
  ensureUnlocked,
  getUnlockedKey,
  hasEscrow,
  clearEscrow,
  getMasterVaultStatus,
  wrapSecretWithKey,
  unwrapSecretWithKey,
  _resetMasterVaultSchemaCache,
  _resetUnlockCache,
} = await import('../services/hamilton/hamiltonPortalMasterVault.js')

const PID = '00000000-0000-4000-8000-000000000001'
const PASS = 'fixture-password-not-a-secret'

describe('autonomous vault unlock (escrow)', () => {
  let db
  beforeEach(() => {
    db = new Database(':memory:')
    db.dialect = 'sqlite'
    _resetMasterVaultSchemaCache()
    _resetUnlockCache()
  })

  it('survives a fresh process and still unwraps a master-wrapped secret', async () => {
    await setMasterPassphrase(db, { profileId: PID, passphrase: PASS, autonomousUnlock: true })
    const status = await getMasterVaultStatus(db, PID)
    expect(status.has_passphrase).toBe(true)
    expect(status.autonomous_unlock).toBe(true)

    // Wrap a secret with the live key, then simulate a process restart.
    const wrapped = wrapSecretWithKey('portal-password', getUnlockedKey(PID))
    _resetUnlockCache()
    expect(getUnlockedKey(PID)).toBeNull() // locked after "restart"

    // Auto-unlock from escrow — no human, no passphrase.
    const key = await ensureUnlocked(db, PID)
    expect(key).toBeTruthy()
    expect(unwrapSecretWithKey(wrapped, key)).toBe('portal-password')
  })

  it('does NOT auto-unlock when autonomous unlock is off', async () => {
    await setMasterPassphrase(db, { profileId: PID, passphrase: PASS }) // default: no escrow
    expect((await getMasterVaultStatus(db, PID)).autonomous_unlock).toBe(false)
    _resetUnlockCache()
    expect(await ensureUnlocked(db, PID)).toBeNull()
  })

  it('unlock-with-flag enables escrow; clearEscrow disables it', async () => {
    await setMasterPassphrase(db, { profileId: PID, passphrase: PASS }) // no escrow yet
    _resetUnlockCache()
    const res = await unlockVault(db, { profileId: PID, passphrase: PASS, autonomousUnlock: true })
    expect(res.ok).toBe(true)
    expect(await hasEscrow(db, PID)).toBe(true)

    _resetUnlockCache()
    expect(await ensureUnlocked(db, PID)).toBeTruthy() // auto-unlocks from escrow

    await clearEscrow(db, PID)
    _resetUnlockCache()
    expect(await hasEscrow(db, PID)).toBe(false)
    expect(await ensureUnlocked(db, PID)).toBeNull()
  })

  it('a wrong passphrase never escrows a key', async () => {
    await setMasterPassphrase(db, { profileId: PID, passphrase: PASS })
    await clearEscrow(db, PID)
    _resetUnlockCache()
    const res = await unlockVault(db, { profileId: PID, passphrase: 'wrong-pass', autonomousUnlock: true })
    expect(res.ok).toBe(false)
    expect(await hasEscrow(db, PID)).toBe(false)
  })
})
