/**
 * laptopConnector.js — frontend API client for the Laptop Connector inbox.
 *
 * Talks to /api/laptop-connector. Admin-only; non-admins get 403, which the
 * UI treats as "hide". The connector CLI (tools/laptop-connector) populates
 * the inbox; this client only reads it and accepts/dismisses items.
 */

import { apiFetch } from '@/api/client'

const BASE = '/api/laptop-connector'

function postJson(path, body) {
  return apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
}

export const laptopConnectorApi = {
  listReview: (type) =>
    apiFetch(`${BASE}/review${type ? `?type=${encodeURIComponent(type)}` : ''}`),
  listRuns: () => apiFetch(`${BASE}/runs`),
  accept: (id) => postJson(`${BASE}/review/${encodeURIComponent(id)}/accept`),
  dismiss: (id, reason) => postJson(`${BASE}/review/${encodeURIComponent(id)}/dismiss`, { reason }),
  bulkDismiss: (body) => postJson(`${BASE}/review/bulk-dismiss`, body),
}
