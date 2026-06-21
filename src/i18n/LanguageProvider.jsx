import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  DEFAULT_LANGUAGE,
  SUPPORTED_LANGUAGES,
  normalizeLanguageCode,
} from '../../shared/languages.js'
import { getActiveProfileId } from '@/api/apiClient'
import { isRealProfileId } from '@/api/profileIdGuards'
import { updatePreferredLanguage, getPreferredLanguage } from '@/api/profiles'
import { LanguageContext, LANGUAGE_STORAGE_KEY, translate } from './languageContext.js'

function readStoredLanguage() {
  if (typeof window === 'undefined') return DEFAULT_LANGUAGE
  try {
    return normalizeLanguageCode(window.localStorage.getItem(LANGUAGE_STORAGE_KEY))
  } catch {
    return DEFAULT_LANGUAGE
  }
}

function writeStoredLanguage(code) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, code)
  } catch {
    /* ignore storage errors (private mode, quota, etc.) */
  }
}

/**
 * Lightweight i18n provider. No heavy dependency — a flat key/value dictionary
 * per language plus a `t(key, vars?)` lookup with `{var}` interpolation.
 *
 * Source of truth precedence:
 *   1. localStorage (instant, survives reloads, set the moment the user picks)
 *   2. backend profile `preferred_language` (synced in once a real profile is
 *      known, so the choice follows the user across devices)
 * English is always the safe fallback.
 */
export function LanguageProvider({ children }) {
  const [language, setLanguageState] = useState(readStoredLanguage)

  // Keep <html lang="…"> accurate for accessibility + the AI/screen readers.
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = language
    }
  }, [language])

  // Best-effort one-way sync FROM the backend on mount: if a real profile is
  // active and has a stored language, adopt it. Never blocks render; failures
  // silently keep the local choice. Runs once on mount — the picker drives all
  // later changes.
  useEffect(() => {
    let cancelled = false
    const profileId = getActiveProfileId?.()
    if (!isRealProfileId(profileId)) return undefined
    getPreferredLanguage(profileId)
      .then((res) => {
        const remote = normalizeLanguageCode(res?.preferred_language)
        setLanguageState((current) => {
          if (cancelled || !remote || remote === current) return current
          writeStoredLanguage(remote)
          return remote
        })
      })
      .catch(() => { /* offline / not-found — keep local choice */ })
    return () => { cancelled = true }
  }, [])

  const setLanguage = useCallback((next) => {
    const code = normalizeLanguageCode(next)
    setLanguageState(code)
    writeStoredLanguage(code)
    // Persist to the profile when we can; ignore failures (local choice stands).
    const profileId = getActiveProfileId?.()
    if (isRealProfileId(profileId)) {
      updatePreferredLanguage(profileId, code).catch(() => {})
    }
    return code
  }, [])

  const t = useCallback((key, vars) => translate(language, key, vars), [language])

  const value = useMemo(
    () => ({ language, setLanguage, t, languages: SUPPORTED_LANGUAGES }),
    [language, setLanguage, t],
  )

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
}

export default LanguageProvider
