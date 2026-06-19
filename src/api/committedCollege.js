/**
 * API client for the committed-college financial-aid workspace.
 * Backend: backend/routes/committedCollege.js (mounted on /api).
 */
import { apiFetch } from '@/api/apiClient.js'
import { assertRealProfileId } from '@/api/profileIdGuards'

/** GET the aggregated workspace (committed college, COA, FAFSA, aid, funding…). */
export async function getCommittedCollegeWorkspace(profileId) {
  assertRealProfileId(profileId, 'getCommittedCollegeWorkspace')
  return apiFetch(`/api/profiles/${profileId}/committed-college/workspace`)
}

/** Commit to one college — the others archive (drop off). */
export async function commitToCollege(profileId, collegeId) {
  assertRealProfileId(profileId, 'commitToCollege')
  return apiFetch(`/api/profiles/${profileId}/committed-college/commit`, {
    method: 'POST',
    body: JSON.stringify({ collegeId }),
  })
}

/** Restore an archived college to its previous status (undo). */
export async function uncommitCollege(profileId, collegeId) {
  assertRealProfileId(profileId, 'uncommitCollege')
  return apiFetch(`/api/profiles/${profileId}/committed-college/uncommit`, {
    method: 'POST',
    body: JSON.stringify({ collegeId }),
  })
}

/**
 * Plan/merge selected funding into Hamilton. With authorize=false this returns
 * the compliance-annotated plan (preview); authorize=true also hands the
 * autopilot/packet (non-federal) items to Hamilton.
 */
export async function mergeCommittedCollegeFunding(
  profileId,
  { selectedFunding = [], deselectedFunding = [], authorize = false } = {},
) {
  assertRealProfileId(profileId, 'mergeCommittedCollegeFunding')
  return apiFetch(`/api/profiles/${profileId}/committed-college/merge-funding`, {
    method: 'POST',
    body: JSON.stringify({ selectedFunding, deselectedFunding, authorize }),
  })
}

/** Set the committed college's cost-of-attendance ({tuition, housing, books, other, total}). */
export async function setCommittedCollegeCOA(profileId, coa = {}) {
  assertRealProfileId(profileId, 'setCommittedCollegeCOA')
  return apiFetch(`/api/profiles/${profileId}/committed-college/cost-of-attendance`, {
    method: 'POST',
    body: JSON.stringify(coa),
  })
}

/**
 * Add a scholarship / financial-aid entry to the committed college's pipeline.
 * entry = { name, amount?, status (awarded|applied|pending|received|declined),
 *           source?, notes?, deadline?, renewable? }. Returns { entry, workspace }.
 */
export async function addCommittedCollegeAid(profileId, entry = {}) {
  assertRealProfileId(profileId, 'addCommittedCollegeAid')
  return apiFetch(`/api/profiles/${profileId}/committed-college/aid`, {
    method: 'POST',
    body: JSON.stringify(entry),
  })
}

/** Update one aid entry (partial patch). Returns { entry, workspace }. */
export async function updateCommittedCollegeAid(profileId, entryId, patch = {}) {
  assertRealProfileId(profileId, 'updateCommittedCollegeAid')
  return apiFetch(`/api/profiles/${profileId}/committed-college/aid/${entryId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

/** Remove one aid entry. Returns { workspace }. */
export async function removeCommittedCollegeAid(profileId, entryId) {
  assertRealProfileId(profileId, 'removeCommittedCollegeAid')
  return apiFetch(`/api/profiles/${profileId}/committed-college/aid/${entryId}`, {
    method: 'DELETE',
  })
}

/** GET the FAFSA lifecycle status (stage, label, next action, ordered stages). */
export async function getFafsaStatus(profileId) {
  assertRealProfileId(profileId, 'getFafsaStatus')
  return apiFetch(`/api/profiles/${profileId}/fafsa-status`)
}

/** Advance/correct the FAFSA stage. */
export async function setFafsaStatus(profileId, stage) {
  assertRealProfileId(profileId, 'setFafsaStatus')
  return apiFetch(`/api/profiles/${profileId}/fafsa-status`, {
    method: 'POST',
    body: JSON.stringify({ stage }),
  })
}

/** GET the FAFSA verification-document checklist. */
export async function getFafsaVerification(profileId) {
  assertRealProfileId(profileId, 'getFafsaVerification')
  return apiFetch(`/api/profiles/${profileId}/fafsa-verification`)
}

/** Toggle one verification document's done-state. */
export async function setFafsaVerificationDoc(profileId, key, done) {
  assertRealProfileId(profileId, 'setFafsaVerificationDoc')
  return apiFetch(`/api/profiles/${profileId}/fafsa-verification`, {
    method: 'POST',
    body: JSON.stringify({ key, done }),
  })
}
