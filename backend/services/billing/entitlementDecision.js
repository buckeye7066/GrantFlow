const PAID_ACCESS_STATUSES = new Set(['active_paid', 'admin_waived'])
const BLOCKED_PROFILE_STATUSES = new Set(['suspended', 'blocked', 'banned', 'deleted'])

function asLower(value) {
  return String(value || '').trim().toLowerCase()
}

export function decideBillingEntitlement({
  isAdmin = false,
  profileStatus = null,
  paymentAccessStatus = null,
  tierAllows = false,
  activeAddons = [],
  promotionActive = false,
  capabilityKey,
  authorityAvailable = true,
} = {}) {
  if (isAdmin === true) {
    return { allowed: true, source: 'admin', reason: null }
  }
  if (!authorityAvailable) {
    return { allowed: false, source: null, reason: 'entitlement_authority_unavailable', unavailable: true }
  }
  const normalizedProfileStatus = asLower(profileStatus)
  if (BLOCKED_PROFILE_STATUSES.has(normalizedProfileStatus)) {
    return { allowed: false, source: null, reason: `profile_${normalizedProfileStatus}` }
  }
  // The global promotion is a temporary grant of every capability. New
  // profiles normally remain in a pending pricing/agreement/payment state
  // while that promotion is active, so payment state must not shadow it.
  if (promotionActive) {
    return { allowed: true, source: 'promotion', reason: null }
  }
  const normalizedPayment = asLower(paymentAccessStatus)
  if (normalizedPayment && !PAID_ACCESS_STATUSES.has(normalizedPayment)) {
    return { allowed: false, source: null, reason: `payment_${normalizedPayment}`, payment_required: true }
  }
  if (tierAllows === true) {
    return { allowed: true, source: 'tier', reason: null }
  }
  const addon = (activeAddons || []).find((row) => row?.capability_key === capabilityKey)
  if (addon) {
    return { allowed: true, source: 'addon', reason: null, addon_id: addon.id }
  }
  return { allowed: false, source: null, reason: 'tier_or_addon_required' }
}

export default decideBillingEntitlement
