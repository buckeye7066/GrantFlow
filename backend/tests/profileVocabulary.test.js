import { describe, it, expect } from 'vitest'
import {
  PROFILE_VOCABULARIES,
  NEEDS_VOCABULARY,
  FOCUS_VOCABULARY,
  getProfileVocabulary,
  mapFreeTextToNeedTag,
  mapFreeTextToFocusTag,
} from '../config/profileVocabulary.js'
import { normalizeNeedCategory, NEED_ALIAS_MAP } from '../services/profileNormalizer.js'
import { CANONICAL_NEED_CATEGORIES } from '../constants/needCategories.js'

describe('profile controlled vocabularies (matcher-sourced)', () => {
  it('exposes needs + focus vocabularies via the catalog', () => {
    expect(getProfileVocabulary('needs')).toBe(NEEDS_VOCABULARY)
    expect(getProfileVocabulary('focus')).toBe(FOCUS_VOCABULARY)
    expect(getProfileVocabulary('nope')).toBeNull()
    expect(Object.keys(PROFILE_VOCABULARIES).sort()).toEqual(['focus', 'needs'])
  })

  it('every needs tag is a canonical matcher need bucket (guaranteed to score)', () => {
    const buckets = new Set(Object.values(NEED_ALIAS_MAP))
    expect(NEEDS_VOCABULARY.length).toBeGreaterThan(0)
    for (const { value, label } of NEEDS_VOCABULARY) {
      expect(typeof label).toBe('string')
      // value IS a canonical bucket the matcher recognizes...
      expect(buckets.has(value), `${value} is a NEED_ALIAS_MAP bucket`).toBe(true)
      // ...and normalizeNeedCategory returns it unchanged (self-normalizing).
      expect(normalizeNeedCategory(value)).toBe(value)
    }
  })

  it('every focus tag is a canonical browse category id', () => {
    const ids = new Set(CANONICAL_NEED_CATEGORIES.map((c) => c.id))
    for (const { value } of FOCUS_VOCABULARY) {
      expect(ids.has(value), `${value} is a CANONICAL_NEED_CATEGORIES id`).toBe(true)
    }
  })

  it('maps a known free-text need to its tag and KEEPS an unknown one (null → keep as custom)', () => {
    // Known aliases resolve to a canonical need bucket.
    expect(mapFreeTextToNeedTag('rent')).toBe('housing')
    expect(mapFreeTextToNeedTag('Rental Assistance')).toBe('housing')
    expect(mapFreeTextToNeedTag('groceries')).toBe('food')
    // Unknown free text does not fabricate a bucket — caller keeps it verbatim.
    expect(mapFreeTextToNeedTag('quantum widget subscription')).toBeNull()
  })

  it('focus mapper resolves category ids and need aliases, else null', () => {
    expect(mapFreeTextToFocusTag('housing')).toBe('housing')
    expect(mapFreeTextToFocusTag('Health & Medical')).toBeNull() // label, not an id/alias
    expect(mapFreeTextToFocusTag('healthcare')).toBe('health_medical') // need alias → bucket that is also a category id
    expect(mapFreeTextToFocusTag('totally novel focus area')).toBeNull()
  })
})
