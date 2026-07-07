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

export async function getPreferredLanguage(id) {
  assertRealProfileId(id, 'getPreferredLanguage')
  return apiFetch(`/api/profiles/${id}/preferred-language`)
}

export async function updatePreferredLanguage(id, code) {
  assertRealProfileId(id, 'updatePreferredLanguage')
  return apiFetch(`/api/profiles/${id}/preferred-language`, {
    method: 'PUT',
    body: JSON.stringify({ preferred_language: code, updated_by: 'language-switcher' }),
  })
}

export async function getProfileProjectReadinessPlan(id) {
  assertRealProfileId(id, 'getProfileProjectReadinessPlan')
  return apiFetch(`/api/profiles/${id}/project-readiness-plan`)
}

export async function prepareProfileProjectReadinessPlan(id) {
  assertRealProfileId(id, 'prepareProfileProjectReadinessPlan')
  return apiFetch(`/api/profiles/${id}/project-readiness-plan/prepare`, {
    method: 'POST',
  })
}

export async function uploadProfileAvatar(profileId, file) {
  assertRealProfileId(profileId, 'uploadProfileAvatar')
  const formData = new FormData()
  formData.append('avatar', file)
  return client.fetch(`/api/profiles/${profileId}/avatar`, {
    method: 'POST',
    body: formData,
  })
}

/**
 * Derive an ORG profile's avatar from its own website homepage logo.
 * Synchronous on the backend: resolves immediately with the updated profile
 * on success, or throws (err.details carries { reason, message }) so callers
 * can fall back to AI generation / upload.
 */
export async function requestProfileAvatarFromWebsite(profileId, options = {}) {
  assertRealProfileId(profileId, 'requestProfileAvatarFromWebsite')
  const body = {}
  const website = options?.website ?? options?.websiteHint
  if (website) body.website = website
  return apiFetch(`/api/profiles/${profileId}/avatar/from-website`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function requestProfileAvatarAI(profileId, options = {}) {
  assertRealProfileId(profileId, 'requestProfileAvatarAI')
  const body = {}
  const websiteHint = options?.websiteHint ?? options?.website
  if (websiteHint) body.website_hint = websiteHint
  return apiFetch(`/api/profiles/${profileId}/avatar/ai`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function upsertProfileSection(profileId, sectionKey, data, updatedBy) {
  assertRealProfileId(profileId, 'upsertProfileSection')
  return getProfileSectionsClient(profileId).update(sectionKey, data, updatedBy)
}

export async function listProfileSections(profileId) {
  assertRealProfileId(profileId, 'listProfileSections')
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

// Controlled vocabulary for tag-picker profile fields (needs / focus).
// The endpoint is owned by the backend schema-redesign branch and may not exist
// yet on older deploys — callers MUST treat a rejection (404 pre-deploy) as
// "no controlled list available" and fall back to free-text entry so the form
// never breaks. The result is memoized module-side (one fetch per session);
// a failed fetch is NOT cached, so a later mount can retry once the endpoint ships.
let _vocabularyPromise = null
export async function getProfileVocabulary() {
  if (_vocabularyPromise) return _vocabularyPromise
  _vocabularyPromise = apiFetch('/api/profiles/vocabulary').catch((err) => {
    _vocabularyPromise = null
    throw err
  })
  return _vocabularyPromise
}

// Test-only hook: reset the module-level vocabulary memo between test cases.
export function __resetProfileVocabularyCache() {
  _vocabularyPromise = null
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

// School-portal bridge — show / revoke the link between this profile and a
// registered school's student-information system. (Mission goal 4 + 7: the
// student can always see and control which school is feeding their data.)
export async function getProfileSchoolLink(profileId) {
  assertRealProfileId(profileId, 'getProfileSchoolLink')
  return apiFetch(`/api/profiles/${profileId}/school-link`)
}

export async function revokeProfileSchoolLink(profileId) {
  assertRealProfileId(profileId, 'revokeProfileSchoolLink')
  return apiFetch(`/api/profiles/${profileId}/school-link/revoke`, {
    method: 'POST',
  })
}
