import { apiFetch } from '@/api/client'

/**
 * persistGapAnswers — shared persistence for Anya's gap-interview answers.
 *
 * The section PUT (PUT /api/profiles/:id/sections/:key) REPLACES the section's
 * data, so each update must first be merged into the section's current data or
 * the interview would wipe fields the user already filled in. This merge+PUT
 * logic originally lived inside ProfileGapGate's mutation; it is extracted here
 * so the profile-page gate (ProfileGapGate) and the global login launcher
 * (LoginGapInterviewLauncher) persist answers through the exact same path.
 *
 * @param {string} profileId
 * @param {Record<string, Record<string, unknown>>} sectionUpdates
 *   `{ sectionKey: { field: value } }` as produced by ProfileGapInterview.
 */
export async function persistGapAnswers(profileId, sectionUpdates) {
  // Merge into current section data (the PUT replaces the section), then save
  // each changed section.
  const current = await apiFetch(`/api/profiles/${profileId}/sections`).catch(() => [])
  const rows = Array.isArray(current) ? current : (current?.sections || [])
  const byKey = {}
  for (const s of rows) byKey[s.section_key] = s.data || {}
  const dropped = []
  for (const [sectionKey, fields] of Object.entries(sectionUpdates || {})) {
    const merged = { ...(byKey[sectionKey] || {}), ...fields }
    const response = await apiFetch(`/api/profiles/${profileId}/sections/${encodeURIComponent(sectionKey)}`, {
      method: 'PUT',
      body: JSON.stringify({ data: merged }),
    })
    // The PUT answers 200 even when the section guard DROPPED a field (it is
    // listed under `rejected`). An answer that never reached the row is a
    // failed save, not a success: the question would be re-asked at every
    // login (GeneMac, 2026-09-07 — education.is_student persisted as {}).
    // Items carrying `routedTo` were saved under a canonical alias, not lost.
    for (const item of Array.isArray(response?.rejected) ? response.rejected : []) {
      if (item?.routedTo) continue
      if (!Object.prototype.hasOwnProperty.call(fields, item?.key)) continue
      dropped.push(`${sectionKey}.${item.key} (${item.reason || 'rejected'})`)
    }
  }
  if (dropped.length > 0) {
    const error = new Error(`Your answer could not be saved: ${dropped.join(', ')}`)
    error.code = 'gap_answer_rejected'
    error.dropped = dropped
    throw error
  }
}
