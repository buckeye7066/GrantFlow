import { describe, expect, it } from 'vitest'
import {
  GREEN_HOME_NO_COST_POLICY_VERSION,
  classifyNoCostGreenHomeResult,
  officialGreenHomePaths,
} from '../services/greenHomeNoCostPolicy.js'

function official(overrides = {}) {
  return {
    title: 'No-cost heat pump direct installation',
    description: 'Income-qualified households receive a heat pump at no cost. No repayment.',
    source_url: 'https://energy.example.gov/programs/heat-pump',
    result_source: 'catalog',
    ...overrides,
  }
}

describe('green-home strict no-cost policy', () => {
  it('accepts an official, explicitly no-cost home upgrade', () => {
    expect(classifyNoCostGreenHomeResult(official())).toMatchObject({
      status: 'eligible',
      reason: 'explicit_no_cost_no_loan_path',
      source_trust: 'official_government',
      policy_version: GREEN_HOME_NO_COST_POLICY_VERSION,
    })
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
    expect(classifyNoCostGreenHomeResult(official(overrides))).toMatchObject({
      status: 'excluded',
      reason,
    })
  })

  it('excludes structured loan, match, and upfront-payment flags', () => {
    expect(classifyNoCostGreenHomeResult(official({ is_loan: true }))).toMatchObject({
      status: 'excluded', reason: 'loan_or_financing',
    })
    expect(classifyNoCostGreenHomeResult(official({ requires_match: true }))).toMatchObject({
      status: 'excluded', reason: 'cost_share_or_match',
    })
    expect(classifyNoCostGreenHomeResult(official({ requires_upfront_payment: true }))).toMatchObject({
      status: 'excluded', reason: 'applicant_payment',
    })
  })

  it('does not mistake “does not need to be repaid” for a loan offer', () => {
    expect(classifyNoCostGreenHomeResult(official({
      description: 'A fully funded weatherization grant that does not need to be repaid.',
    }))).toMatchObject({ status: 'eligible' })
  })

  it('holds unknown cost terms out of the primary result set', () => {
    expect(classifyNoCostGreenHomeResult(official({
      description: 'Residential heat pump upgrade program. Contact the provider for terms.',
    }))).toMatchObject({
      status: 'review',
      reason: 'no_cost_not_proven',
    })
  })

  it('holds an unverified web page for review even when it claims no cost', () => {
    expect(classifyNoCostGreenHomeResult({
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
    expect(classifyNoCostGreenHomeResult({
      title: 'Solar for All',
      description: 'Free residential solar panels under the Greenhouse Gas Reduction Fund.',
      source_url: 'https://www.epa.gov/greenhouse-gas-reduction-fund/solar-all',
      result_source: 'catalog',
    })).toMatchObject({
      status: 'excluded',
      reason: 'retired_or_rescinded_program',
    })
  })

  it('marks stale official locator evidence for review', () => {
    const current = officialGreenHomePaths(new Date('2026-08-10T00:00:00Z'))
    expect(current.every((path) => path.no_cost_classification === 'eligible')).toBe(true)

    const stale = officialGreenHomePaths(new Date('2026-12-31T00:00:00Z'))
    expect(stale.every((path) => path.no_cost_classification === 'review')).toBe(true)
    expect(stale.every((path) => path.no_cost_reason === 'official_source_review_stale')).toBe(true)
  })
})
