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

  it('emits benefit/assistance queries for a disabled senior individual (not just grants)', () => {
    const thesis = {
      applicant_types: ['individual'],
      needs: ['disability', 'housing', 'energy'],
      keywords: ['senior', 'has disability', 'caregiver'],
      location: { state: 'TN', county: 'Bradley', city: 'Cleveland' },
    }
    // max high enough to include the rotated EXTRA pool (state programs live there).
    const qs = buildWebQueries(thesis, { year: 2026, max: 30 })
    // Universal safety-net locators (help even a sparse profile).
    expect(qs.some((q) => /benefits\.gov/i.test(q))).toBe(true)
    expect(qs.some((q) => /\b211\b/.test(q))).toBe(true)
    // Per-need assistance PROGRAMS, not "grants".
    expect(qs.some((q) => /disability assistance programs/i.test(q))).toBe(true)
    // Demographic-specific: senior (Area Agency on Aging) + disability (voc rehab).
    expect(qs.some((q) => /area agency on aging/i.test(q))).toBe(true)
    expect(qs.some((q) => /vocational rehabilitation/i.test(q))).toBe(true)
    // State benefit programs by name.
    expect(qs.some((q) => /LIHEAP/i.test(q))).toBe(true)
  })

  it('does NOT emit benefit/assistance individual queries for students', () => {
    const thesis = {
      applicant_types: ['student'],
      is_student: true,
      needs: ['disability'],
      keywords: ['senior'],
      location: { state: 'TN' },
    }
    const qs = buildWebQueries(thesis, { year: 2026, max: 14 })
    expect(qs.some((q) => /area agency on aging|vocational rehabilitation|benefits\.gov/i.test(q))).toBe(false)
  })

  it('targets a LEARNED institution gap by forcing the missing school queries', () => {
    const thesis = {
      applicant_types: ['student'], is_student: true, needs: [],
      location: { state: 'TN', county: 'Bradley' },
      learned_gaps: { classes: ['institution_gap'], missing_schools: ['Middle Tennessee State University'] },
    }
    const qs = buildWebQueries(thesis, { year: 2026, max: 14 })
    expect(qs.some((q) => /Middle Tennessee State University scholarships/i.test(q))).toBe(true)
    expect(qs.some((q) => /Middle Tennessee State University foundation scholarships/i.test(q))).toBe(true)
  })

  it('targets a LEARNED low_results gap with broader national fallbacks', () => {
    const thesis = {
      applicant_types: ['individual'], needs: ['disability'], location: { state: 'TN' },
      learned_gaps: { classes: ['low_results'], missing_schools: [] },
    }
    const qs = buildWebQueries(thesis, { year: 2026, max: 30 })
    expect(qs.some((q) => /disability grant funding/i.test(q))).toBe(true)
    expect(qs.some((q) => /TN assistance programs/i.test(q))).toBe(true)
  })

  it('gives a sparse low-income individual the universal safety-net locators', () => {
    const qs = buildWebQueries(
      { applicant_types: ['individual'], needs: [], location: { state: 'TN' } },
      { year: 2026, max: 14 },
    )
    expect(qs.some((q) => /benefits\.gov TN/i.test(q))).toBe(true)
    expect(qs.some((q) => /211 community resources TN/i.test(q))).toBe(true)
  })
})
