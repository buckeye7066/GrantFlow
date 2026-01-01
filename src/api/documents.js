import { apiFetch } from './client'

export function listDocuments(filters = {}) {
  const params = new URLSearchParams()
  Object.entries(filters)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .forEach(([key, value]) => params.set(key, value))

  const query = params.toString()
  const url = query ? `/api/documents?${query}` : '/api/documents'

  return apiFetch(url)
}

export function ingestDocument(payload) {
  return apiFetch('/api/documents/ingest', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function deleteDocument(documentId) {
  return apiFetch(`/api/documents/${documentId}`, {
    method: 'DELETE',
  })
}
