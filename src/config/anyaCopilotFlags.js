/**
 * Runtime feature flags for Anya copilot UX.
 * - ANYA_COPILOT_ENABLED: default OFF in production; can be overridden in dev via localStorage.
 * - ANYA_SCREENSHOT_ENABLED: default OFF everywhere (env only).
 */
import { env } from './env'

const STORAGE_KEY_COPILOT = 'grantflow:anya_copilot_enabled'

/**
 * Returns true if Anya copilot UX (context, next steps, use current screen) should be shown.
 * In production: only if VITE_ANYA_COPILOT_ENABLED=true at build time.
 * In dev: also true if localStorage key grantflow:anya_copilot_enabled === 'true'.
 */
export function isAnyaCopilotEnabled() {
  if (env.anyaCopilotEnabled) return true
  if (env.isDev && typeof window !== 'undefined') {
    try {
      return window.localStorage.getItem(STORAGE_KEY_COPILOT) === 'true'
    } catch {
      return false
    }
  }
  return false
}

/**
 * Returns true if Anya screenshot capture is allowed (user-triggered only).
 * Default OFF everywhere.
 */
export function isAnyaScreenshotEnabled() {
  return env.anyaScreenshotEnabled === true
}

/**
 * Enable or disable the copilot flag in localStorage (dev only). No-op in production.
 */
export function setAnyaCopilotEnabled(value) {
  if (env.isProd) return
  try {
    if (value) {
      window.localStorage.setItem(STORAGE_KEY_COPILOT, 'true')
    } else {
      window.localStorage.removeItem(STORAGE_KEY_COPILOT)
    }
  } catch {
    // ignore
  }
}

export { STORAGE_KEY_COPILOT }
