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
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
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
  const sql = fs.readFileSync(fullPath, 'utf8');

  console.log(`Applying: ${filename}`);

  await db.withTransaction(async (tx) => {
    await tx.exec(sql);
    await tx.prepare('INSERT INTO _migrations (name) VALUES (?)').run(filename);
  });
}

function isIdempotentAlreadyAppliedError(err) {
  const msg = String(err?.message || err || '').toLowerCase();

  // SQLite common "already applied" signatures
  if (msg.includes('duplicate column name')) return true;
  if (msg.includes('already exists')) return true; // table/index already exists
  if (msg.includes('duplicate index')) return true;

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

main();

