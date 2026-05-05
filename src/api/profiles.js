import client, { apiFetch, getProfileSectionsClient } from './client'
import { assertRealProfileId } from './profileIdGuards'

export async function listProfiles(params = {}) {
  // React Query passes a "query function context" object into queryFn by default.
  // If callers pass `listProfiles` directly as `queryFn`, we must ignore that context
  // to avoid generating URLs like `?queryKey=[object Object]&signal=[object AbortSignal]`.
  const looksLikeQueryContext =
    params &&
    typeof params === 'object' &&
    (Object.prototype.hasOwnProperty.call(params, 'queryKey') ||
      Object.prototype.hasOwnProperty.call(params, 'signal') ||
      Object.prototype.hasOwnProperty.call(params, 'meta'))

  const effectiveParams = looksLikeQueryContext ? {} : params

  const searchParams = new URLSearchParams()
  Object.entries(effectiveParams)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .forEach(([key, value]) => searchParams.set(key, String(value)))

  const query = searchParams.toString()
  return apiFetch(`/api/profiles${query ? `?${query}` : ''}`)
}

export async function getProfile(id) {
  assertRealProfileId(id, 'getProfile')
  return apiFetch(`/api/profiles/${id}`)
}

export async function updateProfile(id, payload) {
  assertRealProfileId(id, 'updateProfile')
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

export async function deleteProfile(id) {
  assertRealProfileId(id, 'deleteProfile')
  return apiFetch(`/api/profiles/${id}`, {
    method: 'DELETE',
  })
}

export async function requestProfileSectionAI(profileId, sectionKey) {
  assertRealProfileId(profileId, 'requestProfileSectionAI')
  return apiFetch(`/api/profiles/${profileId}/sections/${sectionKey}/ai`, {
    method: 'POST',
  })
}

export async function requestProfileFieldAI(context) {
  const { profileId, sectionKey, fieldName } = context
  assertRealProfileId(profileId, 'requestProfileFieldAI')
  return apiFetch(`/api/profiles/${profileId}/fields/ai`, {
    method: 'POST',
    body: JSON.stringify(context),
  })
}

export async function hardDeleteProfileAdmin(profileId, payload = {}) {
  return apiFetch(`/api/admin/profiles/${profileId}/hard-delete`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function restoreProfileAccessAdmin(profileId, payload = {}) {
  return apiFetch(`/api/admin/profiles/${profileId}/restore-access`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}