import { describe, expect, it } from 'vitest'
import {
  buildEntitlementDecisionInput,
  decideBillingEntitlement,
} from '../services/billing/entitlementService.js'

const authority = (overrides = {}) => ({
  profile: { status: 'active' },
  paymentAccessStatus: 'active_paid',
  effectiveTier: {
    id: 'mid_size',
    capabilities: {
      enable_document_ai: true,
      enable_item_funding: true,
      enable_pipeline_automation: true,
    },
  },
  activeAddons: [],
  promotionActive: false,
  requiresPayment: true,
  ...overrides,
})

describe('billing entitlement authority', () => {
  it('uses the same effective tier that pricing selected', () => {
    const { input } = buildEntitlementDecisionInput(
      authority({
        effectiveTier: {
          id: 'small_org',
          capabilities: {
            enable_document_ai: true,
            enable_item_funding: true,
            enable_pipeline_automation: false,
          },
        },
      }),
      'enable_pipeline_automation',
    )
    expect(input.tierAllows).toBe(false)
    expect(decideBillingEntitlement(input)).toMatchObject({
      allowed: false,
      reason: 'tier_or_addon_required',
    })
  })

  it('fails closed when a paid effective tier has no active payment decision', () => {
    const { paymentAccessStatus, input } = buildEntitlementDecisionInput(
      authority({ paymentAccessStatus: null }),
      'enable_item_funding',
    )
    expect(paymentAccessStatus).toBe('not_active')
    expect(decideBillingEntitlement(input)).toMatchObject({
      allowed: false,
      reason: 'payment_not_active',
      payment_required: true,
    })
  })

  it('honors an active add-on only after payment access is valid', () => {
    const activeAddons = [{ id: 'addon-1', capability_key: 'enable_pipeline_automation' }]
    const paid = buildEntitlementDecisionInput(
      authority({
        effectiveTier: { id: 'small_org', capabilities: { enable_pipeline_automation: false } },
        activeAddons,
      }),
      'enable_pipeline_automation',
    )
    expect(decideBillingEntitlement(paid.input)).toMatchObject({
      allowed: true,
      source: 'addon',
      addon_id: 'addon-1',
    })

    const unpaid = buildEntitlementDecisionInput(
      authority({
        paymentAccessStatus: null,
        effectiveTier: { id: 'small_org', capabilities: { enable_pipeline_automation: false } },
        activeAddons,
      }),
      'enable_pipeline_automation',
    )
    expect(decideBillingEntitlement(unpaid.input)).toMatchObject({
      allowed: false,
      reason: 'payment_not_active',
    })
  })

  it('lets an active free period override pending payment workflow states', () => {
    const { paymentAccessStatus, input } = buildEntitlementDecisionInput(
      authority({
        paymentAccessStatus: 'pending_payment',
        promotionActive: true,
        requiresPayment: false,
      }),
      'enable_pipeline_automation',
    )
    expect(paymentAccessStatus).toBeNull()
    expect(decideBillingEntitlement(input)).toMatchObject({
      allowed: true,
      source: 'promotion',
    })
  })

  it('allows a live free period without manufacturing paid status', () => {
    const { input } = buildEntitlementDecisionInput(
      authority({
        paymentAccessStatus: null,
        promotionActive: true,
        requiresPayment: false,
      }),
      'enable_pipeline_automation',
    )
    expect(decideBillingEntitlement(input)).toMatchObject({
      allowed: true,
      source: 'promotion',
    })
  })
})
