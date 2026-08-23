/**
 * applyableFloorLedger.js — durable state for the PER-TYPE APPLYABLE floor's
 * discovery directive (initiative agent #3).
 *
 * This is the awardable result-floor ledger's twin, under its OWN system_kv key
 * (`profile_applyable_floor_state`) so the applyable directive's attempt /
 * cooldown / exhaustion state can never fight the awardable floor's. It reuses
 * the SAME pure burn/retry decision functions from `config/profileResultFloor.js`
 * — `applyFloorAttempt`, `evaluateFloorEligibility`, `buildFloorFingerprint` —
 * so a crawler outage never burns a profile's chance, a productive pass resets
 * the budget, and N fruitless passes record an evidenced `exhausted` verdict
 * (the #944/#946/#1006 rules, unchanged).
 *
 * The FLOOR value comes from `resolveApplyableFloor()` (a low default, 3), not
 * the awardable target (20): this floor only has to catch the genuinely starved.
 */

import {
  FLOOR_OUTCOME,
  APPLYABLE_FLOOR_KV_KEY,
  applyFloorAttempt,
  buildFloorFingerprint,
  evaluateFloorEligibility,
  resolveApplyableFloor,
} from '../../config/profileResultFloor.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('coverage:applyableFloorLedger')

async function ensureKv(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)').run()
}

/** Read the applyable-floor ledger. Always returns a usable shape, never null. */
export async function readApplyableLedger(db) {
  const empty = { profiles: {}, updated_at: null }
  if (!db?.prepare) return empty
  try {
    await ensureKv(db)
    const row = await db.prepare('SELECT value, updated_at FROM system_kv WHERE key = ?').get(APPLYABLE_FLOOR_KV_KEY)
    if (!row?.value) return empty
    const parsed = JSON.parse(row.value)
    return {
      profiles: parsed?.profiles && typeof parsed.profiles === 'object' ? parsed.profiles : {},
      updated_at: row.updated_at ?? parsed?.updated_at ?? null,
    }
  } catch (err) {
    log.warn('could not read applyable-floor ledger (non-fatal)', { error: err?.message })
    return empty
  }
}

/** Persist the applyable-floor ledger. Returns true when it landed. */
export async function writeApplyableLedger(db, ledger, { at = new Date().toISOString() } = {}) {
  if (!db?.prepare) return false
  try {
    await ensureKv(db)
    const value = JSON.stringify({ profiles: ledger?.profiles ?? {}, updated_at: at })
    const res = await db
      .prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?')
      .run(value, at, APPLYABLE_FLOOR_KV_KEY)
    if (!Number(res?.changes ?? res?.rowCount ?? 0)) {
      await db
        .prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)')
        .run(APPLYABLE_FLOOR_KV_KEY, value, at)
    }
    return true
  } catch (err) {
    log.warn('could not persist applyable-floor ledger (non-fatal)', { error: err?.message })
    return false
  }
}

/**
 * Assess one profile against its APPLYABLE floor, given an already-computed
 * applyable-typed count. Pure decision, ledger-aware. Mirrors
 * `profileResultFloorLedger.assessProfileFloor` but on the applyable count and
 * the applyable floor.
 *
 * @returns {{profile_id, target, applyable, shortfall, below, eligible, reason, attempts, escalation, fingerprint}}
 */
export function assessApplyableFloor({
  profileId,
  applyable,
  ledger,
  activeCatalogCount = 0,
  target = null,
  nowMs = Date.now(),
} = {}) {
  const eff = Number.isFinite(Number(target)) ? Number(target) : resolveApplyableFloor()
  const fingerprint = buildFloorFingerprint({ target: eff, activeCatalogCount })
  const entry = ledger?.profiles?.[String(profileId)] ?? null
  const count = Number(applyable) || 0
  const below = eff > 0 && count < eff
  const elig = evaluateFloorEligibility(entry, { fingerprint, nowMs })
  return {
    profile_id: profileId,
    target: eff,
    applyable: count,
    shortfall: below ? eff - count : 0,
    below,
    eligible: below && elig.eligible,
    reason: below ? elig.reason : 'at_or_above_target',
    attempts: elig.attempts,
    escalation: below ? elig.escalation : 0,
    fingerprint,
  }
}

/**
 * Fold one directive attempt's outcome into the ledger IN MEMORY. The caller
 * batches the write, and must only call this AFTER a successful recount (#946).
 */
export function recordApplyableAttempt(ledger, profileId, outcome) {
  const key = String(profileId)
  const profiles = { ...(ledger?.profiles ?? {}) }
  profiles[key] = applyFloorAttempt(profiles[key] ?? null, outcome)
  return { ...ledger, profiles }
}

export { FLOOR_OUTCOME }

export default {
  readApplyableLedger,
  writeApplyableLedger,
  assessApplyableFloor,
  recordApplyableAttempt,
  FLOOR_OUTCOME,
}
