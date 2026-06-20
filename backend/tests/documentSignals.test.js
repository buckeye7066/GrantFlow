/**
 * Uploaded documents are profile information too. buildProfileSignals now mines
 * salient terms from documents' extracted_text into keywordSet so they enrich
 * matching AND (as the lowest-priority facet) the live-source queries. These
 * tests pin that the mining is relatable (real terms surface) and bounded
 * (boilerplate/stopwords do not).
 */
import { describe, it, expect } from 'vitest'
import { buildProfileSignals } from '../services/profileHelpers.js'
import { getFundingSourceStatus, FUNDING_SOURCES } from '../src/config/fundingSources.js'

describe('buildProfileSignals — document text mining', () => {
  const docProfile = {
    profile: { id: 'p1', primary_type: 'nonprofit' },
    sections: {},
    documents: [
      {
        extracted_text:
          'Our dialysis support program serves kidney patients across rural Appalachia. ' +
          'The dialysis program funds transportation and dialysis copays for kidney dialysis patients. ' +
          'We focus on rural kidney care and dialysis access.',
      },
    ],
  }

  it('surfaces salient document terms as keywords', () => {
    const signals = buildProfileSignals(docProfile)
    const kw = signals.keywords
    // Recurring domain terms from the document should be mined.
    expect(kw.some((k) => k.includes('dialysis'))).toBe(true)
    expect(kw.some((k) => k.includes('kidney'))).toBe(true)
  })

  it('does not mine English/boilerplate stopwords', () => {
    const signals = buildProfileSignals(docProfile)
    const kw = signals.keywords
    for (const noise of ['the', 'and', 'for', 'program', 'across', 'our']) {
      expect(kw).not.toContain(noise)
    }
  })

  it('is safe when no documents are present', () => {
    const signals = buildProfileSignals({ profile: { id: 'p2' }, sections: {} })
    expect(Array.isArray(signals.keywords)).toBe(true)
  })

  it('tolerates empty/garbage extracted_text', () => {
    const signals = buildProfileSignals({
      profile: { id: 'p3' },
      sections: {},
      documents: [{ extracted_text: '' }, { extracted_text: null }, {}],
    })
    expect(Array.isArray(signals.keywords)).toBe(true)
  })
})

describe('funding source registry', () => {
  it('includes the keyless public sources as configured', () => {
    const byId = Object.fromEntries(getFundingSourceStatus().map((s) => [s.id, s]))
    for (const id of ['grants.gov', 'usaspending.gov', 'state.portals', 'propublica.990']) {
      expect(byId[id], `missing source ${id}`).toBeTruthy()
      expect(byId[id].configured).toBe(true) // keyless → always usable
    }
  })

  it('every source carries setup guidance (signup link + steps) for the admin screen', () => {
    for (const src of FUNDING_SOURCES) {
      expect(src.setup, `${src.id} missing setup`).toBeTruthy()
      expect(typeof src.setup.signup_url === 'string' || src.setup.signup_url === null).toBe(true)
      expect(Array.isArray(src.setup.steps)).toBe(true)
      expect(src.setup.steps.length).toBeGreaterThan(0)
    }
  })

  it('never exposes secret values — presence only', () => {
    for (const src of getFundingSourceStatus()) {
      const blob = JSON.stringify(src)
      // env_presence/configured are booleans; no raw key material leaks.
      expect(blob).not.toMatch(/jfeb12e/) // the real SAM key value must never appear
    }
  })
})
