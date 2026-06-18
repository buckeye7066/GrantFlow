// 097_backfill_basic_information_name_parts.mjs  (SQLite)
//
// "Parse, baby, parse." Backfill basic_information.first_name / last_name /
// middle_name from the existing full_name (or the profile's display_name)
// for every profile that has a name but no decomposed parts.
//
// Why: Hamilton's preflight (backend/services/hamilton/hamiltonPreflight.js)
// requires basic_information.first_name AND last_name. The profile editor only
// ever persisted `full_name`, so every profile flagged BOTH as "missing
// information" for every funding source — a wall of false blockers. This
// one-time backfill derives the parts so those blockers clear at the source.
//
// Idempotent: only writes when parts are missing and a first name can be
// derived; never clobbers human-entered values. Re-running is a no-op. The
// _migrations table also prevents normal re-runs.
//
// The Postgres twin lives at:
//   backend/db/postgres/migrations/0093_backfill_basic_information_name_parts.mjs

import { deriveNamePartsIntoBasicInfo } from '../../../shared/nameParsing.js'

export default async function up(db) {
  let updated = 0
  let created = 0

  // 1. Existing basic_information rows: derive missing parts in place.
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

  // 2. Profiles with a display_name but NO basic_information row at all:
  //    create one carrying the derived parts.
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

  console.log(`[097_backfill_name_parts] updated=${updated} created=${created}`)
}
