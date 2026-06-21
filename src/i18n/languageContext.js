import { createContext, useContext } from 'react'
import { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES } from '../../shared/languages.js'

import en from './locales/en.json'
import es from './locales/es.json'
import ru from './locales/ru.json'
import fr from './locales/fr.json'
import uk from './locales/uk.json'
import de from './locales/de.json'
import pt from './locales/pt.json'
import hi from './locales/hi.json'
import zh from './locales/zh.json'

// Static dictionary map. Bundled directly (no network) so the very first paint
// is already in the user's language.
export const DICTIONARIES = { en, es, ru, fr, uk, de, pt, hi, zh }

export const LANGUAGE_STORAGE_KEY = 'grantflow:preferred-language'

export const LanguageContext = createContext(null)

/** Translate `key` in `lang`, with English then raw-key fallback + `{var}` interp. */
export function translate(lang, key, vars) {
  const dict = DICTIONARIES[lang] || DICTIONARIES[DEFAULT_LANGUAGE]
  const fallback = DICTIONARIES[DEFAULT_LANGUAGE]
  let str = dict[key] ?? fallback[key] ?? key
  if (vars && typeof str === 'string') {
    for (const [k, v] of Object.entries(vars)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
    }
  }
  return str
}

export function useLanguage() {
  const ctx = useContext(LanguageContext)
  if (!ctx) {
    // Defensive default so a component rendered outside the provider (e.g. in a
    // test) still works in English instead of throwing.
    return {
      language: DEFAULT_LANGUAGE,
      setLanguage: () => DEFAULT_LANGUAGE,
      t: (key, vars) => translate(DEFAULT_LANGUAGE, key, vars),
      languages: SUPPORTED_LANGUAGES,
    }
  }
  return ctx
}

/** Convenience hook returning just the translate function. */
export function useT() {
  return useLanguage().t
}
