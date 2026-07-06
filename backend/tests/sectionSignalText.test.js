import { describe, it, expect } from 'vitest'
import { sectionSignalText, profileContextToThesisInput } from '../services/crawlerOsPersistence.js'

// The Axiom 13-bucket class (2026-07-06): profile sections were fed to the
// thesis blob as raw JSON.stringify, so every FIELD NAME — including fields
// explicitly declared FALSE ({ firefighter: false }) — injected its words into
// the free-text applicant/need keyword scans.
describe('sectionSignalText — section data → honest signal text', () => {
  it('false/null field names never leak; true booleans keep their humanized meaning', () => {
    const text = sectionSignalText({
      firefighter: false,
      veteran: false,
      healthcare_worker_type: '',
      ssi_recipient_household: true,
      disability_status: 'Has disability',
      nested: { ems_worker: false, chronic_illness: true },
      conditions: [],
    })
    expect(text).not.toContain('firefighter')
    expect(text).not.toContain('veteran')
    expect(text).not.toMatch(/\bems worker\b/)
    expect(text).toContain('ssi recipient household')
    expect(text).toContain('chronic illness')
    expect(text).toContain('Has disability')
  })

  it('keeps strings/numbers/arrays and survives junk input', () => {
    expect(sectionSignalText({ amount: 500, list: ['a', 'b'] })).toBe('500 a b')
    expect(sectionSignalText(null)).toBe('')
    expect(sectionSignalText('plain text')).toBe('plain text')
  })

  it('profileContextToThesisInput uses signal text for section bodies (no JSON keys)', () => {
    const input = profileContextToThesisInput({
      profile: { id: 'p1', primary_type: 'organization' },
      sections: { occupation: { firefighter: false, notes: 'Runs a biotech lab.' } },
    })
    const occ = input.sections.find((s) => s.title === 'occupation')
    expect(occ.body).toBe('Runs a biotech lab.')
    expect(occ.body).not.toContain('firefighter')
  })
})
