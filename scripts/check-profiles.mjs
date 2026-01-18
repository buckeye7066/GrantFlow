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
  { label: 'John', test: (name) => /john\s+white/i.test(name) },
  { label: 'Robert', test: (name) => /robert\s+white/i.test(name) },
  { label: 'Anastasia', test: (name) => /anastasia/i.test(name) },
  { label: 'Luibov', test: (name) => /luibov/i.test(name) },
  { label: 'Focus Forward', test: (name) => /focus\s+forward/i.test(name) },
  { label: 'Axiom Biolabs', test: (name) => /axiom\s+biolabs/i.test(name) },
  { label: 'Brian', test: (name) => /brian/i.test(name) },
  { label: 'Hollie', test: (name) => /hollie/i.test(name) },
  { label: 'Olivia', test: (name) => /olivia/i.test(name) },
  { label: 'Avanell', test: (name) => /avanell/i.test(name) },
  { label: 'Angelika', test: (name) => /angelika/i.test(name) },
  { label: 'Rachel', test: (name) => /rachel/i.test(name) },
  { label: 'Josh', test: (name) => /\bjosh\b/i.test(name) },
  { label: 'Jason', test: (name) => /jason/i.test(name) },
  { label: 'Kathy', test: (name) => /kathy/i.test(name) },
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
