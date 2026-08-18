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
  verifyMigrationLedgerBeforeReadApplied,
  verifyOrBaselineMigrationLedger,
} from './migrationIntegrity.js';
import { applyWorkspacePersistenceTables } from './applyWorkspacePersistenceTables.js';

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

    if (row?.name === 'profiles') {
      await applyWorkspacePersistenceTables(db)
      return
    }
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
    await applyWorkspacePersistenceTables(db)
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

  if (filename.endsWith('.mjs')) {
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
          console.log(`  Skipped already-applied statement (${err?.message || err})`)
        }
      }
      await recordMigrationApplied(tx, filename, checksumSha256, APPLIED_BYTES_PROVENANCE);
    });
  } else {
    await db.withTransaction(async (tx) => {
      tx.exec(sql);
      await recordMigrationApplied(tx, filename, checksumSha256, APPLIED_BYTES_PROVENANCE);
    });
  }
}

export function isIdempotentAlreadyAppliedError(err) {
  const msg = String(err?.message || err || '').toLowerCase();

  if (msg.includes('duplicate column name')) return true;
  if (msg.includes('already exists')) return true;
  if (msg.includes('duplicate index')) return true;
  if (msg.includes('there is already another table or index with this name')) return true;
  if (msg.includes('near "exists"') && msg.includes('syntax error')) return true;

  return false;
}

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
    console.log(`  Recorded as applied (${note})`);
  } catch (e) {
    const msg = String(e?.message || e || '').toLowerCase();
    if (msg.includes('unique') || msg.includes('duplicate')) {
      console.log(`  Already recorded (${note})`);
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
    console.log('\u2713 Database is up to date. No migrations to apply.');
    await db.close?.();
    await db.close?.();
    process.exit(0);
  }

  for (const filename of pending) {
    try {
      await applyMigration(filename);
      console.log('  \u2713 Success\n');
    } catch (error) {
      if (db.dialect !== 'postgres' && isIdempotentAlreadyAppliedError(error)) {
        await recordAsApplied(filename, 'idempotent DDL');
        console.log('');
        continue;
      }

      console.error(`  \u2717 Failed: ${error?.message || error}\n`);
      await db.close?.();
    await db.close?.();
    await db.close?.();
    process.exit(1);
    }
  }

  console.log('\u2713 All migrations applied successfully');
  await db.close?.();
    await db.close?.();
    process.exit(0);
}

export async function runPendingMigrationsOnBoot({ logger = console } = {}) {
  if (!ensureDirExists(migrationsDir)) return { ran: 0, drift: null }
  await ensureSqliteBaseSchema()
  await ensureMigrationsTable()
  const files = listSqlMigrations(migrationsDir)
  const { applied } = await verifyMigrationLedgerBeforeReadApplied({
    db,
    migrationsDir,
    files,
    logger,
    readApplied: getAppliedSet,
  })
  const pending = files.filter((f) => !applied.has(f))
  let ran = 0
  const failed = []
  for (const filename of pending) {
    try {
      await applyMigration(filename)
      ran += 1
    } catch (error) {
      if (db.dialect !== 'postgres' && isIdempotentAlreadyAppliedError(error)) {
        await recordAsApplied(filename, 'idempotent DDL')
        ran += 1
        continue
      }
      failed.push(filename)
      logger.error?.(`[migrate:boot] FAILED on ${filename} (left UNSTAMPED, continuing): ${error?.message || error}`)
    }
  }

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
    missingTables = [`diagnostics_unavailable(${err?.message || err})`]
  }
  const dedupe = await checkPhoneDedupeHealth(db)
  driftLine = summarizeBootHealthLine({ missingCols, missingTables, failed, dedupe })

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

const isDirectInvocation = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('backend/db/migrate.js')
if (isDirectInvocation) {
  main();
}
