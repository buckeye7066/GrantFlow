import { describe, it, expect } from 'vitest'
import {
  PROFILE_SCHEMA,
  resolveFieldFormat,
  isFieldScored,
  getUnscoredProseFieldNames,
  getReferencedVocabularyNames,
} from '../config/profileSchema.js'
import { PROFILE_VOCABULARIES, isVocabularyName } from '../config/profileVocabulary.js'

/**
 * Guard for the 2026-07-07 profile schema redesign field-metadata contract
 * (owner directive: every field feeds the matcher as a structured data point OR
 * is explicitly scored:false drafting-only prose). See docs/canonical_rules.md
 * "Every profile field feeds the matcher or is drafting-only prose".
 */

const KNOWN_FORMATS = new Set([
  'enum', 'tags', 'prose', 'boolean', 'boolean_tri', 'number', 'date', 'text', 'object', 'array',
])

function eachField(fn) {
  for (const [sectionKey, section] of Object.entries(PROFILE_SCHEMA)) {
    for (const [fieldName, meta] of Object.entries(section?.fields ?? {})) {
      fn({ sectionKey, fieldName, meta })
    }
  }
}

describe('profile schema field-metadata contract', () => {
  it('every field has a resolvable, known format', () => {
    eachField(({ sectionKey, fieldName, meta }) => {
      const fmt = resolveFieldFormat(meta)
      expect(fmt, `${sectionKey}.${fieldName} format`).toBeTruthy()
      expect(KNOWN_FORMATS.has(fmt), `${sectionKey}.${fieldName} format=${fmt} must be known`).toBe(true)
    })
  })

  it('enum fields carry a non-empty options array', () => {
    eachField(({ sectionKey, fieldName, meta }) => {
      if (resolveFieldFormat(meta) !== 'enum') return
      expect(Array.isArray(meta.options), `${sectionKey}.${fieldName} options must be an array`).toBe(true)
      expect(meta.options.length, `${sectionKey}.${fieldName} options non-empty`).toBeGreaterThan(0)
    })
  })

  it('tag fields point at a real, matcher-sourced vocabulary', () => {
    let tagFields = 0
    eachField(({ sectionKey, fieldName, meta }) => {
      if (resolveFieldFormat(meta) !== 'tags') return
      tagFields += 1
      expect(typeof meta.vocabulary, `${sectionKey}.${fieldName} vocabulary is a string`).toBe('string')
      expect(isVocabularyName(meta.vocabulary), `${sectionKey}.${fieldName} vocabulary '${meta.vocabulary}' exists`).toBe(true)
    })
    expect(tagFields, 'schema declares at least one tag field').toBeGreaterThan(0)
  })

  it('no field is both scored and free-text prose', () => {
    eachField(({ sectionKey, fieldName, meta }) => {
      if (resolveFieldFormat(meta) === 'prose') {
        expect(meta.scored === true, `${sectionKey}.${fieldName} must not be scored:true prose`).toBe(false)
        expect(isFieldScored(meta), `${sectionKey}.${fieldName} prose must be unscored`).toBe(false)
      }
    })
  })

  it('deprecated fields are unscored', () => {
    eachField(({ sectionKey, fieldName, meta }) => {
      if (!meta.deprecated) return
      expect(isFieldScored(meta), `${sectionKey}.${fieldName} deprecated → unscored`).toBe(false)
    })
  })

  it('every referenced vocabulary exists in profileVocabulary', () => {
    for (const name of getReferencedVocabularyNames()) {
      expect(Object.prototype.hasOwnProperty.call(PROFILE_VOCABULARIES, name), `vocabulary '${name}'`).toBe(true)
    }
  })

  it('the essays section is a first-class drafting-only section Hamilton reads', () => {
    const essays = PROFILE_SCHEMA.essays
    expect(essays, 'essays section present').toBeTruthy()
    // Hamilton's readers (hamiltonFullProposalGenerator / packet / autopilot) draft
    // from these keys — they must exist and all be scored:false prose.
    for (const key of ['primary', 'personal_statement', 'statement_of_need', 'goals', 'career_goals', 'financial_hardship']) {
      const f = essays.fields[key]
      expect(f, `essays.${key} present`).toBeTruthy()
      expect(resolveFieldFormat(f)).toBe('prose')
      expect(isFieldScored(f), `essays.${key} unscored`).toBe(false)
    }
  })

  it('unscored-prose name set includes mission, notes, narrative + essays fields', () => {
    const names = getUnscoredProseFieldNames()
    for (const n of ['mission', 'notes', 'barriers_faced', 'special_circumstances', 'personal_statement', 'statement_of_need']) {
      expect(names.has(n), `${n} is an unscored prose field name`).toBe(true)
    }
    // A structured tag/enum field name must NOT be treated as unscored prose.
    expect(names.has('funding_needs')).toBe(false)
    expect(names.has('focus_areas')).toBe(false)
  })
})
