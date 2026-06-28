// Profile-scoped localStorage helpers.
//
// Per project rules and PROFILE_SCOPING.md:
//   - Every profile-bound piece of state is keyed by profile id.
//   - Switching the active profile evicts all profile-scoped caches.
//   - The store's profile id is the single source of truth — readers must
//     re-validate against the active profile before rendering anything.
//
// The previous codebase used a mix of unscoped keys (e.g.
// `grantflow:funding-results`, `grantflow:saved-grants`,
// `grantflow:dismissed-suggestions`) and per-id keys with no consistent
// shape (e.g. `grantflow:matcher-checklist:<id>`). That created the
// stale-results-after-profile-switch bug we just hit. This helper centralises
// the naming convention and the eviction policy so every reader / writer
// goes through the same gate.

const ROOT_PREFIX = 'grantflow'

// Keys that are profile-scoped but historically were stored as a single
// unscoped value. The eviction routine treats them as per-profile.
export const LEGACY_UNSCOPED_PROFILE_KEYS = Object.freeze([
  'grantflow:funding-results',
  'grantflow:saved-grants',
  'grantflow:dismissed-suggestions',
  'grantflow:discover-last-profile',
  'grantflow:automation-selected-profile',
])

// Keys that are stored as `<prefix>:<id>` and need a per-profile sweep.
export const PER_ID_PROFILE_KEY_PREFIXES = Object.freeze([
  'grantflow:matcher-checklist:',
  'grantflow:matcher-needs:',
  'grantflow:matcher-overrides:',
  'grantflow:funding-results:',
  'grantflow:saved-grants:',
  'grantflow:dismissed-suggestions:',
])

/**
 * Build a canonical per-profile localStorage key.
 * @param {string|null|undefined} profileId
 * @param {string} suffix - the page-level identifier (e.g. 'matcher-checklist')
 * @returns {string|null} the namespaced key, or null when profileId is falsy
 */
export function scopedKey(profileId, suffix) {
  if (!profileId || !suffix) return null
  const id = String(profileId).trim()
  const tag = String(suffix).trim().replace(/^:+|:+$/g, '')
  if (!id || !tag) return null
  return `${ROOT_PREFIX}:${tag}:${id}`
}

function safeRead(key) {
  if (typeof window === 'undefined') return null
  try { return window.localStorage.getItem(key) } catch { return null }
}

function safeWrite(key, value) {
  if (typeof window === 'undefined') return false
  try { window.localStorage.setItem(key, value); return true } catch { return false }
}

function safeRemove(key) {
  if (typeof window === 'undefined') return false
  try { window.localStorage.removeItem(key); return true } catch { return false }
}

/** Read JSON from a per-profile key, or return null if absent / unparseable. */
export function readScopedJSON(profileId, suffix, fallback = null) {
  const key = scopedKey(profileId, suffix)
  if (!key) return fallback
  const raw = safeRead(key)
  if (raw === null || raw === undefined) return fallback
  try { return JSON.parse(raw) } catch { return fallback }
}

/** Write JSON to a per-profile key. No-ops when profileId is missing. */
export function writeScopedJSON(profileId, suffix, value) {
  const key = scopedKey(profileId, suffix)
  if (!key) return false
  return safeWrite(key, JSON.stringify(value ?? null))
}

/** Remove a single per-profile key. */
export function removeScopedKey(profileId, suffix) {
  const key = scopedKey(profileId, suffix)
  if (!key) return false
  return safeRemove(key)
}

/**
 * Wipe every profile-scoped key from localStorage. Called by
 * authStore.setActiveProfileId whenever the active profile actually changes,
 * and by clearState() on logout.
 *
 * Goal-1 invariant: switching profiles MUST clear cached results from the
 * previous one within a single tick; nothing on the page should ever read a
 * result tagged with a different profileId than the active one.
 */
export function clearAllProfileScopedStorage() {
  if (typeof window === 'undefined') return 0
  let removed = 0
  // Direct unscoped offenders.
  for (const key of LEGACY_UNSCOPED_PROFILE_KEYS) {
    if (safeRemove(key)) removed++
  }
  // Per-id keys: enumerate everything in localStorage and drop matches.
  let allKeys = []
  try { allKeys = Object.keys(window.localStorage || {}) } catch { allKeys = [] }
  for (const key of allKeys) {
    if (typeof key !== 'string') continue
    for (const prefix of PER_ID_PROFILE_KEY_PREFIXES) {
      if (key.startsWith(prefix)) {
        if (safeRemove(key)) removed++
        break
      }
    }
  }
  return removed
}

/**
 * Bootstrap migration: drop legacy unscoped versions of keys that should now
 * be profile-scoped. Idempotent — safe to run on every app boot from
 * src/App.jsx. Development logs only; production should not show routine
 * one-time cleanup as a user-facing console issue.
 */
export function migrateLegacyProfileScopedKeys() {
  if (typeof window === 'undefined') return 0
  let removed = 0
  for (const key of LEGACY_UNSCOPED_PROFILE_KEYS) {
    if (safeRead(key) !== null) {
      if (safeRemove(key)) {
        removed++
      }
    }
  }
  if (removed > 0 && import.meta.env?.DEV) {
    try { console.info(`[profileScopedStorage] migrated ${removed} legacy unscoped keys`) } catch { /* ignore */ }
  }
  return removed
}
