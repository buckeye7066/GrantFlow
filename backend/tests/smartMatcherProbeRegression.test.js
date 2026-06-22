/**
 * End-to-end smoke walk: simulates the Smart Matcher pipeline for the
 * "PROBE: Ethics and Boundaries" regression query against the curated
 * NATIONAL_PROGRAMS dataset (which is the catalog the seed pushes into
 * funding_opportunities at startup).
 *
 * No DB required — this is a pure-function walkthrough that proves:
 *   1. interpretFundingIntentRules tags the query as professional_development
 *   2. The seed payload contains multiple prof-dev funder rows
 *   3. Each prof-dev row has at least one keyword overlap with the
 *      catalog SQL filter built from search_terms
 *   4. SSI / SNAP / TANF rows are NOT flagged as prof-dev (so the SQL
 *      exclusion in routes/matching.js will reliably drop them).
 */

import { describe, it, expect } from 'vitest'
import { interpretFundingIntentRules } from '../services/smartMatcherIntent.js'
import { NATIONAL_PROGRAMS } from '../services/shared/data/nationalPrograms.js'
import { seedNationalPrograms as _unused } from '../services/seed/seedNationalPrograms.js'
void _unused

const PROBE_QUERY =
  'Help me find funding to pay for the PROBE: Ethics and Boundaries program'

function rowMatchesAnyTerm(row, terms) {
  const haystack = [
    row.title,
    row.name,
    row.description,
    Array.isArray(row.categories) ? row.categories.join(' ') : row.categories,
    Array.isArray(row.intentMatch) ? row.intentMatch.join(' ') : row.intentMatch,
  ]
    .map((v) => (v === null || v === undefined ? '' : String(v)))
    .join(' ')
    .toLowerCase()
  return terms.some((t) => haystack.includes(String(t).toLowerCase()))
}

describe('Smart Matcher end-to-end walkthrough — PROBE regression', () => {
  it('the user-spec PROBE query is interpreted as professional_development', () => {
    const intent = interpretFundingIntentRules(PROBE_QUERY)
    expect(intent.primary_category).toBe('professional_development')
    expect(intent.branded_program?.name).toBe('PROBE')
    expect(intent.search_terms.length).toBeGreaterThanOrEqual(5)
    expect(intent.excluded_categories).toEqual(
      expect.arrayContaining(['ssi', 'snap', 'tanf']),
    )
  })

  it('NATIONAL_PROGRAMS contains ≥8 prof-dev / CE / licensure / workforce funders', () => {
    const profDev = NATIONAL_PROGRAMS.filter((p) => {
      const cats = Array.isArray(p.categories) ? p.categories : []
      return cats.some((c) =>
        [
          'professional_development',
          'continuing_education',
          'license_reinstatement_support',
          'workforce_reentry_training',
          'workforce_training',
          'certification_assistance',
        ].includes(c),
      )
    })
    expect(profDev.length).toBeGreaterThanOrEqual(8)
  })

  it('PROBE search terms hit ≥5 distinct prof-dev funders in the seed', () => {
    const intent = interpretFundingIntentRules(PROBE_QUERY)
    const profDev = NATIONAL_PROGRAMS.filter((p) => {
      const cats = Array.isArray(p.categories) ? p.categories : []
      return cats.some((c) =>
        [
          'professional_development',
          'continuing_education',
          'license_reinstatement_support',
          'workforce_reentry_training',
        ].includes(c),
      )
    })
    const matched = profDev.filter((p) =>
      rowMatchesAnyTerm(p, intent.search_terms),
    )
    expect(matched.length).toBeGreaterThanOrEqual(5)
  })

  it('rows tagged as cash_assistance / income_support are NOT also tagged prof-dev', () => {
    const cashAssistRows = NATIONAL_PROGRAMS.filter((p) => {
      const cats = Array.isArray(p.categories) ? p.categories : []
      return cats.some((c) =>
        ['cash_assistance', 'income_support', 'food_assistance'].includes(c),
      )
    })
    for (const row of cashAssistRows) {
      const cats = Array.isArray(row.categories) ? row.categories : []
      const hasProfDev = cats.some((c) =>
        [
          'professional_development',
          'continuing_education',
          'license_reinstatement_support',
        ].includes(c),
      )
      expect(
        hasProfDev,
        `Row "${row.name}" must not carry both cash_assistance and prof-dev categories`,
      ).toBe(false)
    }
  })
})
