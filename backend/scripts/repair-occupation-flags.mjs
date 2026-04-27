#!/usr/bin/env node
import { db } from '../db/index.js'
import { safeParseJSON } from '../utils/safeJson.js'
import { guardProfileSectionPayload, OCCUPATION_FLAGS } from '../utils/profileSuggestionGuards.js'

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

async function insertAudit({ profileId, key, oldValue, reason }) {
  await db.prepare(`
    INSERT INTO profile_section_audit (profile_id, section_key, key, old_value, new_value, reason)
    VALUES (?, 'occupation', ?, ?, ?, ?)
  `).run(profileId, key, JSON.stringify(oldValue), JSON.stringify(null), reason)
}

async function main() {
  await ensureAuditTable()

  const rows = await db.prepare(`
    SELECT ps.profile_id, ps.data, p.*
    FROM profile_sections ps
    LEFT JOIN profiles p ON p.id = ps.profile_id
    WHERE ps.section_key = 'occupation'
  `).all()

  let repairedProfiles = 0
  let repairedFields = 0

  for (const row of rows || []) {
    const profileId = row.profile_id
    const data = safeParseJSON(row.data, {})
    const sections = await loadSections(profileId)
    const guarded = guardProfileSectionPayload({ ...data }, {
      profile: row,
      sections,
      sectionKey: 'occupation',
      existing: data,
    })

    const rejectedFlags = guarded.rejected.filter((item) =>
      item.reason === 'missing_employer_evidence' && OCCUPATION_FLAGS.has(item.key) && data[item.key] === true,
    )
    if (rejectedFlags.length === 0) continue

    const repaired = { ...data }
    for (const item of rejectedFlags) {
      repaired[item.key] = null
      await insertAudit({
        profileId,
        key: item.key,
        oldValue: data[item.key],
        reason: item.reason,
      })
      repairedFields += 1
    }

    await db.prepare(`
      UPDATE profile_sections
      SET data = ?, updated_by = 'repair-occupation-flags', updated_at = CURRENT_TIMESTAMP
      WHERE profile_id = ? AND section_key = 'occupation'
    `).run(JSON.stringify(repaired), profileId)
    repairedProfiles += 1
  }

  console.log(JSON.stringify({ scanned: rows?.length ?? 0, repaired_profiles: repairedProfiles, repaired_fields: repairedFields }, null, 2))

  try {
    await db.close?.()
  } catch {
    // ignore
  }
}

main().catch((error) => {
  console.error('[repair-occupation-flags]', error)
  process.exitCode = 1
})
