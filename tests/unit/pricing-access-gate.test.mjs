import test from 'node:test'
import assert from 'node:assert/strict'

import {
  decideAccess,
  isAlwaysAllowedPath,
  isPaymentGatedPath,
} from '../../backend/services/pricing/pricingAccessGate.js'
import { ACCESS_STATUS } from '../../backend/services/pricing/pricingTypes.js'

test('admin user always has access regardless of pricing state', () => {
  const r = decideAccess({
    user: { id: 'a', email: 'buckeye7066@gmail.com', is_admin: true },
    pricing: null,
    agreement: null,
  })
  assert.equal(r.access_granted, true)
  assert.equal(r.is_admin, true)
  assert.equal(r.payment_required, false)
})

test('configured admin email is_admin=false but configured email is still admin', () => {
  const r = decideAccess({
    user: { id: 'a', email: 'BuckEye7066@gmail.com', is_admin: false },
    pricing: { access_status: ACCESS_STATUS.PENDING_PAYMENT },
    agreement: null,
  })
  assert.equal(r.access_granted, true)
  assert.equal(r.is_admin, true)
})

test('non-admin without pricing is blocked', () => {
  const r = decideAccess({
    user: { id: 'u', email: 'jane@example.com' },
    pricing: null,
    agreement: null,
  })
  assert.equal(r.access_granted, false)
  assert.equal(r.blocking_reason, 'no_pricing_yet')
})

test('PENDING_AGREEMENT requires agreement, no checkout yet', () => {
  const r = decideAccess({
    user: { id: 'u', email: 'jane@example.com' },
    pricing: { access_status: ACCESS_STATUS.PENDING_AGREEMENT },
    agreement: null,
  })
  assert.equal(r.access_granted, false)
  assert.equal(r.blocking_reason, 'agreement_required')
  assert.equal(r.agreement_required, true)
  assert.equal(r.checkout_available, false)
})

test('PENDING_PAYMENT exposes checkout', () => {
  const r = decideAccess({
    user: { id: 'u', email: 'jane@example.com' },
    pricing: { access_status: ACCESS_STATUS.PENDING_PAYMENT },
    agreement: { accepted: 1 },
  })
  assert.equal(r.access_granted, false)
  assert.equal(r.blocking_reason, 'payment_required')
  assert.equal(r.checkout_available, true)
  assert.equal(r.agreement_accepted, true)
})

test('ACTIVE_PAID grants access', () => {
  const r = decideAccess({
    user: { id: 'u', email: 'jane@example.com' },
    pricing: { access_status: ACCESS_STATUS.ACTIVE_PAID },
    agreement: { accepted: 1 },
  })
  assert.equal(r.access_granted, true)
  assert.equal(r.payment_required, false)
})

test('ADMIN_WAIVED grants access', () => {
  const r = decideAccess({
    user: { id: 'u', email: 'jane@example.com' },
    pricing: { access_status: ACCESS_STATUS.ADMIN_WAIVED },
    agreement: null,
  })
  assert.equal(r.access_granted, true)
  assert.equal(r.payment_status, 'admin_waived')
})

test('admin-review-required (PENDING_PRICING) blocks the user with the right reason', () => {
  const r = decideAccess({
    user: { id: 'u', email: 'jane@example.com' },
    pricing: { access_status: ACCESS_STATUS.PENDING_PRICING },
    agreement: null,
  })
  assert.equal(r.access_granted, false)
  assert.equal(r.blocking_reason, 'admin_review_required')
})

test('unauthenticated request returns access_granted=false with not_authenticated reason', () => {
  const r = decideAccess({})
  assert.equal(r.access_granted, false)
  assert.equal(r.blocking_reason, 'not_authenticated')
  assert.equal(r.authenticated, false)
})

test('isAlwaysAllowedPath admits the gate-bypass routes', () => {
  for (const p of [
    '/login',
    '/auth/callback',
    '/AnyaOnboarding',
    '/AnyaOnboarding/step-2',
    '/Pricing',
    '/PricingRequired',
    '/PricingRequired?profile_id=abc',
    '/ServiceAgreement',
    '/Checkout',
    '/Admin',
    '/Admin/Pricing',
  ]) {
    assert.equal(isAlwaysAllowedPath(p), true, p)
  }
})

test('isPaymentGatedPath flags the user-facing app surface', () => {
  for (const p of ['/Dashboard', '/Pipeline', '/Documents', '/Apply', '/DiscoverGrants', '/FundingOpportunities', '/Reports']) {
    assert.equal(isPaymentGatedPath(p), true, p)
  }
  for (const p of ['/login', '/PricingRequired', '/Admin', '/AnyaOnboarding']) {
    assert.equal(isPaymentGatedPath(p), false, p)
  }
})
