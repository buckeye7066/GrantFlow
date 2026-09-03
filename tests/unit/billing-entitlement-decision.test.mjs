import test from 'node:test'
import assert from 'node:assert/strict'
import {
  decideBillingEntitlement,
} from '../../backend/services/billing/entitlementDecision.js'

const capabilityKey = 'enable_pipeline_automation'

test('tier and add-on are independent positive entitlement sources', () => {
  assert.deepEqual(
    decideBillingEntitlement({ capabilityKey, tierAllows: true }),
    { allowed: true, source: 'tier', reason: null },
  )
  assert.deepEqual(
    decideBillingEntitlement({
      capabilityKey,
      activeAddons: [{ id: 'addon-1', capability_key: capabilityKey }],
    }),
    { allowed: true, source: 'addon', reason: null, addon_id: 'addon-1' },
  )
})

test('payment and suspension block a tier or add-on fail closed', () => {
  const pending = decideBillingEntitlement({
    capabilityKey,
    paymentAccessStatus: 'pending_payment',
    tierAllows: true,
  })
  assert.equal(pending.allowed, false)
  assert.equal(pending.payment_required, true)

  const suspended = decideBillingEntitlement({
    capabilityKey,
    profileStatus: 'suspended',
    activeAddons: [{ id: 'addon-1', capability_key: capabilityKey }],
  })
  assert.equal(suspended.allowed, false)
  assert.equal(suspended.reason, 'profile_suspended')
})

test('only DB-backed admin bypass and authority failure stays locked', () => {
  assert.equal(decideBillingEntitlement({ isAdmin: true, capabilityKey }).allowed, true)
  const unavailable = decideBillingEntitlement({ capabilityKey, authorityAvailable: false })
  assert.equal(unavailable.allowed, false)
  assert.equal(unavailable.unavailable, true)
  assert.equal('error' in unavailable, false)
})
