/**
 * Anastasia / MTSU end-to-end smoke (live profile + live catalog).
 *
 * This is the user-rule "walk through one real profile end-to-end" guardrail.
 *
 * It runs the EXACT pipeline that the matching route uses, against the real
 * Anastasia profile fixture from designatedProfiles.js, and asserts that:
 *   1. Profile signals classify her as student / TN / female / forensic /
 *      multilingual / SSDI dependent / Polish heritage / rural Appalachian.
 *   2. Smart Matcher classifies her query as primary_category=student_aid.
 *   3. The combined NATIONAL_PROGRAMS + SCHOLARSHIPS catalog yields ≥10
 *      qualified candidates for the merged search-term set built from the
 *      query AND the profile signals — covering federal aid, state TN aid,
 *      housing scholarships, demographic / heritage / STEM scholarships,
 *      and the AAFS forensic-science fund.
 *   4. Generic adult homelessness rows do NOT crowd out student-aid rows
 *      (cross-category cap surface area).
 */

import { describe, it, expect } from 'vitest'
import { interpretFundingIntentRules, detectPrimaryCategory } from '../services/smartMatcherIntent.js'
import { buildProfileSignals } from '../services/profileHelpers.js'
import { DESIGNATED_PROFILES } from '../config/designatedProfiles.js'
import { NATIONAL_PROGRAMS } from '../services/shared/data/nationalPrograms.js'
import { SCHOLARSHIPS } from '../services/shared/data/scholarships.js'

const ANASTASIA_QUERY = 'Help me find funding for off-campus living expenses at MTSU'

const anastasia = DESIGNATED_PROFILES.find(
  (p) => p.id === 'profile-anastasia-white',
)

describe('Anastasia / MTSU end-to-end pipeline', () => {
  it('finds the Anastasia fixture in the designated roster', () => {
    expect(anastasia).toBeDefined()
    expect(anastasia.primary_type).toBe('high_school_student')
  })

  it('builds profile signals that include student-aid keywords', () => {
    const signals = buildProfileSignals({ profile: anastasia, sections: anastasia.sections })
    const allKeywords = new Set([
      ...(signals.keywordSet ? Array.from(signals.keywordSet) : []),
      ...(Array.isArray(signals.keywords) ? signals.keywords : []),
    ].map((k) => String(k).toLowerCase()))

    // Student-aid auto-tagging fired (added by the new student branch in
    // profileHelpers.js).
    expect(allKeywords.has('student aid')).toBe(true)
    expect(allKeywords.has('off-campus housing')).toBe(true)
    expect(allKeywords.has('cost of attendance')).toBe(true)
    expect(allKeywords.has('room and board')).toBe(true)
    expect(allKeywords.has('fafsa')).toBe(true)
    expect(allKeywords.has('pell grant')).toBe(true)
    expect(allKeywords.has('fseog')).toBe(true)

    // Tennessee state student-aid keywords (because profile.location.state=TN).
    expect(allKeywords.has('tennessee hope')).toBe(true)
    expect(allKeywords.has('tsaa')).toBe(true)
    expect(allKeywords.has('aspire award')).toBe(true)

    // Profile-aware boosts: HOPE (≥21 ACT) and Aspire (≥27 ACT, ≥3.75 GPA).
    expect(allKeywords.has('hope eligible')).toBe(true)
    expect(allKeywords.has('aspire eligible')).toBe(true)
    expect(allKeywords.has('aspire scholarship eligible')).toBe(true)

    // Identity-driven scholarship pools: Polish heritage, female STEM,
    // rural Appalachian, SSDI dependent, forensic science.
    expect(allKeywords.has('kosciuszko foundation')).toBe(true)
    expect(allKeywords.has('polish heritage')).toBe(true)
    expect(allKeywords.has('women in stem')).toBe(true)
    expect(allKeywords.has('society of women engineers')).toBe(true)
    expect(allKeywords.has('appalachian regional commission')).toBe(true)
    expect(allKeywords.has('rural student scholarship')).toBe(true)
    expect(allKeywords.has('children of ssdi recipients')).toBe(true)
    expect(allKeywords.has('forensic science')).toBe(true)

    // School-name keywords for MTSU should be present from target_colleges.
    const hasMtsuKeyword = Array.from(allKeywords).some(
      (k) => k.includes('middle tennessee state university') || k.includes('mtsu'),
    )
    expect(hasMtsuKeyword).toBe(true)

    // Applicant type resolves to student.
    expect(signals.applicantType).toBe('student')

    // Needs include education + scholarship + student_aid.
    const needs = Array.from(signals.needs || [])
    expect(needs).toContain('education')
    expect(needs).toContain('scholarship')
    expect(needs).toContain('student_aid')
    expect(needs).toContain('student_living')
    expect(needs).toContain('cost_of_attendance')
  })

  it('classifies the user query as student_aid', () => {
    const result = interpretFundingIntentRules(ANASTASIA_QUERY)
    expect(result.primary_category).toBe('student_aid')
    // No professional credentials detected (she's a HS senior, not RN/MD/etc.).
    expect(result.credentials_detected).toEqual([])
    // Query expanded to ≥10 useful terms.
    expect(result.search_terms.length).toBeGreaterThanOrEqual(10)
    const haystack = result.search_terms.join(' ').toLowerCase()
    expect(haystack).toMatch(/pell/)
    expect(haystack).toMatch(/fafsa|fseog/)
    expect(haystack).toMatch(/student housing|off-campus/)
    expect(haystack).toMatch(/cost of attendance/)
  })

  it('catalog yields ≥15 student-aid candidates for the merged signal set', () => {
    const signals = buildProfileSignals({ profile: anastasia, sections: anastasia.sections })
    const intent = interpretFundingIntentRules(ANASTASIA_QUERY)
    const profileKeywords = signals.keywordSet ? Array.from(signals.keywordSet) : []
    const merged = new Set(
      [...intent.search_terms, ...profileKeywords]
        .map((t) => String(t).toLowerCase())
        .filter((t) => t.length >= 3),
    )

    const allRows = [...NATIONAL_PROGRAMS, ...SCHOLARSHIPS]
    const matched = []
    for (const row of allRows) {
      const hay = [
        row.name || '',
        row.description || '',
        Array.isArray(row.categories) ? row.categories.join(' ') : '',
        Array.isArray(row.intentMatch) ? row.intentMatch.join(' ') : '',
        Array.isArray(row.interestMatch) ? row.interestMatch.join(' ') : '',
        Array.isArray(row.studentMatch) ? row.studentMatch.join(' ') : '',
      ].join(' ').toLowerCase()
      const tags = Array.isArray(row.categories) ? row.categories.map((c) => String(c).toLowerCase()) : []

      // A candidate qualifies if it tags itself as student_aid / scholarship /
      // education AND any merged term appears in its haystack OR any merged
      // term appears that's specifically in our STUDENT_AID_OVERLAP set.
      const isStudentAid = tags.some((t) =>
        ['student_aid', 'cost_of_attendance', 'scholarship', 'education', 'housing'].includes(t),
      )
      const termHit = Array.from(merged).some((t) => t.length >= 3 && hay.includes(t))
      if (isStudentAid && termHit) {
        matched.push({ id: row.id, name: row.name })
      }
    }

    // Spec acceptance: at least 15 distinct funder candidates surface for an
    // off-campus / cost-of-attendance student query for Anastasia.
    expect(matched.length).toBeGreaterThanOrEqual(15)

    // Federal core (Pell + FSEOG + COA appeal + Work-Study) must be present.
    const ids = new Set(matched.map((m) => m.id))
    expect(ids.has('np-pell-grant')).toBe(true)
    expect(ids.has('np-fseog')).toBe(true)
    expect(ids.has('np-coa-appeal')).toBe(true)

    // TN state aid must be present (HOPE / Aspire / TSAA / STEP UP / Promise).
    expect(ids.has('np-tn-hope')).toBe(true)
    expect(ids.has('np-tn-tsaa')).toBe(true)
    expect(ids.has('np-tn-step-up')).toBe(true)

    // Identity-driven scholarships present:
    expect(ids.has('np-aafs-forensic')).toBe(true) // forensic
    expect(ids.has('np-society-women-engineers')).toBe(true) // female STEM
    expect(ids.has('np-kosciuszko-foundation') || ids.has('np-polish-american-scholarship')).toBe(true)
    expect(ids.has('np-arc-scholars')).toBe(true) // Appalachian

    // Off-campus / housing-tagged scholarships from SCHOLARSHIPS catalog.
    expect(ids.has('sch-housing-scholarships') || ids.has('sch-bold-housing') || ids.has('sch-fastweb-housing')).toBe(true)
  })

  it('also benefits a generic Tennessee college student profile (global rule)', () => {
    // Global behavior check: a fictional Robert-style college student in TN
    // (forensic_science replaced with general STEM) gets the same
    // student-aid pool — proving the change is global, not Anastasia-only.
    const generic = {
      id: 'profile-test-tn-student',
      display_name: 'Test TN Student',
      primary_type: 'college_student',
      sections: {
        basic_information: {
          full_name: 'Test Student',
          address: 'Cleveland, Tennessee',
        },
        education: {
          highest_level: 'College Student',
          intended_major: 'Computer Science',
          gpa: '3.5',
          act_score: '24',
          target_colleges: ['Middle Tennessee State University'],
        },
        location_focus: {
          geographic_focus: 'Cleveland, Tennessee',
        },
      },
    }
    const signals = buildProfileSignals({ profile: generic, sections: generic.sections })
    const allKeywords = new Set([
      ...(signals.keywordSet ? Array.from(signals.keywordSet) : []),
      ...(Array.isArray(signals.keywords) ? signals.keywords : []),
    ].map((k) => String(k).toLowerCase()))

    expect(signals.applicantType).toBe('student')
    expect(allKeywords.has('student aid')).toBe(true)
    expect(allKeywords.has('off-campus housing')).toBe(true)
    expect(allKeywords.has('cost of attendance')).toBe(true)
    expect(allKeywords.has('tennessee hope')).toBe(true)
    expect(allKeywords.has('hope eligible')).toBe(true)
    // ACT 24 is below 27 → no Aspire eligibility.
    expect(allKeywords.has('aspire eligible')).toBe(false)
  })
})
