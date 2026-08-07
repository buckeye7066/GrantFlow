/**
 * relevanceFilter.softMode.test.js
 *
 * Verifies the zero-results safety net:
 *   1) Directory-style / general resources ALWAYS pass regardless of rules.
 *   2) In 'soft' mode, population/demographic mismatches return pass:true
 *      with softFail:true and a penalty (to reduce score, not discard).
 *   3) Explicitly exclusive rules (hard:true) still reject in soft mode.
 *
 * Covers the user rules:
 *   - "Population / eligibility mismatches must reduce score, not discard results."
 *   - "Directory-style or general funding resources must always survive filtering
 *      unless explicitly excluded."
 *   - "Hard boolean filters must be avoided unless the funding source is
 *      explicitly exclusive."
 */
import { describe, it, expect } from 'vitest'
import { applyRelevanceFilter } from '../services/relevanceFilter.js'

const INDIVIDUAL_TN = {
  primary_type: 'individual',
  state: 'TN',
  city: 'Nashville',
  gender: 'male',
}

function opp(overrides = {}) {
  return {
    title: 'Example Grant',
    description: 'A grant program',
    application_url: 'https://example.org/apply',
    state: 'TN',
    is_national: true,
    ...overrides,
  }
}

describe('relevanceFilter: directory resources always pass', () => {
  it('directory source short-circuits all rules', () => {
    const o = opp({
      title: 'Contract Opportunity for IT Vendor',
      source: 'directory_listings',
      is_directory_resource: true,
    })
    const result = applyRelevanceFilter(o, INDIVIDUAL_TN)
    expect(result.pass).toBe(true)
    expect(result.directory).toBe(true)
  })

  it('record_origin=directory_* passes even for rules that would normally reject', () => {
    const o = opp({
      title: 'Kickstarter Campaign',
      record_origin: 'directory_curated',
    })
    const result = applyRelevanceFilter(o, INDIVIDUAL_TN)
    expect(result.pass).toBe(true)
  })

  it('type=DIRECTORY passes', () => {
    const o = opp({ title: 'Amber Grant for Women', type: 'DIRECTORY' })
    const result = applyRelevanceFilter(o, INDIVIDUAL_TN)
    expect(result.pass).toBe(true)
  })
})

describe('relevanceFilter: soft mode preserves population-mismatch opportunities', () => {
  it('veteran-only program: strict rejects, soft returns softFail pass', () => {
    const o = opp({ title: 'SSVF Veterans Supportive Services Program' })

    const strict = applyRelevanceFilter(o, INDIVIDUAL_TN)
    expect(strict.pass).toBe(false)
    expect(strict.ruleId).toBe('demographic_veteran_focused')

    const soft = applyRelevanceFilter(o, INDIVIDUAL_TN, { mode: 'soft' })
    expect(soft.pass).toBe(true)
    expect(soft.softFail).toBe(true)
    expect(soft.ruleId).toBe('demographic_veteran_focused')
    expect(typeof soft.penalty).toBe('number')
  })

  it('student-only Pell Grant: strict rejects, soft passes for non-student', () => {
    const o = opp({ title: 'Federal Pell Grant Eligibility' })

    const strict = applyRelevanceFilter(o, INDIVIDUAL_TN)
    expect(strict.pass).toBe(false)

    const soft = applyRelevanceFilter(o, INDIVIDUAL_TN, { mode: 'soft' })
    expect(soft.pass).toBe(true)
    expect(soft.softFail).toBe(true)
  })
})

describe('relevanceFilter: hard rules still reject in soft mode', () => {
  it('women-only program: rejects in both strict and soft mode for male profile', () => {
    const o = opp({ title: 'Amber Grant for Women Only' })

    const strict = applyRelevanceFilter(o, INDIVIDUAL_TN)
    expect(strict.pass).toBe(false)

    const soft = applyRelevanceFilter(o, INDIVIDUAL_TN, { mode: 'soft' })
    expect(soft.pass).toBe(false)
    expect(soft.ruleId).toBe('demographic_women_only')
  })

  it('women-prioritized (non-exclusive) soft-fails instead of hard-rejecting', () => {
    const o = opp({ title: 'Grant for Women Entrepreneurs' })
    const soft = applyRelevanceFilter(o, INDIVIDUAL_TN, { mode: 'soft' })
    expect(soft.pass).toBe(true)
    expect(soft.softFail).toBe(true)
    expect(soft.ruleId).toBe('demographic_women_prioritized')
  })

  it('crowdfunding: rejects in both modes', () => {
    const o = opp({ title: 'Donate to Our GoFundMe' })

    const strict = applyRelevanceFilter(o, INDIVIDUAL_TN)
    expect(strict.pass).toBe(false)

    const soft = applyRelevanceFilter(o, INDIVIDUAL_TN, { mode: 'soft' })
    expect(soft.pass).toBe(false)
  })

  it('no URL: rejects in both modes', () => {
    const o = opp({ application_url: null, source_url: null, url: null })
    const strict = applyRelevanceFilter(o, INDIVIDUAL_TN)
    expect(strict.pass).toBe(false)

    const soft = applyRelevanceFilter(o, INDIVIDUAL_TN, { mode: 'soft' })
    expect(soft.pass).toBe(false)
    expect(soft.ruleId).toBe('no_actionable_url')
  })
})

describe('relevanceFilter: normal grants pass in both modes', () => {
  it('a plain community grant passes for individual profile', () => {
    const o = opp({
      title: 'Community Emergency Assistance Grant',
      description: 'Emergency cash assistance for families',
    })
    const strict = applyRelevanceFilter(o, INDIVIDUAL_TN)
    expect(strict.pass).toBe(true)

    const soft = applyRelevanceFilter(o, INDIVIDUAL_TN, { mode: 'soft' })
    expect(soft.pass).toBe(true)
  })
})
