import { describe, it, expect } from 'vitest'
import llmPageExtract, { isListingSurface, _internal } from '../services/hamilton/portalSync/llmPageExtract.js'

const { partitionAwards, awardHasUserEvidence, errToText, describeLlmFailure } = _internal

describe('portal-sync fabrication guard', () => {
  describe('isListingSurface', () => {
    it('flags search/browse/catalog URLs', () => {
      expect(isListingSurface('https://www.fastweb.com/college-scholarships/search?q=ems')).toBe(true)
      expect(isListingSurface('https://bold.org/scholarships/browse/')).toBe(true)
      expect(isListingSurface('https://www.collegexpress.com/scholarships/list')).toBe(true)
      expect(isListingSurface('https://myscholly.com/matches')).toBe(true)
      expect(isListingSurface('https://example.edu/aid?keyword=nursing')).toBe(true)
    })
    it('flags listing page titles even on neutral URLs', () => {
      expect(isListingSurface('https://example.edu/aid', 'Scholarship Search | Fastweb')).toBe(true)
      expect(isListingSurface('https://example.edu/aid', 'Find College Scholarships')).toBe(true)
    })
    it('does NOT flag genuine account/award pages', () => {
      expect(isListingSurface('https://mtsu.academicworks.com/users/awards', 'Your Awards')).toBe(false)
      expect(isListingSurface('https://example.edu/financial-aid/awards')).toBe(false)
      // "financial" must not fuzzy-match "find"
      expect(isListingSurface('https://example.edu/financial-aid/')).toBe(false)
    })
  })

  describe('awardHasUserEvidence / partitionAwards', () => {
    const listingAward = {
      title: '$25,000 "Be Bold" No-Essay Scholarship',
      amount: 25000,
      status: null,
      sourceUrl: 'https://bold.org/scholarships/browse/',
    }
    const realAward = {
      title: 'MTSU Freshman Guaranteed Scholarship',
      amount: 4000,
      status: 'accepted',
      sourceUrl: 'https://mtsu.academicworks.com/users/awards',
      evidence: 'Your award: $4,000 — status Accepted',
    }

    it('rejects listing-surface awards with a recorded reason', () => {
      const { kept, rejected } = partitionAwards([listingAward], [
        { url: 'https://bold.org/scholarships/browse/', title: 'Browse Scholarships | Bold.org' },
      ])
      expect(kept).toHaveLength(0)
      expect(rejected).toHaveLength(1)
      expect(rejected[0].reason).toMatch(/listing_surface/)
      expect(rejected[0].title).toBe(listingAward.title)
    })

    it('rejects awards without user-specific evidence', () => {
      const noEvidence = { title: 'Niche $2,000 "No Essay" Scholarship', amount: 2000, status: null, sourceUrl: 'https://example.edu/aid' }
      const { kept, rejected } = partitionAwards([noEvidence], [])
      expect(kept).toHaveLength(0)
      expect(rejected[0].reason).toMatch(/no_user_specific_evidence/)
    })

    it('keeps awards with a user award status or account-tied evidence', () => {
      expect(awardHasUserEvidence(realAward)).toBe(true)
      const { kept, rejected } = partitionAwards([realAward], [
        { url: 'https://mtsu.academicworks.com/users/awards', title: 'Your Awards' },
      ])
      expect(kept).toHaveLength(1)
      expect(rejected).toHaveLength(0)
    })

    it('never throws on malformed input', () => {
      expect(partitionAwards(null, null)).toEqual({ kept: [], rejected: [] })
      expect(partitionAwards([{}], [])).toEqual({
        kept: [],
        rejected: [{ title: undefined, sourceUrl: null, reason: expect.stringMatching(/no_user_specific_evidence/) }],
      })
    })
  })

  describe('LLM error stringification', () => {
    it('never yields [object Object]', () => {
      expect(errToText({ status: 429, message: 'rate limited' })).toBe('429 rate limited')
      expect(errToText(new Error('boom'))).toBe('boom')
      expect(errToText('plain')).toBe('plain')
      expect(errToText({ nested: { deep: true } })).not.toBe('[object Object]')
    })
    it('describeLlmFailure surfaces provider errors', () => {
      const text = describeLlmFailure({ anthropicError: { status: 500, message: 'overloaded' }, raw: '{"bad"' })
      expect(text).toContain('anthropic: 500 overloaded')
      expect(text).toContain('raw:')
    })
  })

  it('module default export still exposes the extractor', () => {
    expect(typeof llmPageExtract.extractPortalDataWithLLM).toBe('function')
    expect(typeof llmPageExtract.isListingSurface).toBe('function')
  })
})
