import { getPreferences, updatePreferences } from './preferencesClient.js'

/**
 * Read the incognitoEnabled flag from preferences.
 * @param {Record<string, unknown>} preferences
 * @returns {boolean}
 */
export function getIncognitoEnabled(preferences) {
  return preferences?.custom_preferences?.incognitoEnabled ?? false
}

/**
 * Persist the incognitoEnabled flag.
 * This fetches existing custom_preferences and writes the new value.
 * @param {boolean} value
 * @returns {Promise<Record<string, unknown>>}
 */
export async function setIncognitoEnabled(value) {
  // Retrieve the latest preferences first
  const prefs = await getPreferences()
  const custom = prefs?.custom_preferences ?? {}
  const updatedCustom = { ...custom, incognitoEnabled: value }
  return updatePreferences({ custom_preferences: updatedCustom })
}
