#!/usr/bin/env node
/**
 * Quick sanity check for the production SQLite database.
 *
 * Verifies:
 *   - Required baseline profiles exist (by name)
 *   - Each profile has at least one entry for every canonical section
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
import { supportedSectionKeys as CANONICAL_SECTIONS } from '../backend/config/profileSchema.js'

const REQUIRED_PROFILE_MATCHERS = [
  { label: 'Axiom Community Health', test: (name) => /axiom\s+community\s+health/i.test(name) },
  { label: 'Bright Trails Youth', test: (name) => /bright\s+trails\s+youth/i.test(name) },
  { label: 'Riverbend Veteran Housing', test: (name) => /riverbend\s+veteran\s+housing/i.test(name) },
  { label: 'Harper Family Support', test: (name) => /harper\s+family\s+support/i.test(name) },
  { label: 'Northside Robotics', test: (name) => /northside\s+robotics/i.test(name) },
  { label: 'Demo Tennessee STEM Student', test: (name) => /demo\s+tennessee\s+stem\s+student/i.test(name) },
  { label: 'Summit Adaptive Sports', test: (name) => /summit\s+adaptive\s+sports/i.test(name) },
  { label: 'Oak Street Early Learning', test: (name) => /oak\s+street\s+early\s+learning/i.test(name) },
  { label: 'Sierra Tribal Artisans', test: (name) => /sierra\s+tribal\s+artisans/i.test(name) },
  { label: 'Greenline Food Cooperative', test: (name) => /greenline\s+food\s+cooperative/i.test(name) },
  { label: 'Lakeside Recovery', test: (name) => /lakeside\s+recovery/i.test(name) },
  { label: 'Mercy Table Church Pantry', test: (name) => /mercy\s+table\s+church\s+pantry/i.test(name) },
  { label: 'Rural EMS Training', test: (name) => /rural\s+ems\s+training/i.test(name) },
  { label: 'Community Caregiver Relief', test: (name) => /community\s+caregiver\s+relief/i.test(name) },
  { label: 'First Generation Nursing Student', test: (name) => /first\s+generation\s+nursing\s+student/i.test(name) },
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
  const names = profiles.map((p) => String(p.display_name || '').trim())
  const missingRequired = REQUIRED_PROFILE_MATCHERS
    .filter((m) => !names.some((n) => m.test(n)))
    .map((m) => m.label)
  if (missingRequired.length > 0) {
    console.warn(`[profiles] Missing required baseline profile(s): ${missingRequired.join(', ')}`)
    process.exitCode = 2
  } else {
    console.log('[profiles] All required baseline profiles are present.')
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
    const missing = CANONICAL_SECTIONS.filter((key) => !existingSections.has(key))
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
