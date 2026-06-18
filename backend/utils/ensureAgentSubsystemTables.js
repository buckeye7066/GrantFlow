/**
 * Boot-time self-heal for the GrantFlow agent telemetry / control center
 * subsystem.
 *
 * The Agent Mission Control + Agent Control Center pages probe
 * `tableExists(...)` for every per-agent table (sam_runs, robert_runs,
 * hamilton_runs, john_runs, yana_lead_candidates, agent_activity_events,
 * agent_control_runs, …) and render an "Agent Not installed" empty state
 * when those tables are missing. That happens whenever a deploy boots
 * before the corresponding migrations have been applied — historically
 * possible when `MIGRATE_ON_BOOT` was opt-in.
 *
 * Mission goal (#1, #6, #9): GrantFlow must show real data, never a
 * misleading "not installed" empty state when in fact the agents are
 * fully wired. So we apply the agent-subsystem migrations inline at boot,
 * UNCONDITIONALLY (regardless of `MIGRATE_ON_BOOT` / `SMOKE_MODE`),
 * because:
 *   - every file is pure DDL with IF NOT EXISTS / IF EXISTS guards (safe
 *     to re-apply on a populated DB),
 *   - every file is also covered in `schema.sql` for fresh SQLite
 *     fixtures, so applying a second time is a true no-op,
 *   - applied files are then stamped into `_migrations` so the regular
 *     migration runner skips them next time.
 *
 * Per-file try/catch ensures one bad file (e.g. transient lock, dialect
 * skew) doesn't block the rest. We log a warning and keep going so the
 * server still comes up — Mission Control will just show whatever subset
 * of agents actually has tables.
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const POSTGRES_DIR = path.join(__dirname, '..', 'db', 'postgres', 'migrations')
const SQLITE_DIR = path.join(__dirname, '..', 'db', 'migrations')

// Files to apply, ordered. ALTER TABLE IF EXISTS … RENAME TO statements in
// the rename migration depend on the yana_* tables being present (or not),
// but the rename migration is also written to be a no-op when neither side
// is present, so order is what migrations would naturally have.
const POSTGRES_FILES = [
  '0076_sam_runs.sql',
  '0077_robert_tables.sql',
  '0079_john_tables.sql',
  '0080_agent_telemetry.sql',
  '0081_yana_student_portals_and_application_tasks.sql',
  '0083_yana_automation_tasks.sql',
  '0084_yana_authorizations.sql',
  '0085_yana_hard_stop_resolution.sql',
  '0086_rename_yana_to_hamilton.sql',
  '0087_agent_control_center.sql',
  '0089_yana_lead_discovery.sql',
]

const SQLITE_FILES = [
  '080_sam_runs.sql',
  '081_robert_tables.sql',
  '083_john_tables.sql',
  '084_agent_telemetry.sql',
  '085_yana_student_portals_and_application_tasks.sql',
  '087_yana_automation_tasks.sql',
  '088_yana_authorizations.sql',
  '089_yana_hard_stop_resolution.sql',
  '090_rename_yana_to_hamilton.sql',
  '091_agent_control_center.sql',
  '093_yana_lead_discovery.sql',
]

function isAlreadyAppliedError(err) {
  const msg = String(err?.message || err || '').toLowerCase()
  if (msg.includes('duplicate column name')) return true
  if (msg.includes('already exists')) return true
  if (msg.includes('duplicate index')) return true
  if (msg.includes('there is already another table or index with this name')) return true
  return false
}

async function ensureMigrationsTable(db) {
  if (db.dialect === 'postgres') {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ DEFAULT now()
      );
    `)
    return
  }
  await db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)
}

async function isMigrationApplied(db, filename) {
  try {
    const row = await db.prepare('SELECT 1 AS hit FROM _migrations WHERE name = ?').get(filename)
    return Boolean(row?.hit)
  } catch {
    return false
  }
}

async function recordMigrationApplied(db, filename) {
  try {
    await db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(filename)
  } catch (err) {
    const msg = String(err?.message || err || '').toLowerCase()
    if (msg.includes('unique') || msg.includes('duplicate')) return
    throw err
  }
}

/**
 * Apply the agent-subsystem migrations idempotently. Returns a summary so
 * callers (and tests) can see what happened.
 *
 * @param {object} db - the live DB handle (sqlite or postgres dialect)
 * @param {object} [opts]
 * @param {object} [opts.logger] - logger with .info/.warn/.error
 * @returns {Promise<{ applied: string[], skipped: string[], failed: Array<{ filename: string, error: string }> }>}
 */
export async function ensureAgentSubsystemTables(db, { logger = console } = {}) {
  const out = { applied: [], skipped: [], failed: [] }
  if (!db || typeof db.dialect !== 'string') {
    logger.warn?.('[agent-subsystem] no db handle, skipping')
    return out
  }

  const dir = db.dialect === 'postgres' ? POSTGRES_DIR : SQLITE_DIR
  const files = db.dialect === 'postgres' ? POSTGRES_FILES : SQLITE_FILES

  try {
    await ensureMigrationsTable(db)
  } catch (err) {
    logger.warn?.(
      `[agent-subsystem] could not ensure _migrations table: ${err?.message || err}`,
    )
  }

  for (const filename of files) {
    const fullPath = path.join(dir, filename)
    if (!fs.existsSync(fullPath)) {
      out.skipped.push(filename)
      continue
    }

    let already = false
    try {
      already = await isMigrationApplied(db, filename)
    } catch {
      already = false
    }
    if (already) {
      out.skipped.push(filename)
      continue
    }

    let sql
    try {
      sql = fs.readFileSync(fullPath, 'utf8')
    } catch (readErr) {
      out.failed.push({ filename, error: String(readErr?.message || readErr) })
      logger.warn?.(`[agent-subsystem] could not read ${filename}: ${readErr?.message || readErr}`)
      continue
    }

    try {
      await db.exec(sql)
      await recordMigrationApplied(db, filename)
      out.applied.push(filename)
      logger.info?.(`[agent-subsystem] applied ${filename}`)
    } catch (err) {
      if (isAlreadyAppliedError(err)) {
        try {
          await recordMigrationApplied(db, filename)
        } catch {
          // best-effort
        }
        out.skipped.push(filename)
        continue
      }
      out.failed.push({ filename, error: String(err?.message || err) })
      logger.warn?.(
        `[agent-subsystem] failed to apply ${filename} (continuing): ${err?.message || err}`,
      )
    }
  }

  if (out.applied.length > 0 || out.failed.length > 0) {
    logger.info?.(
      `[agent-subsystem] self-heal complete: applied=${out.applied.length} skipped=${out.skipped.length} failed=${out.failed.length}`,
    )
  }

  return out
}

export const __testables = {
  POSTGRES_FILES,
  SQLITE_FILES,
  isAlreadyAppliedError,
}
