import { describe, expect, it } from 'vitest'
import {
  GREEN_HOME_NO_COST_POLICY_VERSION,
  classifyNoCostGreenHomeResult,
  officialGreenHomePaths,
} from '../services/greenHomeNoCostPolicy.js'

const NOW = new Date('2026-08-10T00:00:00Z')

function classify(result) {
  return classifyNoCostGreenHomeResult(result, { now: NOW })
}

function official(overrides = {}) {
  return {
    title: 'No-cost heat pump direct installation',
    description: 'Income-qualified households receive a heat pump at no cost. No repayment.',
    source_url: 'https://energy.example.gov/programs/heat-pump',
    result_source: 'catalog',
    source_verified_at: '2026-08-09T00:00:00Z',
    ...overrides,
  }
}

describe('green-home strict no-cost policy', () => {
  it('accepts an official, explicitly no-cost home upgrade with human-readable evidence', () => {
    const result = classify(official())
    expect(result).toMatchObject({
      status: 'eligible',
      reason: 'explicit_no_cost_no_loan_path',
      source_trust: 'official_government',
      source_age_days: 1,
      policy_version: GREEN_HOME_NO_COST_POLICY_VERSION,
    })
    expect(result.no_cost_evidence).toMatch(/explicitly states.*no cost|explicitly describes.*no cost/i)
    expect(result.no_cost_evidence).not.toMatch(/^\//)
  })

  it.each([
    ['loan_or_financing', { description: 'No-cost solar panels through PACE financing and monthly payments.' }],
    ['lease_or_ppa', { description: 'Solar panels provided through a power purchase agreement.' }],
    ['tax_credit', { description: 'Heat pump federal tax credit for eligible purchases.' }],
    ['rebate', { description: 'Heat pump rebate after installation.' }],
    ['reimbursement', { description: 'Reimbursement available after purchase.' }],
    ['cost_share_or_match', { description: 'Insulation grant with a 20 percent homeowner contribution.' }],
    ['purchase_required', { description: 'Solar grant after a qualifying purchase.' }],
  ])('excludes %s offers even when green technology is relevant', (reason, overrides) => {
    expect(classify(official(overrides))).toMatchObject({
      status: 'excluded',
      reason,
    })
  })

  it('excludes explicit structured payment fields but never treats profile match score as matching funds', () => {
    expect(classify(official({ is_loan: true }))).toMatchObject({
      status: 'excluded', reason: 'loan_or_financing',
    })
    expect(classify(official({ requires_match: true }))).toMatchObject({
      status: 'excluded', reason: 'cost_share_or_match',
    })
    expect(classify(official({ required_match_percentage: 20 }))).toMatchObject({
      status: 'excluded', reason: 'cost_share_or_match',
    })
    expect(classify(official({ cost_share_percentage: '10' }))).toMatchObject({
      status: 'excluded', reason: 'cost_share_or_match',
    })
    expect(classify(official({ requires_upfront_payment: true }))).toMatchObject({
      status: 'excluded', reason: 'applicant_payment',
    })
    expect(classify(official({ match_percentage: 97 }))).toMatchObject({
      status: 'eligible',
      reason: 'explicit_no_cost_no_loan_path',
    })
  })

  it('does not mistake explicit no-payment language for a payment requirement', () => {
    expect(classify(official({
      description:
        'No-cost insulation with no loan required, no monthly payment, no homeowner contribution, no matching funds, no purchase required, and zero out-of-pocket cost.',
    }))).toMatchObject({
      status: 'eligible',
      reason: 'explicit_no_cost_no_loan_path',
    })
  })

  it('does not treat a normal existing mortgage reference as financing required by the program', () => {
    expect(classify(official({
      description: 'No-cost weatherization for qualifying homeowners, including households that have a mortgage.',
    }))).toMatchObject({ status: 'eligible' })
  })

  it('requires explicit no-payment evidence rather than direct-install or grant language alone', () => {
    expect(classify(official({
      description: 'Direct-install heat pump program. Contact the provider for applicant costs.',
    }))).toMatchObject({
      status: 'review',
      reason: 'no_cost_not_proven',
    })
    expect(classify(official({
      description: 'Grant-funded residential solar program. Cost terms vary.',
    }))).toMatchObject({
      status: 'review',
      reason: 'no_cost_not_proven',
    })
  })

  it('holds unknown cost terms out of the primary result set', () => {
    expect(classify(official({
      description: 'Residential heat pump upgrade program. Contact the provider for terms.',
    }))).toMatchObject({
      status: 'review',
      reason: 'no_cost_not_proven',
    })
  })

  it('holds an unverified catalog record for review even when it claims no cost', () => {
    expect(classify({
      title: 'No-cost local insulation program',
      description: 'Free insulation installation for qualifying homeowners.',
      source_url: 'https://community-energy.example/free-insulation',
      result_source: 'catalog',
    })).toMatchObject({
      status: 'review',
      reason: 'source_not_yet_verified',
      source_trust: 'unverified_catalog',
    })
  })

  it('holds a raw .gov search result for review until a separate verification stage trusts it', () => {
    expect(classify({
      title: 'No-cost state heat-pump installation',
      description: 'Free heat-pump installation for qualifying households.',
      source_url: 'https://energy.example.gov/free-heat-pump',
      result_source: 'web_search',
      source_verified_at: '2026-08-09T00:00:00Z',
    })).toMatchObject({
      status: 'review',
      reason: 'source_not_yet_verified',
      source_trust: 'unverified_web',
    })
  })

  it('accepts a separately verified web source only with explicit trust and fresh verification', () => {
    expect(classify({
      title: 'No-cost state heat-pump installation',
      description: 'Free heat-pump installation for qualifying households.',
      source_url: 'https://energy.example.gov/free-heat-pump',
      result_source: 'web_search',
      source_trust: 'verified',
      source_verified_at: '2026-08-09T00:00:00Z',
    })).toMatchObject({
      status: 'eligible',
      source_trust: 'official_government',
    })
  })

  it('accepts a non-government source only when the record carries verified trust and a fresh date', () => {
    expect(classify({
      title: 'No-cost nonprofit weatherization program',
      description: 'Free weatherization service for qualifying households.',
      source_url: 'https://verified-community.example/weatherization',
      result_source: 'catalog',
      source_trust: 'verified',
      source_verified_at: '2026-08-09T00:00:00Z',
    })).toMatchObject({
      status: 'eligible',
      source_trust: 'verified_source',
    })
  })

  it('holds verified sources with missing or stale verification dates out of primary results', () => {
    expect(classify(official({ source_verified_at: null }))).toMatchObject({
      status: 'review',
      reason: 'source_verification_date_missing',
    })
    expect(classify(official({ source_verified_at: '2026-01-01T00:00:00Z' }))).toMatchObject({
      status: 'review',
      reason: 'source_verification_stale',
    })
  })

  it('holds an unverified web page for review even when it claims no cost', () => {
    expect(classify({
      title: 'Free residential wind turbine installation',
      description: 'Free small wind turbine installation for qualifying homeowners.',
      url: 'https://unknown-provider.example/wind',
      result_source: 'web_search',
    })).toMatchObject({
      status: 'review',
      reason: 'source_not_yet_verified',
      source_trust: 'unverified_web',
    })
  })

  it('excludes terminated Solar for All references rather than presenting them as current', () => {
    expect(classify({
      title: 'Solar for All',
      description: 'Free residential solar panels under the Greenhouse Gas Reduction Fund.',
      source_url: 'https://www.epa.gov/greenhouse-gas-reduction-fund/solar-all',
      result_source: 'catalog',
      source_verified_at: '2026-08-09T00:00:00Z',
    })).toMatchObject({
      status: 'excluded',
      reason: 'retired_or_rescinded_program',
    })
  })

  it('marks stale official locator evidence for review', () => {
    const current = officialGreenHomePaths(NOW)
    expect(current.every((path) => path.no_cost_classification === 'eligible')).toBe(true)

    const stale = officialGreenHomePaths(new Date('2026-12-31T00:00:00Z'))
    expect(stale.every((path) => path.no_cost_classification === 'review')).toBe(true)
    expect(stale.every((path) => path.no_cost_reason === 'official_source_review_stale')).toBe(true)
  })
})
