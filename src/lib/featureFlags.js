/**
 * Feature flags resolved from build-time env defaults + persisted preferences (custom_preferences.feature_flags).
 * Preferences override env when present. Used so Anya copilot/screenshot state persists across refresh and login.
 */
import { env } from '@/config/env'
import { useSettingsStore } from '@/stores/settingsStore'

const DEFAULT_FEATURE_FLAGS = {
  anyaCopilotEnabled: env.anyaCopilotEnabled,
  anyaScreenshotEnabled: env.anyaScreenshotEnabled,
}

/**
 * @param {{ feature_flags?: { anyaCopilotEnabled?: boolean, anyaScreenshotEnabled?: boolean } } | null | undefined} customPrefs
 * @returns {{ anyaCopilotEnabled: boolean, anyaScreenshotEnabled: boolean }}
 */
export function getFeatureFlagsFromPreferences(customPrefs) {
  const flags = customPrefs?.feature_flags
  return {
    anyaCopilotEnabled: typeof flags?.anyaCopilotEnabled === 'boolean' ? flags.anyaCopilotEnabled : DEFAULT_FEATURE_FLAGS.anyaCopilotEnabled,
    anyaScreenshotEnabled: typeof flags?.anyaScreenshotEnabled === 'boolean' ? flags.anyaScreenshotEnabled : DEFAULT_FEATURE_FLAGS.anyaScreenshotEnabled,
  }
}

/**
 * Hook: returns resolved feature flags from settings store + env. Subscribes to store so UI updates when prefs change.
 * Use this in components (Layout, Anya, Settings) so flags persist across refresh and login.
 */
export function useFeatureFlags() {
  const customPrefs = useSettingsStore((state) => state.preferences?.custom_preferences)
  return getFeatureFlagsFromPreferences(customPrefs ?? undefined)
}
