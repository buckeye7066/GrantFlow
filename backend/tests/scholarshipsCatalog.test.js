import { describe, it, expect } from 'vitest'
import { SCHOLARSHIPS } from '../services/shared/data/scholarships.js'

/**
 * Data-contract guard for the curated scholarship catalog.
 *
 * seedScholarships.toCanonical() drops any entry missing id/name/url and
 * upserts on source_id, so a duplicate id silently overwrites a sibling and a
 * malformed url seeds a dead link. This asserts the contract the seed relies on
 * and pins the 2026-08-03 "beat a free Google search" national-scholarship
 * expansion so a future edit cannot silently remove it.
 */
describe('curated scholarship catalog integrity', () => {
  it('every entry has a stable id, a name, and an https url', () => {
    for (const s of SCHOLARSHIPS) {
      expect(typeof s.id, `id on ${s.name}`).toBe('string')
      expect(s.id.length).toBeGreaterThan(0)
      expect(typeof s.name).toBe('string')
      expect(s.name.length).toBeGreaterThan(0)
      expect(typeof s.url, `url on ${s.id}`).toBe('string')
      expect(s.url).toMatch(/^https:\/\//)
    }
  })

  it('has no duplicate source ids (upsert key)', () => {
    const ids = SCHOLARSHIPS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('includes the major national scholarships, scoped to students', () => {
    const nationalIds = [
      'sch-coca-cola-scholars', 'sch-gates-scholarship', 'sch-jkcf-college',
      'sch-dell-scholars', 'sch-elks-mvs', 'sch-hsf', 'sch-uncf',
      'sch-questbridge-match', 'sch-burger-king-scholars', 'sch-davidson-fellows',
      'sch-regeneron-sts', 'sch-point-foundation', 'sch-horatio-alger',
      'sch-national-merit', 'sch-ron-brown',
    ]
    const byId = new Map(SCHOLARSHIPS.map((s) => [s.id, s]))
    for (const id of nationalIds) {
      const s = byId.get(id)
      expect(s, `${id} present`).toBeTruthy()
      // National awards must not carry a state restriction (they surface for
      // every student profile, not one state).
      expect(s.stateRestriction ?? s.state ?? null, `${id} is national`).toBeNull()
      expect(s.eligibility?.requiresStudent, `${id} requires student`).toBe(true)
      // Direct aid only — no loans, no matching funds (mission rule).
      expect(s.fundingType).not.toBe('loan')
    }
  })

  it('exposes the ScholarshipOwl-style aggregator directory (DOL finder)', () => {
    const byId = new Map(SCHOLARSHIPS.map((s) => [s.id, s]))
    const s = byId.get('sch-careeronestop-finder')
    expect(s, 'sch-careeronestop-finder present').toBeTruthy()
    expect(s.type).toBe('directory')
  })
})
