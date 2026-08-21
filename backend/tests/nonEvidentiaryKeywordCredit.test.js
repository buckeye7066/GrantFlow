/**
 * A stopword is not evidence of fit.
 *
 * MEASURED DEFECT (purpose audit 2026-08-21, local corpus C:\mnt\data\grantflow.db).
 * The College/University profile matched "Commercial Fishing Occupational Safety
 * Training Project Grants (T03)" at score 59, decision ACCEPT — its top result.
 * The stored match_explain_json shows WHY: nine of the sixteen credited data
 * points were `keyword` points, and they were
 *
 *     and, education, eligible, era, funding, grant, grants, training,
 *     "higher-education institution advancing research and access."
 *
 * `and` is a conjunction. `grant`, `grants`, `funding` and `eligible` appear in
 * essentially every funding announcement ever written. `era` is a fragment of
 * the SPONSOR's own name ("Centers for Disease Control and Prevention - ERA").
 * None of them is evidence that this funder funds this applicant.
 *
 * The arithmetic makes it worse, not neutral. `keyword` points are excluded from
 * the DENOMINATOR but credited to the NUMERATOR (profileDataPoints.js:77-78), so
 * every junk keyword is free score with no offsetting cost. The same profile
 * carried 37 keyword points against a coverage denominator of 8.
 *
 * The vocabulary needed to fix this already exists in the repo: `DOC_STOPWORDS`
 * (profileHelpers.js) was written for exactly this reason — "ordinary English +
 * grant/admin boilerplate that would otherwise dominate frequency counts and add
 * nothing discriminating" — but it was only ever applied to uploaded-document
 * mining, never to the data-point inventory that scores every match.
 *
 * TIGHTENING ONLY. Keyword points are numerator-only, so withholding credit from
 * a non-evidentiary term can lower a score and can never raise one. No gate is
 * weakened here; a gate that was never applied is applied.
 */
import { describe, it, expect } from 'vitest'
import { buildProfileDataPointInventory, evaluateDataPointMatches } from '../services/profileDataPoints.js'
import { isEvidentiaryKeyword, NON_EVIDENTIARY_KEYWORDS } from '../config/nonEvidentiaryKeywords.js'

/** The College/University profile's real keyword bag, as measured. */
function collegeSignals() {
  return {
    needs: new Set(),
    location: { state: 'GA', county: 'Lee', city: 'Albany', zip: '31701' },
    states: ['GA'],
    applicantType: 'organization',
    applicantTypes: new Set(['higher_education_institution']),
    demographics: new Set(),
    genders: new Set(),
    assistance: new Set(),
    military: new Set(),
    health: new Set(),
    family: new Set(),
    occupation: new Set(),
    credentials: new Set(),
    immigration: new Set(),
    geographic: new Set(),
    sports: new Set(),
    interests: new Set(['higher education', 'research', 'trio']),
    academics: {},
    financial: {},
    keywordSet: new Set([
      'and', 'era', 'grant', 'grants', 'funding', 'eligible', 'gov', 'sam',
      '000', 'none', 'account', 'registered',
      'higher education', 'research funding', 'university grant',
    ]),
  }
}

describe('non-evidentiary keywords earn no data-point credit', () => {
  it('classifies conjunctions, grant boilerplate, form noise and bare numbers as non-evidentiary', () => {
    for (const junk of ['and', 'for', 'the', 'grant', 'grants', 'funding', 'eligible',
      'application', 'applicant', 'federal', 'gov', 'sam', 'era',
      'none', 'n/a', 'unknown', '000', '$5,000', '100']) {
      expect(isEvidentiaryKeyword(junk), `"${junk}" must not count as evidence`).toBe(false)
    }
  })

  it('keeps real vocabulary — including short, meaningful acronyms', () => {
    for (const real of ['ems', 'cte', 'stem', 'trio', 'nursing', 'higher education',
      'research funding', 'paramedic', 'wioa', 'pell grant']) {
      expect(isEvidentiaryKeyword(real), `"${real}" is real profile vocabulary`).toBe(true)
    }
  })

  it('drops junk keyword data points from the inventory but keeps real ones', () => {
    const inv = buildProfileDataPointInventory({ profile: {}, signals: collegeSignals() })
    const ids = inv.dataPoints.map((d) => d.id)
    for (const junk of ['and', 'era', 'grant', 'grants', 'funding', 'eligible', 'gov',
      'sam', '000', 'none', 'account', 'registered']) {
      expect(ids, `keyword:${junk} must not be a data point`).not.toContain(`keyword:${junk}`)
    }
    expect(ids).toContain('keyword:research funding')
    expect(ids).toContain('keyword:university grant')
  })

  it('the coverage DENOMINATOR is unchanged — this only withholds numerator credit', () => {
    const inv = buildProfileDataPointInventory({ profile: {}, signals: collegeSignals() })
    const structural = buildProfileDataPointInventory({
      profile: {},
      signals: { ...collegeSignals(), keywordSet: new Set() },
    })
    expect(inv.total).toBe(structural.total)
  })

  it('an occupational-safety grant no longer harvests credit from boilerplate', () => {
    // The real opportunity row, as stored: a stub description, a blanket
    // entity-type default, and a title whose only overlap with a university is
    // the word "Training".
    const oppText = [
      'Commercial Fishing Occupational Safety Training Project Grants (T03)',
      'Centers for Disease Control and Prevention - ERA',
      'Funding opportunity RFA-OH-22-006 (posted). Eligible applicants may apply for grant funding.',
    ].join(' ').toLowerCase()
    const inv = buildProfileDataPointInventory({ profile: {}, signals: collegeSignals() })
    const evidence = evaluateDataPointMatches({
      inventory: inv,
      oppText,
      oppSignals: ['education', 'programs'],
    })
    const creditedKeywords = (evidence.matched || [])
      .filter((m) => m.kind === 'keyword')
      .map((m) => m.value)
    for (const junk of ['and', 'era', 'grant', 'grants', 'funding', 'eligible']) {
      expect(creditedKeywords, `"${junk}" must not be credited`).not.toContain(junk)
    }
  })

  it('the vocabulary is a frozen, inspectable Set (no ad-hoc regex drift)', () => {
    expect(NON_EVIDENTIARY_KEYWORDS instanceof Set).toBe(true)
    expect(NON_EVIDENTIARY_KEYWORDS.has('and')).toBe(true)
    expect(NON_EVIDENTIARY_KEYWORDS.has('ems')).toBe(false)
  })
})
