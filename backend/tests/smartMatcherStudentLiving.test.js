/**
 * Smart Matcher — Student Living / Cost of Attendance regression suite.
 *
 * Scope: pure-function tests of the intent → primary_category → search_terms
 * pipeline for student housing / off-campus / room-and-board / cost-of-
 * attendance / state student aid queries.
 *
 * Why these matter:
 *   - Original failure: "off-campus living expenses at MTSU" returned only
 *     adult homelessness / Section 8 rows because the intent module didn't
 *     recognize "off-campus", "MTSU", or "living expenses" as student aid.
 *   - These changes are global / permanent so any student profile (Robert
 *     White at CSCC, Anastasia at MTSU, future students at any school)
 *     benefits.
 *   - Acceptance: ≥10 representative student-aid queries that classify as
 *     primary_category='student_aid' AND emit student-aid search terms.
 */

import { describe, it, expect } from 'vitest'
import {
  interpretFundingIntentRules,
  detectPrimaryCategory,
} from '../services/smartMatcherIntent.js'

// ---------------------------------------------------------------------------
// 12 representative student-living queries.
// Each must classify as primary_category='student_aid' and emit at least one
// of the listed expected search terms (substring match, case-insensitive).
// ---------------------------------------------------------------------------
const STUDENT_LIVING_QUERIES = [
  {
    name: 'Off-campus living expenses at MTSU (the regression)',
    text: 'Help me find funding for off-campus living expenses at MTSU',
    expectedTerms: ['off-campus housing', 'cost of attendance', 'fafsa', 'pell grant', 'student housing'],
  },
  {
    name: 'Room and board scholarships',
    text: 'I need scholarships for room and board next semester',
    expectedTerms: ['room and board', 'cost of attendance', 'scholarship', 'student aid'],
  },
  {
    name: 'Cost of attendance gap',
    text: 'How do I close my cost of attendance gap at college',
    expectedTerms: ['cost of attendance', 'student aid', 'fafsa', 'pell grant'],
  },
  {
    name: 'Student rent help',
    text: 'I am a college student and need help paying student rent off campus',
    expectedTerms: ['off-campus housing', 'student housing', 'cost of attendance', 'student aid'],
  },
  {
    name: 'Dorm housing',
    text: 'What scholarships cover dorm housing or residence hall fees?',
    expectedTerms: ['student housing', 'room and board', 'student aid', 'scholarship'],
  },
  {
    name: 'College emergency aid for rent',
    text: 'My rent is overdue and I am in college — is there emergency aid?',
    expectedTerms: ['emergency aid', 'student emergency aid', 'student aid'],
  },
  {
    name: 'FAFSA / Pell',
    text: 'Help me apply for FAFSA and Pell Grant for the upcoming year',
    expectedTerms: ['fafsa', 'pell grant', 'fseog', 'student aid'],
  },
  {
    name: 'Tennessee HOPE Scholarship',
    text: 'Am I eligible for the Tennessee HOPE Scholarship?',
    expectedTerms: ['tennessee hope', 'state student aid', 'scholarship'],
  },
  {
    name: 'Off-campus housing at UCF',
    text: 'I need help with off-campus housing at UCF',
    expectedTerms: ['off-campus housing', 'cost of attendance', 'student housing'],
  },
  {
    name: 'Penn State living costs',
    text: 'How can I get help with living costs at Penn State this year?',
    expectedTerms: ['cost of attendance', 'student housing', 'room and board'],
  },
  {
    name: 'University tuition assistance',
    text: 'University tuition assistance for low-income students',
    expectedTerms: ['scholarship', 'student aid', 'tuition assistance'],
  },
  {
    name: 'Forensic science scholarship + housing',
    text: 'Forensic science scholarship to help pay for off-campus housing',
    expectedTerms: ['off-campus housing', 'cost of attendance', 'scholarship', 'student aid'],
  },
]

describe('Smart Matcher — Student Living / Cost of Attendance', () => {
  describe('Intent classification (primary_category=student_aid)', () => {
    for (const fixture of STUDENT_LIVING_QUERIES) {
      it(`classifies ${fixture.name}`, () => {
        const result = interpretFundingIntentRules(fixture.text)

        // Every student-living query MUST be classified as student_aid OR
        // professional_development (the latter is acceptable for credential
        // queries; not the case for any of these fixtures).
        expect(result.primary_category).toBe('student_aid')

        // student_aid does NOT exclude income_support outright (per the
        // user rule "Population / eligibility mismatches must reduce score,
        // not discard results"). Cross-category capping in routes/matching.js
        // handles the score-vs-include trade-off.
        expect(Array.isArray(result.excluded_categories)).toBe(true)

        const searchTermsLower = result.search_terms.map((t) => String(t).toLowerCase())
        for (const expectedTerm of fixture.expectedTerms) {
          const term = expectedTerm.toLowerCase()
          const hit = searchTermsLower.some((t) => t.includes(term) || term.includes(t))
          expect(hit, `Expected at least one search term containing "${expectedTerm}" — got: ${searchTermsLower.slice(0, 12).join(', ')}`).toBe(true)
        }
      })
    }
  })

  describe('detectPrimaryCategory direct API', () => {
    it('returns student_aid for off-campus / college queries', () => {
      const cat = detectPrimaryCategory('off-campus living expenses at MTSU', [
        'off-campus housing',
        'cost of attendance',
      ])
      expect(cat.primary_category).toBe('student_aid')
    })

    it('returns student_aid for room-and-board scholarships', () => {
      const cat = detectPrimaryCategory('room and board scholarships', [])
      expect(cat.primary_category).toBe('student_aid')
    })

    it('returns student_aid for FAFSA / Pell queries', () => {
      const cat = detectPrimaryCategory('apply for FAFSA and Pell Grant', [])
      expect(cat.primary_category).toBe('student_aid')
    })

    it('keeps professional_development priority over student_aid for PROBE-style queries', () => {
      // Professional development must still win when both signals are present
      // because the user is licensed and asking about their CE — not a student
      // looking for a degree-program scholarship.
      const cat = detectPrimaryCategory('PROBE ethics CE for nursing license reinstatement', [
        'probe ethics',
        'continuing education',
      ])
      expect(cat.primary_category).toBe('professional_development')
    })

    it('returns "general" for non-student housing queries', () => {
      // Sanity: pure rent/eviction/Section 8 with no student signal should
      // NOT be classified as student_aid (so adult-homelessness profiles
      // still get their normal results).
      const cat = detectPrimaryCategory('I am facing eviction and need rental assistance', [
        'rental assistance',
        'eviction',
      ])
      expect(cat.primary_category).toBe('general')
    })
  })

  describe('Late-bound student_aid promotion', () => {
    it('promotes generic "rent help" + college signal to student_aid', () => {
      // The late-bound promotion in interpretFundingIntentRules upgrades
      // primary_category when ANY college/student token appears with a
      // living/rent/expense token — even if the EXPANSION rules didn't fire.
      const result = interpretFundingIntentRules('I need help with rent at university')
      expect(result.primary_category).toBe('student_aid')
    })

    it('promotes "MTSU" + "expenses" to student_aid', () => {
      const result = interpretFundingIntentRules('Cover my expenses at MTSU')
      expect(result.primary_category).toBe('student_aid')
    })

    it('promotes "scholarship" + "rent" to student_aid', () => {
      const result = interpretFundingIntentRules('Scholarship that covers my rent')
      expect(result.primary_category).toBe('student_aid')
    })
  })

  describe('Search term breadth (≥6 terms per query)', () => {
    for (const fixture of STUDENT_LIVING_QUERIES) {
      it(`generates ≥6 terms for: ${fixture.name}`, () => {
        const result = interpretFundingIntentRules(fixture.text)
        expect(result.search_terms.length).toBeGreaterThanOrEqual(6)
      })
    }
  })
})

// ---------------------------------------------------------------------------
// End-to-end smoke test for the original Anastasia / MTSU regression.
//
// This test exercises the SAME pipeline that runs in the route handler and
// asserts that:
//   1. The intent classifier returns primary_category=student_aid.
//   2. Search terms include the keywords needed to hit our seed pool
//      (Pell, FSEOG, Tennessee HOPE, off-campus housing, etc.).
//   3. NATIONAL_PROGRAMS contains the seed rows that those terms would
//      reach (so SQL `LIKE '%pell grant%'` will match Federal Pell Grant).
// ---------------------------------------------------------------------------
import { NATIONAL_PROGRAMS } from '../services/shared/data/nationalPrograms.js'
import { SCHOLARSHIPS } from '../services/shared/data/scholarships.js'

describe('Anastasia / MTSU end-to-end smoke (regression)', () => {
  const ANASTASIA_QUERY = 'Help me find funding for off-campus living expenses at MTSU'

  it('classifies the Anastasia query as student_aid', () => {
    const result = interpretFundingIntentRules(ANASTASIA_QUERY)
    expect(result.primary_category).toBe('student_aid')
    expect(result.summary.toLowerCase()).toContain('student aid')
  })

  it('emits student-aid terms that hit Pell / FSEOG / Tennessee HOPE seed rows', () => {
    const result = interpretFundingIntentRules(ANASTASIA_QUERY)
    const haystack = result.search_terms.join(' ').toLowerCase()
    expect(haystack).toMatch(/pell/)
    expect(haystack).toMatch(/fseog|fafsa/)
    expect(haystack).toMatch(/student housing|off-campus|room and board|cost of attendance/)
  })

  it('NATIONAL_PROGRAMS contains the curated student-living rows', () => {
    const ids = new Set(NATIONAL_PROGRAMS.map((p) => p.id))
    expect(ids.has('np-pell-grant')).toBe(true)
    expect(ids.has('np-fseog')).toBe(true)
    expect(ids.has('np-coa-appeal')).toBe(true)
    expect(ids.has('np-ncan-emergency-aid')).toBe(true)
    expect(ids.has('np-tn-hope')).toBe(true)
    expect(ids.has('np-tn-tsaa')).toBe(true)
    expect(ids.has('np-tn-step-up')).toBe(true)
    expect(ids.has('np-tn-promise')).toBe(true)
    // Anastasia-specific identity fits: Polish heritage + female STEM +
    // forensic-science + rural Appalachian + low-income + SSDI dependent.
    expect(ids.has('np-aafs-forensic')).toBe(true)
    expect(ids.has('np-society-women-engineers')).toBe(true)
    expect(ids.has('np-aauw-scholarships')).toBe(true)
    expect(ids.has('np-kosciuszko-foundation')).toBe(true)
    expect(ids.has('np-polish-american-scholarship')).toBe(true)
    expect(ids.has('np-arc-scholars')).toBe(true)
    expect(ids.has('np-questbridge')).toBe(true)
    expect(ids.has('np-jack-kent-cooke')).toBe(true)
    expect(ids.has('np-coca-cola-scholars')).toBe(true)
    expect(ids.has('np-ssa-student-benefit')).toBe(true)
  })

  it('SCHOLARSHIPS catalog contains the housing/forensic/STEM rows that complete the pool', () => {
    const ids = new Set(SCHOLARSHIPS.map((p) => p.id))
    expect(ids.has('sch-housing-scholarships')).toBe(true)
    expect(ids.has('sch-bold-housing')).toBe(true)
    expect(ids.has('sch-fastweb-housing')).toBe(true)
    expect(ids.has('sch-emergency-aid-ncan')).toBe(true)
    expect(ids.has('sch-tn-hope')).toBe(true)
    expect(ids.has('sch-tn-aspire')).toBe(true)
    expect(ids.has('sch-tn-step-up')).toBe(true)
    expect(ids.has('sch-tn-student-assistance')).toBe(true)
    expect(ids.has('sch-pell')).toBe(true)
    expect(ids.has('sch-fseog')).toBe(true)
    expect(ids.has('sch-forensic-sci-foundation')).toBe(true)
  })

  it('produces ≥15 distinct funder candidates between NATIONAL_PROGRAMS and SCHOLARSHIPS for the Anastasia query', () => {
    // Sanity: at least 15 rows in our seed pool match a substring of the
    // expanded search terms. This is the catalog-side guarantee that the
    // SQL `LIKE` filter in routes/matching.js will return real funders.
    const result = interpretFundingIntentRules(ANASTASIA_QUERY)
    const terms = result.search_terms.map((t) => String(t).toLowerCase())
    const allRows = [...NATIONAL_PROGRAMS, ...SCHOLARSHIPS]
    let hitCount = 0
    for (const row of allRows) {
      const hay = [
        row.name || '',
        row.description || '',
        Array.isArray(row.categories) ? row.categories.join(' ') : '',
        Array.isArray(row.intentMatch) ? row.intentMatch.join(' ') : '',
        Array.isArray(row.interestMatch) ? row.interestMatch.join(' ') : '',
      ].join(' ').toLowerCase()
      const matched = terms.some((t) => t.length >= 3 && hay.includes(t))
      if (matched) hitCount++
    }
    expect(hitCount).toBeGreaterThanOrEqual(15)
  })

  it('does NOT classify Anastasia query as professional_development (no credentials)', () => {
    const result = interpretFundingIntentRules(ANASTASIA_QUERY)
    expect(result.primary_category).not.toBe('professional_development')
    expect(result.credentials_detected).toEqual([])
  })
})
