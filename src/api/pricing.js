import { apiFetch } from '@/api/client'

/**
 * GrantFlow pricing API client.
 *
 * Admin-only endpoints all live under `/api/pricing` and return
 * `{ ok: true, ... }` on success or `{ ok: false, error }` on failure.
 *
 * The user-facing `myEstimate` returns either:
 *   { ok: true, available: false, message: "Pricing will be reviewed after intake." }
 *   { ok: true, available: true,  message: "Based on your needs, ..." }
 */
export const pricingApi = {
  myEstimate: (profileId) =>
    apiFetch(`/api/pricing/my-estimate/${encodeURIComponent(profileId)}`),

  recommend: (payload) =>
    apiFetch('/api/pricing/recommend', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // ── Admin-only ─────────────────────────────────────────────────────────────
  listQuotes: ({ status, limit = 50, offset = 0 } = {}) => {
    const p = new URLSearchParams()
    if (status) p.set('status', status)
    if (limit) p.set('limit', String(limit))
    if (offset) p.set('offset', String(offset))
    const qs = p.toString()
    return apiFetch(`/api/pricing/quotes${qs ? `?${qs}` : ''}`)
  },
  getQuote: (quoteId) =>
    apiFetch(`/api/pricing/quotes/${encodeURIComponent(quoteId)}`),
  approveQuote: (quoteId) =>
    apiFetch(`/api/pricing/quotes/${encodeURIComponent(quoteId)}/approve`, { method: 'POST' }),
  editLineItem: (quoteId, lineItemId, updates) =>
    apiFetch(`/api/pricing/quotes/${encodeURIComponent(quoteId)}/edit`, {
      method: 'POST',
      body: JSON.stringify({ line_item_id: lineItemId, updates }),
    }),
  approveDiscount: (quoteId, discountId) =>
    apiFetch(`/api/pricing/quotes/${encodeURIComponent(quoteId)}/discount`, {
      method: 'POST',
      body: JSON.stringify({ action: 'approve', discount_id: discountId }),
    }),
  removeDiscount: (quoteId, discountId) =>
    apiFetch(`/api/pricing/quotes/${encodeURIComponent(quoteId)}/discount`, {
      method: 'POST',
      body: JSON.stringify({ action: 'remove', discount_id: discountId }),
    }),
  addManualDiscount: (quoteId, discount) =>
    apiFetch(`/api/pricing/quotes/${encodeURIComponent(quoteId)}/discount`, {
      method: 'POST',
      body: JSON.stringify({ action: 'add', ...discount }),
    }),
  markPresented: (quoteId) =>
    apiFetch(`/api/pricing/quotes/${encodeURIComponent(quoteId)}/mark-presented`, { method: 'POST' }),
  markAccepted: (quoteId) =>
    apiFetch(`/api/pricing/quotes/${encodeURIComponent(quoteId)}/mark-accepted`, { method: 'POST' }),
  markDeclined: (quoteId) =>
    apiFetch(`/api/pricing/quotes/${encodeURIComponent(quoteId)}/mark-declined`, { method: 'POST' }),
  listDiscountRules: () => apiFetch('/api/pricing/discount-rules'),
  saveDiscountRule: (rule) =>
    apiFetch('/api/pricing/discount-rules', { method: 'POST', body: JSON.stringify(rule) }),

  // ── Admin pricing toast notifications ────────────────────────────────────
  listAdminNotifications: ({ status, limit = 25 } = {}) => {
    const p = new URLSearchParams()
    if (status) p.set('status', status)
    if (limit) p.set('limit', String(limit))
    const qs = p.toString()
    return apiFetch(`/api/pricing/admin-notifications${qs ? `?${qs}` : ''}`)
  },
  flushQueuedAdminNotifications: () =>
    apiFetch('/api/pricing/admin-notifications/flush-queued', { method: 'POST' }),
  markAdminNotificationDelivered: (id, mode = 'live') =>
    apiFetch(`/api/pricing/admin-notifications/${encodeURIComponent(id)}/delivered`, {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }),
  dismissAdminNotification: (id) =>
    apiFetch(`/api/pricing/admin-notifications/${encodeURIComponent(id)}/dismiss`, { method: 'POST' }),
}

export default pricingApi
