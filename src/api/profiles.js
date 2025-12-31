import client, { apiFetch, getProfileSectionsClient } from './client'

export async function listProfiles(params = {}) {
  const searchParams = new URLSearchParams()
  Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .forEach(([key, value]) => searchParams.set(key, String(value)))

  const query = searchParams.toString()
  return apiFetch(`/api/profiles${query ? `?${query}` : ''}`)
}

export async function getProfile(id) {
  return apiFetch(`/api/profiles/${id}`)
}

export async function updateProfile(id, payload) {
  return apiFetch(`/api/profiles/${id}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export async function uploadProfileAvatar(profileId, file) {
  const formData = new FormData()
  formData.append('avatar', file)
  return client.fetch(`/api/profiles/${profileId}/avatar`, {
    method: 'POST',
    body: formData,
  })
}

export async function requestProfileAvatarAI(profileId) {
  return apiFetch(`/api/profiles/${profileId}/avatar/ai`, {
    method: 'POST',
  })
}

export async function upsertProfileSection(profileId, sectionKey, data, updatedBy) {
  return getProfileSectionsClient(profileId).update(sectionKey, data, updatedBy)
}

export async function listProfileSections(profileId) {
  return getProfileSectionsClient(profileId).list()
}

export async function requestProfileSectionAI(profileId, sectionKey) {
  return apiFetch(`/api/profiles/${profileId}/sections/${sectionKey}/ai`, {
    method: 'POST',
  })
}
