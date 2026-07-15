import { apiFetch } from '@/api/client'

export const getAmyStatus = () => apiFetch('/api/amy/status')
export const getAmyLatestReport = () => apiFetch('/api/amy/report/latest')
export const getAmyHistory = () => apiFetch('/api/amy/reports')
export const getAmyApprovals = () => apiFetch('/api/amy/approvals')
// The apply path for the `relevance_precision` approval item (previously inert:
// no route, no control). POST takes the FULL desired additions list.
export const getAmyRelevanceVocabulary = () => apiFetch('/api/amy/relevance-vocabulary')
export const applyAmyRelevanceVocabulary = (phrases) =>
  apiFetch('/api/amy/relevance-vocabulary', { method: 'POST', body: JSON.stringify({ phrases }) })
export const runAmy = (body) =>
  apiFetch('/api/amy/run', { method: 'POST', body: JSON.stringify(body || {}) })
