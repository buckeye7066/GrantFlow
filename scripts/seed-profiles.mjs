/**
 * Seeds the SQLite database with the baseline 11 GrantFlow profiles.
 *
 * By default this reads from `seed/baseline-profiles.json` and writes to
 * `backend/data/grantflow.db`. Override paths with the environment variables
 * `SEED_PATH` and `DB_PATH`, or via the `--seed <path>` CLI flag.
 *
 * Usage examples:
 *   node scripts/seed-profiles.mjs
 *   DB_PATH=/data/grantflow.db node scripts/seed-profiles.mjs --force
 *   node scripts/seed-profiles.mjs --seed ./tmp/profiles.json --dry-run
 *
 * Flags:
 *   --force / --reset  Delete existing profiles before seeding.
 *   --dry-run          Print the actions without mutating the database.
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const EXPECTED_PROFILE_COUNT = 11

function getArgValue(flag) {
  const index = process.argv.indexOf(flag)
  if (index === -1) return null
  return process.argv[index + 1] ?? null
}

function resolvePaths() {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)

  const dbPath = process.env.DB_PATH
    ? path.resolve(process.cwd(), process.env.DB_PATH)
    : path.resolve(__dirname, '../backend/data/grantflow.db')

  const seedArg = getArgValue('--seed')
  const seedPath = seedArg
    ? path.resolve(process.cwd(), seedArg)
    : process.env.SEED_PATH
    ? path.resolve(process.cwd(), process.env.SEED_PATH)
    : path.resolve(__dirname, '../seed/baseline-profiles.json')

  return { dbPath, seedPath }
}

function parseFlags() {
  const args = new Set(process.argv.slice(2))
  const force = args.has('--force') || args.has('--reset')
  const dryRun = args.has('--dry-run')
  return { force, dryRun }
}

function loadSeed(seedPath) {
  if (!fs.existsSync(seedPath)) {
    throw new Error(`Seed file not found at ${seedPath}`)
  }
  const raw = fs.readFileSync(seedPath, 'utf8')
  let payload
  try {
    payload = JSON.parse(raw)
  } catch (error) {
    throw new Error(`Unable to parse seed JSON: ${error.message}`)
  }

  if (!Array.isArray(payload.profiles) || payload.profiles.length === 0) {
    throw new Error('Seed file missing "profiles" array')
  }
  if (!Array.isArray(payload.sections)) {
    throw new Error('Seed file missing "sections" array')
  }

  return payload
}

function seedProfiles({ dbPath, seedPath, force, dryRun }) {
  const payload = loadSeed(seedPath)
  const profilesSummary = payload.profiles.map((profile) => profile.display_name)

  if (payload.profiles.length !== EXPECTED_PROFILE_COUNT) {
    console.warn(
      `[seed:profiles] Seed file contains ${payload.profiles.length} profile(s); expected ${EXPECTED_PROFILE_COUNT}.`,
    )
  }

  if (dryRun) {
    console.log('[seed:profiles] Dry run enabled. No changes will be written.')
  }

  let db
  try {
    db = new Database(dbPath)
  } catch (error) {
    throw new Error(`Unable to open database at ${dbPath}: ${error.message}`)
  }

  const existingCount = db.prepare('SELECT COUNT(*) AS count FROM profiles').get().count
  if (existingCount > 0 && !force) {
    if (dryRun) {
      console.log(
        `[seed:profiles] Database already contains ${existingCount} profile(s). Use --force to replace them.`,
      )
    } else {
      throw new Error(
        `Database already contains ${existingCount} profile(s). Use --force to replace them, or seed an empty database.`,
      )
    }
  }

  if (!dryRun) {
    const transaction = db.transaction(() => {
      db.exec('DELETE FROM profile_sections')
      db.exec('DELETE FROM profiles')

      const insertProfile = db.prepare(`
        INSERT INTO profiles (
          id,
          primary_type,
          display_name,
          status,
          tags,
          avatar_url,
          created_at,
          updated_at
        ) VALUES (
          @id,
          @primary_type,
          @display_name,
          @status,
          @tags,
          @avatar_url,
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        )
      `)

      const insertSection = db.prepare(`
        INSERT INTO profile_sections (
          profile_id,
          section_key,
          data,
          created_at,
          updated_at
        ) VALUES (
          @profile_id,
          @section_key,
          @data,
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        )
      `)

      payload.profiles.forEach((profile) => {
        insertProfile.run({
          id: profile.id,
          primary_type: profile.primary_type ?? null,
          display_name: profile.display_name,
          status: profile.status ?? 'active',
          tags: JSON.stringify(profile.tags ?? []),
          avatar_url: profile.avatar_url ?? null,
        })
      })

      payload.sections.forEach((section) => {
        insertSection.run({
          profile_id: section.profile_id,
          section_key: section.section_key,
          data: JSON.stringify(section.data ?? {}),
        })
      })
    })

    transaction()
  }

  const finalCount = db.prepare('SELECT COUNT(*) AS count FROM profiles').get().count
  db.close()

  console.log(`[seed:profiles] Seed file: ${seedPath}`)
  console.log(`[seed:profiles] Database: ${dbPath}`)
  console.log(`[seed:profiles] Profiles staged: ${profilesSummary.length}`)
  profilesSummary.forEach((name) => console.log(`  • ${name}`))
  console.log(
    `[seed:profiles] ${dryRun ? 'Dry run complete. No rows written.' : `Database now contains ${finalCount} profile(s).`}`,
  )
}

function main() {
  try {
    const paths = resolvePaths()
    const flags = parseFlags()
    seedProfiles({ ...paths, ...flags })
  } catch (error) {
    console.error('[seed:profiles] Failed:', error.message)
    process.exitCode = 1
  }
}

main()
