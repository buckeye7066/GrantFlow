import { describe, it, expect } from 'vitest'
import { deriveNihSearchText, deduplicateOpportunities } from '../services/crawlerFramework.js'

describe('crawlerFramework helpers', () => {
  it('deriveNihSearchText returns empty string when no context', () => {
    expect(deriveNihSearchText(null)).toBe('')
    expect(deriveNihSearchText({})).toBe('')
    expect(deriveNihSearchText({ signals: {} })).toBe('')
  })

  it('deriveNihSearchText pulls up to 3 unique lowercase terms from signals', () => {
    const ctx = {
      signals: {
        primary_keywords: ['Cancer Research', 'cancer research', 'Oncology'],
        needs: ['Pediatric Care'],
        focus_areas: ['rural health'],
      },
    }
    const text = deriveNihSearchText(ctx)
    const terms = text.split(',').map((s) => s.trim()).filter(Boolean)
    expect(terms.length).toBeLessThanOrEqual(3)
    // Dedup is case-insensitive, so "Cancer Research" and "cancer research" collapse.
    expect(terms).toContain('cancer research')
  })

  it('deriveNihSearchText accepts nested profile.signals shape', () => {
    const ctx = { profile: { signals: { primary_keywords: ['diabetes'] } } }
    expect(deriveNihSearchText(ctx)).toContain('diabetes')
  })

  it('deduplicateOpportunities keeps first by source+source_id', () => {
    const a = { source: 's', source_id: '1', title: 'First' }
    const b = { source: 's', source_id: '1', title: 'Second (dup)' }
    const c = { source: 's', source_id: '2', title: 'Other' }
    const out = deduplicateOpportunities([a, b, c])
    expect(out).toHaveLength(2)
    expect(out[0].title).toBe('First')
    expect(out[1].title).toBe('Other')
  })
})
