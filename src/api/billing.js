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

/**
 * NON-ADMIN: choose when this profile is invoiced.
 *   cadence: 'weekly' (every Friday) | 'biweekly' (every other Friday)
 *          | 'semimonthly' (1st + 16th) | 'monthly' (first Friday of the month)
 * All at 09:00 America/New_York.
 */
export async function setBillingCadence(profileId, cadence) {
  return apiFetch(`/api/billing/me/${profileId}/cadence`, {
    method: 'PUT',
    body: JSON.stringify({ cadence }),
  })
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

/**
 * ADMIN: grant a free period (one week / one month free). The timer starts now.
 *   kind: 'week' | 'month'
 *   scope: 'profile' (requires profileId) | 'global'
 */
export async function grantFreePeriod({ kind = 'week', scope = 'profile', profileId = null, reason = null } = {}) {
  return apiFetch('/api/billing/admin/free/grant', {
    method: 'POST',
    body: JSON.stringify({ kind, scope, profileId, reason }),
  })
}

/** ADMIN: revoke a free period for one profile, or globally. */
export async function revokeFreePeriod({ scope = 'profile', profileId = null } = {}) {
  return apiFetch('/api/billing/admin/free/revoke', {
    method: 'POST',
    body: JSON.stringify({ scope, profileId }),
  })
}

// ── Account status: suspend / reactivate / ban / unban ───────────────────────

export async function suspendAccount(profileId, reason = null) {
  return apiFetch(`/api/billing/admin/accounts/${profileId}/suspend`, { method: 'POST', body: JSON.stringify({ reason }) })
}
export async function reactivateAccount(profileId) {
  return apiFetch(`/api/billing/admin/accounts/${profileId}/reactivate`, { method: 'POST', body: JSON.stringify({}) })
}
export async function banAccountUser(profileId, reason = null) {
  return apiFetch(`/api/billing/admin/accounts/${profileId}/ban`, { method: 'POST', body: JSON.stringify({ reason }) })
}
export async function unbanAccountUser(profileId) {
  return apiFetch(`/api/billing/admin/accounts/${profileId}/unban`, { method: 'POST', body: JSON.stringify({}) })
}
