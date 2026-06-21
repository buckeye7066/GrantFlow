/**
 * languages.js — canonical multi-language catalog for GrantFlow.
 *
 * Single source of truth for the languages GrantFlow supports. Used by:
 *   - the frontend i18n provider (src/i18n) for the language picker + dictionaries
 *   - Anya's onboarding (language is the VERY FIRST onboarding step)
 *   - the backend, to inject a "respond ONLY in <language>" directive into
 *     Anya's system prompt and every other user-facing AI prompt
 *
 * English is the default. Native names are shown in their own script so the
 * picker is friendly regardless of the language the user currently reads.
 *
 * IMPORTANT: keep this list in sync with the JSON dictionaries under
 * src/i18n/locales/. The ISO codes here are the dictionary file names.
 */

export const SUPPORTED_LANGUAGES = Object.freeze([
  Object.freeze({ code: 'en', nativeName: 'English', englishName: 'English' }),
  Object.freeze({ code: 'es', nativeName: 'Español', englishName: 'Spanish' }),
  Object.freeze({ code: 'ru', nativeName: 'Русский', englishName: 'Russian' }),
  Object.freeze({ code: 'fr', nativeName: 'Français', englishName: 'French' }),
  Object.freeze({ code: 'uk', nativeName: 'Українська', englishName: 'Ukrainian' }),
  Object.freeze({ code: 'de', nativeName: 'Deutsch', englishName: 'German' }),
  Object.freeze({ code: 'pt', nativeName: 'Português', englishName: 'Portuguese' }),
  Object.freeze({ code: 'hi', nativeName: 'हिन्दी', englishName: 'Hindi' }),
  Object.freeze({ code: 'zh', nativeName: '中文', englishName: 'Chinese (Simplified)' }),
])

export const DEFAULT_LANGUAGE = 'en'

export const SUPPORTED_LANGUAGE_CODES = Object.freeze(
  SUPPORTED_LANGUAGES.map((l) => l.code),
)

const LANGUAGE_BY_CODE = Object.freeze(
  Object.fromEntries(SUPPORTED_LANGUAGES.map((l) => [l.code, l])),
)

/**
 * Normalize an arbitrary value to a supported ISO code, falling back to English.
 * Accepts things like "es-MX", "EN", " fr " and reduces them to the base code.
 */
export function normalizeLanguageCode(value) {
  if (typeof value !== 'string') return DEFAULT_LANGUAGE
  const base = value.trim().toLowerCase().split(/[-_]/)[0]
  return SUPPORTED_LANGUAGE_CODES.includes(base) ? base : DEFAULT_LANGUAGE
}

/** True when the value resolves to a supported language code (after normalize). */
export function isSupportedLanguage(value) {
  if (typeof value !== 'string') return false
  const base = value.trim().toLowerCase().split(/[-_]/)[0]
  return SUPPORTED_LANGUAGE_CODES.includes(base)
}

/** Look up the catalog entry for a code (normalized). */
export function getLanguage(code) {
  return LANGUAGE_BY_CODE[normalizeLanguageCode(code)]
}

/** Human-readable English name for a code, e.g. 'es' -> 'Spanish'. */
export function languageEnglishName(code) {
  return getLanguage(code).englishName
}

/** Native-script name for a code, e.g. 'es' -> 'Español'. */
export function languageNativeName(code) {
  return getLanguage(code).nativeName
}
