import { apiFetch } from '@/api/client'

export const getAmyStatus = () => apiFetch('/api/amy/status')
export const getAmyLatestReport = () => apiFetch('/api/amy/report/latest')
export const getAmyHistory = () => apiFetch('/api/amy/reports')
export const getAmyApprovals = () => apiFetch('/api/amy/approvals')
export const runAmy = (body) =>
  apiFetch('/api/amy/run', { method: 'POST', body: JSON.stringify(body || {}) })
