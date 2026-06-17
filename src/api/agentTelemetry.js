import { apiFetch } from '@/api/client'

const BASE = '/api/admin/agent-telemetry'

function qs(params = {}) {
  const out = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue
    out.set(k, String(v))
  }
  const s = out.toString()
  return s ? `?${s}` : ''
}

export const agentTelemetryApi = {
  summary: (params) => apiFetch(`${BASE}/summary${qs(params)}`),
  timeline: (params) => apiFetch(`${BASE}/timeline${qs(params)}`),
  yana: (params) => apiFetch(`${BASE}/yana${qs(params)}`),
  robert: (params) => apiFetch(`${BASE}/robert${qs(params)}`),
  robertMap: (params) => apiFetch(`${BASE}/robert/map${qs(params)}`),
  sam: (params) => apiFetch(`${BASE}/sam${qs(params)}`),
  anya: (params) => apiFetch(`${BASE}/anya${qs(params)}`),
  john: (params) => apiFetch(`${BASE}/john${qs(params)}`),
  hamilton: (params) => apiFetch(`${BASE}/hamilton${qs(params)}`),
  health: () => apiFetch(`${BASE}/health`),
}

export default agentTelemetryApi
