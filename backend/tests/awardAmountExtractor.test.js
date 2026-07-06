import { describe, it, expect } from 'vitest'
import {
  extractAwardAmountsFromText,
  resolveOpportunityAmounts,
} from '../services/awardAmountExtractor.js'

describe('extractAwardAmountsFromText — per-award dollar extraction', () => {
  it('parses an explicit range', () => {
    expect(extractAwardAmountsFromText('Awards range from $1,000 to $5,000 per student.'))
      .toMatchObject({ amount_min: 1000, amount_max: 5000, matched: 'range', amount_status: 'range' })
    expect(extractAwardAmountsFromText('Grants between $500 and $2,500 are available.'))
      .toMatchObject({ amount_min: 500, amount_max: 2500, matched: 'range' })
    expect(extractAwardAmountsFromText('Scholarships of $1,000-$10,000.'))
      .toMatchObject({ amount_min: 1000, amount_max: 10000, matched: 'range' })
  })

  it('parses "up to" as a ceiling', () => {
    expect(extractAwardAmountsFromText('Apply for up to $10,000 in scholarship support.'))
      .toMatchObject({ amount_min: null, amount_max: 10000, matched: 'up_to', amount_status: 'range' })
    expect(extractAwardAmountsFromText('A maximum of $7,500 will be awarded per applicant.'))
      .toMatchObject({ amount_min: null, amount_max: 7500, matched: 'up_to' })
    expect(extractAwardAmountsFromText('Requests may not exceed $25,000.'))
      .toMatchObject({ amount_min: null, amount_max: 25000, matched: 'up_to' })
  })

  it('parses exact single-award phrasings (both orders)', () => {
    expect(extractAwardAmountsFromText('One-time scholarship of $2,500 for paramedic students.'))
      .toMatchObject({ amount_min: 2500, amount_max: 2500, matched: 'single', amount_status: 'known' })
    expect(extractAwardAmountsFromText('The foundation offers a $1,500 grant to local churches.'))
      .toMatchObject({ amount_min: 1500, amount_max: 1500, matched: 'single' })
    expect(extractAwardAmountsFromText('Selected students receive $3,000 per year.'))
      .toMatchObject({ amount_min: 3000, amount_max: 3000, matched: 'single' })
  })

  it('parses labeled amounts ("award amount: $X") as exact', () => {
    expect(extractAwardAmountsFromText('Scholarship amount: $2,500 per academic year.'))
      .toMatchObject({ amount_min: 2500, amount_max: 2500, matched: 'labeled', amount_status: 'known' })
    expect(extractAwardAmountsFromText('The grant amount is $10,000.'))
      .toMatchObject({ amount_min: 10000, amount_max: 10000, matched: 'labeled' })
  })

  it('parses minimum/floor-only phrasings as a range floor', () => {
    expect(extractAwardAmountsFromText('Minimum award of $500; larger requests considered.'))
      .toMatchObject({ amount_min: 500, amount_max: null, matched: 'minimum', amount_status: 'range' })
    expect(extractAwardAmountsFromText('Awards start at $1,000.'))
      .toMatchObject({ amount_min: 1000, amount_max: null, matched: 'minimum' })
  })

  it('parses average award as an ESTIMATE (not an exact amount)', () => {
    expect(extractAwardAmountsFromText('The average award is $4,500.'))
      .toMatchObject({ amount_min: 4500, amount_max: 4500, matched: 'average', amount_status: 'estimated' })
    expect(extractAwardAmountsFromText('Typical grant size of $25,000 for first-time applicants.'))
      .toMatchObject({ matched: 'average', amount_status: 'estimated' })
    // lower confidence than an explicit range
    const avg = extractAwardAmountsFromText('Average award of $5,000.')
    const range = extractAwardAmountsFromText('Awards range from $1,000 to $5,000.')
    expect(avg.amount_confidence).toBeLessThan(range.amount_confidence)
  })

  it('handles stipend / reimbursement / matching-funds phrasings', () => {
    expect(extractAwardAmountsFromText('Monthly stipend of $1,200 for fellows.'))
      .toMatchObject({ amount_min: 1200, matched: 'single' })
    expect(extractAwardAmountsFromText('Reimbursement of $2,000 for approved expenses.'))
      .toMatchObject({ amount_min: 2000, matched: 'single' })
    expect(extractAwardAmountsFromText('Tuition reimbursement up to $5,250 per year.'))
      .toMatchObject({ amount_max: 5250, matched: 'up_to' })
    expect(extractAwardAmountsFromText('Matching funds up to $50,000 available for capital projects.'))
      .toMatchObject({ amount_max: 50000, matched: 'up_to' })
  })

  it('understands k / million multipliers', () => {
    expect(extractAwardAmountsFromText('Grants of up to $1.5 million for research infrastructure.').amount_max)
      .toBe(1500000)
    expect(extractAwardAmountsFromText('A $10k award recognizes community leadership.').amount_max)
      .toBe(10000)
  })

  it('REJECTS program-total phrasings as amounts (precision over recall)', () => {
    expect(extractAwardAmountsFromText('The foundation has awarded a total of $2,000,000 since 1998.').matched)
      .toBeNull()
    expect(extractAwardAmountsFromText('More than $5,000,000 in scholarships awarded annually.').matched)
      .toBeNull()
    expect(extractAwardAmountsFromText('With an endowment of $40,000, the fund supports local students... ').matched)
      .toBeNull()
  })

  it('preserves a program-total EXCERPT as amount_text (status stays not_listed)', () => {
    const r = extractAwardAmountsFromText('Total funding available: $500,000 for the 2026 cycle.')
    expect(r.matched).toBeNull()
    expect(r.amount_min).toBeNull()
    expect(r.amount_max).toBeNull()
    expect(r.amount_status).toBe('not_listed')
    expect(r.amount_text).toContain('$500,000')
  })

  it('detects "varies" and "contact funder" statuses without inventing numbers', () => {
    const varies = extractAwardAmountsFromText('Award amounts vary based on demonstrated need.')
    expect(varies).toMatchObject({ amount_min: null, amount_max: null, amount_status: 'varies' })
    expect(varies.amount_text).toBeTruthy()

    const contact = extractAwardAmountsFromText('Contact the funder for award amounts and deadlines.')
    expect(contact).toMatchObject({ amount_min: null, amount_max: null, amount_status: 'contact_required' })
  })

  it('rejects implausible values and empty text', () => {
    expect(extractAwardAmountsFromText('Scholarship of $25 for essay entries.').matched).toBeNull()
    expect(extractAwardAmountsFromText('Award of $999,999,999 for everyone.').matched).toBeNull()
    expect(extractAwardAmountsFromText('').matched).toBeNull()
    expect(extractAwardAmountsFromText(null).matched).toBeNull()
    expect(extractAwardAmountsFromText('').amount_status).toBe('not_listed')
  })
})

describe('resolveOpportunityAmounts — structured wins, extraction fills', () => {
  it('keeps structured adapter numbers untouched (status derived, high confidence)', () => {
    const r = resolveOpportunityAmounts({
      amount_min: 100, amount_max: 900,
      description: 'up to $50,000', // must NOT override structured values
    })
    expect(r).toMatchObject({
      amount_min: 100, amount_max: 900, extracted: false, amount_status: 'range',
    })
    expect(r.amount_confidence).toBeGreaterThan(0.9)
  })

  it('marks structured exact amounts (min === max) as known', () => {
    const r = resolveOpportunityAmounts({ amount_min: 2500, amount_max: 2500 })
    expect(r.amount_status).toBe('known')
  })

  it('extracts from title/description only when both structured fields are absent', () => {
    const r = resolveOpportunityAmounts({
      title: 'Community Paramedic Scholarship',
      description: 'Awards of up to $5,000 for EMS students in Bradley County.',
    })
    expect(r).toMatchObject({
      amount_min: null, amount_max: 5000, extracted: true, amount_status: 'range',
    })
    expect(r.amount_text).toContain('$5,000')
  })

  it('preserves a short human amount_description as text with an honest status', () => {
    const r = resolveOpportunityAmounts({
      title: 'Local Grant',
      amount_description: 'Varies',
    })
    expect(r.amount_min).toBeNull()
    expect(r.amount_text).toBe('Varies')
    expect(r.amount_status).toBe('varies')
  })

  it('honestly returns not_listed when nothing is derivable', () => {
    const r = resolveOpportunityAmounts({ title: 'Local Grant', description: 'Serving our community since 1985.' })
    expect(r).toMatchObject({
      amount_min: null, amount_max: null, extracted: false,
      amount_text: null, amount_status: 'not_listed', amount_confidence: null,
    })
  })
})
