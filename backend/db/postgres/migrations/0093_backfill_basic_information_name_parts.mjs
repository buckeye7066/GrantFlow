// 0093_backfill_basic_information_name_parts.mjs  (Postgres)
//
// Postgres twin of backend/db/migrations/097_backfill_basic_information_name_parts.mjs
//
// "Parse, baby, parse." Backfill basic_information.first_name / last_name /
// middle_name from the existing full_name (or the profile's display_name) for
// every profile that has a name but no decomposed parts, so Hamilton's
// preflight stops raising false "missing first/last name" blockers.
//
// Idempotent: only writes when parts are missing and a first name can be
// derived; never clobbers human-entered values.

import { deriveNamePartsIntoBasicInfo } from '../../../../shared/nameParsing.js'

export default async function up(db) {
  let updated = 0
  let created = 0

  let rows = []
  try {
    rows = await db
      .prepare(
        `SELECT ps.profile_id AS profile_id, ps.data AS data, p.display_name AS display_name
           FROM profile_sections ps
           JOIN profiles p ON p.id = ps.profile_id
          WHERE ps.section_key = 'basic_information'`,
      )
      .all()
  } catch {
    rows = []
  }

  const update = db.prepare(
    `UPDATE profile_sections
        SET data = ?, updated_by = 'name-parts-backfill'
      WHERE profile_id = ? AND section_key = 'basic_information'`,
  )

  for (const row of rows || []) {
    let data = {}
    try { data = typeof row.data === 'string' ? JSON.parse(row.data || '{}') : (row.data || {}) } catch { data = {} }
    const derived = deriveNamePartsIntoBasicInfo(data, row.display_name)
    if (derived.changed) {
      await update.run(JSON.stringify(derived.data), row.profile_id)
      updated += 1
    }
  }

  let orphans = []
  try {
    orphans = await db
      .prepare(
        `SELECT p.id AS id, p.display_name AS display_name
           FROM profiles p
          WHERE p.display_name IS NOT NULL
            AND TRIM(p.display_name) <> ''
            AND NOT EXISTS (
              SELECT 1 FROM profile_sections ps
               WHERE ps.profile_id = p.id AND ps.section_key = 'basic_information'
            )`,
      )
      .all()
  } catch {
    orphans = []
  }

  const insert = db.prepare(
    `INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
       VALUES (?, 'basic_information', ?, 'name-parts-backfill')
       ON CONFLICT(profile_id, section_key) DO NOTHING`,
  )

  for (const o of orphans || []) {
    const base = { full_name: String(o.display_name).trim().slice(0, 200) }
    const derived = deriveNamePartsIntoBasicInfo(base, o.display_name)
    if (derived.changed) {
      await insert.run(o.id, JSON.stringify(derived.data))
      created += 1
    }
  }

  console.log(`[0093_backfill_name_parts] updated=${updated} created=${created}`)
}
