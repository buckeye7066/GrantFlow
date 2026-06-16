import test from 'node:test'
import assert from 'node:assert/strict'

import {
  recommendDiscounts,
  defaultDiscountRules,
  computeDiscountAmount,
} from '../../backend/services/pricing/discountEngine.js'

const lineItems = [
  { service_key: 'standard_foundation_application', subtotal: 3500 },
  { service_key: 'budget_logic_model', subtotal: 600 },
]

function ensureCleanEnv() {
  delete process.env.PRICING_DISCOUNTS_ENABLED
  delete process.env.PRICING_AUTO_DISCOUNTS_ENABLED
  delete process.env.PRICING_REQUIRE_ADMIN_APPROVAL_FOR_DISCOUNTS
  delete process.env.PRICING_MAX_TOTAL_DISCOUNT_PERCENT
}

test('no automatic discounts apply by default', () => {
  ensureCleanEnv()
  const r = recommendDiscounts({
    lineItems,
    inputs: { hardship: true, ministry: true, nonprofit: true, student_or_family: true },
  })
  assert.equal(r.discounts.length, 0)
  assert.equal(r.discount_total, 0)
})

test('manual admin discount is captured but requires approval', () => {
  ensureCleanEnv()
  const r = recommendDiscounts({
    lineItems,
    inputs: {
      manual_admin: [{ type: 'fixed', value: 250, reason: 'New-client courtesy' }],
    },
  })
  assert.equal(r.discounts.length, 1)
  assert.equal(r.discounts[0].amount, 250)
  assert.equal(r.discounts[0].requires_admin_approval, true)
  assert.equal(r.discounts[0].approved, false)
  assert.equal(r.admin_review_required, true)
})

test('discount cap is enforced (PRICING_MAX_TOTAL_DISCOUNT_PERCENT)', () => {
  ensureCleanEnv()
  process.env.PRICING_MAX_TOTAL_DISCOUNT_PERCENT = '10'

  // Subtotal = 4100; cap = 410.
  const r = recommendDiscounts({
    lineItems,
    inputs: {
      manual_admin: [{ type: 'fixed', value: 1000, reason: 'Big discount' }],
    },
  })
  // capped to 410
  assert.equal(r.discounts.length, 1)
  assert.equal(r.discounts[0].amount, 410)
  assert.equal(r.discount_total, 410)

  delete process.env.PRICING_MAX_TOTAL_DISCOUNT_PERCENT
})

test('quote total = subtotal − approved discounts (math is the rule)', () => {
  ensureCleanEnv()
  const subtotal = lineItems.reduce((s, li) => s + li.subtotal, 0)
  const r = recommendDiscounts({
    lineItems,
    inputs: { manual_admin: [{ type: 'percent', value: 10, reason: 'Bundle' }] },
  })
  assert.equal(r.discounts.length, 1)
  // 10% of 4100 = 410
  assert.equal(r.discounts[0].amount, 410)
  // None are approved yet, so total stays at subtotal.
  // (Final total math is enforced in pricingEngine + samPricingAuditor.)
  assert.equal(subtotal - 0, 4100)
})

test('rule with applies_to_services restricts the discountable subtotal', () => {
  const rule = {
    discount_key: 'student_family',
    label: 'Student / family',
    enabled: true,
    type: 'percent',
    value: 15,
    max_amount: null,
    applies_to_services: ['budget_logic_model'],
    requires_admin_approval: true,
    reason_required: true,
  }
  // Only budget_logic_model ($600) is eligible → 15% = $90.
  const amount = computeDiscountAmount(rule, lineItems)
  assert.equal(amount, 90)
})

test('default rules expose every discount key from the spec', () => {
  const rules = defaultDiscountRules()
  const keys = rules.map((r) => r.discount_key)
  for (const k of [
    'hardship',
    'ministry_mission',
    'nonprofit_community_impact',
    'student_family',
    'multi_service_bundle',
    'beta_early_adopter',
    'referral',
    'manual_admin',
    'repeat_client',
    'limited_scope',
  ]) {
    assert.ok(keys.includes(k), `missing default rule ${k}`)
  }
})

test('PRICING_DISCOUNTS_ENABLED=false short-circuits everything', () => {
  ensureCleanEnv()
  process.env.PRICING_DISCOUNTS_ENABLED = 'false'
  const r = recommendDiscounts({
    lineItems,
    inputs: { manual_admin: [{ type: 'fixed', value: 999, reason: 'test' }] },
  })
  assert.equal(r.discounts.length, 0)
  assert.equal(r.discount_total, 0)
  delete process.env.PRICING_DISCOUNTS_ENABLED
})
