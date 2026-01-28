import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import { DESIGNATED_PROFILES } from '../config/designatedProfiles.js'
import { safeParseJSON } from './safeJson.js'

export const DESIGNATED_PROFILE_IDS = new Set(
  (Array.isArray(DESIGNATED_PROFILES) ? DESIGNATED_PROFILES : [])
    .map((p) => String(p?.id || '').trim())
    .filter(Boolean),
)

export function isDesignatedProfileId(id) {
  return DESIGNATED_PROFILE_IDS.has(String(id || '').trim())
}

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
    // Ensure tombstones exist (migration drift safety).
    const isPostgres = tx?.dialect === 'postgres'
    await tx.prepare(
      isPostgres
        ? `
          CREATE TABLE IF NOT EXISTS profile_tombstones (
            profile_id TEXT PRIMARY KEY,
            deleted_at TIMESTAMPTZ DEFAULT now(),
            deleted_by TEXT,
            reason TEXT
          )
        `
        : `
          CREATE TABLE IF NOT EXISTS profile_tombstones (
            profile_id TEXT PRIMARY KEY,
            deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            deleted_by TEXT,
            reason TEXT
          )
        `,
    ).run()

    let tombstoneRows = []
    try {
      tombstoneRows = await tx.prepare('SELECT profile_id FROM profile_tombstones').all()
    } catch {
      tombstoneRows = []
    }
    const tombstoned = new Set((tombstoneRows || []).map((r) => String(r?.profile_id || '').trim()).filter(Boolean))

    const upsertProfile = tx.prepare(`
      INSERT INTO profiles (id, display_name, primary_type, status, tags, updated_at)
      VALUES (@id, @display_name, @primary_type, @status, @tags, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        primary_type = excluded.primary_type,
        status = excluded.status,
        tags = excluded.tags,
        updated_at = CURRENT_TIMESTAMP
      -- Never resurrect profiles that a user/admin explicitly deleted.
      -- (Otherwise these "designated" profiles keep coming back after deletion.)
      WHERE profiles.status IS NULL OR profiles.status <> 'deleted'
    `)

    // CRITICAL: never wipe existing profile sections on boot.
    // Users/admin may have edited profiles; startup seeding must be additive/idempotent.
    const upsertSection = tx.prepare(`
      INSERT INTO profile_sections (id, profile_id, section_key, data, updated_by, updated_at)
      VALUES (?, ?, ?, ?, 'system-sync', CURRENT_TIMESTAMP)
      ON CONFLICT(profile_id, section_key) DO NOTHING
    `)

    for (const profile of DESIGNATED_PROFILES) {
      const profileId = String(profile?.id || '').trim()
      if (!profileId) continue
      if (tombstoned.has(profileId)) {
        // A profile was hard-deleted; never recreate it.
        console.warn('[ensureDesignatedProfiles] Skipping tombstoned profile', { profile_id: profileId })
        continue
      }

      await upsertProfile.run({
        id: profileId,
        display_name: profile.display_name,
        primary_type: profile.primary_type,
        status: profile.status ?? 'active',
        tags: JSON.stringify(profile.tags ?? []),
      })

      const seededSections = profile.sections ?? loadSectionsFromDataFile(profile.data_file)
      if (seededSections) {
        for (const [sectionKey, sectionData] of Object.entries(seededSections)) {
          await upsertSection.run(randomUUID(), profileId, sectionKey, JSON.stringify(sectionData ?? {}))
        }
      }
    }
  })
}

export default ensureDesignatedProfiles
