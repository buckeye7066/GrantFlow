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

  // Read the answers BACK. An empty `rejected` only proves the section guard let
  // the field through — it says nothing about what the row ends up holding. The
  // same PUT then runs the field mirrors (backend/routes/profiles.js), which
  // re-derive the deprecated half of every mirrored pair, and on 2026-09-08 that
  // silently blanked the veteran answer to '' on the way out: a 200, no
  // rejection, and the same question asked again at the next login, forever.
  //
  // Verifying the stored value closes the whole class rather than one mechanism:
  // whatever erases an answer — a guard, a mirror, a trigger, something added
  // later — the user is told instead of being put back in the loop.
  const after = await apiFetch(`/api/profiles/${profileId}/sections`).catch(() => null)
  const afterRows = Array.isArray(after) ? after : (after?.sections || [])
  // Only claim an answer was lost when the read-back actually returned the
  // profile's sections. A failed or empty read means we could not verify, which
  // is not the same as evidence of loss — reporting it as loss would turn a
  // transient into a scary dead end.
  if (afterRows.length > 0) {
    const stored = {}
    for (const s of afterRows) stored[s.section_key] = s.data || {}
    const lost = []
    for (const [sectionKey, fields] of Object.entries(sectionUpdates || {})) {
      for (const [field, wrote] of Object.entries(fields)) {
        if (!answerLanded(stored[sectionKey]?.[field], wrote)) {
          lost.push(`${sectionKey}.${field}`)
        }
      }
    }
    if (lost.length > 0) {
      const error = new Error(
        `Your answer was not kept: ${lost.join(', ')}. It saved but did not stick, so it would be asked again — please report this.`,
      )
      error.code = 'gap_answer_not_persisted'
      error.dropped = lost
      throw error
    }
  }
}

/**
 * Did the value we wrote actually land? Deliberately permissive about shape,
 * strict about presence: the save path legitimately reshapes some values (long
 * text is merged sentence-wise by the section guard's dedupeLongText, numbers
 * round-trip as strings), but it must never come back empty or contradicted.
 */
function answerLanded(stored, wrote) {
  if (typeof wrote === 'boolean') return stored === wrote
  if (stored === null || stored === undefined) return false
  if (typeof wrote === 'number') return Number(stored) === wrote
  const want = String(wrote).trim()
  if (!want) return true
  const got = String(stored).trim()
  // Long text is spliced into whatever the user already had, so containment —
  // not equality — is the honest check.
  return got === want || got.includes(want)
}
