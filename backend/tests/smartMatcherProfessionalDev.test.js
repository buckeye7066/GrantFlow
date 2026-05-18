/**
 * Smart Matcher — Professional Development & Continuing Education
 * regression suite (spec §1–§7).
 *
 * Scope: pure-function tests of the intent → primary_category → excluded
 * categories pipeline plus a representative coverage check across nursing,
 * social work, medicine, mental health, and allied-health professions.
 *
 * Why these matter:
 *   - The original failure case ("PROBE: Ethics and Boundaries program"
 *     returned only SSI at 51%) must be permanently fixed.
 *   - Acceptance criteria in the spec require ≥10 representative queries
 *     covering CE / professional development across health professions.
 *   - These run without spinning up a server and complete in milliseconds,
 *     so they live alongside other unit tests.
 */

import { describe, it, expect } from 'vitest'
import {
  interpretFundingIntentRules,
  detectPrimaryCategory,
  extractCredentials,
  INCOME_SUPPORT_CATEGORIES,
} from '../services/smartMatcherIntent.js'

// ---------------------------------------------------------------------------
// Fixtures: 10 representative CE / professional-development queries
// drawn from real GrantFlow telemetry plus the original PROBE regression.
// ---------------------------------------------------------------------------
const PROFESSIONAL_DEVELOPMENT_QUERIES = [
  {
    name: 'PROBE Ethics & Boundaries (the original regression)',
    text: 'Help me find funding to pay for the PROBE: Ethics and Boundaries program',
    expectedBranded: 'PROBE',
    expectedTerms: ['probe ethics', 'professional boundaries', 'continuing education'],
  },
  {
    name: 'Nursing license reinstatement (RN)',
    text: 'I am an RN and need help paying for license reinstatement coursework',
    expectedCredentials: ['RN'],
    expectedTerms: ['license reinstatement', 'continuing education', 'professional development'],
  },
  {
    name: 'Social work CE (LCSW)',
    text: 'I am an LCSW seeking continuing education funding for my license renewal',
    expectedCredentials: ['LCSW'],
    expectedTerms: ['continuing education', 'professional development'],
  },
  {
    name: 'Physician CME (MD)',
    text: 'MD looking for CME funding to maintain board certification',
    expectedCredentials: ['MD'],
    expectedTerms: ['continuing education', 'cme', 'recertification'],
  },
  {
    name: 'Mental health counselor (LPC) ethics training',
    text: 'I am an LPC needing ethics training funds for license renewal',
    expectedCredentials: ['LPC'],
    expectedTerms: ['ethics training', 'continuing education'],
  },
  {
    name: 'CITI training (research ethics)',
    text: 'Need funding to complete CITI training for research compliance',
    expectedBranded: 'CITI',
    expectedTerms: ['research ethics', 'continuing education'],
  },
  {
    name: 'Nursing reentry / refresher',
    text: 'Looking for funding for a return to nursing refresher course',
    expectedTerms: ['nurse reentry', 'continuing education', 'professional development'],
  },
  {
    name: 'WIOA Individual Training Account',
    text: 'Help paying for WIOA individual training account certification',
    expectedTerms: ['workforce development', 'wioa training', 'individual training account'],
  },
  {
    name: 'Allied health PT credential',
    text: 'PT looking for grants to cover continuing professional development',
    expectedCredentials: ['PT'],
    expectedTerms: ['professional development', 'continuing education'],
  },
  {
    name: 'NCLEX exam fee assistance',
    text: 'Need scholarship to cover NCLEX exam fee for nursing license',
    expectedBranded: 'NCLEX',
    expectedTerms: ['licensure', 'continuing education'],
  },
  {
    name: 'Vocational rehabilitation re-entry',
    text: 'Need re-entry training and vocational rehab funding to return to practice after disability',
    expectedTerms: ['vocational rehabilitation', 'workforce reentry'],
  },
  {
    name: 'Marriage & family therapist CE (LMFT)',
    text: 'LMFT looking for ethics CE scholarships for license renewal',
    expectedCredentials: ['LMFT'],
    expectedTerms: ['continuing education', 'ethics training'],
  },
]

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Smart Matcher — Professional Development regression suite', () => {
  it('exposes the income-support exclusion list (spec §3, §4)', () => {
    expect(Array.isArray(INCOME_SUPPORT_CATEGORIES)).toBe(true)
    expect(INCOME_SUPPORT_CATEGORIES.length).toBeGreaterThan(0)
    // Core means-tested programs MUST be in the exclusion list.
    expect(INCOME_SUPPORT_CATEGORIES).toEqual(
      expect.arrayContaining(['ssi', 'snap', 'tanf']),
    )
  })

  it('detectPrimaryCategory returns professional_development for explicit phrases', () => {
    const cases = [
      'continuing education funding',
      'license reinstatement help',
      'professional development scholarship',
      'WIOA individual training account',
      'PROBE ethics and boundaries program',
    ]
    for (const text of cases) {
      const detected = detectPrimaryCategory(text, [])
      expect(detected.primary_category, `Expected prof-dev for: ${text}`).toBe(
        'professional_development',
      )
      expect(detected.excluded_categories.length).toBeGreaterThan(0)
      expect(detected.excluded_categories).toEqual(
        expect.arrayContaining(['ssi', 'snap']),
      )
    }
  })

  it('detectPrimaryCategory stays "general" for unrelated queries', () => {
    const detected = detectPrimaryCategory('rental assistance for eviction', [])
    expect(detected.primary_category).toBe('general')
    expect(detected.excluded_categories).toEqual([])
  })

  it('extractCredentials picks up RN, LCSW, MD, LPC, etc.', () => {
    const samples = {
      'I am an RN with 10 years experience': ['RN'],
      'LCSW seeking ethics CE': ['LCSW'],
      'MD looking for CME': ['MD'],
      'LPC needing license renewal': ['LPC'],
      'PsyD researcher': ['PSYD'],
      'PT specializing in pediatrics': ['PT'],
    }
    for (const [text, expected] of Object.entries(samples)) {
      const found = extractCredentials(text)
      for (const cred of expected) {
        expect(found, `Expected ${cred} in "${text}"`).toContain(cred)
      }
    }
  })

  describe('representative CE / professional-development queries', () => {
    for (const fixture of PROFESSIONAL_DEVELOPMENT_QUERIES) {
      it(`flags "${fixture.name}" as professional_development`, () => {
        const result = interpretFundingIntentRules(fixture.text)

        // Every fixture must be classified as professional_development.
        expect(
          result.primary_category,
          `Expected primary_category=professional_development for "${fixture.text}". Got "${result.primary_category}"`,
        ).toBe('professional_development')

        // Every fixture must include the cash-assistance exclusion list so
        // SSI / SNAP / TANF can't pollute the result set.
        expect(result.excluded_categories).toEqual(
          expect.arrayContaining(['ssi', 'snap', 'tanf']),
        )

        // search_terms must include at least one professional-development
        // signal so the catalog SQL keyword filter hits the right pool.
        const termsLower = (result.search_terms || []).map((t) =>
          String(t).toLowerCase(),
        )
        const hasProfDevSignal = [
          'professional development',
          'continuing education',
          'license reinstatement',
          'wioa training',
          'cme',
          'ceu',
          'workforce development',
          'recertification',
          'ethics training',
          'professional boundaries',
          'vocational rehabilitation',
          'workforce reentry',
          'nurse reentry',
        ].some((kw) => termsLower.some((t) => t.includes(kw)))
        expect(
          hasProfDevSignal,
          `Expected at least one prof-dev term for "${fixture.text}". Got ${JSON.stringify(termsLower)}`,
        ).toBe(true)

        // Branded program assertion — when set the test fixture knows which
        // canonical branded entry should fire.
        if (fixture.expectedBranded) {
          expect(result.branded_program?.name).toBe(fixture.expectedBranded)
        }

        // Credentials assertion (when present in fixture).
        if (Array.isArray(fixture.expectedCredentials)) {
          for (const cred of fixture.expectedCredentials) {
            expect(
              result.credentials_detected,
              `Expected credential ${cred} for "${fixture.text}"`,
            ).toContain(cred)
          }
        }

        // Targeted term assertions (when fixture pins specific phrases).
        if (Array.isArray(fixture.expectedTerms)) {
          for (const term of fixture.expectedTerms) {
            const has = termsLower.some((t) => t.includes(term.toLowerCase()))
            expect(
              has,
              `Expected term containing "${term}" for "${fixture.text}". Got ${JSON.stringify(termsLower)}`,
            ).toBe(true)
          }
        }
      })
    }
  })

  it('non-CE queries do NOT get tagged as professional_development', () => {
    const negatives = [
      'help paying my rent this month',
      'food assistance for my family',
      'utility bill emergency',
      'transportation to medical appointments',
    ]
    for (const text of negatives) {
      const result = interpretFundingIntentRules(text)
      expect(
        result.primary_category,
        `Did NOT expect prof-dev for "${text}". Got "${result.primary_category}"`,
      ).not.toBe('professional_development')
      expect(result.excluded_categories).toEqual([])
    }
  })

  it('PROBE without ethics suffix still classifies as prof-dev (spec §6)', () => {
    const result = interpretFundingIntentRules(
      'I need to pay for the PROBE program',
    )
    expect(result.branded_program?.name).toBe('PROBE')
    expect(result.primary_category).toBe('professional_development')
  })
})
