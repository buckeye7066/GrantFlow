import { apiFetch } from './client'

export async function fetchServiceCatalog({ includeInactive = false } = {}) {
  const q = includeInactive ? '?include_inactive=true' : ''
  return apiFetch(`/api/services/catalog${q}`)
}

export async function fetchServiceTerms() {
  return apiFetch('/api/services/terms')
}

export async function createServicePurchase(payload) {
  return apiFetch('/api/services/purchases', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function listServicePurchases() {
  return apiFetch('/api/services/purchases')
}

export async function addHourlyTimeEntry(payload) {
  return apiFetch('/api/services/hourly/time-entry', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function createServiceCheckout(payload) {
  return apiFetch('/api/stripe/checkout/service', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function createHourlyCheckout(payload) {
  return apiFetch('/api/stripe/checkout/hourly', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

// Admin
export async function adminFetchServiceCatalog() {
  return apiFetch('/api/admin/service-catalog/catalog')
}

export async function adminToggleServiceActive(slug, isActive) {
  return apiFetch(`/api/admin/service-catalog/service/${encodeURIComponent(slug)}/toggle`, {
    method: 'POST',
    body: JSON.stringify({ is_active: Boolean(isActive) }),
  })
}

export async function adminMapStripePrice(priceId, stripePriceId) {
  return apiFetch(`/api/admin/service-catalog/price/${encodeURIComponent(priceId)}/map-stripe`, {
    method: 'POST',
    body: JSON.stringify({ stripe_price_id: stripePriceId }),
  })
}

