import { apiFetch } from './client'
import { assertRealProfileId } from './profileIdGuards'

export async function listProfileMemory(profileId, { includeDeleted = false } = {}) {
  assertRealProfileId(profileId, 'listProfileMemory')
  const params = includeDeleted ? '?include_deleted=true' : ''
  return apiFetch(`/api/profiles/${profileId}/memory${params}`)
}

export async function getProfileMemoryContract(profileId) {
  assertRealProfileId(profileId, 'getProfileMemoryContract')
  return apiFetch(`/api/profiles/${profileId}/memory/contract`)
}

export async function createProfileMemory(profileId, input) {
  assertRealProfileId(profileId, 'createProfileMemory')
  return apiFetch(`/api/profiles/${profileId}/memory`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function updateProfileMemory(profileId, entryId, input) {
  assertRealProfileId(profileId, 'updateProfileMemory')
  return apiFetch(`/api/profiles/${profileId}/memory/${entryId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
}

export async function updateProfileMemoryRetention(profileId, entryId, input) {
  assertRealProfileId(profileId, 'updateProfileMemoryRetention')
  return apiFetch(`/api/profiles/${profileId}/memory/${entryId}/retention`, {
    method: 'PUT',
    body: JSON.stringify(input),
  })
}

export async function deleteProfileMemory(profileId, entryId, reason = 'user_requested') {
  assertRealProfileId(profileId, 'deleteProfileMemory')
  return apiFetch(`/api/profiles/${profileId}/memory/${entryId}`, {
    method: 'DELETE',
    body: JSON.stringify({ reason }),
  })
}
