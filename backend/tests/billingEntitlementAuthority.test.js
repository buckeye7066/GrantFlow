import { describe, expect, it } from 'vitest'
import {
  UNIVERSAL_ENTITLEMENT_TIER,
  buildEntitlementDecisionInput,
  decideBillingEntitlement,
} from '../services/billing/entitlementService.js'
import { CAPABILITY_KEYS } from '../../shared/tierCatalog.js'

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
  // OWNER ORDER 2026-09-07 ("make these changes global and permanent" —
  // "(highest non-admin tier)"): every non-admin profile holds the capabilities
  // of the highest non-admin tier no matter which tier it is BILLED at. This
  // test used to pin `tier_or_addon_required` for a small_org effective tier;
  // the billed tier no longer decides capabilities, only the universal policy
  // tier does — while the billed tier is still the one pricing selected.
  it('entitles the highest non-admin tier capabilities regardless of the BILLED effective tier', () => {
    const billed = {
      id: 'small_org',
      capabilities: {
        enable_document_ai: true,
        enable_item_funding: true,
        enable_pipeline_automation: false,
      },
    }
    const { input } = buildEntitlementDecisionInput(
      authority({ effectiveTier: billed }),
      'enable_pipeline_automation',
    )
    expect(UNIVERSAL_ENTITLEMENT_TIER.id).toBe('large_org')
    expect(input.tierAllows).toBe(true)
    expect(decideBillingEntitlement(input)).toMatchObject({
      allowed: true,
      source: 'tier',
    })
  })

  it('the universal policy tier carries every capability and never rewrites the billing it reads', () => {
    for (const key of Object.values(CAPABILITY_KEYS)) {
      expect(UNIVERSAL_ENTITLEMENT_TIER.capabilities[key]).toBe(true)
      expect(buildEntitlementDecisionInput(authority(), key).input.tierAllows).toBe(true)
    }
    const auth = authority({ effectiveBilling: { tier_id: 'individual', net_monthly_cents: 0 } })
    buildEntitlementDecisionInput(auth, 'enable_pipeline_automation')
    expect(auth.effectiveBilling).toEqual({ tier_id: 'individual', net_monthly_cents: 0 })
    expect(auth.effectiveTier.id).toBe('mid_size')
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
    // OWNER ORDER 2026-09-07: the universal policy tier already grants every
    // catalog capability, so the add-on branch is only reachable when the
    // entitlement tier lacks the key. Override the policy tier here to keep
    // the add-on precedence (payment first, then add-on) under test.
    const noPipelineTier = { id: 'test_no_pipeline', capabilities: { enable_pipeline_automation: false } }
    const paid = buildEntitlementDecisionInput(
      authority({
        effectiveTier: { id: 'small_org', capabilities: { enable_pipeline_automation: false } },
        entitlementTier: noPipelineTier,
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
        entitlementTier: noPipelineTier,
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
