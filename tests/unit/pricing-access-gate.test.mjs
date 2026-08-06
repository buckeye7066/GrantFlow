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
    principal: { userId: 'a', identityResolved: true, isAdmin: true },
    pricing: null,
    agreement: null,
  })
  assert.equal(r.access_granted, true)
  assert.equal(r.is_admin, true)
  assert.equal(r.payment_required, false)
})

test('an admin-looking email without DB admin authority remains payment-gated', () => {
  const r = decideAccess({
    principal: {
      userId: 'a',
      identityResolved: true,
      isAdmin: false,
      email: 'admin@grantflow.local',
      role: 'admin',
      is_admin: true,
    },
    pricing: { access_status: ACCESS_STATUS.PENDING_PAYMENT },
    agreement: null,
  })
  assert.equal(r.access_granted, false)
  assert.equal(r.is_admin, false)
  assert.equal(r.blocking_reason, 'payment_required')
})

test('non-admin without pricing is blocked', () => {
  const r = decideAccess({
    principal: { userId: 'u', identityResolved: true, isAdmin: false },
    pricing: null,
    agreement: null,
  })
  assert.equal(r.access_granted, false)
  assert.equal(r.blocking_reason, 'no_pricing_yet')
})

test('PENDING_AGREEMENT requires agreement, no checkout yet', () => {
  const r = decideAccess({
    principal: { userId: 'u', identityResolved: true, isAdmin: false },
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
    principal: { userId: 'u', identityResolved: true, isAdmin: false },
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
    principal: { userId: 'u', identityResolved: true, isAdmin: false },
    pricing: { access_status: ACCESS_STATUS.ACTIVE_PAID },
    agreement: { accepted: 1 },
  })
  assert.equal(r.access_granted, true)
  assert.equal(r.payment_required, false)
})

test('ADMIN_WAIVED grants access', () => {
  const r = decideAccess({
    principal: { userId: 'u', identityResolved: true, isAdmin: false },
    pricing: { access_status: ACCESS_STATUS.ADMIN_WAIVED },
    agreement: null,
  })
  assert.equal(r.access_granted, true)
  assert.equal(r.payment_status, 'admin_waived')
})

test('admin-review-required (PENDING_PRICING) blocks the user with the right reason', () => {
  const r = decideAccess({
    principal: { userId: 'u', identityResolved: true, isAdmin: false },
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

test('raw JWT authority fields are ignored without a trusted principal projection', () => {
  const r = decideAccess({
    user: { id: 'stale-admin', role: 'admin', is_admin: true, email: 'admin@grantflow.local' },
    pricing: { access_status: ACCESS_STATUS.ACTIVE_PAID },
    agreement: { accepted: 1 },
  })
  assert.equal(r.authenticated, false)
  assert.equal(r.is_admin, false)
  assert.equal(r.access_granted, false)
  assert.equal(r.blocking_reason, 'not_authenticated')
})

test('an unresolved principal cannot use an isAdmin projection', () => {
  const r = decideAccess({
    principal: { userId: 'deleted-user', identityResolved: false, isAdmin: true },
    pricing: { access_status: ACCESS_STATUS.ACTIVE_PAID },
    agreement: { accepted: 1 },
  })
  assert.equal(r.authenticated, false)
  assert.equal(r.is_admin, false)
  assert.equal(r.access_granted, false)
})

test('a validated synthetic service principal retains the canonical admin bypass', () => {
  const r = decideAccess({
    principal: { userId: 'system_admin_token', identityResolved: true, isAdmin: true },
    pricing: null,
    agreement: null,
  })
  assert.equal(r.authenticated, true)
  assert.equal(r.is_admin, true)
  assert.equal(r.access_granted, true)
  assert.equal(r.payment_status, 'admin_bypass')
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
