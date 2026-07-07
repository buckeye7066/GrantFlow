/**
 * discoveryPreferences.js — per-profile discovery settings, stored on the SAME
 * profile_sections row the other automation settings use (`automation_preferences`,
 * under the `discovery` sub-key, alongside `portal_access` and `automations`).
 *
 * Today the only preference is `min_match_score`: the default minimum match
 * score run-smart applies when the request does not specify one — i.e. the
 * "Minimum match score" slider that previously persisted into a dead legacy
 * Base44 entity nothing ever read.
 *
 * Threshold semantics (canonical, see config/matchThresholds.js):
 *   - The DISPLAY floor DEFAULT_MIN_SCORE is NOT lowered by this. A stored
 *     preference feeds run-smart's EXPLICIT min path, which is the sanctioned
 *     below-floor route (an explicit min is already honored below the floor).
 *   - AUTO_ADD behavior is untouched — this only affects what a run returns.
 *   - Stored values from the retired need-anchored scale (>30) are translated
 *     to their data-point band on read/write (see normalizeMinMatchScore).
 */

import { DEFAULT_MIN_SCORE, translateLegacyMinScore } from '../config/matchThresholds.js'

const SECTION_KEY = 'automation_preferences'

/**
 * Clamp an arbitrary incoming value to a valid stored min score, or null when
 * it is not a usable number (null = "no preference stored").
 *
 * DATA-POINT scale migration (2026-07-06): any value above the slider's live
 * range must be a retired need-anchored-scale number (e.g. the stuck "85"
 * preference that starved discovery forever) — it is translated to the
 * equivalent band via translateLegacyMinScore before storage/use, so a legacy
 * write can never persist an impossible floor again.
 */
export function normalizeMinMatchScore(raw) {
  if (raw === undefined || raw === null || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  const clamped = Math.min(100, Math.max(0, Math.round(n)))
  return translateLegacyMinScore(clamped)
}

async function loadPreferencesBlob(db, profileId) {
  try {
    const row = await db
      .prepare(`SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = '${SECTION_KEY}' LIMIT 1`)
      .get(String(profileId))
    if (!row?.data) return {}
    const parsed = typeof row.data === 'string' ? JSON.parse(row.data) : row.data
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Read the profile's discovery preferences (normalized; min_match_score may be
 * null). This is the READ choke point for the stored min score, so it also
 * completes the ONE-TIME legacy-scale migration: a value persisted on the
 * retired need-anchored scale (>30, e.g. 85) comes back translated to its
 * data-point band by normalizeMinMatchScore and — when the stored number
 * differs — is written back so the translation happens exactly once. The
 * write-back is best-effort; a failure just means we translate again on the
 * next read.
 */
export async function getDiscoveryPreferences(db, profileId) {
  const prefs = await loadPreferencesBlob(db, profileId)
  const discovery = prefs?.discovery && typeof prefs.discovery === 'object' ? prefs.discovery : {}
  const raw = discovery.min_match_score
  const normalized = normalizeMinMatchScore(raw)
  if (normalized !== null && Number(raw) !== normalized) {
    try {
      await saveDiscoveryMinMatchScore(db, profileId, normalized, 'legacy_scale_migration')
    } catch {
      /* best-effort: the stale stored value is still translated on every read */
    }
  }
  return { min_match_score: normalized }
}

/**
 * Persist the discovery min score for a profile, preserving the section's
 * other sub-keys (portal_access, automations). `minScore: null` clears the
 * preference (run-smart falls back to DEFAULT_MIN_SCORE).
 */
export async function saveDiscoveryMinMatchScore(db, profileId, minScore, updatedBy = null) {
  const normalized = normalizeMinMatchScore(minScore)
  const prefs = await loadPreferencesBlob(db, profileId)
  const discovery = prefs?.discovery && typeof prefs.discovery === 'object' ? { ...prefs.discovery } : {}
  if (normalized === null) delete discovery.min_match_score
  else discovery.min_match_score = normalized
  prefs.discovery = discovery

  const data = JSON.stringify(prefs)
  const existing = await db
    .prepare(`SELECT 1 AS x FROM profile_sections WHERE profile_id = ? AND section_key = '${SECTION_KEY}'`)
    .get(String(profileId))
  if (existing) {
    await db
      .prepare(`UPDATE profile_sections SET data = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE profile_id = ? AND section_key = '${SECTION_KEY}'`)
      .run(data, updatedBy, String(profileId))
  } else {
    await db
      .prepare(`INSERT INTO profile_sections (profile_id, section_key, data, updated_by) VALUES (?, '${SECTION_KEY}', ?, ?)`)
      .run(String(profileId), data, updatedBy)
  }
  return { min_match_score: normalized }
}

/**
 * Resolve the min score a run-smart call should use:
 *   1. an EXPLICIT positive request value always wins (legacy behavior:
 *      `Number(x) || DEFAULT_MIN_SCORE`, so 0/NaN never counted as explicit);
 *   2. otherwise the profile's STORED preference (when > 0);
 *   3. otherwise DEFAULT_MIN_SCORE.
 * Best-effort on the DB read — a preference-load failure must never break a run.
 */
export async function resolveRunSmartMinScore(db, profileId, requested) {
  const explicit = Number(requested)
  if (Number.isFinite(explicit) && explicit > 0) return Math.min(100, explicit)
  try {
    const { min_match_score: stored } = await getDiscoveryPreferences(db, profileId)
    if (stored !== null && stored > 0) return stored
  } catch {
    /* fall through to the default */
  }
  return DEFAULT_MIN_SCORE
}

export default {
  normalizeMinMatchScore,
  getDiscoveryPreferences,
  saveDiscoveryMinMatchScore,
  resolveRunSmartMinScore,
}
