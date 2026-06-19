import { apiFetch } from './client'

/** PUBLIC canonical tier catalog (tiers, capabilities, discounts, plain-English copy). */
export async function getTierCatalog() {
  return apiFetch('/api/billing/catalog')
}

/**
 * NON-ADMIN, read-only billing overview for a profile the user can access.
 * Returns { account, billing (effective seat-driven amount), read_only }.
 */
export async function getBillingOverview(profileId) {
  return apiFetch(`/api/billing/me/${profileId}`)
}

export async function listBillingTiers() {
  return apiFetch('/api/billing/tiers')
}

export async function createBillingTier(payload) {
  return apiFetch('/api/billing/tiers', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function updateBillingTier(id, payload) {
  return apiFetch(`/api/billing/tiers/${id}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export async function listBillingAccounts() {
  return apiFetch('/api/billing/accounts')
}

export async function getBillingAccount(profileId) {
  return apiFetch(`/api/billing/accounts/${profileId}`)
}

export async function updateBillingAccount(profileId, payload) {
  return apiFetch(`/api/billing/accounts/${profileId}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}
