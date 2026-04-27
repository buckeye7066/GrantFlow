import {
  SECTION_PROMPTS,
  supportedSectionKeys,
  canonicalSectionKeys,
  CANONICAL_SECTION_DEFAULTS,
} from '../prompts/profileSections.js'
import { safeParseJSON } from '../utils/safeJson.js'
import { guardProfileSectionForWrite } from '../utils/guardedProfileSectionWrite.js'

const insertSectionStmt = (db) => {
  const sql =
    db?.dialect === 'postgres'
      ? `
          INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (profile_id, section_key) DO NOTHING
        `
      : `
          INSERT OR IGNORE INTO profile_sections (profile_id, section_key, data, updated_by)
          VALUES (?, ?, ?, ?)
        `
  return db.prepare(sql)
}

const updateSectionStmt = (db) =>
  db.prepare(
    db?.dialect === 'postgres'
      ? `
          UPDATE profile_sections
          SET data = $1, updated_by = $2, updated_at = CURRENT_TIMESTAMP
          WHERE id = $3
        `
      : `
          UPDATE profile_sections
          SET data = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `,
  )

const selectSectionsStmt = (db) =>
  db.prepare(
    db?.dialect === 'postgres'
      ? `
          SELECT id, section_key, data
          FROM profile_sections
          WHERE profile_id = $1
          ORDER BY section_key
        `
      : `
          SELECT id, section_key, data
          FROM profile_sections
          WHERE profile_id = ?
          ORDER BY section_key
        `,
  )

function hasValue(value) {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

export async function ensureProfileSections(db, profileId, updatedBy = 'system') {
  const insert = insertSectionStmt(db)
  for (const sectionKey of canonicalSectionKeys) {
    const defaults = CANONICAL_SECTION_DEFAULTS[sectionKey] ?? {}
    if (db?.dialect === 'postgres') {
      await insert.run([profileId, sectionKey, JSON.stringify(defaults), updatedBy])
    } else {
      await insert.run(profileId, sectionKey, JSON.stringify(defaults), updatedBy)
    }
  }
}

export function normalizeSectionData(data, sectionKey) {
  const defaults = CANONICAL_SECTION_DEFAULTS[sectionKey]
  if (!defaults) return data
  // Shallow merge is intentional: canonical defaults define the key set.
  return { ...defaults, ...(data && typeof data === 'object' ? data : {}) }
}

export async function repairProfileSections(db, profileId, updatedBy = 'system-repair') {
  const selectStmt = selectSectionsStmt(db)
  const rowsBefore = db?.dialect === 'postgres' ? await selectStmt.all([profileId]) : await selectStmt.all(profileId)
  const existingKeys = new Set(rowsBefore.map((row) => row.section_key))
  const missingSections = canonicalSectionKeys.filter((key) => !existingKeys.has(key))
  await ensureProfileSections(db, profileId, updatedBy)
  const rows = db?.dialect === 'postgres' ? await selectStmt.all([profileId]) : await selectStmt.all(profileId)
  const updateStmt = updateSectionStmt(db)
  const updatedSections = []

  for (const row of rows) {
    const parsed = safeParseJSON(row.data, {})
    const normalized = normalizeSectionData(parsed, row.section_key)
    const guarded = await guardProfileSectionForWrite(db, profileId, row.section_key, normalized)
    const normalizedStr = JSON.stringify(guarded.data)
    if (normalizedStr !== row.data) {
      if (db?.dialect === 'postgres') {
        await updateStmt.run([normalizedStr, updatedBy, row.id])
      } else {
        await updateStmt.run(normalizedStr, updatedBy, row.id)
      }
      updatedSections.push(row.section_key)
    }
  }

  return {
    missing_sections: missingSections,
    repaired_sections: updatedSections,
    total_sections: rows.length,
  }
}

export async function calculateProfileCompleteness(db, profileId) {
  const selectStmt = selectSectionsStmt(db)
  const rows = db?.dialect === 'postgres' ? await selectStmt.all([profileId]) : await selectStmt.all(profileId)
  const sectionMap = new Map(
    rows.map((row) => [row.section_key, safeParseJSON(row.data, {})]),
  )

  const missingSections = canonicalSectionKeys.filter(
    (key) => !sectionMap.has(key),
  )

  let totalKeys = 0
  let presentKeys = 0
  const missingKeys = []

  for (const sectionKey of canonicalSectionKeys) {
    const defaults = CANONICAL_SECTION_DEFAULTS[sectionKey]
    const keys = defaults ? Object.keys(defaults) : []
    totalKeys += keys.length
    const data = sectionMap.get(sectionKey) ?? {}
    const missingForSection = []

    for (const key of keys) {
      if (hasValue(data[key])) {
        presentKeys += 1
      } else {
        missingForSection.push(key)
      }
    }

    if (missingForSection.length > 0) {
      missingKeys.push({
        section_key: sectionKey,
        missing_keys: missingForSection,
      })
    }
  }

  const percent_complete =
    totalKeys === 0 ? 0 : Math.round((presentKeys / totalKeys) * 100)

  return {
    total_keys: totalKeys,
    present_keys: presentKeys,
    percent_complete,
    missing_sections: missingSections,
    missing_keys: missingKeys,
  }
}

