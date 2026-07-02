import test from 'node:test'
import assert from 'node:assert/strict'

import {
  analyzeProfileScope,
  assertProfileScopedSql,
  runProfileContext,
  ProfileScopeError,
  PROFILE_SCOPED_TABLES,
  DUAL_SCOPE_TABLES,
  ORG_SCOPED_TABLES,
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

// --- Dual-scope tier: funding_opportunities -------------------------------

test('tier allowlists: funding_opportunities is dual-scope, organizations is org-scoped', () => {
  assert.ok(DUAL_SCOPE_TABLES.has('funding_opportunities'))
  assert.ok(ORG_SCOPED_TABLES.has('organizations'))
})

test('funding_opportunities: canonical dual-scope read clause passes', () => {
  const r = analyzeProfileScope(
    'SELECT * FROM funding_opportunities WHERE (profile_id IS NULL OR profile_id = ?) AND is_active = 1',
  )
  assert.equal(r.fundingReadViolation, false)
  assert.equal(r.fundingWriteViolation, false)
})

test('funding_opportunities: global-only read (profile_id IS NULL) passes', () => {
  const r = analyzeProfileScope('SELECT * FROM funding_opportunities WHERE profile_id IS NULL AND state = ?')
  assert.equal(r.fundingReadViolation, false)
})

test('funding_opportunities: id-targeted read passes', () => {
  const r = analyzeProfileScope('SELECT * FROM funding_opportunities WHERE id = ? LIMIT 1')
  assert.equal(r.fundingReadViolation, false)
})

test('funding_opportunities: catalog-wide read is flagged as a read violation (observability tier)', () => {
  const r = analyzeProfileScope('SELECT * FROM funding_opportunities WHERE is_active = 1 ORDER BY created_at DESC')
  assert.equal(r.fundingReadViolation, true)
  assert.equal(r.fundingWriteViolation, false)
})

test('funding_opportunities: unscoped catalog read under a claim warns but does NOT throw by default', () => {
  const originalWarn = console.warn
  console.warn = () => {}
  try {
    runProfileContext({ profileId: 'p1', actorRole: 'user' }, () => {
      const ctx = {}
      assertProfileScopedSql('SELECT * FROM funding_opportunities WHERE is_active = 1')
      void ctx
    })
  } finally {
    console.warn = originalWarn
  }
})

test('funding_opportunities: unscoped catalog read throws when PROFILE_SCOPE_FUNDING_READS=strict', () => {
  process.env.PROFILE_SCOPE_FUNDING_READS = 'strict'
  try {
    const bad = () =>
      runProfileContext({ profileId: 'p1', actorRole: 'user' }, () =>
        assertProfileScopedSql('SELECT * FROM funding_opportunities WHERE is_active = 1'),
      )
    assert.throws(bad, ProfileScopeError)
  } finally {
    delete process.env.PROFILE_SCOPE_FUNDING_READS
  }
})

test('funding_opportunities: wholesale UPDATE under a claim throws (write tier is strict)', () => {
  const bad = () =>
    runProfileContext({ profileId: 'p1', actorRole: 'user' }, () =>
      assertProfileScopedSql("UPDATE funding_opportunities SET is_active = 0 WHERE deadline < '2020-01-01'"),
    )
  assert.throws(bad, ProfileScopeError)
})

test('funding_opportunities: row-targeted writes pass (id / fingerprint / profile_id / global-maintenance)', () => {
  for (const sql of [
    'UPDATE funding_opportunities SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?',
    'UPDATE funding_opportunities SET title = ? WHERE fingerprint = ?',
    'DELETE FROM funding_opportunities WHERE profile_id = ?',
    'UPDATE funding_opportunities SET is_active = 1 WHERE profile_id IS NULL',
    'DELETE FROM funding_opportunities WHERE id IN (?, ?)',
  ]) {
    const r = analyzeProfileScope(sql)
    assert.equal(r.fundingWriteViolation, false, `unexpected write violation: ${sql}`)
  }
})

test('funding_opportunities: INSERT (crawl ingestion of global rows) is allowed', () => {
  const r = analyzeProfileScope('INSERT INTO funding_opportunities (id, title, source) VALUES (?, ?, ?)')
  assert.equal(r.fundingReadViolation, false)
  assert.equal(r.fundingWriteViolation, false)
})

test('funding_opportunities: admin role bypasses the write tier', () => {
  runProfileContext({ profileId: 'p1', actorRole: 'admin' }, () => {
    assertProfileScopedSql('UPDATE funding_opportunities SET is_active = 0 WHERE is_active = 1')
  })
})

// --- Org-scoped tier: organizations ---------------------------------------

test('organizations: id-targeted lookup passes', () => {
  const r = analyzeProfileScope('SELECT * FROM organizations WHERE id = ?')
  assert.equal(r.orgViolation, false)
})

test('organizations: id IN accessible-set clause passes', () => {
  const r = analyzeProfileScope('SELECT * FROM organizations WHERE deleted_at IS NULL AND id IN (?, ?, ?)')
  assert.equal(r.orgViolation, false)
})

test('organizations: join through owning row (organization_id linkage) passes', () => {
  const r = analyzeProfileScope(
    'SELECT p.id, o.email FROM profiles p JOIN organizations o ON o.id = p.organization_id WHERE p.id = ?',
  )
  assert.equal(r.orgViolation, false)
})

test('organizations: wholesale read is flagged', () => {
  const r = analyzeProfileScope('SELECT * FROM organizations WHERE deleted_at IS NULL')
  assert.equal(r.orgViolation, true)
})

test('organizations: wholesale read under a non-admin claim throws by default', () => {
  const bad = () =>
    runProfileContext({ profileId: 'p1', actorRole: 'user' }, () =>
      assertProfileScopedSql('SELECT * FROM organizations WHERE deleted_at IS NULL'),
    )
  assert.throws(bad, ProfileScopeError)
})

test('organizations: wholesale read with admin role bypasses', () => {
  runProfileContext({ profileId: 'p1', actorRole: 'admin' }, () => {
    assertProfileScopedSql('SELECT COUNT(*) as c FROM organizations')
  })
})

test('organizations: no active claim = warn-only (boot/system paths unaffected)', () => {
  const originalWarn = console.warn
  console.warn = () => {}
  try {
    runProfileContext({ actorRole: 'user' }, () => {
      assertProfileScopedSql("SELECT id FROM organizations WHERE lower(email) = ?")
    })
  } finally {
    console.warn = originalWarn
  }
})

test('organizations: INSERT (org creation) is allowed', () => {
  const r = analyzeProfileScope('INSERT INTO organizations (id, name) VALUES (?, ?)')
  assert.equal(r.orgViolation, false)
})

test('organizations: wholesale UPDATE under a claim throws', () => {
  const bad = () =>
    runProfileContext({ profileId: 'p1', actorRole: 'user' }, () =>
      assertProfileScopedSql("UPDATE organizations SET notes = 'x'"),
    )
  assert.throws(bad, ProfileScopeError)
})

test('core tables unchanged: grants still requires a profile_id predicate specifically', () => {
  // id-targeting is NOT sufficient for strictly tenant-owned tables.
  const bad = () =>
    runProfileContext({ profileId: 'p1', actorRole: 'user' }, () =>
      assertProfileScopedSql('SELECT * FROM grants WHERE id = ?'),
    )
  assert.throws(bad, ProfileScopeError)
})
