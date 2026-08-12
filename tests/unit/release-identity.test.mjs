import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildDatabaseMigrationIdentity,
  buildEvidenceArtifact,
  buildMigrationSetManifest,
  buildRepositoryReleaseIdentity,
  canonicalJson,
  clearReleaseIdentityCaches,
  resolveReleaseCommit,
  sha256,
} from '../../shared/releaseIdentity.js'

function fixtureRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grantflow-release-identity-'))
  fs.mkdirSync(path.join(repoRoot, 'backend/db/postgres/migrations'), { recursive: true })
  fs.mkdirSync(path.join(repoRoot, 'backend/db/migrations'), { recursive: true })
  fs.mkdirSync(path.join(repoRoot, 'docs/production-readiness'), { recursive: true })
  fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ version: '1.2.3' }))
  fs.writeFileSync(
    path.join(repoRoot, 'backend/db/postgres/migrations/0001_first.sql'),
    'CREATE TABLE first_table (id TEXT);\n',
  )
  fs.writeFileSync(
    path.join(repoRoot, 'backend/db/postgres/migrations/0002_second.mjs'),
    'export default async function up() {}\n',
  )
  fs.writeFileSync(
    path.join(repoRoot, 'backend/db/migrations/001_first.sql'),
    'CREATE TABLE first_table (id TEXT);\n',
  )
  fs.writeFileSync(
    path.join(repoRoot, 'docs/production-readiness/grantflow.md'),
    '# GrantFlow release evidence\n',
  )
  return repoRoot
}

function fakeDb(rows, {
  dialect = 'postgres',
  checksumColumns = true,
} = {}) {
  return {
    dialect,
    prepare(sql) {
      assert.match(sql, /FROM _migrations/)
      if (!checksumColumns && /checksum_sha256/.test(sql)) {
        throw new Error('no such column: checksum_sha256')
      }
      return {
        async all() {
          return rows
        },
      }
    },
  }
}

function ledgerRows(manifest, provenance = 'applied_bytes') {
  return manifest.files.map((file, index) => ({
    id: index + 1,
    name: file.name,
    checksum_sha256: file.sha256,
    checksum_provenance: provenance,
    applied_at: `2026-01-0${index + 1}T00:00:00Z`,
  }))
}

test('release identity uses canonical JSON and exact provider SHAs', () => {
  assert.equal(
    canonicalJson({ z: 1, a: { d: 4, b: 2 } }),
    '{"a":{"b":2,"d":4},"z":1}',
  )
  const commit = 'a'.repeat(40)
  assert.deepEqual(resolveReleaseCommit({ RAILWAY_GIT_COMMIT_SHA: commit }), {
    commit,
    source: 'RAILWAY_GIT_COMMIT_SHA',
  })
  assert.deepEqual(resolveReleaseCommit({ RAILWAY_GIT_COMMIT_SHA: 'short' }), {
    commit: null,
    source: 'unavailable_local_build',
  })
})

test('repository release identity binds commit, migration sets, and evidence artifact', () => {
  const repoRoot = fixtureRepo()
  clearReleaseIdentityCaches()
  const commit = 'b'.repeat(40)
  const identity = buildRepositoryReleaseIdentity({
    repoRoot,
    commit,
    useCache: false,
  })

  assert.equal(identity.contract, 'grantflow-release-identity-v2')
  assert.equal(identity.commit, commit)
  assert.equal(identity.package_version, '1.2.3')
  assert.equal(identity.migration_sets.postgres.file_count, 2)
  assert.equal(identity.migration_sets.sqlite.file_count, 1)
  assert.match(identity.migration_sets.postgres.manifest_sha256, /^[0-9a-f]{64}$/)
  assert.equal(identity.evidence_artifact.path, 'docs/production-readiness/grantflow.md')
  assert.match(identity.evidence_artifact.sha256, /^[0-9a-f]{64}$/)
  assert.match(identity.manifest_sha256, /^[0-9a-f]{64}$/)

  const repeated = buildRepositoryReleaseIdentity({
    repoRoot,
    commit,
    useCache: false,
  })
  assert.deepEqual(repeated, identity)

  fs.appendFileSync(
    path.join(repoRoot, 'docs/production-readiness/grantflow.md'),
    'Changed evidence.\n',
  )
  clearReleaseIdentityCaches()
  const changed = buildRepositoryReleaseIdentity({
    repoRoot,
    commit,
    useCache: false,
  })
  assert.notEqual(changed.evidence_artifact.sha256, identity.evidence_artifact.sha256)
  assert.notEqual(changed.manifest_sha256, identity.manifest_sha256)
})

test('migration manifests use deterministic code-unit ordering', () => {
  const repoRoot = fixtureRepo()
  fs.writeFileSync(
    path.join(repoRoot, 'backend/db/postgres/migrations/0003_z.sql'),
    'SELECT 1;\n',
  )
  fs.writeFileSync(
    path.join(repoRoot, 'backend/db/postgres/migrations/0003_ä.sql'),
    'SELECT 2;\n',
  )
  const manifest = buildMigrationSetManifest({
    repoRoot,
    dialect: 'postgres',
    useCache: false,
  })
  assert.deepEqual(
    manifest.files.map((file) => file.name),
    ['0001_first.sql', '0002_second.mjs', '0003_z.sql', '0003_ä.sql'],
  )
})

test('artifact and migration hashing refuse traversal and symlink escapes', () => {
  const repoRoot = fixtureRepo()
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grantflow-release-outside-'))
  const outsideFile = path.join(outsideDir, 'outside.sql')
  fs.writeFileSync(outsideFile, 'SELECT secret;\n')

  assert.throws(
    () => buildEvidenceArtifact({ repoRoot, relativePath: '../outside.sql' }),
    /repository-relative|escapes the canonical repository root/,
  )

  const evidenceLink = path.join(repoRoot, 'docs/production-readiness/escape.md')
  fs.symlinkSync(outsideFile, evidenceLink)
  assert.throws(
    () => buildEvidenceArtifact({ repoRoot, relativePath: 'docs/production-readiness/escape.md' }),
    /escapes the canonical repository root/,
  )

  const migrationLink = path.join(repoRoot, 'backend/db/postgres/migrations/0003_escape.sql')
  fs.symlinkSync(outsideFile, migrationLink)
  assert.throws(
    () => buildMigrationSetManifest({ repoRoot, dialect: 'postgres', useCache: false }),
    /escapes the canonical repository root/,
  )
})

test('migration-set hash changes when a migration byte changes', () => {
  const repoRoot = fixtureRepo()
  clearReleaseIdentityCaches()
  const before = buildMigrationSetManifest({
    repoRoot,
    dialect: 'postgres',
    useCache: false,
  })
  fs.appendFileSync(
    path.join(repoRoot, 'backend/db/postgres/migrations/0001_first.sql'),
    '-- changed\n',
  )
  const after = buildMigrationSetManifest({
    repoRoot,
    dialect: 'postgres',
    useCache: false,
  })
  assert.notEqual(after.manifest_sha256, before.manifest_sha256)
  assert.notEqual(after.files[0].sha256, before.files[0].sha256)
})

test('database identity requires stored checksums matching the exact canonical release set', async () => {
  const repoRoot = fixtureRepo()
  clearReleaseIdentityCaches()
  const releaseIdentity = buildRepositoryReleaseIdentity({
    repoRoot,
    commit: 'c'.repeat(40),
    useCache: false,
  })
  const manifest = buildMigrationSetManifest({
    repoRoot,
    dialect: 'postgres',
    useCache: false,
  })
  const rows = ledgerRows(manifest)

  const exact = await buildDatabaseMigrationIdentity(fakeDb(rows), {
    repoRoot,
    releaseIdentity,
  })
  assert.equal(exact.available, true)
  assert.equal(exact.matches_release, true)
  assert.equal(exact.order_matches, true)
  assert.equal(exact.name_parity_matches, true)
  assert.equal(exact.checksums_match, true)
  assert.equal(exact.stored_checksum_complete, true)
  assert.equal(exact.historical_applied_bytes_attested, true)
  assert.deepEqual(exact.pending, [])
  assert.deepEqual(exact.unexpected, [])
  assert.deepEqual(exact.checksum_missing, [])
  assert.deepEqual(exact.checksum_mismatches, [])
  assert.equal(exact.applied_sha256, exact.expected_sha256)
  assert.equal(exact.expected_sha256, releaseIdentity.migration_sets.postgres.manifest_sha256)
  assert.equal(
    exact.hash_provenance,
    'stored_database_migration_checksums_compared_with_release_file_hashes',
  )

  const reversed = await buildDatabaseMigrationIdentity(fakeDb([...rows].reverse()), {
    repoRoot,
    releaseIdentity,
  })
  assert.equal(reversed.matches_release, true)
  assert.equal(reversed.order_matches, false)
  assert.equal(reversed.name_parity_matches, true)
  assert.equal(reversed.applied_sha256, reversed.expected_sha256)

  const missing = await buildDatabaseMigrationIdentity(fakeDb(rows.slice(0, 1)), {
    repoRoot,
    releaseIdentity,
  })
  assert.equal(missing.matches_release, false)
  assert.deepEqual(missing.pending, ['0002_second.mjs'])

  const changedChecksumRows = rows.map((row) => ({ ...row }))
  changedChecksumRows[0].checksum_sha256 = 'd'.repeat(64)
  const changed = await buildDatabaseMigrationIdentity(fakeDb(changedChecksumRows), {
    repoRoot,
    releaseIdentity,
  })
  assert.equal(changed.matches_release, false)
  assert.equal(changed.checksums_match, false)
  assert.deepEqual(changed.checksum_mismatches, [{
    name: '0001_first.sql',
    stored_sha256: 'd'.repeat(64),
    release_sha256: manifest.files[0].sha256,
  }])
})

test('name parity without stored checksums remains non-authoritative', async () => {
  const repoRoot = fixtureRepo()
  const releaseIdentity = buildRepositoryReleaseIdentity({
    repoRoot,
    commit: 'e'.repeat(40),
    useCache: false,
  })
  const rows = [
    { id: 1, name: '0001_first.sql', applied_at: '2026-01-01T00:00:00Z' },
    { id: 2, name: '0002_second.mjs', applied_at: '2026-01-02T00:00:00Z' },
  ]
  const identity = await buildDatabaseMigrationIdentity(
    fakeDb(rows, { checksumColumns: false }),
    { repoRoot, releaseIdentity },
  )

  assert.equal(identity.name_parity_matches, true)
  assert.equal(identity.checksum_columns_available, false)
  assert.equal(identity.stored_checksum_complete, false)
  assert.equal(identity.matches_release, false)
  assert.deepEqual(identity.checksum_missing, ['0001_first.sql', '0002_second.mjs'])
})

test('legacy checksum baselines are transparent about historical-byte uncertainty', async () => {
  const repoRoot = fixtureRepo()
  const releaseIdentity = buildRepositoryReleaseIdentity({
    repoRoot,
    commit: 'f'.repeat(40),
    useCache: false,
  })
  const manifest = buildMigrationSetManifest({
    repoRoot,
    dialect: 'postgres',
    useCache: false,
  })
  const identity = await buildDatabaseMigrationIdentity(
    fakeDb(ledgerRows(manifest, 'legacy_baseline_current_release')),
    { repoRoot, releaseIdentity },
  )

  assert.equal(identity.matches_release, true)
  assert.equal(identity.historical_applied_bytes_attested, false)
  assert.deepEqual(identity.checksum_provenance_counts, {
    legacy_baseline_current_release: 2,
  })
})

test('sha256 helper is a stable content address', () => {
  assert.equal(
    sha256('grantflow'),
    'a1db17ff41dadd2c51b5e991ba7cb9013651618d9dd28a756ef8e34e62394a02',
  )
})
