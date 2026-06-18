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
  '0095_agent_control_lock_owner_token.sql',
  '0096_agent_telemetry_missing_tables.sql',
  '0098_yana_prospect_columns.sql',
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
  '099_agent_control_lock_owner_token.sql',
  '100_agent_telemetry_missing_tables.sql',
  '101_yana_prospect_columns.sql',
]

// A representative ("witness") table for each migration file. When a file is
// already stamped in `_migrations` we still confirm its witness table is
// physically present before trusting the stamp — see the skip logic in
// ensureAgentSubsystemTables. Files not listed here fall back to trusting the
// stamp (e.g. the yana_* ALTER-only / rename migrations, which have no single
// stable witness table). Keyed by BOTH the postgres and sqlite filenames so a
// single lookup works for either dialect.
const REPRESENTATIVE_TABLES = {
  '0076_sam_runs.sql': 'sam_runs',
  '080_sam_runs.sql': 'sam_runs',
  '0077_robert_tables.sql': 'robert_runs',
  '081_robert_tables.sql': 'robert_runs',
  '0079_john_tables.sql': 'john_runs',
  '083_john_tables.sql': 'john_runs',
  '0080_agent_telemetry.sql': 'agent_activity_events',
  '084_agent_telemetry.sql': 'agent_activity_events',
  // The yana→hamilton rename also CREATEs the canonical hamilton_* tables for
  // fresh DBs, so it has a stable witness. Without this, a stamped-but-missing
  // hamilton_authorizations (the cause of the /authorize 500s) would never be
  // re-created at boot.
  '0086_rename_yana_to_hamilton.sql': 'hamilton_authorizations',
  '090_rename_yana_to_hamilton.sql': 'hamilton_authorizations',
  '0087_agent_control_center.sql': 'agent_control_runs',
  '091_agent_control_center.sql': 'agent_control_runs',
  '0089_yana_lead_discovery.sql': 'yana_lead_candidates',
  '093_yana_lead_discovery.sql': 'yana_lead_candidates',
  '0096_agent_telemetry_missing_tables.sql': 'sam_findings',
  '100_agent_telemetry_missing_tables.sql': 'sam_findings',
}

// Identifier whitelist so a witness name can never be interpolated unsafely.
const TABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Does `tableName` actually exist right now? Dialect-aware, mirrors the
 * canonical helper in agentTelemetryStore.js. Returns false on any error so a
 * probe failure degrades to "re-apply the idempotent DDL", never a throw.
 */
async function tableExists(db, tableName) {
  if (!db || typeof tableName !== 'string' || !TABLE_NAME_RE.test(tableName)) return false
  try {
    if (db.dialect === 'postgres') {
      const row = await db
        .prepare(
          'SELECT 1 AS ok FROM information_schema.tables WHERE table_schema = ANY (current_schemas(false)) AND table_name = ?',
        )
        .get(tableName)
      return Boolean(row && (row.ok === 1 || row.ok === true))
    }
    const row = await db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type IN ('table','view') AND name = ?")
      .get(tableName)
    return Boolean(row && (row.ok === 1 || row.ok === true))
  } catch {
    return false
  }
}

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
    // Trust the `_migrations` ledger ONLY when the live schema agrees with it.
    // A file can be stamped as applied while its table is absent — a DB
    // restore/branch, a transaction that rolled back *after* stamping, or a
    // hand-seeded `_migrations`. When that happens the stamp lies, so we verify
    // the file's witness table actually exists and re-apply the (idempotent)
    // DDL when it doesn't. This is precisely the gap that let Robert fail with
    // `relation "robert_runs" does not exist` even though both the boot and
    // the per-run orchestrator self-heal had already "run" (they skipped the
    // file on the stamp). Files without a witness keep trusting the stamp.
    if (already) {
      const witness = REPRESENTATIVE_TABLES[filename]
      if (!witness || (await tableExists(db, witness))) {
        out.skipped.push(filename)
        continue
      }
      out.repaired = out.repaired || []
      out.repaired.push(filename)
      logger.warn?.(
        `[agent-subsystem] ${filename} is stamped applied but witness table "${witness}" is missing — re-applying DDL`,
      )
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

  // Stale-lock recovery. Reclaim any Agent Control Center lock orphaned by a
  // crashed/killed run BEFORE this fix shipped (or by an earlier deploy of
  // this process). The acquire path also sweeps on every attempt, but doing
  // it once at boot means a wedged lock is cleared the instant the new build
  // comes up — no need to wait for the next run to be triggered.
  try {
    const { sweepExpiredLocks } = await import('../services/agentControl/agentControlStore.js')
    const swept = await sweepExpiredLocks(db)
    out.locksSwept = swept
    if (swept > 0) {
      logger.info?.(`[agent-subsystem] reclaimed ${swept} expired agent-control lock(s) at boot`)
    }
  } catch (sweepErr) {
    logger.warn?.(`[agent-subsystem] stale-lock sweep skipped: ${sweepErr?.message || sweepErr}`)
  }

  return out
}

export const __testables = {
  POSTGRES_FILES,
  SQLITE_FILES,
  REPRESENTATIVE_TABLES,
  isAlreadyAppliedError,
  tableExists,
}
