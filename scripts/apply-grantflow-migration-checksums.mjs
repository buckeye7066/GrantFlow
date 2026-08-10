// Retry after the repository-containment regression was fixed in shared/releaseIdentity.js.
import fs from 'node:fs'

const file = 'backend/db/migrate.js'
let source = fs.readFileSync(file, 'utf8')

function replaceOnce(before, after, label) {
  const first = source.indexOf(before)
  if (first < 0) throw new Error(`Missing migrate.js source for ${label}`)
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Expected one migrate.js source block for ${label}`)
  }
  source = source.slice(0, first) + after + source.slice(first + before.length)
}

function replaceCount(before, after, expectedCount, label) {
  const parts = source.split(before)
  const count = parts.length - 1
  if (count !== expectedCount) {
    throw new Error(`Expected ${expectedCount} occurrences for ${label}; found ${count}`)
  }
  source = parts.join(after)
}

const importPattern = /import\s*\{\s*getDb\s*\}\s*from\s*['"]\.\/index\.js['"]\s*;?/
const importMatches = source.match(new RegExp(importPattern.source, 'g')) || []
if (importMatches.length !== 1) {
  throw new Error(`Expected one getDb import; found ${importMatches.length}`)
}
source = source.replace(
  importPattern,
  `import { getDb } from './index.js';
import {
  APPLIED_BYTES_PROVENANCE,
  IDEMPOTENT_RECORD_PROVENANCE,
  ensureMigrationIntegrityColumns,
  migrationFileChecksum,
  recordMigrationApplied,
  verifyOrBaselineMigrationLedger,
} from './migrationIntegrity.js';`,
)

const ensureStart = source.indexOf('async function ensureMigrationsTable() {')
const ensureEnd = source.indexOf('\n\nasync function getAppliedSet()', ensureStart)
if (ensureStart < 0 || ensureEnd < 0) throw new Error('Could not locate ensureMigrationsTable')
source = source.slice(0, ensureStart)
  + `async function ensureMigrationsTable() {
  await ensureMigrationIntegrityColumns(db)
}`
  + source.slice(ensureEnd)

replaceOnce(
  `async function applyMigration(filename) {
  const fullPath = path.join(migrationsDir, filename);

  console.log(\`Applying: \${filename}\`);`,
  `async function applyMigration(filename) {
  const fullPath = path.join(migrationsDir, filename);
  const checksumSha256 = migrationFileChecksum(fullPath);

  console.log(\`Applying: \${filename}\`);`,
  'apply-time checksum',
)

replaceOnce(
  `  } else if (sql.includes('@sqlite-continue-on-idempotent-errors')) {
    await db.withTransaction((tx) => {`,
  `  } else if (sql.includes('@sqlite-continue-on-idempotent-errors')) {
    await db.withTransaction(async (tx) => {`,
  'async SQLite idempotent transaction',
)
replaceOnce(
  `    await db.withTransaction((tx) => {
      tx.exec(sql);`,
  `    await db.withTransaction(async (tx) => {
      tx.exec(sql);`,
  'async SQLite standard transaction',
)

replaceCount(
  "await tx.prepare('INSERT INTO _migrations (name) VALUES (?)').run(filename)",
  'await recordMigrationApplied(tx, filename, checksumSha256, APPLIED_BYTES_PROVENANCE)',
  3,
  'asynchronous migration ledger writes',
)
replaceCount(
  "tx.prepare('INSERT INTO _migrations (name) VALUES (?)').run(filename);",
  'await recordMigrationApplied(tx, filename, checksumSha256, APPLIED_BYTES_PROVENANCE);',
  2,
  'synchronous SQLite migration ledger writes',
)

replaceOnce(
  `async function recordAsApplied(filename, note) {
  try {
    await db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(filename);`,
  `async function recordAsApplied(filename, note) {
  try {
    const fullPath = path.join(migrationsDir, filename)
    const checksumSha256 = migrationFileChecksum(fullPath)
    await recordMigrationApplied(
      db,
      filename,
      checksumSha256,
      IDEMPOTENT_RECORD_PROVENANCE,
    );`,
  'idempotent ledger write',
)

replaceOnce(
  `  const applied = await getAppliedSet();
  const files = listSqlMigrations(migrationsDir);
  const pending = files.filter((f) => !applied.has(f));`,
  `  const files = listSqlMigrations(migrationsDir);
  const integrity = await verifyOrBaselineMigrationLedger(db, migrationsDir, files)
  console.log(
    \`Migration checksum ledger: checked=\${integrity.checked} applied_bytes=\${integrity.applied_bytes} baselined=\${integrity.baselined} legacy_or_idempotent=\${integrity.legacy_or_idempotent}\`,
  )
  const applied = await getAppliedSet();
  const pending = files.filter((f) => !applied.has(f));`,
  'migration ledger verification before pending calculation',
)

fs.writeFileSync(file, source)
console.log('Applied migration-ledger checksum patch.')
