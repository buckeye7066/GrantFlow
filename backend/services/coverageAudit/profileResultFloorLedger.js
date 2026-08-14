/**
 * profileResultFloorLedger.js — durable state for the per-profile result floor.
 *
 * Holds, in `system_kv` under `profile_result_floor_state`:
 *   - `targets`  : per-profile overrides of the requested result number (the
 *                  fleet default lives in `config/profileResultFloor.js`).
 *   - `profiles` : one attempt/verdict entry per profile — attempts, best count
 *                  reached, the world-fingerprint the verdict was reached in,
 *                  and, once spent, an EVIDENCED "exhausted" record.
 *
 * All decision logic is PURE and lives in `config/profileResultFloor.js`; this
 * module is only I/O, so the burn/retry/exhaustion rules are unit-testable
 * without a database and cannot be re-encoded per call site.
 *
 * Every write is best-effort: the ledger is how the floor converges, not a
 * critical path, and a `system_kv` failure must never redden a boot.
 */

import {
  FLOOR_OUTCOME,
  RESULT_FLOOR_KV_KEY,
  applyFloorAttempt,
  buildFloorFingerprint,
  evaluateFloorEligibility,
  resolveProfileResultTarget,
} from '../../config/profileResultFloor.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('coverage:resultFloorLedger')

async function ensureKv(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)').run()
}

/** Read the ledger. Always returns a usable shape, never null. */
export async function readFloorLedger(db) {
  const empty = { targets: {}, profiles: {}, updated_at: null }
  if (!db?.prepare) return empty
  try {
    await ensureKv(db)
    const row = await db.prepare('SELECT value, updated_at FROM system_kv WHERE key = ?').get(RESULT_FLOOR_KV_KEY)
    if (!row?.value) return empty
    const parsed = JSON.parse(row.value)
    return {
      targets: parsed?.targets && typeof parsed.targets === 'object' ? parsed.targets : {},
      profiles: parsed?.profiles && typeof parsed.profiles === 'object' ? parsed.profiles : {},
      updated_at: row.updated_at ?? parsed?.updated_at ?? null,
    }
  } catch (err) {
    log.warn('could not read result-floor ledger (non-fatal)', { error: err?.message })
    return empty
  }
}

/** Persist the ledger. Returns true when it landed. */
export async function writeFloorLedger(db, ledger, { at = new Date().toISOString() } = {}) {
  if (!db?.prepare) return false
  try {
    await ensureKv(db)
    const value = JSON.stringify({
      targets: ledger?.targets ?? {},
      profiles: ledger?.profiles ?? {},
      updated_at: at,
    })
    const res = await db
      .prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?')
      .run(value, at, RESULT_FLOOR_KV_KEY)
    if (!Number(res?.changes ?? res?.rowCount ?? 0)) {
      await db
        .prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)')
        .run(RESULT_FLOOR_KV_KEY, value, at)
    }
    return true
  } catch (err) {
    log.warn('could not persist result-floor ledger (non-fatal)', { error: err?.message })
    return false
  }
}

/**
 * How many ACTIVE catalog rows exist — the "has the world moved" half of the
 * drift fingerprint. A failure returns 0, which simply means no drift is
 * detected this run (the cooldown still governs); it never invents growth.
 */
export async function countActiveCatalogRows(db) {
  if (!db?.prepare) return 0
  const isPg = db?.dialect === 'postgres'
  try {
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS c FROM funding_opportunities
          WHERE is_active IS NULL OR is_active = ${isPg ? 'TRUE' : '1'}`,
      )
      .get()
    return Number(row?.c ?? 0) || 0
  } catch {
    return 0
  }
}

/**
 * Assess one profile against its floor, given an already-computed awardable
 * count. Pure decision, ledger-aware.
 *
 * @returns {{profile_id, target, awardable, shortfall, below, eligible, reason, attempts, escalation, fingerprint}}
 */
export function assessProfileFloor({
  profileId,
  awardable,
  ledger,
  activeCatalogCount = 0,
  nowMs = Date.now(),
} = {}) {
  const target = resolveProfileResultTarget(profileId, ledger)
  const fingerprint = buildFloorFingerprint({ target, activeCatalogCount })
  const entry = ledger?.profiles?.[String(profileId)] ?? null
  const count = Number(awardable) || 0
  const below = target > 0 && count < target
  const elig = evaluateFloorEligibility(entry, { fingerprint, nowMs })
  return {
    profile_id: profileId,
    target,
    awardable: count,
    shortfall: below ? target - count : 0,
    below,
    eligible: below && elig.eligible,
    reason: below ? elig.reason : 'at_or_above_target',
    attempts: elig.attempts,
    escalation: below ? elig.escalation : 0,
    fingerprint,
  }
}

/**
 * Fold one attempt's outcome into the ledger IN MEMORY (the caller batches the
 * write). Kept separate from `writeFloorLedger` so a caller that fails to
 * recount never persists a mark for an outcome it does not know — the #946
 * "mark written before the answer" rule.
 */
export function recordFloorAttempt(ledger, profileId, outcome) {
  const key = String(profileId)
  const profiles = { ...(ledger?.profiles ?? {}) }
  profiles[key] = applyFloorAttempt(profiles[key] ?? null, outcome)
  return { ...ledger, profiles }
}

/**
 * Refresh a profile's OBSERVED state without spending an attempt. Used by the
 * boot net, which counts but never crawls: it must be able to record that a
 * profile has reached its target (clearing any stale exhaustion) without that
 * looking like a discovery attempt.
 *
 * `fingerprint` BELONGS TO THE VERDICT, NOT TO THE OBSERVATION — this is the
 * whole reason the drift-reopen path exists. `evaluateFloorEligibility`
 * (config/profileResultFloor.js) decides `drifted` by comparing the CURRENT
 * world fingerprint against `entry.fingerprint`, the one the last ATTEMPT was
 * made in, and only `applyFloorAttempt` may advance it. This function used to
 * write it too — and it runs for EVERY profile on EVERY boot
 * (startup/enforceInvariants.js `enforceProfileResultFloor`), so by the time
 * the nightly heal sweep read the ledger `entry.fingerprint` had already been
 * advanced to the current bucket and `drifted` was ALWAYS false. Catalog growth
 * past `RESULT_FLOOR_CATALOG_DRIFT_STEP` and a changed target could therefore
 * never re-open an exhausted profile (only the 14-day cooldown could), and the
 * `drifted && attempts > 0` non-exhausted reset was dead code. The observation
 * is recorded under its own key so the census keeps its telemetry.
 */
export function refreshFloorObservation(ledger, profileId, { target, awardable, fingerprint, at = new Date().toISOString() }) {
  const key = String(profileId)
  const profiles = { ...(ledger?.profiles ?? {}) }
  const prev = profiles[key] ?? null
  const count = Number(awardable) || 0
  const met = Number(target) > 0 && count >= Number(target)
  const next = {
    ...(prev ?? {}),
    target: Number(target) || 0,
    awardable: count,
    best_awardable: Math.max(Number(prev?.best_awardable) || 0, count),
    observed_at: at,
    ...(fingerprint ? { observed_fingerprint: fingerprint } : {}),
  }
  if (met) {
    // Served. A stale "exhausted" verdict from when it was short would suppress
    // every future pass, so reaching the target must clear it outright. The
    // attempt fingerprint goes with the verdict it belonged to.
    next.attempts = 0
    next.exhausted_at = null
    next.exhausted_evidence = null
    next.fingerprint = fingerprint ?? prev?.fingerprint ?? null
    // A served profile must not keep reporting the outcome of the pass that
    // failed it — `applyFloorAttempt` stamps ADDED in its own met-branch.
    next.last_outcome = FLOOR_OUTCOME.ADDED
  } else {
    next.attempts = Number(prev?.attempts) || 0
  }
  profiles[key] = next
  return { ...ledger, profiles }
}

export default {
  readFloorLedger,
  writeFloorLedger,
  countActiveCatalogRows,
  assessProfileFloor,
  recordFloorAttempt,
  refreshFloorObservation,
}
