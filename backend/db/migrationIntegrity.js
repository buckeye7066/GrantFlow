import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const SHA256_HEX = /^[0-9a-f]{64}$/i

export const APPLIED_BYTES_PROVENANCE = 'applied_bytes'
export const LEGACY_BASELINE_PROVENANCE = 'legacy_baseline_current_release'
export const IDEMPOTENT_RECORD_PROVENANCE = 'idempotent_existing_schema'

export function migrationFileChecksum(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

export function normalizeMigrationChecksum(value) {
  const checksum = String(value || '').trim().toLowerCase()
  return SHA256_HEX.test(checksum) ? checksum : null
}

export async function ensureMigrationIntegrityColumns(db) {
  if (db.dialect === 'postgres') {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        checksum_sha256 TEXT,
        checksum_provenance TEXT,
        applied_at TIMESTAMPTZ DEFAULT now()
      );
      ALTER TABLE _migrations ADD COLUMN IF NOT EXISTS checksum_sha256 TEXT;
      ALTER TABLE _migrations ADD COLUMN IF NOT EXISTS checksum_provenance TEXT;
    `)
    return
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      checksum_sha256 TEXT,
      checksum_provenance TEXT,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)
  const columns = await db.prepare('PRAGMA table_info(_migrations)').all()
  const names = new Set((columns || []).map((column) => String(column?.name || '')))
  if (!names.has('checksum_sha256')) {
    await db.exec('ALTER TABLE _migrations ADD COLUMN checksum_sha256 TEXT;')
  }
  if (!names.has('checksum_provenance')) {
    await db.exec('ALTER TABLE _migrations ADD COLUMN checksum_provenance TEXT;')
  }
}

export async function recordMigrationApplied(
  dbh,
  filename,
  checksumSha256,
  provenance = APPLIED_BYTES_PROVENANCE,
) {
  const checksum = normalizeMigrationChecksum(checksumSha256)
  if (!checksum) throw new Error(`Migration ${filename} has an invalid SHA-256 checksum`)
  await dbh.prepare(
    `INSERT INTO _migrations (name, checksum_sha256, checksum_provenance)
     VALUES (?, ?, ?)`,
  ).run(filename, checksum, provenance)
}

export async function verifyOrBaselineMigrationLedger(
  db,
  migrationsDir,
  filenames,
  { logger = console } = {},
) {
  const allowed = new Set(filenames)
  const rows = await db.prepare(
    `SELECT id, name, checksum_sha256, checksum_provenance, applied_at
       FROM _migrations
      ORDER BY id`,
  ).all()
  const summary = {
    checked: 0,
    baselined: 0,
    applied_bytes: 0,
    legacy_or_idempotent: 0,
  }

  for (const row of rows || []) {
    const filename = String(row?.name || '')
    if (!allowed.has(filename)) {
      throw new Error(`Migration ledger references a file not present in this release: ${filename}`)
    }
    const filePath = path.join(migrationsDir, filename)
    const expected = migrationFileChecksum(filePath)
    const stored = normalizeMigrationChecksum(row?.checksum_sha256)
    const provenance = String(row?.checksum_provenance || '').trim()
    summary.checked += 1

    if (stored && stored !== expected) {
      throw new Error(
        `Migration checksum mismatch for ${filename}: ledger=${stored} release=${expected}`,
      )
    }

    if (!stored) {
      await db.prepare(
        `UPDATE _migrations
            SET checksum_sha256 = ?, checksum_provenance = ?
          WHERE id = ?
            AND (checksum_sha256 IS NULL OR TRIM(checksum_sha256) = '')`,
      ).run(expected, LEGACY_BASELINE_PROVENANCE, row.id)
      summary.baselined += 1
      summary.legacy_or_idempotent += 1
      logger.warn?.(
        `[migrate] Baseline-attested legacy migration ${filename}; original applied bytes remain unknown`,
      )
      continue
    }

    if (provenance === APPLIED_BYTES_PROVENANCE) summary.applied_bytes += 1
    else summary.legacy_or_idempotent += 1
  }

  return summary
}


/**
 * Verify or baseline the checksum ledger before reading the applied-name set.
 * Dependency injection keeps this ordering invariant executable in unit tests
 * without opening a production database connection.
 */
export async function verifyMigrationLedgerBeforeReadApplied({
  db,
  migrationsDir,
  files,
  logger = console,
  verifyLedger = verifyOrBaselineMigrationLedger,
  readApplied,
} = {}) {
  if (typeof readApplied !== 'function') {
    throw new TypeError('readApplied must be a function')
  }
  const integrity = await verifyLedger(db, migrationsDir, files, { logger })
  logger.info?.(
    `[migrate:boot] checksum ledger: checked=${integrity.checked} applied_bytes=${integrity.applied_bytes} baselined=${integrity.baselined} legacy_or_idempotent=${integrity.legacy_or_idempotent}`,
  )
  const applied = await readApplied()
  return { integrity, applied }
}

export default {
  APPLIED_BYTES_PROVENANCE,
  IDEMPOTENT_RECORD_PROVENANCE,
  LEGACY_BASELINE_PROVENANCE,
  ensureMigrationIntegrityColumns,
  migrationFileChecksum,
  normalizeMigrationChecksum,
  recordMigrationApplied,
  verifyMigrationLedgerBeforeReadApplied,
  verifyOrBaselineMigrationLedger,
}
