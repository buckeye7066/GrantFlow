import { describe, expect, it, vi } from 'vitest'
import { decideBillingEntitlement } from '../services/billing/entitlementDecision.js'
import {
  bypassEntitlementWhen,
  isHamiltonSecretInboxRequest,
} from '../middleware/entitlements.js'

describe('billing entitlement precedence', () => {
  for (const paymentAccessStatus of ['pending_pricing', 'pending_agreement', 'pending_payment']) {
    it(`lets the active global promotion override ${paymentAccessStatus}`, () => {
      expect(decideBillingEntitlement({
        profileStatus: 'active',
        paymentAccessStatus,
        promotionActive: true,
        capabilityKey: 'enable_pipeline_automation',
      })).toEqual({ allowed: true, source: 'promotion', reason: null })
    })
  }

  it('does not let a promotion override a blocked profile', () => {
    expect(decideBillingEntitlement({
      profileStatus: 'suspended',
      paymentAccessStatus: 'pending_payment',
      promotionActive: true,
      capabilityKey: 'enable_pipeline_automation',
    })).toMatchObject({ allowed: false, reason: 'profile_suspended' })
  })
})

describe('Hamilton secret callback entitlement bypass', () => {
  it.each(['/sms-inbox', '/inbox'])('reaches token authentication for POST %s', (suffix) => {
    const entitlement = vi.fn()
    const next = vi.fn()
    const middleware = bypassEntitlementWhen(isHamiltonSecretInboxRequest, entitlement)
    middleware({ method: 'POST', originalUrl: `/api/hamilton/automation${suffix}` }, {}, next)
    expect(next).toHaveBeenCalledOnce()
    expect(entitlement).not.toHaveBeenCalled()
  })

  it('does not bypass ordinary Hamilton routes or non-POST inbox reads', () => {
    for (const req of [
      { method: 'POST', originalUrl: '/api/hamilton/automation/start' },
      { method: 'GET', originalUrl: '/api/hamilton/automation/inbox' },
      { method: 'POST', originalUrl: '/api/hamilton/automation/inbox-status' },
    ]) {
      const entitlement = vi.fn()
      bypassEntitlementWhen(isHamiltonSecretInboxRequest, entitlement)(req, {}, vi.fn())
      expect(entitlement).toHaveBeenCalledOnce()
    }
  })
})
