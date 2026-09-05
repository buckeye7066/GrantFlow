/**
 * Billing entitlement precedence at the SERVICE boundary (ported from PR
 * #1525's billingEntitlementDecision.test.js, adapted to main).
 *
 * main's pure decideBillingEntitlement() checks payment BEFORE promotion by
 * design; the promotion override lives one layer up, in
 * buildEntitlementDecisionInput(), which removes the payment prerequisite for
 * the duration of an active promotion / free period. These tests pin that
 * composed behavior — the one every gate actually sees — rather than
 * re-ordering the pure function.
 */
import { describe, expect, it } from 'vitest'
import {
  buildEntitlementDecisionInput,
  decideBillingEntitlement,
} from '../services/billing/entitlementService.js'

const capabilityKey = 'enable_pipeline_automation'

function decideFor(authority) {
  return decideBillingEntitlement(buildEntitlementDecisionInput(authority, capabilityKey).input)
}

describe('billing entitlement precedence (service boundary)', () => {
  for (const paymentAccessStatus of ['pending_pricing', 'pending_agreement', 'pending_payment']) {
    it(`lets an active promotion override ${paymentAccessStatus}`, () => {
      expect(decideFor({
        profile: { status: 'active' },
        paymentAccessStatus,
        promotionActive: true,
        requiresPayment: false,
        activeAddons: [],
        effectiveTier: { capabilities: { [capabilityKey]: false } },
      })).toEqual({ allowed: true, source: 'promotion', reason: null })
    })
  }

  it('does not let a promotion override a blocked profile', () => {
    expect(decideFor({
      profile: { status: 'suspended' },
      paymentAccessStatus: 'pending_payment',
      promotionActive: true,
      requiresPayment: false,
      activeAddons: [],
      effectiveTier: { capabilities: { [capabilityKey]: true } },
    })).toMatchObject({ allowed: false, reason: 'profile_suspended' })
  })

  it('treats a missing payment row as not_active when payment is required', () => {
    const { paymentAccessStatus, input } = buildEntitlementDecisionInput({
      profile: { status: 'active' },
      paymentAccessStatus: null,
      promotionActive: false,
      requiresPayment: true,
      activeAddons: [{ id: 'addon-1', capability_key: capabilityKey }],
      effectiveTier: { capabilities: { [capabilityKey]: true } },
    }, capabilityKey)
    expect(paymentAccessStatus).toBe('not_active')
    expect(decideBillingEntitlement(input)).toMatchObject({
      allowed: false,
      reason: 'payment_not_active',
      payment_required: true,
    })
  })

  it('admits a tier or an add-on once payment is in good standing', () => {
    expect(decideFor({
      profile: { status: 'active' },
      paymentAccessStatus: 'active_paid',
      promotionActive: false,
      requiresPayment: true,
      activeAddons: [],
      effectiveTier: { capabilities: { [capabilityKey]: true } },
    })).toEqual({ allowed: true, source: 'tier', reason: null })

    expect(decideFor({
      profile: { status: 'active' },
      paymentAccessStatus: 'admin_waived',
      promotionActive: false,
      requiresPayment: true,
      activeAddons: [{ id: 'addon-1', capability_key: capabilityKey }],
      effectiveTier: { capabilities: { [capabilityKey]: false } },
    })).toEqual({ allowed: true, source: 'addon', reason: null, addon_id: 'addon-1' })
  })
})
