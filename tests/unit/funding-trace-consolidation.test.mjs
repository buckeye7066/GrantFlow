import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  consolidateFundingSources,
  isSourceAddable,
  traceSourceToOpportunity,
  ADDABILITY_DEFAULTS,
} from '../../backend/services/fundingTraceService.js'

const row = (overrides = {}) => ({
  'Awarding Agency': 'Department of Defense',
  'Awarding Sub Agency': 'Navy',
  'Award Amount': '1000000',
  'Start Date': '2023-01-01',
  'Award ID': 'A1',
  ...overrides,
})

describe('consolidateFundingSources', () => {
  it('groups awards by sub-agency and sums amounts', () => {
    const out = consolidateFundingSources([
      row({ 'Award ID': 'A1', 'Award Amount': '1000000', 'Start Date': '2023-01-01' }),
      row({ 'Award ID': 'A3', 'Award Amount': '750000', 'Start Date': '2024-02-01' }),
    ])
    assert.equal(out.length, 1)
    assert.equal(out[0].name, 'Navy')
    assert.equal(out[0].parent_agency, 'Department of Defense')
    assert.equal(out[0].total_amount, 1_750_000)
    assert.equal(out[0].award_count, 2)
    assert.equal(out[0].latest_year, 2024)
  })

  it('keeps distinct sub-agencies under the same department separate', () => {
    const out = consolidateFundingSources([
      row({ 'Awarding Sub Agency': 'Navy', 'Award ID': 'A1', 'Award Amount': '1000000' }),
      row({ 'Awarding Sub Agency': 'Army', 'Award ID': 'A2', 'Award Amount': '500000' }),
    ])
    assert.equal(out.length, 2)
    assert.deepEqual(out.map((s) => s.name).sort(), ['Army', 'Navy'])
  })

  it('does NOT merge identically-named offices across different departments', () => {
    const out = consolidateFundingSources([
      row({ 'Awarding Agency': 'Dept A', 'Awarding Sub Agency': 'Office of Inspector General', 'Award ID': 'X1', 'Award Amount': '100000' }),
      row({ 'Awarding Agency': 'Dept B', 'Awarding Sub Agency': 'Office of Inspector General', 'Award ID': 'X2', 'Award Amount': '200000' }),
    ])
    assert.equal(out.length, 2)
    assert.equal(out.every((s) => s.name === 'Office of Inspector General'), true)
    assert.deepEqual(out.map((s) => s.parent_agency).sort(), ['Dept A', 'Dept B'])
  })

  it('falls back to the department when a row has no sub-agency', () => {
    const out = consolidateFundingSources([
      row({ 'Awarding Agency': 'Health and Human Services', 'Awarding Sub Agency': '', 'Award ID': 'B1', 'Award Amount': '250000' }),
    ])
    assert.equal(out.length, 1)
    assert.equal(out[0].name, 'Health and Human Services')
    assert.equal(out[0].parent_agency, null)
  })

  it('ranks sources by total dollars descending and builds a sample url', () => {
    const out = consolidateFundingSources([
      row({ 'Awarding Sub Agency': 'Small Office', 'Award ID': 'S1', 'Award Amount': '10000' }),
      row({ 'Awarding Sub Agency': 'Big Office', 'Award ID': 'B1', 'Award Amount': '9000000' }),
    ])
    assert.equal(out[0].name, 'Big Office')
    assert.equal(out[0].sample_url, 'https://www.usaspending.gov/award/B1')
  })

  it('skips rows with no agency at all', () => {
    const out = consolidateFundingSources([
      { 'Awarding Agency': '', 'Awarding Sub Agency': '', 'Award Amount': '5000' },
    ])
    assert.equal(out.length, 0)
  })
})

describe('isSourceAddable', () => {
  const now = new Date('2026-06-18T00:00:00Z')

  it('rejects federal sources below the dollar floor', () => {
    const src = { total_amount: 10_000, latest_year: 2025 }
    assert.equal(isSourceAddable(src, { now }), false)
  })

  it('accepts federal sources at or above the floor and recent', () => {
    const src = { total_amount: ADDABILITY_DEFAULTS.minAmount, latest_year: 2025 }
    assert.equal(isSourceAddable(src, { now }), true)
  })

  it('rejects stale federal sources older than maxAgeYears', () => {
    const src = { total_amount: 5_000_000, latest_year: 2018 }
    assert.equal(isSourceAddable(src, { now }), false)
  })

  it('respects custom thresholds', () => {
    const src = { total_amount: 50_000, latest_year: 2020 }
    assert.equal(isSourceAddable(src, { minAmount: 100_000, maxAgeYears: 5, now }), false)
    assert.equal(isSourceAddable(src, { minAmount: 10_000, maxAgeYears: 10, now }), true)
  })

  it('does not apply the dollar floor to sources with no amount (AI channels)', () => {
    assert.equal(isSourceAddable({ total_amount: null, addable: true }, { now }), true)
    assert.equal(isSourceAddable({ total_amount: null, addable: false }, { now }), false)
  })

  it('fails open on missing year when dollars clear the floor', () => {
    const src = { total_amount: 5_000_000, latest_year: null }
    assert.equal(isSourceAddable(src, { now }), true)
  })
})

describe('traceSourceToOpportunity', () => {
  it('maps a federal source to a catalog opportunity payload', () => {
    const src = {
      key: 'usaspending:Department of Defense::Navy',
      name: 'Navy',
      parent_agency: 'Department of Defense',
      type: 'federal_agency',
      total_amount: 1_750_000,
      award_count: 2,
      latest_year: 2024,
      origin: 'usaspending',
      sample_url: 'https://www.usaspending.gov/award/A1',
    }
    const opp = traceSourceToOpportunity(src, 'Acme Corp')
    assert.equal(opp.sponsor, 'Navy')
    assert.equal(opp.funding_source_type, 'government')
    assert.equal(opp.source, 'funding_trace.usaspending')
    assert.equal(opp.amount_max, 1_750_000)
    assert.equal(opp.record_origin, 'funding_trace')
    assert.ok(opp.description.includes('Department of Defense'))
  })
})
