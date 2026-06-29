/**
 * scoringTuning.js
 *
 * LIVE, DB-PERSISTED overrides for the crawler's core scoring knobs — the match
 * score floor and the four weighted subscale weights. This is the seam that
 * makes Amy's "improve the crawlers with each cycle" loop actually take effect
 * and STICK:
 *
 *   - Live: the match engine reads getEffectiveWeights()/getEffectiveMinScore()
 *     on every score, so an applied tuning changes scoring IMMEDIATELY in the
 *     running process (unlike editing matchThresholds.js, whose constants are
 *     import-cached and never re-read).
 *   - Persistent: tuning is saved to system_kv and re-hydrated on boot, so an
 *     improvement survives restarts and redeploys (unlike an ephemeral file edit
 *     on a container filesystem).
 *
 * Defaults come from matchThresholds.js, so with no override the behavior is
 * byte-for-byte identical to before. Fully reversible: clear the override (or
 * restore the previous value) and the engine is back to the defaults.
 */

import {
  W_NEED,
  W_ELIGIBILITY,
  W_GEO,
  W_CATEGORY,
  DEFAULT_MIN_SCORE,
} from './matchThresholds.js'

export const WEIGHT_KEYS = ['W_NEED', 'W_ELIGIBILITY', 'W_GEO', 'W_CATEGORY']
const DEFAULT_WEIGHTS = Object.freeze({ W_NEED, W_ELIGIBILITY, W_GEO, W_CATEGORY })
const KV_KEY = 'crawler_scoring_tuning'

let _weights = { ...DEFAULT_WEIGHTS }
let _minScore = DEFAULT_MIN_SCORE

/** Clamp + normalize weights so they always sum to 1.0 (bounded per weight). */
export function normalizeWeights(weights) {
  const clamped = {}
  for (const k of WEIGHT_KEYS) clamped[k] = Math.max(0.05, Math.min(0.6, Number(weights?.[k]) || 0))
  const sum = WEIGHT_KEYS.reduce((s, k) => s + clamped[k], 0) || 1
  const scaled = {}
  for (const k of WEIGHT_KEYS) scaled[k] = Math.round((clamped[k] / sum) * 1000) / 1000
  const drift = Math.round((1 - WEIGHT_KEYS.reduce((s, k) => s + scaled[k], 0)) * 1000) / 1000
  scaled.W_NEED = Math.round((scaled.W_NEED + drift) * 1000) / 1000
  return scaled
}

/** Live weights the scoring engine multiplies each subscale by. */
export function getEffectiveWeights() {
  return _weights
}

/** Live default min score (the "75% slider" floor). */
export function getEffectiveMinScore() {
  return _minScore
}

export function getDefaultWeights() {
  return { ...DEFAULT_WEIGHTS }
}

export function getScoringTuning() {
  return { weights: { ..._weights }, minScore: _minScore }
}

/**
 * Update the live tuning in-process. Returns the new effective tuning.
 * Weights are normalized to sum 1.0; minScore is clamped to [0, 100].
 */
export function setScoringTuning({ weights, minScore } = {}) {
  if (weights && typeof weights === 'object') {
    _weights = normalizeWeights({ ..._weights, ...weights })
  }
  if (Number.isFinite(Number(minScore))) {
    _minScore = Math.max(0, Math.min(100, Math.round(Number(minScore))))
  }
  return getScoringTuning()
}

/** Reset to the matchThresholds.js defaults (used by tests + full revert). */
export function resetScoringTuning() {
  _weights = { ...DEFAULT_WEIGHTS }
  _minScore = DEFAULT_MIN_SCORE
  return getScoringTuning()
}

async function ensureKv(db) {
  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)').run()
  } catch {
    // table may already exist with a richer shape — fine
  }
}

/** Persist the current live tuning to system_kv so it survives restarts. */
export async function persistScoringTuning(db) {
  if (!db) return false
  try {
    await ensureKv(db)
    const value = JSON.stringify(getScoringTuning())
    const now = new Date().toISOString()
    const res = await db.prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?').run(value, now, KV_KEY)
    if (!Number(res?.changes ?? res?.rowCount ?? 0)) {
      await db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(KV_KEY, value, now)
    }
    return true
  } catch {
    return false
  }
}

/** Load persisted tuning into the live store on boot. Returns the loaded value or null. */
export async function hydrateScoringTuning(db) {
  if (!db) return null
  try {
    await ensureKv(db)
    const row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(KV_KEY)
    if (!row?.value) return null
    const parsed = JSON.parse(row.value)
    setScoringTuning(parsed)
    return getScoringTuning()
  } catch {
    return null
  }
}

export default {
  WEIGHT_KEYS,
  getEffectiveWeights,
  getEffectiveMinScore,
  getDefaultWeights,
  getScoringTuning,
  setScoringTuning,
  resetScoringTuning,
  normalizeWeights,
  persistScoringTuning,
  hydrateScoringTuning,
}
