import {
  PROFILE_SECTION_DEFAULTS,
  REQUIRED_PROFILE_SECTION_KEYS,
} from '../config/comprehensiveApplicationTemplate.js'
import { safeParseJSON } from '../utils/safeJson.js'

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function deepApplyDefaults(existing, defaults) {
  if (!isPlainObject(defaults)) return existing
  const base = isPlainObject(existing) ? { ...existing } : {}

  Object.entries(defaults).forEach(([key, defaultValue]) => {
    const currentValue = base[key]
    if (currentValue === undefined) {
      base[key] = defaultValue
      return
    }
    if (isPlainObject(currentValue) && isPlainObject(defaultValue)) {
      base[key] = deepApplyDefaults(currentValue, defaultValue)
    }
  })

  return base
}

export function ensureProfileHasRequiredSections(db, profileId) {
  if (!profileId) return { created: [], updated: [] }

  const existingRows = db
    .prepare(
      `
        SELECT section_key, data
        FROM profile_sections
        WHERE profile_id = ?
      `,
    )
    .all(profileId)

  const existingMap = new Map(
    existingRows.map((row) => [row.section_key, safeParseJSON(row.data, {})]),
  )

  const created = []
  const updated = []

  const insertStmt = db.prepare(
    `
      INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
      VALUES (?, ?, ?, ?)
    `,
  )

  const updateStmt = db.prepare(
    `
      UPDATE profile_sections
      SET data = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ?
      WHERE profile_id = ? AND section_key = ?
    `,
  )

  REQUIRED_PROFILE_SECTION_KEYS.forEach((sectionKey) => {
    const defaults = PROFILE_SECTION_DEFAULTS[sectionKey] ?? {}
    if (!existingMap.has(sectionKey)) {
      insertStmt.run(profileId, sectionKey, JSON.stringify(defaults), 'system_defaults')
      created.push(sectionKey)
      existingMap.set(sectionKey, defaults)
      return
    }

    // For parity-critical sections, ensure missing keys are present (non-destructive).
    if (sectionKey === 'comprehensive_application' || sectionKey === 'education') {
      const existing = existingMap.get(sectionKey)
      const merged = deepApplyDefaults(existing, defaults)
      const changed = JSON.stringify(existing) !== JSON.stringify(merged)
      if (changed) {
        updateStmt.run(JSON.stringify(merged), 'system_defaults', profileId, sectionKey)
        updated.push(sectionKey)
        existingMap.set(sectionKey, merged)
      }
    }
  })

  return { created, updated }
}

