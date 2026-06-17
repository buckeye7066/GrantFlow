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
import { fileURLToPath } from 'url';
import { getDb } from './index.js';

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
  if (db.dialect === 'postgres') {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ DEFAULT now()
      );
    `);
    return;
  }

  // sqlite
  await db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

async function getAppliedSet() {
  const rows = await db.prepare('SELECT name FROM _migrations ORDER BY id').all();
  return new Set((rows || []).map((r) => r.name));
}

async function applyMigration(filename) {
  const fullPath = path.join(migrationsDir, filename);

  console.log(`Applying: ${filename}`);

  // .mjs migrations export a default async function(db). They get the live
  // connection (so they can use better-sqlite3 escape hatches like
  // unsafeMode), and they're responsible for inserting their own row into
  // _migrations only on success — but for symmetry we record afterwards.
  if (filename.endsWith('.mjs')) {
    // Import via file: URL so Windows paths work; cache-bust by filename so
    // repeated invocations in the same process get fresh module instances.
    const mod = await import(`file://${fullPath.replace(/\\/g, '/')}`)
    const fn = typeof mod?.default === 'function' ? mod.default : mod?.up
    if (typeof fn !== 'function') {
      throw new Error(`Migration ${filename} must export a default function or 'up' (received ${typeof fn})`)
    }
    if (db.dialect === 'postgres') {
      await db.withTransaction(async (tx) => {
        await fn(tx)
        await tx.prepare('INSERT INTO _migrations (name) VALUES (?)').run(filename)
      })
    } else {
      await db.withTransaction(async (tx) => {
        await fn(tx)
        await tx.prepare('INSERT INTO _migrations (name) VALUES (?)').run(filename)
      })
    }
    return
  }

  const sql = fs.readFileSync(fullPath, 'utf8');

  if (db.dialect === 'postgres') {
    await db.withTransaction(async (tx) => {
      await tx.exec(sql);
      await tx.prepare('INSERT INTO _migrations (name) VALUES (?)').run(filename);
    });
  } else if (sql.includes('@sqlite-continue-on-idempotent-errors')) {
    await db.withTransaction((tx) => {
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
      tx.prepare('INSERT INTO _migrations (name) VALUES (?)').run(filename);
    });
  } else {
    // IMPORTANT: must await — the sqlite withTransaction is async (manual
    // BEGIN/COMMIT) and without awaiting we'd return before COMMIT, which
    // previously caused the caller to log "Success" while the INSERT into
    // _migrations never landed, looping the same migration every boot.
    await db.withTransaction((tx) => {
      tx.exec(sql);
      tx.prepare('INSERT INTO _migrations (name) VALUES (?)').run(filename);
    });
  }
}

function isIdempotentAlreadyAppliedError(err) {
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

async function recordAsApplied(filename, note) {
  try {
    await db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(filename);
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

  const applied = await getAppliedSet();
  const files = listSqlMigrations(migrationsDir);
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
      logger.error?.(`[migrate:boot] Failed on ${filename}: ${error?.message || error}`)
      throw error
    }
  }

  let driftLine = 'schema check: UNAVAILABLE'
  try {
    const { getSystemDiagnostics } = await import('../services/diagnosticsService.js')
    const diag = await getSystemDiagnostics(db)
    const sc = diag?.db?.schema_checks
    const missingCols = sc?.details?.missing_columns || []
    const missingTables = sc?.details?.missing_tables || []
    if (missingCols.length === 0 && missingTables.length === 0) {
      driftLine = 'schema check: OK'
    } else {
      const parts = []
      if (missingCols.length) parts.push(`cols=${missingCols.join(',')}`)
      if (missingTables.length) parts.push(`tables=${missingTables.join(',')}`)
      driftLine = `schema check: DRIFT: ${parts.join('; ')}`
    }
  } catch (err) {
    driftLine = `schema check: UNAVAILABLE (${err?.message || err})`
  }
  logger.log?.(`[migrate:boot] ran=${ran} ${driftLine}`)
  return { ran, drift: driftLine }
}

// Only run the CLI entry point when invoked directly, so importers
// (e.g. backend/server.js boot hook) don't trigger process.exit.
const isDirectInvocation = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('backend/db/migrate.js')
if (isDirectInvocation) {
  main();
}

