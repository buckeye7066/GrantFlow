import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildDatabaseMigrationIdentity,
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

function fakeDb(rows, dialect = 'postgres') {
  return {
    dialect,
    prepare(sql) {
      assert.match(sql, /FROM _migrations/)
      return {
        async all() {
          return rows
        },
      }
    },
  }
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

  assert.equal(identity.contract, 'grantflow-release-identity-v1')
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

test('database migration identity matches only the exact ordered release set', async () => {
  const repoRoot = fixtureRepo()
  clearReleaseIdentityCaches()
  const releaseIdentity = buildRepositoryReleaseIdentity({
    repoRoot,
    commit: 'c'.repeat(40),
    useCache: false,
  })
  const rows = [
    { id: 1, name: '0001_first.sql', applied_at: '2026-01-01T00:00:00Z' },
    { id: 2, name: '0002_second.mjs', applied_at: '2026-01-02T00:00:00Z' },
  ]

  const exact = await buildDatabaseMigrationIdentity(fakeDb(rows), {
    repoRoot,
    releaseIdentity,
  })
  assert.equal(exact.available, true)
  assert.equal(exact.matches_release, true)
  assert.equal(exact.order_matches, true)
  assert.deepEqual(exact.pending, [])
  assert.deepEqual(exact.unexpected, [])
  assert.equal(exact.applied_sha256, exact.expected_sha256)
  assert.equal(exact.expected_sha256, releaseIdentity.migration_sets.postgres.manifest_sha256)
  assert.equal(exact.historical_applied_bytes_attested, false)
  assert.equal(
    exact.hash_provenance,
    'release_file_hashes_mapped_to_ordered_database_migration_names',
  )

  const reversed = await buildDatabaseMigrationIdentity(fakeDb([...rows].reverse()), {
    repoRoot,
    releaseIdentity,
  })
  assert.equal(reversed.matches_release, false)
  assert.equal(reversed.order_matches, false)

  const missing = await buildDatabaseMigrationIdentity(fakeDb(rows.slice(0, 1)), {
    repoRoot,
    releaseIdentity,
  })
  assert.equal(missing.matches_release, false)
  assert.deepEqual(missing.pending, ['0002_second.mjs'])

  const unexpected = await buildDatabaseMigrationIdentity(fakeDb([
    ...rows,
    { id: 3, name: '9999_unknown.sql', applied_at: '2026-01-03T00:00:00Z' },
  ]), {
    repoRoot,
    releaseIdentity,
  })
  assert.equal(unexpected.matches_release, false)
  assert.deepEqual(unexpected.unexpected, ['9999_unknown.sql'])
})

test('sha256 helper is a stable content address', () => {
  assert.equal(
    sha256('grantflow'),
    'a1db17ff41dadd2c51b5e991ba7cb9013651618d9dd28a756ef8e34e62394a02',
  )
})
