import { apiFetch } from '@/api/apiClient'

export function prepareApplication(grantId, organizationId) {
  return apiFetch('/api/applications/prepare', {
    method: 'POST',
    body: JSON.stringify({ grantId, organizationId }),
  })
}

export function getApplication(id) {
  return apiFetch(`/api/applications/${id}`)
}

export function patchApplication(id, patch) {
  return apiFetch(`/api/applications/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch ?? {}),
  })
}

export function listSections(id) {
  return apiFetch(`/api/applications/${id}/sections`)
}

export function saveSection(id, sectionKey, { title, content } = {}) {
  return apiFetch(`/api/applications/${id}/sections/${encodeURIComponent(sectionKey)}`, {
    method: 'PUT',
    body: JSON.stringify({ title, content }),
  })
}

export function listChecklist(id) {
  return apiFetch(`/api/applications/${id}/checklist`)
}

export function setChecklistItem(id, key, { label, status } = {}) {
  return apiFetch(`/api/applications/${id}/checklist/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: JSON.stringify({ label, status }),
  })
}

export function validate(id) {
  return apiFetch(`/api/applications/${id}/validate`, { method: 'POST' })
}

export function compile(id) {
  return apiFetch(`/api/applications/${id}/compile`, { method: 'POST' })
}

export function exportPackage(id, format) {
  return apiFetch(`/api/applications/${id}/export`, {
    method: 'POST',
    body: JSON.stringify({ format }),
  })
}

export function submit(id, method, metadata, { confirmIncomplete = false } = {}) {
  return apiFetch(`/api/applications/${id}/submit`, {
    method: 'POST',
    body: JSON.stringify({ method, metadata, confirm_incomplete: confirmIncomplete === true }),
  })
}

export function autoPopulate(id) {
  return apiFetch(`/api/applications/${id}/auto-populate`, { method: 'POST' })
}

