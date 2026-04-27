#!/usr/bin/env node
import { db } from '../db/index.js'
import { safeParseJSON } from '../utils/safeJson.js'
import { guardProfileSectionPayload } from '../utils/profileSuggestionGuards.js'

async function ensureAuditTable() {
  if (db?.dialect === 'postgres') return
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS profile_section_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id TEXT NOT NULL,
      section_key TEXT NOT NULL,
      key TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      reason TEXT NOT NULL,
      repaired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run()
}

async function loadSections(profileId) {
  const rows = await db.prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?').all(profileId)
  return Object.fromEntries((rows || []).map((row) => [row.section_key, safeParseJSON(row.data, {})]))
}

async function main() {
  await ensureAuditTable()
  const rows = await db.prepare(`
    SELECT ps.profile_id, ps.section_key, ps.data, p.*
    FROM profile_sections ps
    LEFT JOIN profiles p ON p.id = ps.profile_id
  `).all()

  let updatedRows = 0
  let droppedFields = 0
  for (const row of rows || []) {
    const current = safeParseJSON(row.data, {})
    const sections = await loadSections(row.profile_id)
    const guarded = guardProfileSectionPayload(current, {
      profile: row,
      sections,
      sectionKey: row.section_key,
      existing: current,
    })
    const auditItems = guarded.rejected.filter((item) => ['unknown_field', 'format_mismatch'].includes(item.reason))
    if (auditItems.length === 0 && JSON.stringify(current) === JSON.stringify(guarded.data)) continue

    for (const item of auditItems) {
      await db.prepare(`
        INSERT INTO profile_section_audit (profile_id, section_key, key, old_value, new_value, reason)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(row.profile_id, row.section_key, item.key, JSON.stringify(current[item.key]), JSON.stringify(null), item.reason)
      droppedFields += 1
    }

    await db.prepare(`
      UPDATE profile_sections
      SET data = ?, updated_by = 'migrate-section-data-to-schema', updated_at = CURRENT_TIMESTAMP
      WHERE profile_id = ? AND section_key = ?
    `).run(JSON.stringify(guarded.data), row.profile_id, row.section_key)
    updatedRows += 1
  }

  console.log(JSON.stringify({ scanned: rows?.length ?? 0, updated_rows: updatedRows, dropped_fields: droppedFields }, null, 2))
  try {
    await db.close?.()
  } catch {
    // ignore
  }
}

main().catch((error) => {
  console.error('[migrate-section-data-to-schema]', error)
  process.exitCode = 1
})
