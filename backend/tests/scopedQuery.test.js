import { describe, it, expect } from 'vitest'
import {
  analyzeProfileScope,
  assertProfileScopedSql,
  runProfileContext,
  ProfileScopeError,
  ORG_KEYED_PROFILE_TABLES,
} from '../db/scopedQuery.js'

// The exact org-branch query from GET /api/matching/profile/:id/grants that
// 500'd in prod on 2026-07-13 (ProfileScopeError for any non-admin whose
// profile has an organization_id). organization_id is a first-class tenant
// key on grants, so this must pass the guard.
const ORG_BRANCH_MATCHING_SQL = `
  SELECT g.id AS grant_id, g.title AS grant_title, g.funder AS grant_funder,
         g.status AS grant_status, g.deadline AS grant_deadline, g.notes AS grant_notes,
         g.funding_opportunity_id, fo.*
  FROM grants g
  LEFT JOIN funding_opportunities fo ON fo.id = g.funding_opportunity_id
  WHERE g.organization_id = ?
  ORDER BY g.updated_at DESC, g.created_at DESC`

const TENANT_CTX = {
  profileId: 'profile-josh-dasher',
  userId: 'user-1',
  actorRole: 'enduser',
  route: 'GET /api/matching/profile/profile-josh-dasher/grants',
}

function assertUnderTenant(sql) {
  return runProfileContext(TENANT_CTX, () => assertProfileScopedSql(sql))
}

describe('analyzeProfileScope — org-keyed tenant predicates', () => {
  it('accepts a param-bound organization_id equality on grants', () => {
    const a = analyzeProfileScope(ORG_BRANCH_MATCHING_SQL)
    expect(a.isScoped).toBe(true)
    expect(a.tables).toEqual(['grants'])
    expect(a.hasProfilePredicate).toBe(false)
    expect(a.hasOrgKeyPredicate).toBe(true)
  })

  it('accepts organization_id IN (...) on grants', () => {
    const a = analyzeProfileScope('SELECT * FROM grants WHERE organization_id IN (?, ?)')
    expect(a.hasOrgKeyPredicate).toBe(true)
  })

  it('accepts Postgres-style $N placeholders', () => {
    const a = analyzeProfileScope('SELECT * FROM grants g WHERE g.organization_id = $1')
    expect(a.hasOrgKeyPredicate).toBe(true)
  })

  it('rejects a LITERAL organization_id value (not param-bound)', () => {
    const a = analyzeProfileScope("SELECT * FROM grants WHERE organization_id = 'org-1'")
    expect(a.hasOrgKeyPredicate).toBe(false)
  })

  it('rejects a bare organization_id mention with no predicate', () => {
    const a = analyzeProfileScope('SELECT organization_id FROM grants')
    expect(a.hasOrgKeyPredicate).toBe(false)
  })

  it('rejects the org key when the query joins a non-org-keyed scoped table', () => {
    const a = analyzeProfileScope(
      `SELECT * FROM grants g JOIN anya_sessions s ON s.profile_id = g.profile_id
       WHERE g.organization_id = ?`,
    )
    expect(a.tables).toEqual(expect.arrayContaining(['grants', 'anya_sessions']))
    expect(a.hasOrgKeyPredicate).toBe(false)
  })

  it('org-keyed set only contains tables that actually carry organization_id', () => {
    expect([...ORG_KEYED_PROFILE_TABLES].sort()).toEqual(['documents', 'grants'])
  })
})

describe('assertProfileScopedSql — strict mode under a claimed profile', () => {
  it('passes the prod org-branch matching query (the 2026-07-13 regression)', () => {
    expect(() => assertUnderTenant(ORG_BRANCH_MATCHING_SQL)).not.toThrow()
  })

  it('still throws on an unscoped grants SELECT', () => {
    expect(() => assertUnderTenant('SELECT * FROM grants')).toThrow(ProfileScopeError)
  })

  it('still throws when organization_id is only a literal', () => {
    expect(() => assertUnderTenant("SELECT * FROM grants WHERE organization_id = 'org-1'")).toThrow(
      ProfileScopeError,
    )
  })

  it('still passes a profile_id-scoped SELECT', () => {
    expect(() => assertUnderTenant('SELECT * FROM grants WHERE profile_id = ?')).not.toThrow()
  })

  it('still throws for non-org-keyed profile tables even with an org predicate', () => {
    expect(() =>
      assertUnderTenant('SELECT * FROM anya_sessions WHERE organization_id = ?'),
    ).toThrow(ProfileScopeError)
  })
})
