/**
 * profileFieldWriter.js
 *
 * Write a SINGLE field back into its profile_sections row — the server-side
 * twin of what the ProfileSectionEditor modal does, but for one field at a
 * time. This powers inline hard-stop remediation: when Hamilton stops because
 * (say) `first_name` is missing, the operator types the value right in the
 * hard-stop banner and it lands back in `basic_information.first_name`, exactly
 * where it was missing to begin with.
 *
 * It deliberately reuses the same guard + name-derivation + profiles-table sync
 * as PUT /api/profiles/:id/sections/:sectionKey so an inline fix is
 * indistinguishable from a full section save:
 *   - guardProfileSectionForWrite() rejects fields that don't belong to the
 *     section (so we never write junk),
 *   - deriveNamePartsIntoBasicInfo() keeps first/last/full name consistent,
 *   - syncProfileFieldsFromSection() mirrors key fields onto the profiles table.
 */

import { safeParseJSON } from '../utils/safeJson.js'
import { guardProfileSectionForWrite } from '../utils/guardedProfileSectionWrite.js'
import { syncProfileFieldsFromSection } from '../utils/profileSectionSync.js'
import { deriveNamePartsIntoBasicInfo } from '../../shared/nameParsing.js'

/**
 * Set one field on one profile section.
 *
 * @returns {Promise<{ ok: boolean, accepted: boolean, sectionKey: string,
 *   field: string, saved: object, rejected: Array }>}
 * @throws if the field is rejected by the section guard (caller surfaces a 422).
 */
export async function setProfileSectionField(db, {
  profileId,
  sectionKey,
  field,
  value,
  updatedBy = null,
} = {}) {
  if (!db) throw new Error('db required')
  if (!profileId) throw new Error('profileId required')
  if (!sectionKey) throw new Error('sectionKey required')
  if (!field) throw new Error('field required')

  // Load the current section so we merge rather than clobber sibling fields.
  let existing = {}
  try {
    const row = await db
      .prepare('SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = ? LIMIT 1')
      .get(profileId, sectionKey)
    if (row?.data) existing = typeof row.data === 'object' ? row.data : safeParseJSON(row.data, {})
  } catch {
    existing = {}
  }

  let merged = { ...existing, [field]: value }

  // Keep first/last/full name aligned the same way the section editor does.
  if (sectionKey === 'basic_information') {
    merged = deriveNamePartsIntoBasicInfo(merged).data
  }

  const guarded = await guardProfileSectionForWrite(db, profileId, sectionKey, merged)
  const guardedData = guarded.data

  // If the very field we tried to set was rejected by the guard, don't pretend
  // success — the caller turns this into a 422 so the UI shows a real error
  // instead of silently dropping the value.
  const fieldRejected = (guarded.rejected || []).some((r) => r.key === field)
  if (fieldRejected) {
    const reason = (guarded.rejected.find((r) => r.key === field) || {}).reason || 'unsupported_field'
    const err = new Error(`Field "${field}" is not accepted by section "${sectionKey}" (${reason}).`)
    err.code = 'field_rejected'
    err.rejected = guarded.rejected
    throw err
  }

  await db.prepare(
    `INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(profile_id, section_key) DO UPDATE SET
         data = excluded.data,
         updated_by = excluded.updated_by,
         updated_at = CURRENT_TIMESTAMP`,
  ).run(profileId, sectionKey, JSON.stringify(guardedData), updatedBy)

  // Mirror synced fields (display_name, state, zip, …) onto the profiles table.
  try {
    syncProfileFieldsFromSection(db, profileId, sectionKey, guardedData)
  } catch {
    // Non-fatal — the section is the source of truth; the mirror is a convenience.
  }

  return {
    ok: true,
    accepted: true,
    sectionKey,
    field,
    saved: guardedData,
    rejected: guarded.rejected || [],
  }
}

export default { setProfileSectionField }
