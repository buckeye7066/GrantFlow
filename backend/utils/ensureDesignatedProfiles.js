import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import { DESIGNATED_PROFILES } from '../config/designatedProfiles.js'
import { safeParseJSON } from './safeJson.js'

function loadSectionsFromDataFile(dataFile) {
  if (!dataFile) return null
  try {
    const resolved = path.isAbsolute(dataFile) ? dataFile : path.resolve(process.cwd(), dataFile)
    if (!fs.existsSync(resolved)) return null
    const raw = fs.readFileSync(resolved, 'utf8')
    const parsed = safeParseJSON(raw, null)
    if (!parsed || typeof parsed !== 'object') return null
    const sections = parsed.sections ?? parsed.profile?.sections ?? null
    if (!sections || typeof sections !== 'object') return null
    return sections
  } catch (error) {
    console.warn('[ensureDesignatedProfiles] Failed to load data file:', dataFile, error?.message || error)
    return null
  }
}

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

    // CRITICAL: never wipe existing profile sections on boot.
    // Users/admin may have edited profiles; startup seeding must be additive/idempotent.
    const upsertSection = tx.prepare(`
      INSERT INTO profile_sections (id, profile_id, section_key, data, updated_by, updated_at)
      VALUES (?, ?, ?, ?, 'system-sync', CURRENT_TIMESTAMP)
      ON CONFLICT(profile_id, section_key) DO NOTHING
    `)

    for (const profile of DESIGNATED_PROFILES) {
      await upsertProfile.run({
        id: profile.id,
        display_name: profile.display_name,
        primary_type: profile.primary_type,
        status: profile.status ?? 'active',
        tags: JSON.stringify(profile.tags ?? []),
      })

      const seededSections = profile.sections ?? loadSectionsFromDataFile(profile.data_file)
      if (seededSections) {
        for (const [sectionKey, sectionData] of Object.entries(seededSections)) {
          await upsertSection.run(randomUUID(), profile.id, sectionKey, JSON.stringify(sectionData ?? {}))
        }
      }
    }
  })
}

export default ensureDesignatedProfiles
