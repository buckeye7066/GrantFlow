import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  APPLIED_BYTES_PROVENANCE,
  LEGACY_BASELINE_PROVENANCE,
  ensureMigrationIntegrityColumns,
  migrationFileChecksum,
  recordMigrationApplied,
  verifyOrBaselineMigrationLedger,
} from '../../backend/db/migrationIntegrity.js'

function memoryDb({ dialect = 'sqlite', rows = [], columns = ['id', 'name', 'applied_at'] } = {}) {
  const state = {
    rows: rows.map((row) => ({ ...row })),
    columns: new Set(columns),
    exec: [],
  }
  return {
    dialect,
    state,
    async exec(sql) {
      state.exec.push(sql)
      if (/ADD COLUMN checksum_sha256/i.test(sql)) state.columns.add('checksum_sha256')
      if (/ADD COLUMN checksum_provenance/i.test(sql)) state.columns.add('checksum_provenance')
    },
    prepare(sql) {
      return {
        async all() {
          if (/PRAGMA table_info\(_migrations\)/i.test(sql)) {
            return [...state.columns].map((name, index) => ({ cid: index, name }))
          }
          if (/FROM _migrations/i.test(sql)) return state.rows.map((row) => ({ ...row }))
          throw new Error(`Unexpected all() SQL: ${sql}`)
        },
        async run(...args) {
          if (/INSERT INTO _migrations/i.test(sql)) {
            const [name, checksum_sha256, checksum_provenance] = args
            state.rows.push({
              id: state.rows.length + 1,
              name,
              checksum_sha256,
              checksum_provenance,
              applied_at: '2026-08-10T00:00:00Z',
            })
            return { changes: 1 }
          }
          if (/UPDATE _migrations/i.test(sql)) {
            const [checksum_sha256, checksum_provenance, id] = args
            const row = state.rows.find((candidate) => candidate.id === id)
            if (row && !String(row.checksum_sha256 || '').trim()) {
              row.checksum_sha256 = checksum_sha256
              row.checksum_provenance = checksum_provenance
              return { changes: 1 }
            }
            return { changes: 0 }
          }
          throw new Error(`Unexpected run() SQL: ${sql}`)
        },
      }
    },
  }
}

function migrationFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'grantflow-migration-integrity-'))
  fs.writeFileSync(path.join(directory, '0001_first.sql'), 'SELECT 1;\n')
  fs.writeFileSync(path.join(directory, '0002_second.mjs'), 'export default async function up() {}\n')
  return directory
}

test('SQLite migration ledger is upgraded with checksum columns', async () => {
  const db = memoryDb()
  await ensureMigrationIntegrityColumns(db)
  assert.equal(db.state.columns.has('checksum_sha256'), true)
  assert.equal(db.state.columns.has('checksum_provenance'), true)
  assert.ok(db.state.exec.some((sql) => /CREATE TABLE IF NOT EXISTS _migrations/.test(sql)))
})

test('new migration records persist the exact applied file checksum', async () => {
  const directory = migrationFixture()
  const checksum = migrationFileChecksum(path.join(directory, '0001_first.sql'))
  const db = memoryDb({ columns: ['id', 'name', 'checksum_sha256', 'checksum_provenance', 'applied_at'] })

  await recordMigrationApplied(db, '0001_first.sql', checksum, APPLIED_BYTES_PROVENANCE)

  assert.deepEqual(db.state.rows[0], {
    id: 1,
    name: '0001_first.sql',
    checksum_sha256: checksum,
    checksum_provenance: APPLIED_BYTES_PROVENANCE,
    applied_at: '2026-08-10T00:00:00Z',
  })
})

test('legacy rows receive a transparent current-release baseline exactly once', async () => {
  const directory = migrationFixture()
  const warnings = []
  const db = memoryDb({
    columns: ['id', 'name', 'checksum_sha256', 'checksum_provenance', 'applied_at'],
    rows: [
      { id: 1, name: '0001_first.sql', checksum_sha256: null, checksum_provenance: null },
      { id: 2, name: '0002_second.mjs', checksum_sha256: '', checksum_provenance: '' },
    ],
  })

  const first = await verifyOrBaselineMigrationLedger(
    db,
    directory,
    ['0001_first.sql', '0002_second.mjs'],
    { logger: { warn(message) { warnings.push(message) } } },
  )
  assert.equal(first.baselined, 2)
  assert.equal(first.legacy_or_idempotent, 2)
  assert.equal(warnings.length, 2)
  assert.equal(db.state.rows.every((row) => row.checksum_provenance === LEGACY_BASELINE_PROVENANCE), true)

  const second = await verifyOrBaselineMigrationLedger(
    db,
    directory,
    ['0001_first.sql', '0002_second.mjs'],
    { logger: { warn(message) { warnings.push(message) } } },
  )
  assert.equal(second.baselined, 0)
  assert.equal(warnings.length, 2)
})

test('a changed or missing applied migration fails closed', async () => {
  const directory = migrationFixture()
  const firstPath = path.join(directory, '0001_first.sql')
  const db = memoryDb({
    columns: ['id', 'name', 'checksum_sha256', 'checksum_provenance', 'applied_at'],
    rows: [{
      id: 1,
      name: '0001_first.sql',
      checksum_sha256: migrationFileChecksum(firstPath),
      checksum_provenance: APPLIED_BYTES_PROVENANCE,
    }],
  })

  fs.appendFileSync(firstPath, '-- changed after application\n')
  await assert.rejects(
    verifyOrBaselineMigrationLedger(db, directory, ['0001_first.sql', '0002_second.mjs']),
    /Migration checksum mismatch/,
  )

  const missingDb = memoryDb({
    columns: ['id', 'name', 'checksum_sha256', 'checksum_provenance', 'applied_at'],
    rows: [{ id: 1, name: '9999_missing.sql', checksum_sha256: 'a'.repeat(64) }],
  })
  await assert.rejects(
    verifyOrBaselineMigrationLedger(missingDb, directory, ['0001_first.sql', '0002_second.mjs']),
    /file not present in this release/,
  )
})

test('boot migration path verifies or baselines the ledger before reading applied rows', () => {
  const source = fs.readFileSync(
    new URL('../../backend/db/migrate.js', import.meta.url),
    'utf8',
  )
  const bootStart = source.indexOf('export async function runPendingMigrationsOnBoot')
  const bootSource = source.slice(bootStart)
  const verifyIndex = bootSource.indexOf('verifyOrBaselineMigrationLedger(')
  const appliedIndex = bootSource.indexOf('getAppliedSet()')

  assert.notEqual(bootStart, -1)
  assert.notEqual(verifyIndex, -1)
  assert.notEqual(appliedIndex, -1)
  assert.ok(verifyIndex < appliedIndex)
})
