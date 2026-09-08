/**
 * profileFieldMirrors.js (backend) — persist the mirror rules from
 * shared/profileFieldMirrors.js for one profile.
 *
 * Called after every section save (PUT /:id/sections/:key and
 * setProfileSectionField) and by the boot invariant
 * `profile_field_mirror_backfill` for every live profile (with
 * `seedCanonical`, so an answer that only exists in a now-hidden legacy field
 * is copied into the canonical field the user can still see and edit).
 *
 * Writes touch ONLY the sections a rule changes, merge into the stored row
 * (never replace it), and go through the same profile_sections upsert the
 * routes use. Returns what changed so callers can log/re-sync.
 */
import { deriveProfileFieldMirrors } from '../../shared/profileFieldMirrors.js'
import { syncProfileFieldsFromSection } from '../utils/profileSectionSync.js'

function parseSectionData(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export async function loadProfileSections(db, profileId) {
  // audit:allow unscoped-profile-query -- keyed by profile_id; callers have already authorized the profile.
  const rows = await db
    .prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?')
    .all(String(profileId))
  const sections = {}
  for (const row of rows || []) {
    if (!row?.section_key) continue
    sections[row.section_key] = parseSectionData(row.data)
  }
  return sections
}

/**
 * @returns {Promise<{ changed: Array<{section:string, fields:string[]}>, applied: Array<object> }>}
 */
export async function applyProfileFieldMirrors(db, profileId, { seedCanonical = false, updatedBy = null, sections = null } = {}) {
  if (!db || !profileId) return { changed: [], applied: [] }
  const current = sections && typeof sections === 'object' ? sections : await loadProfileSections(db, profileId)
  const { patches, applied } = deriveProfileFieldMirrors(current, { seedCanonical })
  const changed = []
  const upsert = db.prepare(
    `INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(profile_id, section_key) DO UPDATE SET
       data = excluded.data,
       updated_by = excluded.updated_by,
       updated_at = CURRENT_TIMESTAMP`,
  )
  for (const [sectionKey, patch] of Object.entries(patches)) {
    const merged = { ...(current[sectionKey] || {}), ...patch }
    await upsert.run(String(profileId), sectionKey, JSON.stringify(merged), updatedBy ?? 'profile_field_mirrors')
    current[sectionKey] = merged
    changed.push({ section: sectionKey, fields: Object.keys(patch) })
    try {
      // Keep the profiles-table shortcuts (state, zip, veteran, disability, …) in step.
      await syncProfileFieldsFromSection(db, profileId, sectionKey, merged)
    } catch {
      /* best effort; the section row itself is the source of truth */
    }
  }
  return { changed, applied }
}

export default { applyProfileFieldMirrors, loadProfileSections }
