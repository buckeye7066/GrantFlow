import { describe, expect, it } from 'vitest'
import { buildProfileSignals, hasTextValue, isSentinelText } from '../services/profileHelpers.js'
import { containsAffirmedTermWholeWord, stripNegatedClauses } from '../services/shared/textMatch.js'

// A placeholder that says "no value" is an ABSENCE, never a fact. A live
// student profile carried `medicaid_waiver_program: "none"` and was read as a
// Medicaid-waiver participant (owner finding 2026-09-05); 37 of 51 production
// profiles carry at least one such field.

function signalsFor(sections, profile = { id: 'student-a', primary_type: 'student', display_name: 'Student A' }) {
  return buildProfileSignals({ profile, sections })
}

describe('sentinel text values', () => {
  it('recognises the placeholder vocabulary and nothing else', () => {
    for (const v of ['none', 'None', ' N/A ', 'n/a', 'unknown', 'Not applicable', 'not provided', 'None reported.', '-', '']) {
      expect(hasTextValue(v), v).toBe(false)
    }
    for (const v of ['none of the above programs, only WIC', 'ECF CHOICES', 'Katie Beckett', 'HCBS waiver through TennCare']) {
      expect(hasTextValue(v), v).toBe(true)
    }
    expect(isSentinelText('none')).toBe(true)
    expect(isSentinelText('ECF CHOICES')).toBe(false)
  })

  it('medicaid_waiver_program "none" is no waiver, "ECF CHOICES" is', () => {
    const none = signalsFor({ government_assistance: { medicaid_waiver_program: 'none', ecf_choices_role: '' } })
    expect(none.assistance.has('medicaid_waiver')).toBe(false)
    expect(none.assistance.has('ecf_choices')).toBe(false)
    expect(none.keywordSet.has('medicaid waiver')).toBe(false)
    expect(none.keywordSet.has('none')).toBe(false)

    const ecf = signalsFor({ government_assistance: { medicaid_waiver_program: 'ECF CHOICES', ecf_choices_role: 'participant' } })
    expect(ecf.assistance.has('medicaid_waiver')).toBe(true)
    expect(ecf.assistance.has('ecf_choices')).toBe(true)
  })

  it('sentinel free-text fields register no keywords', () => {
    const s = signalsFor({
      health_medical: { support_needs_level: 'unknown', chronic_illness_type: 'none' },
      demographics: { tribal_affiliation: 'N/A', religious_affiliation: 'none', citizenship: 'unknown' },
    })
    for (const junk of ['unknown', 'none', 'n/a', 'unknown support needs']) {
      expect(s.keywordSet.has(junk), junk).toBe(false)
    }
  })
})

describe('status words read in context', () => {
  it('a student whose status is "Unemployed" has no job-loss hardship', () => {
    const s = signalsFor({ employment: { current_status: 'Unemployed', notes: 'High school student focused on academics' } })
    expect(s.assistance.has('unemployed')).toBe(false)
    expect(s.needs.has('employment')).toBe(false)
    expect(s.needs_structured.has('employment')).toBe(false)
  })

  it('a non-student "Unemployed" status still declares the hardship', () => {
    const s = signalsFor(
      { employment: { current_status: 'Unemployed', notes: 'Laid off in March' } },
      { id: 'adult-a', primary_type: 'individual', display_name: 'Adult A' },
    )
    expect(s.assistance.has('unemployed')).toBe(true)
    expect(s.needs.has('employment')).toBe(true)
  })

  it('English plus a second language is bilingual, not non-English-speaking', () => {
    const bilingual = signalsFor({ demographics: { languages: ['English', 'Russian'] } })
    expect(bilingual.demographics.has('non_english_speaker')).toBe(false)
    expect(bilingual.keywordSet.has('bilingual')).toBe(true)
    expect(bilingual.keywordSet.has('esl')).toBe(false)

    const noEnglish = signalsFor({ demographics: { languages: ['Spanish'] } })
    expect(noEnglish.demographics.has('non_english_speaker')).toBe(true)
    expect(noEnglish.keywordSet.has('esl')).toBe(true)
  })
})

describe('denied clauses are not evidence', () => {
  it('stripNegatedClauses drops only the clauses that carry a negation cue', () => {
    const text = 'No military affiliation or documentation indicating veteran status. Served two years in AmeriCorps; wants a job.'
    expect(stripNegatedClauses(text)).toBe(' Served two years in AmeriCorps; wants a job.')
    expect(containsAffirmedTermWholeWord('No small business details provided in the profile.', 'small business')).toBe(false)
    expect(containsAffirmedTermWholeWord('Runs a small business selling produce.', 'small business')).toBe(true)
  })

  it('notes that deny a fact register none of its vocabulary', () => {
    const s = signalsFor({
      military_service: { veteran: false, notes: 'No military affiliation or documentation indicating veteran status, active duty, or dependency on military personnel.' },
      small_business_details: { notes: 'No small business details provided in the profile.' },
    })
    expect(s.keywordSet.has('veteran')).toBe(false)
    expect(s.keywordSet.has('small business')).toBe(false)
    expect(s.intentPhrases.has('small business')).toBe(false)
    expect(s.military.size).toBe(0)
  })
})
