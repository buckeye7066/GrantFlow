/**
 * Last visited page persistence via /api/preferences (source of truth).
 * Use for "Continue where I left off" and next-step suggestions.
 */
import { apiFetch } from '@/api/client'

/**
 * Get last visited path from server preferences.
 * @returns {Promise<string|null>}
 */
export async function getLastVisitedPath() {
  try {
    const prefs = await apiFetch('/api/preferences')
    const path = prefs?.custom_preferences?.lastVisitedPath
    return typeof path === 'string' && path.length > 0 ? path : null
  } catch {
    return null
  }
}

/**
 * Save last visited path to server preferences (merges with existing custom_preferences).
 * @param {string} path - Full path including query string, e.g. /Pipeline or /DiscoverGrants?profile_id=1
 */
export async function setLastVisitedPath(path) {
  if (!path || typeof path !== 'string') return
  try {
    const existing = await apiFetch('/api/preferences')
    const custom = existing?.custom_preferences ?? {}
    const merged = { ...custom, lastVisitedPath: path }
    await apiFetch('/api/preferences', {
      method: 'PUT',
      body: JSON.stringify({ custom_preferences: merged }),
    })
  } catch {
    // Best-effort: ignore
  }
}
