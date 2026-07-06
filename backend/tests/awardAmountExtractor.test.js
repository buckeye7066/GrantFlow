import { describe, it, expect } from 'vitest'
import {
  extractAwardAmountsFromText,
  resolveOpportunityAmounts,
} from '../services/awardAmountExtractor.js'

describe('extractAwardAmountsFromText — per-award dollar extraction', () => {
  it('parses an explicit range', () => {
    expect(extractAwardAmountsFromText('Awards range from $1,000 to $5,000 per student.'))
      .toEqual({ amount_min: 1000, amount_max: 5000, matched: 'range' })
    expect(extractAwardAmountsFromText('Grants between $500 and $2,500 are available.'))
      .toEqual({ amount_min: 500, amount_max: 2500, matched: 'range' })
    expect(extractAwardAmountsFromText('Scholarships of $1,000-$10,000.'))
      .toEqual({ amount_min: 1000, amount_max: 10000, matched: 'range' })
  })

  it('parses "up to" as a ceiling', () => {
    expect(extractAwardAmountsFromText('Apply for up to $10,000 in scholarship support.'))
      .toEqual({ amount_min: null, amount_max: 10000, matched: 'up_to' })
    expect(extractAwardAmountsFromText('A maximum of $7,500 will be awarded per applicant.'))
      .toEqual({ amount_min: null, amount_max: 7500, matched: 'up_to' })
    expect(extractAwardAmountsFromText('Requests may not exceed $25,000.'))
      .toEqual({ amount_min: null, amount_max: 25000, matched: 'up_to' })
  })

  it('parses exact single-award phrasings (both orders)', () => {
    expect(extractAwardAmountsFromText('One-time scholarship of $2,500 for paramedic students.'))
      .toEqual({ amount_min: 2500, amount_max: 2500, matched: 'single' })
    expect(extractAwardAmountsFromText('The foundation offers a $1,500 grant to local churches.'))
      .toEqual({ amount_min: 1500, amount_max: 1500, matched: 'single' })
    expect(extractAwardAmountsFromText('Selected students receive $3,000 per year.'))
      .toEqual({ amount_min: 3000, amount_max: 3000, matched: 'single' })
  })

  it('understands k / million multipliers', () => {
    expect(extractAwardAmountsFromText('Grants of up to $1.5 million for research infrastructure.').amount_max)
      .toBe(1500000)
    expect(extractAwardAmountsFromText('A $10k award recognizes community leadership.').amount_max)
      .toBe(10000)
  })

  it('REJECTS program-total phrasings (precision over recall)', () => {
    expect(extractAwardAmountsFromText('The foundation has awarded a total of $2,000,000 since 1998.').matched)
      .toBeNull()
    expect(extractAwardAmountsFromText('More than $5,000,000 in scholarships awarded annually.').matched)
      .toBeNull()
    expect(extractAwardAmountsFromText('With an endowment of $40,000, the fund supports local students... ').matched)
      .toBeNull()
  })

  it('rejects implausible values and amount-free text', () => {
    expect(extractAwardAmountsFromText('Scholarship of $25 for essay entries.').matched).toBeNull()
    expect(extractAwardAmountsFromText('Award of $999,999,999 for everyone.').matched).toBeNull()
    expect(extractAwardAmountsFromText('Amount varies by need and enrollment status.').matched).toBeNull()
    expect(extractAwardAmountsFromText('').matched).toBeNull()
    expect(extractAwardAmountsFromText(null).matched).toBeNull()
  })
})

describe('resolveOpportunityAmounts — structured wins, extraction fills', () => {
  it('keeps structured adapter numbers untouched', () => {
    const r = resolveOpportunityAmounts({
      amount_min: 100, amount_max: 900,
      description: 'up to $50,000', // must NOT override structured values
    })
    expect(r).toEqual({ amount_min: 100, amount_max: 900, extracted: false })
  })

  it('extracts from title/description only when both structured fields are absent', () => {
    const r = resolveOpportunityAmounts({
      title: 'Community Paramedic Scholarship',
      description: 'Awards of up to $5,000 for EMS students in Bradley County.',
    })
    expect(r).toEqual({ amount_min: null, amount_max: 5000, extracted: true })
  })

  it('honestly returns nulls when nothing is derivable', () => {
    const r = resolveOpportunityAmounts({ title: 'Local Grant', description: 'Amount varies.' })
    expect(r).toEqual({ amount_min: null, amount_max: null, extracted: false })
  })
})
