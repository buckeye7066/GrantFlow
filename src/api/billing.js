import { apiFetch } from './client'

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
