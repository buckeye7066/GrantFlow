import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import { DESIGNATED_PROFILES } from '../config/designatedProfiles.js'
import { safeParseJSON } from './safeJson.js'
import { attachDesignatedProfileOwner } from './profileOwnershipRepair.js'

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

function _seedProfilesSync(tx) {
  const createTombstones = tx.prepare(
    `CREATE TABLE IF NOT EXISTS profile_tombstones (
       profile_id TEXT PRIMARY KEY,
       deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
       deleted_by TEXT,
       reason TEXT
     )`,
  )
  createTombstones.run()

  let tombstoneRows = []
  try {
    tombstoneRows = tx.prepare('SELECT profile_id FROM profile_tombstones').all()
  } catch {
    tombstoneRows = []
  }
  const rows = Array.isArray(tombstoneRows) ? tombstoneRows : (tombstoneRows?.rows ?? [])
  const tombstoned = new Set(rows.map((r) => String(r?.profile_id || '').trim()).filter(Boolean))

  const upsertProfile = tx.prepare(`
    INSERT INTO profiles (id, display_name, primary_type, status, tags, updated_at)
    VALUES (@id, @display_name, @primary_type, @status, @tags, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      -- PRESERVE an admin/real display_name already in the DB (seed only sets it
      -- on first INSERT). This keeps real client names OUT of source control (the
      -- config carries generic placeholders) while letting the app show the real
      -- name — and stops the boot re-seed from reverting an admin rename.
      display_name = COALESCE(NULLIF(profiles.display_name, ''), excluded.display_name),
      primary_type = excluded.primary_type,
      status = excluded.status,
      tags = excluded.tags,
      updated_at = CURRENT_TIMESTAMP
    WHERE profiles.status IS NULL OR profiles.status <> 'deleted'
  `)

  const upsertSection = tx.prepare(`
    INSERT INTO profile_sections (id, profile_id, section_key, data, updated_by, updated_at)
    VALUES (?, ?, ?, ?, 'system-sync', CURRENT_TIMESTAMP)
    ON CONFLICT(profile_id, section_key) DO NOTHING
  `)

  for (const profile of DESIGNATED_PROFILES) {
    const profileId = String(profile?.id || '').trim()
    if (!profileId) continue
    if (tombstoned.has(profileId)) {
      console.warn('[ensureDesignatedProfiles] Skipping tombstoned profile', { profile_id: profileId })
      continue
    }

    upsertProfile.run({
      id: profileId,
      display_name: profile.display_name,
      primary_type: profile.primary_type,
      status: profile.status ?? 'active',
      tags: JSON.stringify(profile.tags ?? []),
    })

    const seededSections = profile.sections ?? loadSectionsFromDataFile(profile.data_file)
    if (seededSections) {
      for (const [sectionKey, sectionData] of Object.entries(seededSections)) {
        upsertSection.run(randomUUID(), profileId, sectionKey, JSON.stringify(sectionData ?? {}))
      }
    }
  }
}

async function _seedProfilesAsync(tx) {
  await tx.prepare(
    `CREATE TABLE IF NOT EXISTS profile_tombstones (
       profile_id TEXT PRIMARY KEY,
       deleted_at TIMESTAMPTZ DEFAULT now(),
       deleted_by TEXT,
       reason TEXT
     )`,
  ).run()

  let tombstoneRows = []
  try {
    tombstoneRows = await tx.prepare('SELECT profile_id FROM profile_tombstones').all()
  } catch {
    tombstoneRows = []
  }
  const rows = Array.isArray(tombstoneRows) ? tombstoneRows : (tombstoneRows?.rows ?? [])
  const tombstoned = new Set(rows.map((r) => String(r?.profile_id || '').trim()).filter(Boolean))

  for (const profile of DESIGNATED_PROFILES) {
    const profileId = String(profile?.id || '').trim()
    if (!profileId) continue
    if (tombstoned.has(profileId)) {
      console.warn('[ensureDesignatedProfiles] Skipping tombstoned profile', { profile_id: profileId })
      continue
    }

    await tx.prepare(`
      INSERT INTO profiles (id, display_name, primary_type, status, tags, updated_at)
      VALUES (@id, @display_name, @primary_type, @status, @tags, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        -- PRESERVE an admin/real display_name already in the DB (see sync path).
        -- Keeps real client names out of source control + un-reverts on re-seed.
        display_name = COALESCE(NULLIF(profiles.display_name, ''), excluded.display_name),
        primary_type = excluded.primary_type,
        status = excluded.status,
        tags = excluded.tags,
        updated_at = CURRENT_TIMESTAMP
      WHERE profiles.status IS NULL OR profiles.status <> 'deleted'
    `).run({
      id: profileId,
      display_name: profile.display_name,
      primary_type: profile.primary_type,
      status: profile.status ?? 'active',
      tags: JSON.stringify(profile.tags ?? []),
    })

    const seededSections = profile.sections ?? loadSectionsFromDataFile(profile.data_file)
    if (seededSections) {
      for (const [sectionKey, sectionData] of Object.entries(seededSections)) {
        await tx.prepare(`
          INSERT INTO profile_sections (id, profile_id, section_key, data, updated_by, updated_at)
          VALUES (?, ?, ?, ?, 'system-sync', CURRENT_TIMESTAMP)
          ON CONFLICT(profile_id, section_key) DO NOTHING
        `).run(randomUUID(), profileId, sectionKey, JSON.stringify(sectionData ?? {}))
      }
    }
  }
}

export async function ensureDesignatedProfiles(db) {
  const isPostgres = db?.dialect === 'postgres'
  if (isPostgres) {
    await db.withTransaction(async (tx) => {
      await _seedProfilesAsync(tx)
    })
  } else {
    db.withTransaction((tx) => {
      _seedProfilesSync(tx)
    })
  }

  for (const profile of DESIGNATED_PROFILES) {
    const profileId = String(profile?.id || '').trim()
    const ownerEmail = profile?.owner_email
    if (!profileId || !ownerEmail) continue
    try {
      await attachDesignatedProfileOwner(db, profileId, ownerEmail)
    } catch (e) {
      console.warn('[ensureDesignatedProfiles] attachDesignatedProfileOwner failed', profileId, e?.message || e)
    }
  }
}

export default ensureDesignatedProfiles
