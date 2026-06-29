import { describe, it, expect } from 'vitest'
import { buildGrantScopeFromContext } from '../utils/accessControl.js'

describe('buildGrantScopeFromContext', () => {
  it('returns an unfiltered clause for admins', () => {
    expect(buildGrantScopeFromContext({ isAdmin: true })).toEqual({ sql: '1 = 1', params: [] })
  })

  it('treats a null access set (access-layer "all") as unfiltered', () => {
    expect(
      buildGrantScopeFromContext({ isAdmin: false, accessibleProfileIds: null, accessibleOrgIds: null }),
    ).toEqual({ sql: '1 = 1', params: [] })
  })

  it('scopes a regular user to their accessible orgs and profiles', () => {
    const scope = buildGrantScopeFromContext({
      isAdmin: false,
      accessibleProfileIds: new Set(['p1', 'p2']),
      accessibleOrgIds: new Set(['o1']),
    })
    expect(scope.sql).toBe('(organization_id IN (?) OR profile_id IN (?, ?))')
    expect(scope.params).toEqual(['o1', 'p1', 'p2'])
  })

  it('matches nothing (honest zeros) when the user has no access at all', () => {
    const scope = buildGrantScopeFromContext({
      isAdmin: false,
      accessibleProfileIds: new Set(),
      accessibleOrgIds: new Set(),
    })
    expect(scope.sql).toBe('(1 = 0 OR 1 = 0)')
    expect(scope.params).toEqual([])
  })

  it('handles a missing context defensively (no access)', () => {
    const scope = buildGrantScopeFromContext(undefined)
    expect(scope.sql).toBe('(1 = 0 OR 1 = 0)')
    expect(scope.params).toEqual([])
  })
})
