/**
 * Award-summary builder — awarded vs applied split, totals, and "from where".
 */
import { describe, it, expect } from 'vitest'
import { buildAwardSummary } from '../services/awardSummary.js'

describe('buildAwardSummary', () => {
  it('splits committed-college aid into awarded vs applied and totals each', () => {
    const s = buildAwardSummary({
      collegeName: 'MTSU',
      aidEntries: [
        { name: 'Merit', amount: 4000, status: 'awarded', source: 'MTSU Financial Aid' },
        { name: 'Pending one', amount: 3000, status: 'applied', source: 'MTSU Financial Aid' },
        { name: 'Legacy (no status)', amount: 1000 }, // counts as awarded
      ],
    })
    expect(s.awarded.total).toBe(5000)
    expect(s.awarded.count).toBe(2)
    expect(s.applied.total).toBe(3000)
    expect(s.total_in_play).toBe(8000)
    expect(s.awarded.items[0].from).toBe('MTSU')
  })

  it('maps grant rows: amount_awarded → awarded, sponsor/funder → from, source_url → source', () => {
    const s = buildAwardSummary({
      grantRows: [
        { title: 'State Grant', amount_awarded: 2500, status: 'awarded', funder: 'TN Arts', source_url: 'https://tn.gov/x' },
        { title: 'Applied Grant', amount_requested: 1500, status: 'submitted', sponsor: 'NSF', source_url: 'https://nsf.gov' },
      ],
    })
    const awarded = s.awarded.items.find((i) => i.name === 'State Grant')
    expect(awarded.amount).toBe(2500)
    expect(awarded.from).toBe('TN Arts')
    expect(awarded.source).toBe('https://tn.gov/x')
    const applied = s.applied.items.find((i) => i.name === 'Applied Grant')
    expect(applied.amount).toBe(1500)
    expect(applied.from).toBe('NSF')
  })

  it('handles empty inputs', () => {
    const s = buildAwardSummary({})
    expect(s.total_in_play).toBe(0)
    expect(s.awarded.items).toEqual([])
  })
})
