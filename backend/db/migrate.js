/**
 * Unified DB migration runner (sqlite + postgres)
 *
 * - sqlite migrations live in:   backend/db/migrations/*.sql
 * - postgres migrations live in: backend/db/postgres/migrations/*.sql
 *
 * This runner intentionally does NOT create/update schema during normal server startup in production.
 * Run: `npm run migrate`
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { getDb } from './index.js';
import {
  APPLIED_BYTES_PROVENANCE,
  IDEMPOTENT_RECORD_PROVENANCE,
  ensureMigrationIntegrityColumns,
  migrationFileChecksum,
  recordMigrationApplied,
  verifyOrBaselineMigrationLedger,
} from './migrationIntegrity.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db = getDb();

const migrationsDir =
  db.dialect === 'postgres'
    ? path.join(__dirname, 'postgres', 'migrations')
    : path.join(__dirname, 'migrations');

async function ensureSqliteBaseSchema() {
  if (db.dialect !== 'sqlite') return

  // For a fresh SQLite DB file, migrations are ALTER/CREATE statements that assume base tables exist.
  // Bootstrap the base schema from `backend/db/schema.sql` exactly once (idempotent CREATE TABLEs).
  try {
    const row = await db
      .prepare(
        `
          SELECT name
          FROM sqlite_master
          WHERE type = 'table' AND name = 'profiles'
        `,
      )
      .get()

    if (row?.name === 'profiles') return
  } catch {
    // If probing fails, we still try to apply schema to self-heal.
  }

  const schemaPath = path.join(__dirname, 'schema.sql')
  if (!fs.existsSync(schemaPath)) {
    console.error('[migrate] ERROR: schema.sql not found at', schemaPath)
    process.exit(1)
  }

  console.log('[migrate] Bootstrapping base SQLite schema from schema.sql')
  const sql = fs.readFileSync(schemaPath, 'utf8')
  try {
    await db.exec(sql)
    console.log('[migrate] ✓ Base schema applied')
  } catch (error) {
    console.error('[migrate] ✗ Failed to apply base schema:', error?.message || String(error))
    process.exit(1)
  }
}

function ensureDirExists(dir) {
  if (!fs.existsSync(dir)) return false;
  return fs.statSync(dir).isDirectory();
}

function listSqlMigrations(dir) {
  // Includes both .sql files (SQL-only migrations) and .mjs files (migrations
  // that need procedural escape hatches not expressible in SQL — e.g. SQLite
  // CHECK-constraint rewrites that require the better-sqlite3 unsafeMode +
  // writable_schema + schema_version trick).
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql') || f.endsWith('.mjs'))
    .sort();
}

async function ensureMigrationsTable() {
  await ensureMigrationIntegrityColumns(db)
}

async function getAppliedSet() {
  const rows = await db.prepare('SELECT name FROM _migrations ORDER BY id').all();
  return new Set((rows || []).map((r) => r.name));
}

async function applyMigration(filename) {
  const fullPath = path.join(migrationsDir, filename);
  const checksumSha256 = migrationFileChecksum(fullPath);

  console.log(`Applying: ${filename}`);

  // .mjs migrations export a default async function(db). They get the live
  // connection (so they can use better-sqlite3 escape hatches like
  // unsafeMode), and they're responsible for inserting their own row into
  // _migrations only on success — but for symmetry we record afterwards.
  if (filename.endsWith('.mjs')) {
    // Import via file: URL so Windows paths work. pathToFileURL emits a valid
    // file:///C:/... URL (a bare `file://C:/...` parses the drive letter as a
    // hostname, which Node/Vite reject) and percent-encodes spaces/specials.
    const mod = await import(pathToFileURL(fullPath).href)
    const fn = typeof mod?.default === 'function' ? mod.default : mod?.up
    if (typeof fn !== 'function') {
      throw new Error(`Migration ${filename} must export a default function or 'up' (received ${typeof fn})`)
    }
    if (db.dialect === 'postgres') {
      await db.withTransaction(async (tx) => {
        await fn(tx)
        await recordMigrationApplied(tx, filename, checksumSha256, APPLIED_BYTES_PROVENANCE)
      })
    } else {
      await db.withTransaction(async (tx) => {
        await fn(tx)
        await recordMigrationApplied(tx, filename, checksumSha256, APPLIED_BYTES_PROVENANCE)
      })
    }
    return
  }

  const sql = fs.readFileSync(fullPath, 'utf8');

  if (db.dialect === 'postgres') {
    await db.withTransaction(async (tx) => {
      await tx.exec(sql);
      await recordMigrationApplied(tx, filename, checksumSha256, APPLIED_BYTES_PROVENANCE);
    });
  } else if (sql.includes('@sqlite-continue-on-idempotent-errors')) {
    await db.withTransaction(async (tx) => {
      const statements = sql
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .split(';')
        .map((stmt) => stmt.trim())
        .filter(Boolean)
      for (const statement of statements) {
        try {
          tx.exec(`${statement};`)
        } catch (err) {
          if (!isIdempotentAlreadyAppliedError(err)) throw err
          console.log(`  ↪ Skipped already-applied statement (${err?.message || err})`)
        }
      }
      await recordMigrationApplied(tx, filename, checksumSha256, APPLIED_BYTES_PROVENANCE);
    });
  } else {
    // IMPORTANT: must await — the sqlite withTransaction is async (manual
    // BEGIN/COMMIT) and without awaiting we'd return before COMMIT, which
    // previously caused the caller to log "Success" while the INSERT into
    // _migrations never landed, looping the same migration every boot.
    await db.withTransaction(async (tx) => {
      tx.exec(sql);
      await recordMigrationApplied(tx, filename, checksumSha256, APPLIED_BYTES_PROVENANCE);
    });
  }
}

export function isIdempotentAlreadyAppliedError(err) {
  const msg = String(err?.message || err || '').toLowerCase();

  // SQLite common "already applied" signatures
  if (msg.includes('duplicate column name')) return true;
  if (msg.includes('already exists')) return true; // table/index already exists
  if (msg.includes('duplicate index')) return true;

  // ALTER TABLE ... RENAME TO <name> when <name> already exists. This is a
  // harmless idempotent state on fresh DBs where schema.sql already created
  // the target table — the rename is a no-op and we can move on.
  if (msg.includes('there is already another table or index with this name')) return true;

  // sqlite < 3.35 does not support `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`;
  // the legacy schema-apply path already materialized the column in practice,
  // so treat this specific parser error as an "already applied" signal.
  if (msg.includes('near "exists"') && msg.includes('syntax error')) return true;

  return false;
}

// Round 30 — boot health for the HIGH-RISK phone-dedup repair (137/138 · 0141/0142).
// The boot runner CATCHES a failed migration, leaves it unstamped, and CONTINUES (so an
// unrelated idempotent hiccup can't take prod down). The cost is that a failed DATA repair
// could otherwise start prod with duplicates still present while the schema check reports
// OK (it only inspects selected missing columns/tables). These helpers give the boot signal
// two teeth: (1) the failed filenames are surfaced, and (2) the repair's POST-CONDITIONS are
// asserted, so a failed/unstamped 138/0142 flips the health line off OK instead of hiding.

// Tables whose (user_id, profile_id/stripe_customer_id) pair legitimately records the ACTOR
// at event time and must never be rewritten by the merge — mirrors the migration's EXEMPT set
// (audit/actor rows; yana_* were renamed to hamilton_* so are vestigial phantoms only).
const PHONE_DEDUPE_EXEMPT_TABLES = new Set(['audit_logs', 'agent_activity_events'])
const isPhoneDedupeExempt = (t) => PHONE_DEDUPE_EXEMPT_TABLES.has(t) || t.startsWith('yana_')

async function indexExists(dbh, name) {
  if (dbh.dialect === 'postgres') {
    const row = await dbh.prepare('SELECT indexname FROM pg_indexes WHERE indexname = ?').get(name)
    return Boolean(row?.indexname)
  }
  const row = await dbh.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`).get(name)
  return Boolean(row?.name)
}

// Enumerate two-owner tables (user_id + profile_id, or user_id + stripe_customer_id) from the
// LIVE migrated schema — the same by-construction discovery the migration test uses, so a
// table added by a future migration is covered without editing a hardcoded list.
async function twoOwnerTables(dbh) {
  let tables
  let colsOf
  if (dbh.dialect === 'postgres') {
    tables = (await dbh.prepare(`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public'`).all()).map((r) => r.name)
    colsOf = async (t) => (await dbh.prepare(`SELECT column_name AS name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ?`).all(t)).map((r) => r.name)
  } else {
    tables = (await dbh.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all()).map((r) => r.name)
    colsOf = async (t) => (await dbh.prepare(`PRAGMA table_info(${JSON.stringify(t)})`).all()).map((r) => r.name)
  }
  const profile = []
  const stripe = []
  for (const t of tables) {
    if (isPhoneDedupeExempt(t)) continue
    const cols = await colsOf(t)
    if (cols.includes('user_id') && cols.includes('profile_id')) profile.push(t)
    if (cols.includes('user_id') && cols.includes('stripe_customer_id')) stripe.push(t)
  }
  return { profile, stripe }
}

async function countTwoOwnerSplits(dbh) {
  const { profile, stripe } = await twoOwnerTables(dbh)
  let splits = 0
  for (const t of profile) {
    const q = `SELECT COUNT(*) AS c FROM ${t} x JOIN profiles p ON p.id = x.profile_id WHERE x.user_id IS NOT NULL AND p.user_id IS NOT NULL AND x.user_id <> p.user_id`
    splits += Number((await dbh.prepare(q).get())?.c || 0)
  }
  for (const t of stripe) {
    if (t === 'stripe_customers') continue
    const q = `SELECT COUNT(*) AS c FROM ${t} x JOIN stripe_customers s ON s.stripe_customer_id = x.stripe_customer_id WHERE x.user_id IS NOT NULL AND s.user_id IS NOT NULL AND x.user_id <> s.user_id`
    splits += Number((await dbh.prepare(q).get())?.c || 0)
  }
  return splits
}

/**
 * Assert the phone-dedup repair's post-conditions actually hold. Returns
 * { ok, problems: string[] }. A failed/unstamped 138/0142 leaves at least one of these
 * broken, so `ok` is false and the boot health line cannot report OK. Never throws — a
 * probe error is itself recorded as a problem (visible, not swallowed).
 */
export async function checkPhoneDedupeHealth(dbh = db) {
  const problems = []
  try {
    if (!(await indexExists(dbh, 'ux_users_primary_phone'))) problems.push('missing index ux_users_primary_phone (primary_phone not de-duplicated)')
  } catch (err) { problems.push(`primary_phone index probe failed: ${err?.message || err}`) }
  try {
    if (!(await indexExists(dbh, 'ux_uvc_one_active_per_credential'))) problems.push('missing index ux_uvc_one_active_per_credential (one-active-code invariant not enforced)')
  } catch (err) { problems.push(`one-active-code index probe failed: ${err?.message || err}`) }
  try {
    const splits = await countTwoOwnerSplits(dbh)
    if (splits > 0) problems.push(`two-owner split rows=${splits} (user_id points at a different account than its profile/customer)`)
  } catch (err) { problems.push(`two-owner split probe failed: ${err?.message || err}`) }
  return { ok: problems.length === 0, problems }
}

/**
 * Pure decision: fold the schema-drift facts, the boot runner's failed migrations, and the
 * phone-dedup post-condition health into ONE operator line. `schema check: OK` is reachable
 * ONLY when nothing is missing, nothing failed, and the repair's post-conditions hold — so a
 * failed high-risk repair can never hide behind a green schema check.
 */
export function summarizeBootHealthLine({ missingCols = [], missingTables = [], failed = [], dedupe = { ok: true, problems: [] } } = {}) {
  const parts = []
  if (missingCols.length) parts.push(`cols=${missingCols.join(',')}`)
  if (missingTables.length) parts.push(`tables=${missingTables.join(',')}`)
  if (failed.length) parts.push(`failed_migrations=${failed.join(',')}`)
  if (!dedupe.ok) parts.push(`phone_dedupe=${dedupe.problems.join(' | ')}`)
  return parts.length === 0 ? 'schema check: OK' : `schema check: DRIFT: ${parts.join('; ')}`
}

async function recordAsApplied(filename, note) {
  try {
    const fullPath = path.join(migrationsDir, filename)
    const checksumSha256 = migrationFileChecksum(fullPath)
    await recordMigrationApplied(
      db,
      filename,
      checksumSha256,
      IDEMPOTENT_RECORD_PROVENANCE,
    );
    console.log(`  ↪ Recorded as applied (${note})`);
  } catch (e) {
    // If it was recorded concurrently, treat as success.
    const msg = String(e?.message || e || '').toLowerCase();
    if (msg.includes('unique') || msg.includes('duplicate')) {
      console.log(`  ↪ Already recorded (${note})`);
      return;
    }
    throw e;
  }
}

async function main() {
  console.log('=== DB Migration Runner ===');
  console.log('Dialect:', db.dialect);
  console.log('Migrations dir:', migrationsDir);

  if (!ensureDirExists(migrationsDir)) {
    console.error('ERROR: migrations directory not found:', migrationsDir);
    await db.close?.();
    await db.close?.();
    await db.close?.();
    process.exit(1);
  }

  await ensureSqliteBaseSchema()
  await ensureMigrationsTable();

  const files = listSqlMigrations(migrationsDir);
  const integrity = await verifyOrBaselineMigrationLedger(db, migrationsDir, files)
  console.log(
    `Migration checksum ledger: checked=${integrity.checked} applied_bytes=${integrity.applied_bytes} baselined=${integrity.baselined} legacy_or_idempotent=${integrity.legacy_or_idempotent}`,
  )
  const applied = await getAppliedSet();
  const pending = files.filter((f) => !applied.has(f));

  console.log(`Applied migrations: ${applied.size}`);
  console.log(`Available migrations: ${files.length}`);
  console.log(`Pending migrations: ${pending.length}`);

  if (pending.length === 0) {
    console.log('✓ Database is up to date. No migrations to apply.');
    await db.close?.();
    await db.close?.();
    process.exit(0);
  }

  for (const filename of pending) {
    try {
      await applyMigration(filename);
      console.log('  ✓ Success\n');
    } catch (error) {
      // Bootstrap safety:
      // Existing SQLite environments may have had schema changes applied via `schema.sql` startup auto-migration,
      // but `_migrations` is empty. In that case, treat "already applied" DDL failures as success and record them.
      // IMPORTANT: Postgres migrations must be strict/deterministic. Never swallow/record on error for Postgres.
      if (db.dialect !== 'postgres' && isIdempotentAlreadyAppliedError(error)) {
        await recordAsApplied(filename, 'idempotent DDL');
        console.log('');
        continue;
      }

      console.error(`  ✗ Failed: ${error?.message || error}\n`);
      await db.close?.();
    await db.close?.();
    await db.close?.();
    process.exit(1);
    }
  }

  console.log('✓ All migrations applied successfully');
  await db.close?.();
    await db.close?.();
    process.exit(0);
}

/**
 * Idempotent boot-time migrate + schema-check entry point.
 *
 * Called from backend/server.js by default (opt out with
 * MIGRATE_ON_BOOT=0|false|no|off). Applies pending migrations using the same
 * logic as `npm run migrate`, then emits exactly one line of the form
 * `schema check: OK` or `schema check: DRIFT: <cols>` so operators can grep
 * the startup log for drift without reading the full admin.diagnostics
 * output.
 *
 * Safe to call multiple times; _migrations is the idempotency table.
 */
export async function runPendingMigrationsOnBoot({ logger = console } = {}) {
  if (!ensureDirExists(migrationsDir)) return { ran: 0, drift: null }
  await ensureSqliteBaseSchema()
  await ensureMigrationsTable()
  const applied = await getAppliedSet()
  const files = listSqlMigrations(migrationsDir)
  const pending = files.filter((f) => !applied.has(f))
  let ran = 0
  // Round 30: TRACK the files that failed to apply so they can be SURFACED (a queryable
  // signal + a prominent log), not just logged-and-forgotten. High-risk data repairs
  // (phone-dedup) especially must not fail silently while the schema check reports OK.
  const failed = []
  for (const filename of pending) {
    try {
      await applyMigration(filename)
      ran += 1
    } catch (error) {
      // SQLite: a recognised "already applied" DDL error means the legacy
      // schema-apply path already materialised it — stamp it and move on.
      if (db.dialect !== 'postgres' && isIdempotentAlreadyAppliedError(error)) {
        await recordAsApplied(filename, 'idempotent DDL')
        ran += 1
        continue
      }
      // Resilient boot (Postgres + SQLite): a single failing migration must
      // NOT abort the whole chain. Historically the strict `throw` here meant
      // the first migration that errored against an already-populated prod DB
      // (e.g. a CHECK constraint or a non-IF-NOT-EXISTS object) blocked every
      // later additive migration — that is exactly how funding_opportunities
      // ended up missing `reality_status`, breaking all crawler/connector
      // writes. We log and continue so subsequent idempotent migrations still
      // apply; the failed file is left UNSTAMPED (no false "applied" record)
      // and retried next boot, and the `schema check: DRIFT` line below makes
      // any remaining gap visible. The CLI runner (`npm run migrate`, main())
      // stays strict so CI still fails loudly on a bad migration.
      failed.push(filename)
      logger.error?.(`[migrate:boot] FAILED on ${filename} (left UNSTAMPED, continuing): ${error?.message || error}`)
    }
  }

  // Post-repair health: schema drift (existing) + failed migrations + phone-dedup
  // post-conditions. `schema check: OK` is now reachable ONLY when all three are clean.
  let missingCols = []
  let missingTables = []
  let driftLine
  try {
    const { getSystemDiagnostics } = await import('../services/diagnosticsService.js')
    const diag = await getSystemDiagnostics(db)
    const sc = diag?.db?.schema_checks
    missingCols = sc?.details?.missing_columns || []
    missingTables = sc?.details?.missing_tables || []
  } catch (err) {
    // Diagnostics unavailable — do NOT report OK; fold the reason in and keep going so
    // the phone-dedup post-condition check still runs.
    missingTables = [`diagnostics_unavailable(${err?.message || err})`]
  }
  const dedupe = await checkPhoneDedupeHealth(db)
  driftLine = summarizeBootHealthLine({ missingCols, missingTables, failed, dedupe })

  // Queryable signal (durable): persist the failed set + health line so operators/monitors
  // can read it without grepping logs. Best-effort — never let it break boot.
  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)').run()
    const now = new Date().toISOString()
    const upsert = db.dialect === 'postgres'
      ? 'INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at'
      : 'INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    await db.prepare(upsert).run('migrate_boot_failed_migrations', JSON.stringify(failed), now)
    await db.prepare(upsert).run('migrate_boot_health', driftLine, now)
  } catch (err) {
    logger.error?.(`[migrate:boot] could not persist boot health signal: ${err?.message || err}`)
  }

  if (failed.length) logger.error?.(`[migrate:boot] ${failed.length} migration(s) FAILED and left unstamped: ${failed.join(', ')}`)
  if (!dedupe.ok) logger.error?.(`[migrate:boot] phone-dedup post-conditions NOT met: ${dedupe.problems.join(' | ')}`)
  logger.log?.(`[migrate:boot] ran=${ran} ${driftLine}`)
  return { ran, failed, drift: driftLine, health: dedupe }
}

// Only run the CLI entry point when invoked directly, so importers
// (e.g. backend/server.js boot hook) don't trigger process.exit.
const isDirectInvocation = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('backend/db/migrate.js')
if (isDirectInvocation) {
  main();
}

