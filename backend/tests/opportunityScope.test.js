/**
 * Unit tests for backend/services/opportunityScope.js.
 *
 * These pin the exact shape of the scope clauses that user-facing SELECTs
 * depend on, so accidental regressions (e.g. "bug fix" that drops profile
 * scope) show up immediately instead of leaking another profile's data into
 * a discovery response.
 */

import { describe, it, expect } from 'vitest'
import { withOpportunityScope, resolveIsAdmin } from '../services/opportunityScope.js'

describe('withOpportunityScope', () => {
  it('adds is_active + profile gate when no WHERE exists', () => {
    const res = withOpportunityScope('SELECT * FROM funding_opportunities', { profileId: 'p1' })
    expect(res.sql).toMatch(/WHERE is_active = 1/)
    expect(res.sql).toMatch(/profile_id IS NULL OR profile_id = \?/)
    expect(res.params).toEqual(['p1'])
  })

  it('uses AND when caller already has a WHERE', () => {
    const res = withOpportunityScope(
      "SELECT * FROM funding_opportunities WHERE opportunity_type = 'grant'",
      { profileId: 'p2' },
    )
    expect(res.sql).toMatch(/WHERE opportunity_type = 'grant' AND is_active = 1/)
    expect(res.params).toEqual(['p2'])
  })

  it('restricts to public rows when no profile id is given', () => {
    const res = withOpportunityScope('SELECT * FROM funding_opportunities', {})
    expect(res.sql).toMatch(/profile_id IS NULL/)
    expect(res.sql).not.toMatch(/profile_id = \?/)
    expect(res.params).toEqual([])
  })

  it('collapses to is_active only when isAdmin=true', () => {
    const res = withOpportunityScope('SELECT * FROM funding_opportunities', { isAdmin: true, profileId: 'p1' })
    expect(res.sql).toBe('SELECT * FROM funding_opportunities WHERE is_active = 1')
    expect(res.params).toEqual([])
  })

  it('injects minSourceTrust with NULL passthrough', () => {
    const res = withOpportunityScope('SELECT * FROM funding_opportunities', {
      profileId: 'p1',
      minSourceTrust: 40,
    })
    expect(res.sql).toMatch(/source_trust IS NULL OR source_trust >= \?/)
    expect(res.params).toContain(40)
  })

  it('injects state/is_national filter when states provided', () => {
    const res = withOpportunityScope('SELECT * FROM funding_opportunities', {
      profileId: 'p1',
      states: ['oh', 'MI', 'pa'],
    })
    expect(res.sql).toMatch(/is_national = 1 OR state IS NULL OR state IN \(\?,\?,\?\)/)
    expect(res.params.slice(-3)).toEqual(['OH', 'MI', 'PA'])
  })

  it('respects ORDER BY / LIMIT tail', () => {
    const res = withOpportunityScope(
      'SELECT * FROM funding_opportunities ORDER BY updated_at DESC LIMIT 100',
      { profileId: 'p1' },
    )
    // scope must be injected before ORDER BY
    expect(res.sql.indexOf('is_active = 1')).toBeLessThan(res.sql.indexOf('ORDER BY'))
    expect(res.sql.endsWith('ORDER BY updated_at DESC LIMIT 100')).toBe(true)
  })

  it('switches boolean literal for postgres dialect', () => {
    const res = withOpportunityScope('SELECT * FROM funding_opportunities', {
      profileId: 'p1',
      states: ['OH'],
      dialect: 'postgres',
    })
    expect(res.sql).toMatch(/is_active = TRUE/)
    expect(res.sql).toMatch(/is_national = TRUE/)
  })
})

describe('resolveIsAdmin', () => {
  it('returns false when req is missing or user absent', () => {
    expect(resolveIsAdmin(null)).toBe(false)
    expect(resolveIsAdmin({})).toBe(false)
    expect(resolveIsAdmin({ user: null })).toBe(false)
  })

  it('accepts explicit isAdmin flag', () => {
    expect(resolveIsAdmin({ user: { isAdmin: true } })).toBe(true)
    expect(resolveIsAdmin({ user: { isAdmin: false } })).toBe(false)
  })

  it('accepts role array containing admin', () => {
    expect(resolveIsAdmin({ user: { roles: ['user', 'admin'] } })).toBe(true)
    expect(resolveIsAdmin({ user: { roles: ['user'] } })).toBe(false)
  })

  it('accepts role string "admin"', () => {
    expect(resolveIsAdmin({ user: { role: 'Admin' } })).toBe(true)
    expect(resolveIsAdmin({ user: { role: 'member' } })).toBe(false)
  })
})
