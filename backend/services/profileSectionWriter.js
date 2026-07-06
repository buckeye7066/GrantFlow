/**
 * profileSectionWriter.js
 *
 * Shared "persist Anya interview answers into profile_sections" logic,
 * extracted from routes/onboarding.js's /complete handler so it can be
 * reused by both the original signup flow and the authenticated
 * re-interview flow (routes/onboardingReinterview.js) without duplicating
 * the json_patch / merge-fallback logic.
 */

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(String(value))
  } catch {
    return fallback
  }
}

function mergeSectionData(current, incoming) {
  if (!current || typeof current !== 'object') return incoming ?? {}
  if (!incoming || typeof incoming !== 'object') return current
  const result = { ...current }
  for (const [key, value] of Object.entries(incoming)) {
    if (Array.isArray(value)) {
      const existing = Array.isArray(current[key]) ? current[key] : []
      const merged = new Set([...existing, ...value])
      result[key] = Array.from(merged)
    } else if (value !== null && typeof value === 'object') {
      result[key] = mergeSectionData(current[key] ?? {}, value)
    } else if (value !== null && value !== undefined && value !== '') {
      result[key] = value
    }
  }
  return result
}

/**
 * Upsert every non-empty section the interview engine collected into
 * profile_sections for `profileId`. Merges into (never blindly overwrites)
 * whatever's already there, via json_patch where available, falling back to
 * a read-merge-write for older SQLite builds without json_patch.
 *
 * @param {object} db - request-scoped DB handle (req.db)
 * @param {string} profileId
 * @param {object} sections - { [sectionKey]: { ...answeredFields } }
 * @param {string} [updatedBy] - attribution written to profile_sections.updated_by
 */
export async function upsertProfileSections(db, profileId, sections, updatedBy = 'anya-onboarding') {
  const upsertSection = db.prepare(
    `INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(profile_id, section_key) DO UPDATE SET
         data = json_patch(profile_sections.data, excluded.data),
         updated_by = excluded.updated_by,
         updated_at = CURRENT_TIMESTAMP`,
  )

  for (const [sectionKey, sectionData] of Object.entries(sections ?? {})) {
    if (!sectionData || typeof sectionData !== 'object') continue
    // Skip sections that contain nothing the user actually answered.
    if (Object.keys(sectionData).length === 0) continue
    try {
      await upsertSection.run(profileId, sectionKey, JSON.stringify(sectionData), updatedBy)
    } catch (sectionErr) {
      // SQLite < 3.38 has no json_patch — fall back to a read-merge-write.
      try {
        const existing = await db
          .prepare(
            `SELECT data FROM profile_sections
               WHERE profile_id = ? AND section_key = ?`,
          )
          .get(profileId, sectionKey)
        const current = existing?.data ? parseJson(existing.data, {}) : {}
        const merged = mergeSectionData(current, sectionData)
        await db
          .prepare(
            `INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(profile_id, section_key) DO UPDATE SET
                 data = excluded.data,
                 updated_by = excluded.updated_by,
                 updated_at = CURRENT_TIMESTAMP`,
          )
          .run(profileId, sectionKey, JSON.stringify(merged), updatedBy)
      } catch (fallbackErr) {
        console.warn(
          '[profileSectionWriter] section persist fallback failed for',
          sectionKey,
          fallbackErr?.message ?? fallbackErr,
        )
      }
    }
  }
}
