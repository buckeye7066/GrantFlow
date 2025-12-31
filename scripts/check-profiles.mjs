#!/usr/bin/env node
/**
 * Quick sanity check for the production SQLite database.
 *
 * Verifies:
 *   - Exactly 11 active profiles exist
 *   - Each profile has at least one entry for every expected section
 *   - Outputs a concise report highlighting missing data, if any
 *
 * Usage:
 *   DB_PATH=/path/to/grantflow.db node scripts/check-profiles.mjs
 *
 * The default DB path assumes the local development layout. For Railway,
 * mount the persistent volume, download the database locally, or run this
 * script in a `railway run` shell with `DB_PATH=/data/grantflow.db`.
 */

import Database from 'better-sqlite3'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const EXPECTED_PROFILE_COUNT = 11
const EXPECTED_SECTIONS = [
  'basic_information',
  'organization_details',
  'financial_information',
  'government_assistance',
  'health_medical',
  'demographics',
  'family_life',
  'military_service',
  'occupation',
  'location_focus',
  'narrative',
  'university_applications',
]

function main() {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  const resolvedDbPath = process.env.DB_PATH
    ? path.resolve(process.cwd(), process.env.DB_PATH)
    : path.resolve(__dirname, '../backend/data/grantflow.db')

  let db
  try {
    db = new Database(resolvedDbPath, { readonly: true })
  } catch (error) {
    console.error(`[profiles] Unable to open database at ${resolvedDbPath}:`, error.message)
    process.exitCode = 1
    return
  }

  const profiles = db
    .prepare(
      `
        SELECT id, display_name, status
        FROM profiles
        ORDER BY created_at ASC
      `,
    )
    .all()

  console.log(`Found ${profiles.length} profile(s) in ${resolvedDbPath}`)
  if (profiles.length !== EXPECTED_PROFILE_COUNT) {
    console.warn(
      `[profiles] Expected ${EXPECTED_PROFILE_COUNT} records. Found ${profiles.length}. Verify migration zip / seeds.`,
    )
  }

  const sectionStmt = db.prepare(
    `
      SELECT section_key
      FROM profile_sections
      WHERE profile_id = ?
    `,
  )

  const rows = []
  profiles.forEach((profile) => {
    const existingSections = new Set(sectionStmt.all(profile.id).map((row) => row.section_key))
    const missing = EXPECTED_SECTIONS.filter((key) => !existingSections.has(key))
    rows.push({
      id: profile.id,
      name: profile.display_name,
      status: profile.status,
      missingSections: missing,
    })
  })

  const failures = rows.filter((row) => row.missingSections.length > 0)
  if (failures.length > 0) {
    console.warn('[profiles] Some profiles are missing required sections:')
    failures.forEach((row) => {
      console.warn(
        `  • ${row.name} (${row.id}) missing ${row.missingSections.length} section(s): ${row.missingSections.join(', ')}`,
      )
    })
    process.exitCode = 2
  } else {
    console.log('[profiles] All profiles contain the expected sections.')
  }

  db.close()
}

main()
