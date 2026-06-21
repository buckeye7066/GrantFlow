import { describe, expect, it } from 'vitest'

import {
  getProfilePreferredLanguage,
  buildLanguageDirective,
  buildLanguageDirectiveForProfile,
  scanProfileLanguageReadiness,
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

// Async db stub mimicking prepare().all() returning the joined profile rows the
// readiness scan reads (the Postgres path).
function makeScanDb(rows) {
  return {
    prepare() {
      return { all: async () => rows }
    },
  }
}

describe('scanProfileLanguageReadiness (Sam/Anya observability)', () => {
  it('reports all-clear when no profile sets a language', async () => {
    const out = await scanProfileLanguageReadiness(makeScanDb([
      { id: 'p1', display_name: 'A', data: null },
      { id: 'p2', display_name: 'B', data: null },
    ]))
    expect(out.ok).toBe(true)
    expect(out.profiles_scanned).toBe(2)
    expect(out.explicit_non_default).toBe(0)
    expect(out.findings).toEqual([])
    expect(out.summary).toContain('all stored language preferences are valid')
  })

  it('counts non-English choices and their distribution', async () => {
    const out = await scanProfileLanguageReadiness(makeScanDb([
      { id: 'p1', display_name: 'A', data: JSON.stringify({ preferred_language: 'es' }) },
      { id: 'p2', display_name: 'B', data: JSON.stringify({ preferred_language: 'es-MX' }) },
      { id: 'p3', display_name: 'C', data: JSON.stringify({ preferred_language: 'en' }) },
    ]))
    expect(out.explicit_non_default).toBe(2)
    expect(out.by_language.es).toBe(2)
    expect(out.findings).toEqual([])
    expect(out.summary).toContain('Spanish:2')
  })

  it('flags an unsupported stored code as a low finding (silent English degrade)', async () => {
    const out = await scanProfileLanguageReadiness(makeScanDb([
      { id: 'p9', display_name: 'Z', data: JSON.stringify({ preferred_language: 'tlh' }) },
    ]))
    expect(out.findings).toHaveLength(1)
    expect(out.findings[0]).toMatchObject({ severity: 'low', category: 'profile_language' })
    expect(out.findings[0].evidence).toEqual({ profile_id: 'p9', stored_value: 'tlh' })
    expect(out.summary).toContain('unsupported language code')
  })

  it('never throws on a missing table — returns an empty result', async () => {
    const throwingDb = { prepare() { return { all: async () => { throw new Error('no such table: profiles') } } } }
    const out = await scanProfileLanguageReadiness(throwingDb)
    expect(out.ok).toBe(true)
    expect(out.profiles_scanned).toBe(0)
    expect(out.findings).toEqual([])
  })
})
