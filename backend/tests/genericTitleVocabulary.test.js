import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

import {
  GENERIC_TITLE_PHRASES,
  getGenericTitlePhrases,
  getGenericTitleAdditions,
  setGenericTitleAdditions,
  sanitizeGenericTitleAdditions,
  isGenericTitle,
  isGenericOnly,
} from '../config/genericTitleVocabulary.js'

// The vocabulary is process-global (an additive live mirror, like
// coverageOverrides). Every test that sets additions MUST reset it.
afterEach(() => setGenericTitleAdditions([]))

describe('genericTitleVocabulary — the registry', () => {
  it('matches generic listings and leaves concrete programs alone', () => {
    expect(isGenericTitle('Tennessee Funding Finder')).toBe(true)
    expect(isGenericTitle('List of Grants for Families')).toBe(true)
    expect(isGenericTitle('Community Resource Directory')).toBe(true)
    expect(isGenericTitle('Emergency Rental Assistance Program')).toBe(false)
    expect(isGenericTitle('Pell Grant')).toBe(false)
  })

  it('isGenericOnly spares a generically-titled row with a concrete anchor', () => {
    // "Cancer Resource Directory" is a cancer row, not a generic listing.
    expect(isGenericTitle('Cancer Resource Directory')).toBe(true)
    expect(isGenericOnly('Cancer Resource Directory')).toBe(false)
    expect(isGenericOnly('Funding Finder')).toBe(true)
  })

  it('treats phrases as LITERAL text — an addition can never inject a pattern', () => {
    // If additions were compiled as regex source, this would become a
    // catastrophic/alternating pattern instead of a literal phrase.
    setGenericTitleAdditions(['grants (a|b)+'])
    // Rejected by the charset guard, so it never reaches the matcher at all.
    expect(getGenericTitleAdditions()).toEqual([])
    expect(isGenericTitle('grants (a|b)+')).toBe(false)
  })

  it('sanitize rejects junk, dupes, baseline repeats and over-short tokens', () => {
    const out = sanitizeGenericTitleAdditions([
      'aid', // too short — would swallow legitimate titles
      'directory', // already baseline
      'Statewide Benefits Lookup', // ok (normalized to lowercase)
      'statewide benefits lookup', // dupe of the above
      '<script>', // junk
      '   ', // empty
      'x'.repeat(200), // too long
    ])
    expect(out).toEqual(['statewide benefits lookup'])
  })

  it('additions are ADDITIVE — a baseline phrase can never be removed', () => {
    setGenericTitleAdditions(['statewide benefits lookup'])
    expect(isGenericTitle('Statewide Benefits Lookup')).toBe(true)
    expect(isGenericTitle('Funding Finder')).toBe(true) // baseline still holds
    expect(getGenericTitlePhrases().length).toBe(GENERIC_TITLE_PHRASES.length + 1)
  })
})

describe('genericTitleVocabulary — TOTALITY (no second copy of the list)', () => {
  // The drift this registry exists to kill: amyReport's GENERIC_TITLE_RX and
  // profileSpecificGate's GENERIC_ONLY_RE were two hand-maintained lists that
  // shared only 4 of ~12 terms, so Amy flagged phrasings the gate could not
  // act on. Both consumers, plus the engine's ACCEPT cap, must read the
  // registry — a re-introduced local list is what this test forbids.
  const CONSUMERS = [
    'backend/services/amy/amyReport.js',
    'backend/services/matching/profileSpecificGate.js',
    'backend/services/matchEngine.js',
  ]

  it('every consumer imports the registry instead of defining its own vocabulary', () => {
    for (const rel of CONSUMERS) {
      const src = fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8')
      expect(src, `${rel} must import the shared vocabulary`).toMatch(
        /from '.*config\/genericTitleVocabulary\.js'/,
      )
    }
  })

  it('no consumer re-declares a local generic-title regex', () => {
    const BANNED = /(GENERIC_TITLE_RX|GENERIC_ONLY_RE)\s*=/
    for (const rel of CONSUMERS) {
      const src = fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8')
      expect(src, `${rel} re-declares a local generic vocabulary — use the registry`).not.toMatch(BANNED)
    }
  })

  it('the registry covers every phrase both original lists carried', () => {
    // Union of the two pre-registry regexes. If a future edit drops one of
    // these, a row the old system caught would silently start ACCEPTing.
    const ORIGINAL_UNION = [
      'funding finder', 'benefit finder', 'grant search', 'search portal',
      'directory', 'resource guide', 'resource center', 'resource finder',
      'general funding', 'general assistance', 'find funding', 'find grants',
      'find help', 'list of', 'database of', 'portal',
      'general funding support', 'resource directory', 'service directory',
      'funding opportunities',
    ]
    for (const phrase of ORIGINAL_UNION) {
      expect(isGenericTitle(`A ${phrase} page`), `lost coverage of "${phrase}"`).toBe(true)
    }
  })
})
