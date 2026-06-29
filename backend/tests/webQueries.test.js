/**
 * Unit tests for backend/crawler-os/webQueries.js
 */
import { describe, it, expect } from 'vitest'
import { buildWebQueries } from '../crawler-os/webQueries.js'

describe('buildWebQueries', () => {
  it('builds need + geo keyed queries for a real thesis', () => {
    const thesis = {
      applicant_types: ['nonprofit'],
      needs: ['youth services', 'after school'],
      location: { state: 'TN', city: 'Nashville' },
    }
    const qs = buildWebQueries(thesis, { year: 2026 })
    expect(qs.length).toBeGreaterThan(0)
    expect(qs.length).toBeLessThanOrEqual(6)
    // need + type + geo present
    expect(qs.some((q) => /youth services/i.test(q) && /Nashville, TN/.test(q))).toBe(true)
    // community foundation place-based query
    expect(qs.some((q) => /community foundation grants Nashville, TN/i.test(q))).toBe(true)
    // deduped
    expect(new Set(qs).size).toBe(qs.length)
  })

  it('still returns a usable query for a sparse profile', () => {
    const qs = buildWebQueries({ applicant_types: ['individual'], needs: [], location: {} }, { year: 2026 })
    expect(qs.length).toBeGreaterThanOrEqual(1)
    expect(qs[0].length).toBeGreaterThan(6)
  })

  it('maps applicant buckets to readable words', () => {
    const qs = buildWebQueries({ applicant_types: ['vfd'], needs: ['equipment'], location: { state: 'OH' } })
    expect(qs.some((q) => /volunteer fire department/i.test(q))).toBe(true)
  })
})
