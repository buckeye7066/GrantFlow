import { apiFetch } from '@/api/client'

/**
 * Access-gate client. Used by `<RequirePaidAccess>` and the pricing pages.
 *
 * Server returns:
 *   { ok: true, authenticated, is_admin, profile_id, payment_required,
 *     agreement_required, agreement_accepted, payment_status,
 *     access_granted, blocking_reason, quote_id, checkout_available,
 *     access_status, recommended_package_name, primary_service_key,
 *     total_cents, discount_eligible, installed }
 */
export const accessGateApi = {
  status: (profileId) => {
    const qs = profileId ? `?profile_id=${encodeURIComponent(profileId)}` : ''
    return apiFetch(`/api/access-gate/status${qs}`)
  },
  acceptAgreement: (profileId, agreementText) =>
    apiFetch('/api/access-gate/agreement/accept', {
      method: 'POST',
      body: JSON.stringify({ profile_id: profileId, agreement_text: agreementText }),
    }),
  // Admin-only:
  initializePricing: (payload) =>
    apiFetch('/api/access-gate/initialize-pricing', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  paymentSuccess: (profileId, quoteId) =>
    apiFetch('/api/access-gate/payment-success', {
      method: 'POST',
      body: JSON.stringify({ profile_id: profileId, quote_id: quoteId }),
    }),
  adminWaive: (profileId) =>
    apiFetch('/api/access-gate/admin-waive', {
      method: 'POST',
      body: JSON.stringify({ profile_id: profileId }),
    }),
}

export default accessGateApi
