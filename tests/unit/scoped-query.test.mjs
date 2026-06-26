import test from 'node:test'
import assert from 'node:assert/strict'

import {
  analyzeProfileScope,
  assertProfileScopedSql,
  runProfileContext,
  ProfileScopeError,
  PROFILE_SCOPED_TABLES,
} from '../../backend/db/scopedQuery.js'

test('analyzeProfileScope: flags SELECT on grants without profile_id', () => {
  const r = analyzeProfileScope('SELECT * FROM grants WHERE id = ?')
  assert.equal(r.isScoped, true)
  assert.deepEqual(r.tables, ['grants'])
  assert.equal(r.hasProfilePredicate, false)
})

test('analyzeProfileScope: passes when profile_id = $N predicate present', () => {
  const r = analyzeProfileScope('SELECT * FROM grants WHERE id = $1 AND profile_id = $2')
  assert.equal(r.hasProfilePredicate, true)
})

test('analyzeProfileScope: passes when profile_id = ? predicate present', () => {
  const r = analyzeProfileScope('SELECT * FROM opportunities WHERE profile_id = ?')
  assert.equal(r.hasProfilePredicate, true)
})

test('analyzeProfileScope: passes when profile_id IN (...) predicate present', () => {
  const r = analyzeProfileScope('SELECT * FROM applications WHERE profile_id IN ($1,$2)')
  assert.equal(r.hasProfilePredicate, true)
})

test('analyzeProfileScope: DDL is out of scope', () => {
  const r = analyzeProfileScope('CREATE INDEX idx_x ON grants(fingerprint)')
  assert.equal(r.isScoped, false)
})

test('analyzeProfileScope: INSERT into scoped table with profile_id column passes', () => {
  const r = analyzeProfileScope('INSERT INTO grants (id, profile_id, title) VALUES (?, ?, ?)')
  assert.equal(r.hasProfilePredicate, true)
})

test('assertProfileScopedSql: throws by default when profile claim is active', () => {
  const bad = () =>
    runProfileContext({ profileId: 'p1', actorRole: 'user' }, () =>
      assertProfileScopedSql('SELECT * FROM grants WHERE id = ?'),
    )
  assert.throws(bad, ProfileScopeError)
})

test('assertProfileScopedSql: warn-only deployment mode does not throw', () => {
  process.env.PROFILE_SCOPE_MODE = 'warn'
  const originalWarn = console.warn
  console.warn = () => {}
  try {
    runProfileContext({ profileId: 'p1', actorRole: 'user' }, () => {
      assertProfileScopedSql('SELECT * FROM grants WHERE id = ?')
    })
  } finally {
    console.warn = originalWarn
    delete process.env.PROFILE_SCOPE_MODE
  }
})

test('assertProfileScopedSql: admin_global bypasses the guard', () => {
  process.env.PROFILE_SCOPE_STRICT = '1'
  try {
    runProfileContext({ profileId: 'p1', actorRole: 'admin_global' }, () => {
      assertProfileScopedSql('SELECT * FROM grants WHERE id = ?')
    })
  } finally {
    delete process.env.PROFILE_SCOPE_STRICT
  }
})

test('assertProfileScopedSql: no context = no-op (boot/migrations)', () => {
  assertProfileScopedSql('SELECT * FROM grants')
})

test('allowlist: covers the seven tenant-owned tables called out by admin scans', () => {
  for (const t of ['grants', 'opportunities', 'saved_grants', 'applications', 'documents', 'matches', 'decisions']) {
    assert.ok(PROFILE_SCOPED_TABLES.has(t), `missing ${t}`)
  }
})
