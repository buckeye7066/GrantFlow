/**
 * v4-fixes.test.js
 *
 * Unit tests for v4 improvements:
 * - State normalization utility
 * - Opportunity expiration detection
 * - Category matching improvements
 * - Match engine scoring floor
 */
import { describe, it, expect } from 'vitest'

// ── State Normalization ──────────────────────────────────────────────────────

describe('State Normalization', () => {
  let normalizeState, statesMatch, stateFullName, isValidState

  it('should load the module', async () => {
    const mod = await import('../../backend/utils/stateNormalization.js')
    normalizeState = mod.normalizeState
    statesMatch = mod.statesMatch
    stateFullName = mod.stateFullName
    isValidState = mod.isValidState
    expect(normalizeState).toBeDefined()
    expect(statesMatch).toBeDefined()
  })

  it('normalizes abbreviations', async () => {
    const { normalizeState } = await import('../../backend/utils/stateNormalization.js')
    expect(normalizeState('TN')).toBe('TN')
    expect(normalizeState('tn')).toBe('TN')
    expect(normalizeState('Tn')).toBe('TN')
    expect(normalizeState('CA')).toBe('CA')
    expect(normalizeState('ny')).toBe('NY')
  })

  it('normalizes full names', async () => {
    const { normalizeState } = await import('../../backend/utils/stateNormalization.js')
    expect(normalizeState('Tennessee')).toBe('TN')
    expect(normalizeState('TENNESSEE')).toBe('TN')
    expect(normalizeState('tennessee')).toBe('TN')
    expect(normalizeState('California')).toBe('CA')
    expect(normalizeState('New York')).toBe('NY')
    expect(normalizeState('West Virginia')).toBe('WV')
    expect(normalizeState('District of Columbia')).toBe('DC')
  })

  it('handles edge cases', async () => {
    const { normalizeState } = await import('../../backend/utils/stateNormalization.js')
    expect(normalizeState(null)).toBeNull()
    expect(normalizeState(undefined)).toBeNull()
    expect(normalizeState('')).toBeNull()
    expect(normalizeState('  ')).toBeNull()
    expect(normalizeState('XZ')).toBeNull()
    expect(normalizeState('Not A State')).toBeNull()
  })

  it('statesMatch compares correctly', async () => {
    const { statesMatch } = await import('../../backend/utils/stateNormalization.js')
    expect(statesMatch('TN', 'Tennessee')).toBe(true)
    expect(statesMatch('tn', 'TN')).toBe(true)
    expect(statesMatch('California', 'CA')).toBe(true)
    expect(statesMatch('TN', 'CA')).toBe(false)
    expect(statesMatch('TN', null)).toBe(false)
    expect(statesMatch(null, null)).toBe(false)
  })

  it('stateFullName returns correct names', async () => {
    const { stateFullName } = await import('../../backend/utils/stateNormalization.js')
    expect(stateFullName('TN')).toBe('Tennessee')
    expect(stateFullName('CA')).toBe('California')
    expect(stateFullName('DC')).toBe('District of Columbia')
    expect(stateFullName('XX')).toBeNull()
    expect(stateFullName(null)).toBeNull()
  })

  it('isValidState validates correctly', async () => {
    const { isValidState } = await import('../../backend/utils/stateNormalization.js')
    expect(isValidState('TN')).toBe(true)
    expect(isValidState('Tennessee')).toBe(true)
    expect(isValidState('XZ')).toBe(false)
    expect(isValidState('')).toBe(false)
  })
})

// ── Opportunity Expiration ───────────────────────────────────────────────────

describe('Opportunity Expiration Detection', () => {
  it('detects expired fixed-deadline opportunities', async () => {
    const { isExpired } = await import('../../backend/services/shared/opportunityPolicy.js')

    // Past deadline → expired
    expect(isExpired({ deadline: '2020-01-01', deadline_type: 'fixed' })).toBe(true)
    expect(isExpired({ deadline: '2023-06-30' })).toBe(true)
  })

  it('does not expire rolling deadlines', async () => {
    const { isExpired } = await import('../../backend/services/shared/opportunityPolicy.js')

    expect(isExpired({ deadline: '2020-01-01', deadline_type: 'rolling' })).toBe(false)
    expect(isExpired({ deadline_type: 'rolling' })).toBe(false)
  })

  it('does not expire opportunities without deadlines', async () => {
    const { isExpired } = await import('../../backend/services/shared/opportunityPolicy.js')

    expect(isExpired({})).toBe(false)
    expect(isExpired({ deadline: null })).toBe(false)
    expect(isExpired({ deadline: '' })).toBe(false)
  })

  it('does not expire future deadlines', async () => {
    const { isExpired } = await import('../../backend/services/shared/opportunityPolicy.js')

    const future = new Date()
    future.setFullYear(future.getFullYear() + 1)
    expect(isExpired({ deadline: future.toISOString() })).toBe(false)
  })

  it('handles invalid date strings', async () => {
    const { isExpired } = await import('../../backend/services/shared/opportunityPolicy.js')

    expect(isExpired({ deadline: 'not-a-date' })).toBe(false)
    expect(isExpired({ deadline: 'TBD' })).toBe(false)
  })

  it('enforceOpportunityPolicy rejects expired opportunities', async () => {
    const { enforceOpportunityPolicy } = await import('../../backend/services/shared/opportunityPolicy.js')

    const expired = {
      title: 'Expired Grant',
      url: 'https://example-real.org/expired',
      deadline: '2020-01-01',
      deadline_type: 'fixed',
    }
    const result = enforceOpportunityPolicy(expired)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('expired_deadline')
  })

  it('enforceOpportunityPolicy allows expired when opt-in', async () => {
    const { enforceOpportunityPolicy } = await import('../../backend/services/shared/opportunityPolicy.js')

    const expired = {
      title: 'Expired Grant',
      url: 'https://example-real.org/expired',
      deadline: '2020-01-01',
      deadline_type: 'fixed',
    }
    const result = enforceOpportunityPolicy(expired, { allowExpired: true })
    expect(result.ok).toBe(true)
  })
})

// ── Match Engine Scoring Floor ───────────────────────────────────────────────

describe('Match Engine Scoring Floor', () => {
  it('partial matches never score zero', async () => {
    const { scoreProgram } = await import('../../backend/services/crawlers/matchEngine.js')

    // A program with no category overlap but not hard-gated
    const program = {
      id: 'test-1',
      name: 'Generic Program',
      url: 'https://example-real.org/program',
      categories: ['agriculture'],
      type: 'grant',
    }
    const analysis = {
      location: { state: 'TN' },
      applicantType: 'individual',
      needs: new Set(['housing']),
      demographics: new Set(),
      health: new Set(),
      family: new Set(),
      military: new Set(),
      occupation: new Set(),
      immigration: new Set(),
      geographic: new Set(),
      income: {},
      education: {},
      interests: new Set(),
      sports: new Set(),
      keywords: [],
    }

    const result = scoreProgram(program, analysis)
    // Should not be null (not hard-gated)
    expect(result).not.toBeNull()
    // Should have a score >= 5 (the floor)
    expect(result.matchScore).toBeGreaterThanOrEqual(5)
  })
})

// ── State Normalization in Match Engine ──────────────────────────────────────

describe('Match Engine State Normalization', () => {
  it('matches TN with Tennessee in scoring', async () => {
    const { scoreProgram } = await import('../../backend/services/crawlers/matchEngine.js')

    const program = {
      id: 'tn-prog',
      name: 'TN Program',
      url: 'https://example-real.org/tn',
      categories: ['housing'],
      stateRestriction: 'Tennessee',
    }
    const analysis = {
      location: { state: 'TN' },
      applicantType: 'individual',
      needs: new Set(['housing']),
      demographics: new Set(),
      health: new Set(),
      family: new Set(),
      military: new Set(),
      occupation: new Set(),
      immigration: new Set(),
      geographic: new Set(),
      income: {},
      education: {},
      interests: new Set(),
      sports: new Set(),
      keywords: [],
    }

    const result = scoreProgram(program, analysis)
    expect(result).not.toBeNull()
    // Should get full state match points (20), not mismatch penalty
    const localityScore = result.match_explain?.scoreBreakdown?.locality
    expect(localityScore).toBe(20)
    expect(result.matchReasons).toEqual(expect.arrayContaining([
      expect.stringContaining('Available in TN'),
    ]))
  })
})
