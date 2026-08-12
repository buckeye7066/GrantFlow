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
    title: 'No-cost heat-pump direct installation',
    description: 'Income-qualified households receive a heat pump at no cost. No repayment.',
    source_url: 'https://energy.example.gov/programs/heat-pump',
    result_source: 'catalog',
    source_trust_tier: 'official_portal',
    source_reviewed_at: '2026-08-09T00:00:00Z',
    source_reviewed_by: 'test-reviewer',
    source_review_version: GREEN_HOME_NO_COST_POLICY_VERSION,
    link_status: 'ok',
    last_verified_at: '2026-08-09T00:00:00Z',
    ...overrides,
  }
}

describe('green-home strict no-cost policy', () => {
  it('accepts a freshly reviewed official source with explicit no-payment evidence', () => {
    expect(classify(official())).toMatchObject({
      status: 'eligible',
      reason: 'explicit_no_cost_no_loan_path',
      source_trust: 'official_government',
      source_age_days: 1,
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
  ])('excludes %s offers even when the technology is relevant', (reason, overrides) => {
    expect(classify(official(overrides))).toMatchObject({ status: 'excluded', reason })
  })

  it('scans persisted eligibility prose for contradictory payment terms', () => {
    expect(classify(official({
      title: 'No-cost heat pump program',
      description: 'The provider advertises a free heat pump installation.',
      eligibility_text: 'Approved households must make a qualifying purchase and pay an installation fee.',
    }))).toMatchObject({ status: 'excluded', reason: 'applicant_payment' })
  })

  it('does not mistake explicit no-payment language for a payment requirement', () => {
    expect(classify(official({
      description: 'No-cost insulation with no loan required, no monthly payment, no homeowner contribution, no matching funds, no purchase required, and zero out-of-pocket cost.',
    }))).toMatchObject({ status: 'eligible' })
  })

  it('requires explicit no-payment evidence rather than direct-install or grant wording alone', () => {
    expect(classify(official({
      title: 'Heat pump direct installation program',
      description: 'Direct-install heat pump program. Contact the provider for applicant costs.',
    }))).toMatchObject({ status: 'review', reason: 'no_cost_not_proven' })
    expect(classify(official({
      title: 'Residential solar program',
      description: 'Grant-funded residential solar program. Cost terms vary.',
    }))).toMatchObject({ status: 'review', reason: 'no_cost_not_proven' })
  })

  it('recognizes hyphenated heat pumps and qualified free-installation wording', () => {
    expect(classify(official({
      title: 'Heat-pumps for qualifying households',
      description: 'Free residential heat pump installation for qualifying households.',
    }))).toMatchObject({ status: 'eligible' })
  })

  it('holds raw web leads for review even when a government-domain snippet says free', () => {
    expect(classify({
      title: 'Free residential wind turbine installation',
      description: 'Free small wind installation for selected homeowners.',
      source_url: 'https://energy.example.gov/wind',
      result_source: 'web_search',
      source_trust_tier: 'official_portal',
      source_reviewed_at: '2026-08-09T00:00:00Z',
      source_reviewed_by: 'test-reviewer',
      source_review_version: GREEN_HOME_NO_COST_POLICY_VERSION,
      link_status: 'ok',
      last_verified_at: '2026-08-09T00:00:00Z',
    })).toMatchObject({
      status: 'review',
      reason: 'source_not_yet_verified',
      source_trust: 'unverified_web',
    })
  })

  it('does not promote a reachable non-government page without explicit source review', () => {
    expect(classify({
      title: 'No-cost nonprofit weatherization program',
      description: 'Free weatherization service for qualifying households.',
      source_url: 'https://community-energy.example/weatherization',
      result_source: 'catalog',
      verified_url: 1,
      link_status: 'ok',
      last_verified_at: '2026-08-09T00:00:00Z',
    })).toMatchObject({
      status: 'review',
      reason: 'source_not_yet_verified',
      source_trust: 'unverified_catalog',
    })
  })

  it('accepts a non-government source only with explicit trust, content review, and link proof', () => {
    expect(classify({
      title: 'No-cost nonprofit weatherization program',
      description: 'Free weatherization service for qualifying households.',
      source_url: 'https://community-energy.example/weatherization',
      result_source: 'catalog',
      source_trust_tier: 'manual_curated',
      source_reviewed_at: '2026-08-09T00:00:00Z',
      source_reviewed_by: 'test-reviewer',
      source_review_version: GREEN_HOME_NO_COST_POLICY_VERSION,
      link_status: 'ok',
      last_verified_at: '2026-08-09T00:00:00Z',
    })).toMatchObject({ status: 'eligible', source_trust: 'verified_source' })
  })

  it('separates content-review freshness from link liveness', () => {
    // A null source_reviewed_at fails the TRUST gate before the freshness
    // check ever runs: hasCompleteContentReview() (sourceTrust's official/
    // verified check) requires reviewed_at/by/version together, so removing
    // reviewed_at degrades trust to 'unverified_official' and the classifier
    // returns 'source_not_yet_verified' — 'source_review_date_missing' is
    // unreachable for a MISSING date specifically (it fires only when trust
    // already passed via some other reviewed_at fallback, e.g. an official
    // locator's own `reviewed_at` field, which this fixture does not use).
    // This is deterministic, fail-closed behavior, not a regression.
    expect(classify(official({ source_reviewed_at: null }))).toMatchObject({
      status: 'review', reason: 'source_not_yet_verified',
    })
    expect(classify(official({ source_reviewed_at: '2026-01-01T00:00:00Z' }))).toMatchObject({
      status: 'review', reason: 'source_review_stale',
    })
    expect(classify(official({ link_status: 'broken' }))).toMatchObject({
      status: 'review', reason: 'source_link_not_verified',
    })
    expect(classify(official({ last_verified_at: '2026-01-01T00:00:00Z' }))).toMatchObject({
      status: 'review', reason: 'source_link_stale',
    })
  })

  it('excludes terminated Solar for All references', () => {
    expect(classify(official({
      title: 'Solar for All',
      description: 'Free residential solar panels under the Greenhouse Gas Reduction Fund.',
    }))).toMatchObject({ status: 'excluded', reason: 'retired_or_rescinded_program' })
  })

  it('runs official locator paths through the same classifier', () => {
    const current = officialGreenHomePaths(NOW)
    expect(current.find((path) => path.id === 'doe-weatherization-assistance')).toMatchObject({
      no_cost_classification: 'eligible',
      no_cost_reason: 'explicit_no_cost_no_loan_path',
    })
    expect(current.find((path) => path.id === 'hhs-liheap-weatherization-repairs')).toMatchObject({
      no_cost_classification: 'review',
      no_cost_reason: 'no_cost_not_proven',
    })

    const stale = officialGreenHomePaths(new Date('2026-12-31T00:00:00Z'))
    expect(stale.find((path) => path.id === 'doe-weatherization-assistance')).toMatchObject({
      no_cost_classification: 'review',
      no_cost_reason: 'source_review_stale',
    })
  })
})
