import {
  resolveAllProfileEntitlements,
  resolveProfileEntitlement,
} from '../services/billing/entitlementService.js'
import { ensureBillingAccount, mapAccountRow } from '../services/billingAccounts.js'
import { CAPABILITY_KEYS } from '../../shared/tierCatalog.js'

export const TIER_CAPABILITIES = Object.freeze({ ...CAPABILITY_KEYS })

export async function getProfileBillingAccount(db, profileId) {
  if (!profileId) return null
  const row = await ensureBillingAccount(db, profileId)
  return mapAccountRow(row)
}

export async function getProfileEntitlements(db, req, profileId) {
  return await resolveAllProfileEntitlements(db, {
    profileId,
    isAdmin: req?.ctx?.isAdmin === true,
  })
}

export async function hasTierCapability(db, req, profileId, capabilityKey) {
  const decision = await resolveProfileEntitlement(db, {
    profileId,
    capabilityKey,
    isAdmin: req?.ctx?.isAdmin === true,
  })
  return decision.allowed === true
}

export async function requireTierCapability(req, res, profileId, capabilityKey) {
  const decision = await resolveProfileEntitlement(req.db, {
    profileId,
    capabilityKey,
    isAdmin: req?.ctx?.isAdmin === true,
  })
  if (decision.allowed === true) {
    req.entitlement = decision
    return true
  }

  const paymentRequired = decision.payment_required === true
  const reason = String(decision.reason || '')
  const suspended = reason.startsWith('profile_') && reason !== 'profile_not_found'
  const unavailable = decision.unavailable === true
  const notFound = reason === 'profile_not_found'
  res.status(unavailable ? 503 : notFound ? 404 : paymentRequired ? 402 : suspended ? 423 : 403).json({
    error: unavailable
      ? 'entitlement_authority_unavailable'
      : notFound
        ? 'profile_not_found'
        : paymentRequired
        ? 'payment_required'
        : suspended
          ? 'profile_access_paused'
          : 'tier_or_addon_required',
    capability: capabilityKey,
    reason: decision.reason,
    tier_id: decision.tier_id || null,
    message: unavailable
      ? 'GrantFlow could not verify billing entitlements. The feature remains locked until verification succeeds.'
      : notFound
        ? 'The requested profile does not exist or is no longer available.'
        : paymentRequired
        ? 'Payment or an approved waiver is required before this feature can run.'
        : suspended
          ? 'This profile is paused. Resolve the account hold before using paid features.'
          : 'Your tier does not include this feature and no active add-on grants it.',
  })
  return false
}
