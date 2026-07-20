/**
 * sam.js
 *
 * Frontend API client for /api/sam/* — Sam's production-readiness findings.
 * Every route requires an authenticated admin session.
 */

import { apiFetch } from '@/api/client'

const BASE = '/api/sam'

export const samApi = {
  run: ({ mode = 'observe', checks = null, dryRun = true } = {}) =>
    apiFetch(`${BASE}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, checks, dryRun }),
    }),

  updateFinding: (findingId, status) =>
    apiFetch(`${BASE}/findings/${encodeURIComponent(findingId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    }),
}

export default samApi
