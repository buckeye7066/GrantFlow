/**
 * agentControl.js
 *
 * Frontend API client for the Admin Agent Control Center. Talks to
 * /api/admin/agent-control. Every endpoint requires the canonical
 * admin/operator session (buckeye7066@gmail.com) — non-admins receive
 * HTTP 403 from the backend, which the UI treats as "hide controls".
 */

import { apiFetch } from '@/api/client'

const BASE = '/api/admin/agent-control'

function qs(params = {}) {
  const out = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue
    out.set(k, String(v))
  }
  const s = out.toString()
  return s ? `?${s}` : ''
}

function postJson(path, body) {
  return apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
}

export const agentControlApi = {
  status: () => apiFetch(`${BASE}/status`),

  listRuns: (params) => apiFetch(`${BASE}/runs${qs(params)}`),
  getRun: (runId) => apiFetch(`${BASE}/runs/${encodeURIComponent(runId)}`),
  getEvents: (runId, params) => apiFetch(`${BASE}/runs/${encodeURIComponent(runId)}/events${qs(params)}`),

  start: ({ runType, agents = [], options = {} } = {}) =>
    postJson(`${BASE}/start`, { run_type: runType, agents, options }),
  startFullCycle: (options = {}) =>
    postJson(`${BASE}/start`, { run_type: 'full_cycle', agents: ['sam', 'robert', 'yana', 'john', 'hamilton'], options }),
  startSelectedAgents: (agents = [], options = {}) =>
    postJson(`${BASE}/start`, { run_type: 'selected_agents', agents, options }),

  pause: (runId, reason = null) => postJson(`${BASE}/runs/${encodeURIComponent(runId)}/pause`, { reason }),
  resume: (runId) => postJson(`${BASE}/runs/${encodeURIComponent(runId)}/resume`),
  stop: (runId, reason = null) => postJson(`${BASE}/runs/${encodeURIComponent(runId)}/stop`, { reason }),
  emergencyStop: (runId, reason = null) =>
    postJson(`${BASE}/runs/${encodeURIComponent(runId)}/emergency-stop`, { reason }),
  cancel: (runId, reason = null) => postJson(`${BASE}/runs/${encodeURIComponent(runId)}/cancel`, { reason }),

  // Anya autonomous-scheduler master toggle (persisted, owner-only).
  getAnyaAutonomous: () => apiFetch(`${BASE}/anya/autonomous`),
  setAnyaAutonomous: (enabled) =>
    apiFetch(`${BASE}/anya/autonomous`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: Boolean(enabled) }),
    }),

  // Autonomous Code Repair (Sam/Anya) config — master switch, land mode,
  // critical-path override — persisted DB-authoritative, owner-only.
  getAdversarialRepair: () => apiFetch(`${BASE}/adversarial-repair`),
  setAdversarialRepair: (patch) =>
    apiFetch(`${BASE}/adversarial-repair`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch || {}),
    }),

  startAgent: (agentName, options = {}) =>
    postJson(`${BASE}/agents/${encodeURIComponent(agentName)}/start`, { options }),
  stopAgent: (agentName, reason = null) =>
    postJson(`${BASE}/agents/${encodeURIComponent(agentName)}/stop`, { reason }),
  agentStatus: (agentName) => apiFetch(`${BASE}/agents/${encodeURIComponent(agentName)}/status`),

  // Free-text, one-shot instruction attached to an agent ahead of its next run.
  getDirective: (agentName) => apiFetch(`${BASE}/agents/${encodeURIComponent(agentName)}/directive`),
  setDirective: (agentName, instruction) =>
    apiFetch(`${BASE}/agents/${encodeURIComponent(agentName)}/directive`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction: instruction || '' }),
    }),
}

export default agentControlApi
