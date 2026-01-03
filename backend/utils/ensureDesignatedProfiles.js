import { randomUUID } from 'crypto'
import { DESIGNATED_PROFILES } from '../config/designatedProfiles.js'

export function ensureDesignatedProfiles(db) {
  const upsertProfile = db.prepare(`
    INSERT INTO profiles (id, display_name, primary_type, status, tags, updated_at)
    VALUES (@id, @display_name, @primary_type, @status, @tags, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      display_name = excluded.display_name,
      primary_type = excluded.primary_type,
      status = excluded.status,
      tags = excluded.tags,
      updated_at = CURRENT_TIMESTAMP
  `)

  const deleteSections = db.prepare(`DELETE FROM profile_sections WHERE profile_id = ?`)

  const insertSection = db.prepare(`
    INSERT INTO profile_sections (id, profile_id, section_key, data, updated_by)
    VALUES (?, ?, ?, ?, 'system-sync')
  `)

  const transaction = db.transaction(() => {
    for (const profile of DESIGNATED_PROFILES) {
      upsertProfile.run({
        id: profile.id,
        display_name: profile.display_name,
        primary_type: profile.primary_type,
        status: profile.status ?? 'active',
        tags: JSON.stringify(profile.tags ?? []),
      })

      deleteSections.run(profile.id)

      if (profile.sections) {
        for (const [sectionKey, sectionData] of Object.entries(profile.sections)) {
          insertSection.run(randomUUID(), profile.id, sectionKey, JSON.stringify(sectionData ?? {}))
        }
      }
    }
  })

  transaction()
}

export default ensureDesignatedProfiles
