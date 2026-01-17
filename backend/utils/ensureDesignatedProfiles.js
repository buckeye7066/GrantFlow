import { randomUUID } from 'crypto'
import fs from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import { DESIGNATED_PROFILES as FALLBACK_DESIGNATED_PROFILES } from '../config/designatedProfiles.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const repoRootDir = join(__dirname, '..', '..')

function safeJsonString(value, fallback = '[]') {
  if (value == null) return fallback
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return fallback
  }
}

function normalizeApplicantType(value) {
  const v = String(value || '').trim()
  if (!v) return 'other'
  const allowed = new Set([
    'individual_need',
    'family',
    'organization',
    'nonprofit',
    'small_business',
    'student',
    'college_student',
    'high_school_student',
    'medical_assistance',
    'government',
    'other',
  ])
  if (allowed.has(v)) return v
  if (v === 'individual') return 'individual_need'
  if (v === 'smallbusiness') return 'small_business'
  if (v === 'highschool_student') return 'high_school_student'
  if (v === 'collegestudent') return 'college_student'
  return 'other'
}

function loadBaselineSeed() {
  const seedPath = join(repoRootDir, 'seed', 'baseline-profiles.json')
  if (!fs.existsSync(seedPath)) return null
  try {
    const payload = JSON.parse(fs.readFileSync(seedPath, 'utf8'))
    const profiles = Array.isArray(payload?.profiles) ? payload.profiles : null
    const sections = Array.isArray(payload?.sections) ? payload.sections : null
    if (!profiles || !sections) return null
    return { profiles, sections }
  } catch {
    return null
  }
}

export async function ensureDesignatedProfiles(db) {
  const seed = loadBaselineSeed()
  if (seed) {
    // Source of truth: seed/baseline-profiles.json (keeps production and local consistent).
    // Use a real transaction for both sqlite + postgres.
    await db.withTransaction(async (tx) => {
      // Ensure referenced organizations exist (profiles.organization_id has an FK).
      const upsertOrg = tx.prepare(`
        INSERT INTO organizations (id, name, applicant_type, updated_at)
        VALUES (@id, @name, @applicant_type, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          applicant_type = excluded.applicant_type,
          updated_at = CURRENT_TIMESTAMP
      `)

      const upsertProfile = tx.prepare(`
        INSERT INTO profiles (id, primary_type, display_name, status, tags, avatar_url, organization_id, updated_at)
        VALUES (@id, @primary_type, @display_name, @status, @tags, @avatar_url, @organization_id, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          primary_type = excluded.primary_type,
          display_name = excluded.display_name,
          status = excluded.status,
          tags = excluded.tags,
          avatar_url = excluded.avatar_url,
          organization_id = excluded.organization_id,
          updated_at = CURRENT_TIMESTAMP
      `)

      const upsertSection = tx.prepare(`
        INSERT INTO profile_sections (id, profile_id, section_key, data, updated_by, updated_at)
        VALUES (?, ?, ?, ?, 'system-sync', CURRENT_TIMESTAMP)
        ON CONFLICT(profile_id, section_key) DO UPDATE SET
          data = excluded.data,
          updated_by = excluded.updated_by,
          updated_at = CURRENT_TIMESTAMP
      `)

      for (const profile of seed.profiles) {
        if (profile.organization_id) {
          await upsertOrg.run({
            id: profile.organization_id,
            name: profile.display_name ?? profile.name ?? 'Organization',
            applicant_type: normalizeApplicantType(profile.primary_type),
          })
        }
        await upsertProfile.run({
          id: profile.id,
          primary_type: profile.primary_type ?? null,
          display_name: profile.display_name ?? profile.name ?? 'Profile',
          status: profile.status ?? 'active',
          tags: safeJsonString(profile.tags, '[]'),
          avatar_url: profile.avatar_url ?? null,
          organization_id: profile.organization_id ?? null,
        })
      }

      for (const section of seed.sections) {
        if (!section?.profile_id || !section?.section_key) continue
        const data =
          typeof section.data === 'string' ? section.data : safeJsonString(section.data, '{}')
        await upsertSection.run(randomUUID(), section.profile_id, section.section_key, data)
      }
    })

    return
  }

  // Fallback: hardcoded designated profiles (legacy)
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

    for (const profile of FALLBACK_DESIGNATED_PROFILES) {
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
