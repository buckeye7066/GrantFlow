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

    // Non-destructive section upsert: never delete existing user-entered sections.
    const upsertSection = tx.prepare(`
      INSERT INTO profile_sections (id, profile_id, section_key, data, updated_by, updated_at)
      VALUES (?, ?, ?, ?, 'system-sync', CURRENT_TIMESTAMP)
      ON CONFLICT(profile_id, section_key) DO UPDATE SET
        data = excluded.data,
        updated_by = 'system-sync',
        updated_at = CURRENT_TIMESTAMP
    `)

    for (const profile of DESIGNATED_PROFILES) {
      await upsertProfile.run({
        id: profile.id,
        display_name: profile.display_name,
        primary_type: profile.primary_type,
        status: profile.status ?? 'active',
        tags: JSON.stringify(profile.tags ?? []),
      })

      if (profile.sections) {
        for (const [sectionKey, sectionData] of Object.entries(profile.sections)) {
          await upsertSection.run(randomUUID(), profile.id, sectionKey, JSON.stringify(sectionData ?? {}))
        }
      }
    }
  })
}

export default ensureDesignatedProfiles
