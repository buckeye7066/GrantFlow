/**
 * Profile-id boundary guards.
 *
 * `__admin__` is a UI-only pseudo-profile id used by the auth store and
 * `Layout.jsx` for the admin "view all" mode. It is NOT a real row in the
 * `profiles` table — every backend route that resolves a profile by id
 * returns 404 for it. The Documents page reproduced this in production
 * after admin login: `GET /api/profiles/__admin__ 404`. The fix is at the
 * API boundary so every future caller is safe by default.
 *
 * This module intentionally has zero imports so it can be unit-tested
 * directly under `node --test`, without dragging in the rest of the API
 * client (which uses Vite-only imports such as `import.meta.env`).
 */

export const ADMIN_PROFILE_SENTINEL = '__admin__'

/** True iff `id` is a real, routable profile id. */
export function isRealProfileId(id) {
  if (id === null || id === undefined) return false
  if (typeof id === 'number' && !Number.isFinite(id)) return false
  if (typeof id !== 'string' && typeof id !== 'number') return false
  const str = String(id)
  if (str === '') return false
  if (str === ADMIN_PROFILE_SENTINEL) return false
  return true
}

/**
 * Throw a tagged error if `id` is not a real profile id. Designed to live
 * at the top of every `/api/profiles/<id>` helper so we never issue an
 * HTTP request to a sentinel.
 */
export function assertRealProfileId(id, fnName) {
  if (isRealProfileId(id)) return
  const err = new Error(
    `[api/profiles.${fnName}] called with non-routable id ${JSON.stringify(id)}; refusing to hit /api/profiles/${id}.`,
  )
  err.code = 'INVALID_PROFILE_ID'
  throw err
}
