import { describe, expect, it } from 'vitest'

import {
  getProfilePreferredLanguage,
  buildLanguageDirective,
  buildLanguageDirectiveForProfile,
} from '../services/languagePreference.js'
import {
  SUPPORTED_LANGUAGE_CODES,
  normalizeLanguageCode,
  isSupportedLanguage,
  DEFAULT_LANGUAGE,
} from '../../shared/languages.js'

// Minimal synchronous db stub mimicking the prepare().get() shape used by the
// sync helper (the SQLite/orchestrator path).
function makeDb(rowByKey) {
  return {
    prepare() {
      return {
        get(profileId, sectionKey) {
          return rowByKey[`${profileId}:${sectionKey}`] ?? undefined
        },
      }
    },
  }
}

describe('shared/languages', () => {
  it('lists exactly the nine supported codes with English default', () => {
    expect(SUPPORTED_LANGUAGE_CODES).toEqual(['en', 'es', 'ru', 'fr', 'uk', 'de', 'pt', 'hi', 'zh'])
    expect(DEFAULT_LANGUAGE).toBe('en')
  })

  it('normalizes regional + casing variants down to the base code', () => {
    expect(normalizeLanguageCode('es-MX')).toBe('es')
    expect(normalizeLanguageCode('  ZH ')).toBe('zh')
    expect(normalizeLanguageCode('klingon')).toBe('en')
    expect(normalizeLanguageCode(null)).toBe('en')
  })

  it('isSupportedLanguage accepts known codes and rejects junk', () => {
    expect(isSupportedLanguage('uk')).toBe(true)
    expect(isSupportedLanguage('fr-CA')).toBe(true)
    expect(isSupportedLanguage('tlh')).toBe(false)
    expect(isSupportedLanguage(undefined)).toBe(false)
  })
})

describe('languagePreference helper', () => {
  it('defaults to English when there is no row', () => {
    const db = makeDb({})
    expect(getProfilePreferredLanguage(db, 'p1')).toBe('en')
  })

  it('reads and normalizes the stored preferred_language', () => {
    const db = makeDb({ 'p1:language_preferences': { data: JSON.stringify({ preferred_language: 'es-ES' }) } })
    expect(getProfilePreferredLanguage(db, 'p1')).toBe('es')
  })

  it('falls back to English on malformed JSON', () => {
    const db = makeDb({ 'p1:language_preferences': { data: '{not json' } })
    expect(getProfilePreferredLanguage(db, 'p1')).toBe('en')
  })

  it('emits no directive for English (default path is untouched)', () => {
    expect(buildLanguageDirective('en')).toBe('')
    const db = makeDb({})
    expect(buildLanguageDirectiveForProfile(db, 'p1')).toBe('')
  })

  it('emits a strong "respond ONLY in" directive for a non-English language', () => {
    const directive = buildLanguageDirective('ru')
    expect(directive).toContain('Respond ONLY in Russian')
    expect(directive).toContain('(ru)')
  })
})
