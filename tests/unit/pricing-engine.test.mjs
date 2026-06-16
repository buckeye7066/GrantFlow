import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildRecommendedQuote,
  recomputeTotal,
  buildClientEstimateMessage,
} from '../../backend/services/pricing/pricingEngine.js'
import { PRICING_CATALOG_VERSION } from '../../backend/services/pricing/pricingTypes.js'

test('buildRecommendedQuote returns a versioned quote with USD currency', () => {
  const q = buildRecommendedQuote({
    profile: { primary_type: 'individual' },
    intakeAnswers: { wants_research_only: true },
  })
  assert.equal(q.pricing_catalog_version, PRICING_CATALOG_VERSION)
  assert.ok(q.primary_service_key, 'primary_service_key must be set on every quote')
  assert.equal(typeof q.user_payment_required, 'boolean')
  assert.equal(typeof q.discount_eligible, 'boolean')
  assert.equal(q.currency, 'USD')
  assert.ok(Array.isArray(q.line_items))
  assert.ok(q.line_items.length >= 1)
})

test('subtotal == sum of line_items.subtotal', () => {
  const q = buildRecommendedQuote({
    profile: { primary_type: 'student' },
    intakeAnswers: { is_transfer_student: true, wants_application_help: true, amount_requested: 4000 },
  })
  const expected = q.line_items.reduce((s, li) => s + li.subtotal, 0)
  assert.equal(q.subtotal, Math.round(expected * 100) / 100)
})

test('total = max(0, subtotal - sum(approved discounts))', () => {
  const q = buildRecommendedQuote({
    profile: { primary_type: 'nonprofit' },
    organization: { annual_budget: 500000 },
    intakeAnswers: { wants_application_help: true, amount_requested: 75000 },
  })
  // No discounts are pre-approved, so total === subtotal.
  assert.equal(q.total, q.subtotal)
})

test('client_category_override sets the category and explains itself', () => {
  const q = buildRecommendedQuote({
    profile: { primary_type: 'small_business' },
    intakeAnswers: { wants_application_help: true, amount_requested: 50000 },
    clientCategoryOverride: 'large',
  })
  assert.equal(q.client_category, 'large')
  assert.equal(q.category_confidence, 'admin_override')
})

test('reasons array contains at least one human-readable line', () => {
  const q = buildRecommendedQuote({
    profile: { primary_type: 'church' },
    organization: { annual_budget: 60000 },
    intakeAnswers: { has_draft: true },
  })
  assert.ok(q.reasons.length >= 1)
  assert.equal(typeof q.reasons[0], 'string')
})

test('admin_review_required defaults true (PRICING_REQUIRE_ADMIN_APPROVAL=true)', () => {
  const q = buildRecommendedQuote({
    profile: { primary_type: 'family' },
    intakeAnswers: { wants_application_help: true, amount_requested: 2000 },
  })
  assert.equal(q.admin_review_required, true)
})

test('recomputeTotal handles approval flips deterministically', () => {
  const seed = {
    line_items: [
      { service_key: 'a', subtotal: 1000 },
      { service_key: 'b', subtotal: 500 },
    ],
    discounts: [
      { amount: 200, approved: false },
      { amount: 100, approved: true },
    ],
  }
  const r = recomputeTotal(seed)
  assert.equal(r.subtotal, 1500)
  assert.equal(r.discount_total, 100)
  assert.equal(r.total, 1400)
})

test('buildClientEstimateMessage produces a non-binding sentence with rounded $ figure', () => {
  const message = buildClientEstimateMessage({ total: 3473 })
  assert.match(message, /starting around \$/)
  assert.doesNotMatch(message, /guaranteed/i)
})

test('buildClientEstimateMessage falls back politely when total is 0', () => {
  const message = buildClientEstimateMessage({ total: 0 })
  assert.match(message, /preparing|next steps/i)
})
