import { apiFetch } from './client'

export function exportGrantAccounting(grantId, { provider = 'generic', currency = 'USD' } = {}) {
  const query = new URLSearchParams({ provider, currency })
  return apiFetch(`/api/accounting-exchange/${encodeURIComponent(grantId)}/export?${query}`)
}

export function reconcileGrantAccounting(grantId, { provider = 'generic', csv }) {
  return apiFetch(`/api/accounting-exchange/${encodeURIComponent(grantId)}/reconcile`, {
    method: 'POST',
    body: JSON.stringify({ provider, csv }),
  })
}
