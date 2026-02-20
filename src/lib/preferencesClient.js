/**
 * Thin client for user preferences API.
 * Used for explicit fetch/update; app bootstrap uses settingsStore which also calls these endpoints.
 */
import { apiFetch } from '@/api/client'

/** @returns {Promise<Record<string, unknown>>} */
export async function getPreferences() {
  const data = await apiFetch('/api/preferences')
  return data
}

/**
 * @param {Record<string, unknown>} updates - Partial preferences (e.g. { custom_preferences: { feature_flags: { ... } } })
 * @returns {Promise<Record<string, unknown>>}
 */
export async function updatePreferences(updates) {
  const data = await apiFetch('/api/preferences', {
    method: 'PUT',
    body: JSON.stringify(updates),
  })
  return data
}
