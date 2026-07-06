/**
 * relevanceFilterRules.test.js
 *
 * Validates the structural integrity of RELEVANCE_RULES.
 * These tests ensure every rule has the required fields, no duplicate IDs,
 * valid RegExp patterns, and callable profileCheck functions.
 * They do NOT test filter behavior — that is covered by other tests.
 */
import { describe, it, expect } from 'vitest'
import { RELEVANCE_RULES } from '../services/relevanceFilterRules.js'

const REQUIRED_FIELDS = ['id', 'category', 'description', 'oppPattern', 'profileCheck', 'reason']

describe('RELEVANCE_RULES structure', () => {
  it('exports a non-empty array', () => {
    expect(Array.isArray(RELEVANCE_RULES)).toBe(true)
    expect(RELEVANCE_RULES.length).toBeGreaterThan(0)
  })

  it('every rule has all required fields', () => {
    for (const rule of RELEVANCE_RULES) {
      for (const field of REQUIRED_FIELDS) {
        expect(rule, `Rule "${rule.id}" is missing field "${field}"`).toHaveProperty(field)
      }
    }
  })

  it('no duplicate rule IDs', () => {
    const ids = RELEVANCE_RULES.map((r) => r.id)
    const unique = new Set(ids)
    expect(ids.length).toBe(unique.size)
  })

  it('every rule id is a non-empty string', () => {
    for (const rule of RELEVANCE_RULES) {
      expect(typeof rule.id).toBe('string')
      expect(rule.id.length).toBeGreaterThan(0)
    }
  })

  it('every rule category is a non-empty string', () => {
    for (const rule of RELEVANCE_RULES) {
      expect(typeof rule.category, `Rule "${rule.id}" category`).toBe('string')
      expect(rule.category.length, `Rule "${rule.id}" category is empty`).toBeGreaterThan(0)
    }
  })

  it('every rule oppPattern is either null or a RegExp', () => {
    for (const rule of RELEVANCE_RULES) {
      const p = rule.oppPattern
      const valid = p === null || p instanceof RegExp
      expect(valid, `Rule "${rule.id}" oppPattern must be null or RegExp, got ${typeof p}`).toBe(true)
    }
  })

  it('every rule profileCheck is a function', () => {
    for (const rule of RELEVANCE_RULES) {
      expect(
        typeof rule.profileCheck,
        `Rule "${rule.id}" profileCheck must be a function`,
      ).toBe('function')
    }
  })

  it('every rule reason is a non-empty string or function', () => {
    for (const rule of RELEVANCE_RULES) {
      const r = rule.reason
      const valid = (typeof r === 'string' && r.length > 0) || typeof r === 'function'
      expect(valid, `Rule "${rule.id}" reason must be a non-empty string or function`).toBe(true)
    }
  })

  it('profileCheck does not throw when called with empty objects', () => {
    const emptyProfile = {}
    const emptyOppText = ''
    const emptyOpportunity = {}
    for (const rule of RELEVANCE_RULES) {
      expect(() => {
        rule.profileCheck(emptyProfile, emptyOppText, emptyOpportunity)
      }, `Rule "${rule.id}" profileCheck threw with empty inputs`).not.toThrow()
    }
  })

  it('there are at least 15 rules (covering the original rule set)', () => {
    expect(RELEVANCE_RULES.length).toBeGreaterThanOrEqual(15)
  })
})

// ── Research-org recognition (the Axiom BioLabs false-rejection class) ────────
// A profile that DECLARES research capability via organization_type must not be
// rejected by the research-institution content gates, while individuals,
// families, and community nonprofits still are.
describe('research-institution rules recognize declared research organizations', () => {
  const researchRule = RELEVANCE_RULES.find((r) => r.id === 'research_institution_only')
  const piRule = RELEVANCE_RULES.find((r) => r.id === 'content_pi_institution_restricted')

  const axiomLike = {
    primary_type: 'organization',
    organization_type: 'Biotechnology / research organization',
  }
  const family = { primary_type: 'family' }
  const church = { primary_type: 'church' }

  it('research_institution_only PASSES a declared research org and still rejects individuals', () => {
    // profileCheck returns true = REJECT
    expect(researchRule.profileCheck(axiomLike, '', {})).toBe(false)
    expect(researchRule.profileCheck(family, '', {})).toBe(true)
  })

  it('research_institution_only still rejects a church (no research declaration)', () => {
    expect(researchRule.profileCheck(church, '', {})).toBe(true)
  })

  it('PI/institution-restricted rule passes a declared research org', () => {
    expect(piRule.profileCheck(axiomLike, '', {})).toBe(false)
  })

  it('classic institution primary_types still pass', () => {
    for (const t of ['university', 'hospital', 'research_institution']) {
      expect(researchRule.profileCheck({ primary_type: t }, '', {})).toBe(false)
    }
  })
})
