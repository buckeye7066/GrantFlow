import { apiFetch } from './client'

export function listDocuments(filters = {}) {
  const params = new URLSearchParams()
  Object.entries(filters)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .forEach(([key, value]) => params.set(key, String(value)))

  const query = params.toString()
  const url = query ? `/api/documents?${query}` : '/api/documents'

  return apiFetch(url)
}

export function ingestDocument(payload) {
  const isFormData = typeof FormData !== 'undefined' && payload instanceof FormData
  return apiFetch('/api/documents/ingest', {
    method: 'POST',
    body: isFormData ? payload : JSON.stringify(payload),
  })
}

export function createDocument(payload) {
  return apiFetch('/api/documents', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function deleteDocument(documentId) {
  return apiFetch(`/api/documents/${documentId}`, {
    method: 'DELETE',
  })
}

export function parseDocument(documentId) {
  return apiFetch(`/api/documents/${documentId}/parse`, {
    method: 'POST',
  })
}

export function parseAllProfileDocuments(profileId, options = {}) {
  if (!profileId) {
    throw new Error('profileId is required')
  }
  const { profile_id: _ignored, ...safeOptions } = options || {}
  const payload = {
    profile_id: profileId,
    ...safeOptions,
  }
  return apiFetch('/api/documents/parse-all', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function ingestDocumentById(documentId, options = {}) {
  if (!documentId) throw new Error('documentId is required')
  return apiFetch(`/api/documents/${documentId}/ingest`, {
    method: 'POST',
    body: JSON.stringify(options || {}),
  })
}

export function getDocumentExtract(documentId) {
  if (!documentId) throw new Error('documentId is required')
  return apiFetch(`/api/documents/${documentId}/extract`)
}

export function getDocumentExtractText(documentId) {
  if (!documentId) throw new Error('documentId is required')
  return apiFetch(`/api/documents/${documentId}/extract/text`)
}
