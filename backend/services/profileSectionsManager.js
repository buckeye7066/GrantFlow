import { SECTION_PROMPTS, supportedSectionKeys } from '../prompts/profileSections.js'
import { safeParseJSON } from '../utils/safeJson.js'

const insertSectionStmt = (db) => {
  const sql =
    db?.dialect === 'postgres'
      ? `
          INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
          VALUES (?, ?, ?, ?)
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
    `
    UPDATE profile_sections
    SET data = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
    `,
  )

const selectSectionsStmt = (db) =>
  db.prepare(
    `
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
  for (const sectionKey of supportedSectionKeys) {
    await insert.run(profileId, sectionKey, JSON.stringify({}), updatedBy)
  }
}

export function normalizeSectionData(data, sectionKey) {
  const config = SECTION_PROMPTS[sectionKey]
  if (!config) return data
  const normalized = { ...data }
  for (const key of config.keys) {
    if (!Object.prototype.hasOwnProperty.call(normalized, key)) {
      normalized[key] = null
    }
  }
  return normalized
}

export async function repairProfileSections(db, profileId, updatedBy = 'system-repair') {
  const rowsBefore = await selectSectionsStmt(db).all(profileId)
  const existingKeys = new Set(rowsBefore.map((row) => row.section_key))
  const missingSections = supportedSectionKeys.filter((key) => !existingKeys.has(key))
  await ensureProfileSections(db, profileId, updatedBy)
  const rows = await selectSectionsStmt(db).all(profileId)
  const updateStmt = updateSectionStmt(db)
  const updatedSections = []

  for (const row of rows) {
    const parsed = safeParseJSON(row.data, {})
    const normalized = normalizeSectionData(parsed, row.section_key)
    const normalizedStr = JSON.stringify(normalized)
    if (normalizedStr !== row.data) {
      await updateStmt.run(normalizedStr, updatedBy, row.id)
      updatedSections.push(row.section_key)
    }
  }

  return {
    missing_sections: missingSections,
    repaired_sections: updatedSections,
    total_sections: rows.length,
  }
}

export function calculateProfileCompleteness(db, profileId) {
  const rows = selectSectionsStmt(db).all(profileId)
  const sectionMap = new Map(
    rows.map((row) => [row.section_key, safeParseJSON(row.data, {})]),
  )

  const missingSections = supportedSectionKeys.filter(
    (key) => !sectionMap.has(key),
  )

  let totalKeys = 0
  let presentKeys = 0
  const missingKeys = []

  for (const sectionKey of supportedSectionKeys) {
    const config = SECTION_PROMPTS[sectionKey]
    if (!config) continue
    const keys = config.keys ?? []
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

