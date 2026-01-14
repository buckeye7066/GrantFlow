import { randomUUID } from 'crypto'
import { DESIGNATED_PROFILES } from '../config/designatedProfiles.js'

export async function ensureDesignatedProfiles(db) {
  // Use a real transaction for both sqlite + postgres.
  await db.withTransaction(async (tx) => {
    const upsertProfile = tx.prepare(`
      INSERT INTO profiles (id, display_name, primary_type, status, tags, updated_at)
      VALUES (@id, @display_name, @primary_type, @status, @tags, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        primary_type = excluded.primary_type,
        status = excluded.status,
        tags = excluded.tags,
        updated_at = CURRENT_TIMESTAMP
    `)

    const deleteSections = tx.prepare(`DELETE FROM profile_sections WHERE profile_id = ?`)

    const insertSection = tx.prepare(`
      INSERT INTO profile_sections (id, profile_id, section_key, data, updated_by)
      VALUES (?, ?, ?, ?, 'system-sync')
    `)

    for (const profile of DESIGNATED_PROFILES) {
      await upsertProfile.run({
        id: profile.id,
        display_name: profile.display_name,
        primary_type: profile.primary_type,
        status: profile.status ?? 'active',
        tags: JSON.stringify(profile.tags ?? []),
      })

      await deleteSections.run(profile.id)

      if (profile.sections) {
        for (const [sectionKey, sectionData] of Object.entries(profile.sections)) {
          await insertSection.run(randomUUID(), profile.id, sectionKey, JSON.stringify(sectionData ?? {}))
        }
      }
    }
  })
}

export default ensureDesignatedProfiles
