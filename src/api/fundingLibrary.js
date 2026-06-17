import { apiFetch } from '@/api/client'

function buildQuery(params = {}) {
  const usp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '' || v === false) continue
    usp.set(k, String(v))
  }
  const s = usp.toString()
  return s ? `?${s}` : ''
}

export const fundingLibraryApi = {
  list: (params = {}) => apiFetch(`/api/funding-library${buildQuery(params)}`),
  get: (id) => apiFetch(`/api/funding-library/${encodeURIComponent(id)}`),
}

export default fundingLibraryApi
