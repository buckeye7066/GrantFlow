/**
 * Runtime feature flags for Anya copilot UX.
 * Resolved from env defaults + persisted preferences (custom_preferences.feature_flags).
 * Prefer useFeatureFlags() in components so UI reacts to pref changes; these getters read from store when hydrated.
 */
import { getFeatureFlagsFromPreferences } from '@/lib/featureFlags'
import { useSettingsStore } from '@/stores/settingsStore'

/**
 * Returns true if Anya copilot UX (context, next steps, use current screen) should be shown.
 * Reads from persisted preferences when store is hydrated; otherwise falls back to env.
 */
export function isAnyaCopilotEnabled() {
  try {
    const customPrefs = useSettingsStore.getState?.()?.preferences?.custom_preferences
    const flags = getFeatureFlagsFromPreferences(customPrefs ?? undefined)
    return flags.anyaCopilotEnabled === true
  } catch {
    return false
  }
}

/**
 * Returns true if Anya screenshot capture is allowed (user-triggered only).
 */
export function isAnyaScreenshotEnabled() {
  try {
    const customPrefs = useSettingsStore.getState?.()?.preferences?.custom_preferences
    const flags = getFeatureFlagsFromPreferences(customPrefs ?? undefined)
    return flags.anyaScreenshotEnabled === true
  } catch {
    return false
  }
}

/**
 * @deprecated Use Settings → Features toggles (persisted via PUT /api/preferences). No-op; kept for compatibility.
 * @param {boolean} _value - Ignored; toggle via Settings UI instead.
 */
export function setAnyaCopilotEnabled(_value) {
  // Flags are now persisted in backend; toggle via Settings → Features.
}

export const STORAGE_KEY_COPILOT = 'grantflow:anya_copilot_enabled'
