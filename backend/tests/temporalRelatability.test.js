/**
 * The TEMPORAL half of the relatable gate (owner rule 2026-09-07).
 *
 * Built from one Tennessee student's real Discover page: an incoming MTSU
 * freshman who earned an associate degree at her community college through
 * dual enrollment, lives in Cleveland, TN (Bradley County), and declares
 * Polish / Russian / Ukrainian heritage. Her community college's "graduating
 * seniors entering <college>" and "incoming first-time freshmen" awards kept
 * surfacing in September because every institutional tie read as timeless.
 * No real given names appear here by design (privacy tripwire).
 */
import { describe, it, expect } from 'vitest'
import {
  buildProfileFactTimeline, parsePlace, normalizeStateCode, heritageRoot, sameInstitutionName,
  institutionRelationship, residenceRelationship, FACT_STATUS,
} from '../config/profileFactTimeline.js'
import {
  detectTemporalAnchors, temporalAnchorVerdict, temporalAnchorConflict, temporalAnchorEvidence,
  originSearchTerms, TEMPORAL_ANCHOR_CLASSES,
} from '../config/temporalRelatability.js'

const NOW = new Date('2026-09-07T16:00:00Z')

/** The student's profile shape (values only where the gate reads them). */
function studentSections(overrides = {}) {
  return {
    basic_information: {
      city: 'Cleveland', state: 'TN', zip_code: '55402',
      location: { city: 'Cleveland', county: 'Bradley County', state: 'TN', zip_code: '37312' },
      current_school: 'Middle Tennessee State University',
      academic_status: { education_level: 'College Freshman (incoming), Associate degree earned May 2026', college_courses: 'Yes' },
      tags: ['High School Senior'],
      ...(overrides.basic_information ?? {}),
    },
    education: {
      current_institution: 'Middle Tennessee State University',
      highest_level: 'Associates Degree',
      schools: { name: 'Cleveland State Community College', status: 'Graduated May 2026 — Associate degree earned (dual enrollment via TVEC)', type: 'Community College' },
      ...(overrides.education ?? {}),
    },
    demographics: { heritage: 'Polish, Russian, Ukrainian', languages: ['English', 'Russian'], veteran_status: 'Not a veteran', ...(overrides.demographics ?? {}) },
  }
}

// Verbatim prod rows (title / sponsor / eligibility / description).
const PRINCIPALS = {
  title: "Principal's Scholarship - Cleveland State Community College",
  sponsor: 'Cleveland State Community College',
  eligibility_text: 'You must have a minimum 3.0 GPA and a minimum ACT score of 19 to be eligible for this award.',
  description: "The Principal's Scholarship is available to graduating seniors from service area high schools entering Cleveland State Community College.",
}
const EMPOWERMENT = {
  title: 'Empowerment Grant – Incoming Freshmen',
  sponsor: 'Cleveland State Community College',
  eligibility_text: 'One scholarship recipient from each of the schools within our service area.',
  description: 'Awarded to incoming first-time freshmen who have attained the honor of being the highest ranked student in their high school graduating class.',
}
const TSU = {
  title: 'TSU Scholarships',
  sponsor: 'Tennessee State University',
  eligibility_text: 'Students must be admitted to TSU to complete the online scholarship application.',
  description: 'TSU offers various scholarships for first-time freshmen, transfer, and international students, as well as continuing undergraduate students.',
}

describe('profileFactTimeline — WHEN a fact is true', () => {
  it('reads the student: MTSU is CURRENT, the community college is PAST, stage is undergraduate, heritage is origin', () => {
    const t = buildProfileFactTimeline(studentSections(), { now: NOW })
    expect(institutionRelationship(t, 'Middle Tennessee State University')).toBe(FACT_STATUS.CURRENT)
    expect(institutionRelationship(t, 'Cleveland State Community College')).toBe(FACT_STATUS.PAST)
    expect(institutionRelationship(t, 'Tennessee State University')).toBeNull()
    expect(t.stage).toBe('undergraduate')
    expect(t.heritage.map((h) => h.root).sort()).toEqual(['poland', 'russia', 'ukraine'])
    // The stale tag is NOT a fact source.
    expect(JSON.stringify(t)).not.toMatch(/High School Senior/)
  })

  it('a declared high school is PAST once its class has graduated, CURRENT before', () => {
    const edu = { high_school_name: 'Cleveland High School', high_school_graduation_year: 2026 }
    const past = buildProfileFactTimeline(studentSections({ education: edu }), { now: NOW })
    expect(institutionRelationship(past, 'Cleveland High School')).toBe(FACT_STATUS.PAST)
    const before = buildProfileFactTimeline(
      { ...studentSections({ education: edu }), basic_information: { academic_status: { education_level: 'High School Senior' } } },
      { now: new Date('2026-03-01T00:00:00Z') },
    )
    expect(institutionRelationship(before, 'Cleveland High School')).toBe(FACT_STATUS.CURRENT)
  })

  it('reads current residence from the location block, past residences and birthplace from their fields', () => {
    const t = buildProfileFactTimeline(studentSections({
      basic_information: { previous_residences: ['Chattanooga, TN (2008-2015)'], birthplace: 'Chattanooga, Tennessee' },
    }), { now: NOW })
    expect(residenceRelationship(t, parsePlace('Bradley County, TN'))).toBe(FACT_STATUS.CURRENT)
    expect(residenceRelationship(t, parsePlace('Cleveland, TN'))).toBe(FACT_STATUS.CURRENT)
    expect(residenceRelationship(t, parsePlace('Chattanooga, TN'))).toBe(FACT_STATUS.PAST)
    expect(residenceRelationship(t, parsePlace('Nashville, TN'))).toBeNull()
    expect(t.birthplace).toMatchObject({ city: 'chattanooga', state: 'TN', status: FACT_STATUS.ORIGIN })
    // The Minneapolis ZIP in the top-level field never becomes a residence claim.
    expect(t.residences.some((r) => r.zip === '55402')).toBe(false)
  })

  it('parsePlace / normalizeStateCode / heritageRoot / sameInstitutionName', () => {
    expect(parsePlace('Cleveland, TN 37312')).toMatchObject({ city: 'cleveland', state: 'TN', zip: '37312' })
    expect(parsePlace('Bradley County, Tennessee')).toMatchObject({ county: 'bradley', state: 'TN' })
    expect(parsePlace('Tennessee')).toMatchObject({ state: 'TN', city: null })
    expect(parsePlace('')).toBeNull()
    expect(normalizeStateCode('tennessee')).toBe('TN')
    expect(normalizeStateCode('USA')).toBeNull()
    expect(heritageRoot('Russian')).toBe('russia')
    expect(heritageRoot('Ukrainian')).toBe('ukraine')
    expect(heritageRoot('Polish')).toBe('poland')
    expect(sameInstitutionName('Tennessee State University', 'Middle Tennessee State University')).toBe(false)
    expect(sameInstitutionName('Cleveland State Community College', 'cleveland state community college')).toBe(true)
  })
})

describe('temporalRelatability — the row declares WHEN, the timeline says whether', () => {
  it('registry sanity: every class has patterns, a subject, and a requirement', () => {
    for (const cls of TEMPORAL_ANCHOR_CLASSES) {
      expect(cls.patterns.length).toBeGreaterThan(0)
      expect(['institution', 'place', 'stage', 'heritage']).toContain(cls.subject)
      expect(['current', 'past_or_current', 'origin']).toContain(cls.requires)
    }
  })

  it("the community college's 'graduating seniors ... entering <college>' award is STALE for its September graduate", () => {
    const anchors = detectTemporalAnchors(PRINCIPALS)
    expect(anchors.map((a) => a.classId)).toEqual(expect.arrayContaining(['high_school_senior', 'entering_institution']))
    const conflict = temporalAnchorConflict(studentSections(), PRINCIPALS, { now: NOW })
    expect(conflict).toBeTruthy()
    expect(conflict.reason).toMatch(/PAST tie/)
  })

  it("'incoming first-time freshmen' with the college as SPONSOR is STALE once the profile has graduated from it", () => {
    const conflict = temporalAnchorConflict(studentSections(), EMPOWERMENT, { now: NOW })
    expect(conflict).toBeTruthy()
    expect(conflict.classId).toBe('entering_institution')
    expect(conflict.subject).toMatch(/Cleveland State Community College/)
  })

  it('the SAME incoming-freshmen award is a CURRENT fit for a profile entering that college', () => {
    const entering = studentSections({
      education: { current_institution: 'Cleveland State Community College', schools: { name: 'Cleveland State Community College', status: 'incoming' } },
      basic_information: { current_school: 'Cleveland State Community College', academic_status: { education_level: 'High School Senior', college_courses: 'No' } },
    })
    expect(temporalAnchorConflict(entering, EMPOWERMENT, { now: NOW })).toBeNull()
    const ev = temporalAnchorEvidence(entering, EMPOWERMENT, { now: NOW })
    expect(ev.verdict).toBe('fit_current')
  })

  it("'must be admitted to TSU' is ELSEWHERE for a student who declares she is at MTSU (and never named TSU)", () => {
    const conflict = temporalAnchorConflict(studentSections(), TSU, { now: NOW })
    expect(conflict).toBeTruthy()
    expect(conflict.classId).toBe('current_enrollment')
    expect(conflict.reason).toMatch(/elsewhere/)
    expect(conflict.reason).toMatch(/Middle Tennessee State University/)
  })

  it('the same TSU row is NEUTRAL when TSU is a declared target, or when the profile declares no current school', () => {
    const targeting = studentSections({ education: { target_colleges: ['Tennessee State University'] } })
    expect(temporalAnchorConflict(targeting, TSU, { now: NOW })).toBeNull()
    expect(temporalAnchorEvidence(targeting, TSU, { now: NOW }).verdict).toBe('unknown')
    const noSchool = studentSections({
      education: { current_institution: '', schools: {} },
      basic_information: { current_school: '', academic_status: { education_level: 'High School Senior' } },
    })
    expect(temporalAnchorConflict(noSchool, TSU, { now: NOW })).toBeNull()
  })

  it('an ALUMNI award honors a PAST tie — the declared high school reaches it', () => {
    const row = { title: 'Cleveland High School Alumni Association Scholarship', sponsor: 'Cleveland High School Alumni Association', description: 'Open to graduates of Cleveland High School pursuing any degree.' }
    const withHs = studentSections({ education: { high_school_name: 'Cleveland High School', high_school_graduation_year: 2026 } })
    expect(temporalAnchorConflict(withHs, row, { now: NOW })).toBeNull()
    expect(temporalAnchorEvidence(withHs, row, { now: NOW }).verdict).toBe('fit_past')
    // Without the declared high school the tie is unknown, never invented.
    expect(temporalAnchorEvidence(studentSections(), row, { now: NOW }).verdict).toBe('unknown')
  })

  it('residency requires NOW: current county fits, a former city is stale, a stranger city is unknown', () => {
    const county = { title: 'Bradley County Community Foundation Scholarship', description: 'Applicants must be a resident of Bradley County, TN.' }
    expect(temporalAnchorEvidence(studentSections(), county, { now: NOW }).verdict).toBe('fit_current')
    const moved = studentSections({ basic_information: { previous_residences: ['Chattanooga, TN'] } })
    const chatt = { title: 'Chattanooga Neighborhood Scholarship', description: 'For residents of Chattanooga, TN.' }
    expect(temporalAnchorConflict(moved, chatt, { now: NOW })?.classId).toBe('residency')
    expect(temporalAnchorConflict(studentSections(), chatt, { now: NOW })).toBeNull()
    const former = { title: 'Chattanooga Hometown Award', description: 'Open to current or former residents of Chattanooga, TN.' }
    expect(temporalAnchorEvidence(moved, former, { now: NOW }).verdict).toBe('fit_past')
  })

  it('a single named COUNTY the profile provably does not live in is ELSEWHERE; lists, areas, cities and silence stay neutral', () => {
    // Verbatim prod row, surfaced as a direct ACCEPT for a Bradley County, TN resident.
    const rochester = {
      title: 'Individual Training Grant Program',
      sponsor: 'RochesterWorks',
      eligibility_text: 'RochesterWorks can only approve training funds for individuals who live in Monroe County or dislocated workers who were laid off from a Monroe County employer.',
    }
    expect(temporalAnchorEvidence(studentSections(), rochester, { now: NOW }).verdict).toBe('elsewhere')
    expect(temporalAnchorConflict(studentSections(), rochester, { now: NOW })?.classId).toBe('residency')
    // No declared county: a county in ANOTHER named state is still provable…
    const noCounty = studentSections({ basic_information: { location: { city: 'Cleveland', state: 'TN' } } })
    expect(temporalAnchorConflict(noCounty, { title: 'X', description: 'For residents of Monroe County, New York.' }, { now: NOW })?.classId).toBe('residency')
    // …but an unqualified county is not (Monroe County also exists in Tennessee).
    expect(temporalAnchorConflict(noCounty, rochester, { now: NOW })).toBeNull()
    // Lists and widened areas may include the profile's county.
    expect(temporalAnchorConflict(studentSections(), { title: 'X', description: 'Open to residents of Hamilton County, Bradley County, or Marion County.' }, { now: NOW })).toBeNull()
    expect(temporalAnchorConflict(studentSections(), { title: 'X', description: 'For residents of Hamilton County and surrounding counties.' }, { now: NOW })).toBeNull()
    expect(temporalAnchorConflict(studentSections(), { title: 'X', description: 'Serving residents of the Hamilton County area.' }, { now: NOW })).toBeNull()
    // A different CITY stays neutral; the profile's own county still fits.
    expect(temporalAnchorConflict(studentSections(), { title: 'X', description: 'For residents of Chattanooga, TN.' }, { now: NOW })).toBeNull()
    expect(temporalAnchorEvidence(studentSections(), { title: 'X', description: 'For residents of Bradley County.' }, { now: NOW }).verdict).toBe('fit_current')
  })

  it('birthplace and heritage are ORIGIN facts', () => {
    const born = studentSections({ basic_information: { birthplace: 'Chattanooga, TN' } })
    const native = { title: 'Chattanooga Natives Scholarship', description: 'For students born in Chattanooga, TN.' }
    expect(temporalAnchorEvidence(born, native, { now: NOW }).verdict).toBe('fit_origin')
    expect(temporalAnchorConflict(studentSections({ basic_information: { birthplace: 'Nashville, TN' } }), native, { now: NOW })?.classId).toBe('birthplace')
    const russian = { title: 'Russian Heritage Scholarship', description: 'For students of Russian descent.' }
    expect(temporalAnchorEvidence(studentSections(), russian, { now: NOW }).verdict).toBe('fit_origin')
    const polish = { title: 'Polish-American Students Award', description: 'Supports Polish-American students in Tennessee.' }
    expect(temporalAnchorEvidence(studentSections(), polish, { now: NOW }).verdict).toBe('fit_origin')
    const irish = { title: 'Irish Heritage Scholarship', description: 'For students of Irish descent.' }
    expect(temporalAnchorEvidence(studentSections(), irish, { now: NOW }).verdict).toBe('unknown')
  })

  it('negation and inclusion guards: "not limited to residents of" and "seniors and current college students" declare nothing', () => {
    expect(detectTemporalAnchors({ title: 'Open Award', description: 'This award is not limited to residents of Bradley County, TN.' })).toEqual([])
    expect(detectTemporalAnchors({ title: 'Broad Award', description: 'Open to graduating high school seniors and current college students.' }).map((a) => a.classId)).not.toContain('high_school_senior')
    expect(temporalAnchorVerdict(buildProfileFactTimeline(studentSections(), { now: NOW }), { title: 'Generic Grant', description: 'Supports education.' })).toBeNull()
  })

  it('ENGINE WIRING: computeMatchDecision REJECTs the stale college award and records a positive fit on an alumni award', async () => {
    const { computeMatchDecision } = await import('../services/matchEngine.js')
    const profile = { id: 'p-tn-student', primary_type: 'student', display_name: 'TN Student' }
    const sections = studentSections({ education: { high_school_name: 'Cleveland High School', high_school_graduation_year: 2026 } })
    const ctx = { profile: { ...profile, sections }, sections }
    const stale = computeMatchDecision(ctx, { ...PRINCIPALS, id: 'o1', state: 'TN', opportunity_kind: 'SCHOLARSHIP', amount_max: 1000, application_url: 'https://example.org/apply' })
    expect(stale.decision).toBe('REJECT')
    // A residency-stale row passes every earlier gate (same state, no
    // institution) so the refusal text proves THIS gate is on the path.
    const moved = studentSections({ basic_information: { previous_residences: ['Chattanooga, TN (2008-2015)'] } })
    const movedCtx = { profile: { ...profile, sections: moved }, sections: moved }
    const chatt = computeMatchDecision(movedCtx, {
      id: 'o3', state: 'TN', opportunity_kind: 'SCHOLARSHIP', amount_max: 1000, application_url: 'https://example.org/apply',
      title: 'Chattanooga Neighborhood Scholarship', sponsor: 'Chattanooga Community Fund',
      description: 'For students who are residents of Chattanooga, TN. Scholarship for education and tuition.',
      categories: ['education', 'scholarship'], need_categories: ['education', 'student_aid'],
    })
    expect(chatt.decision).toBe('REJECT')
    expect(String(chatt.explanation)).toMatch(/PAST tie/)
    const alumni = computeMatchDecision(ctx, {
      id: 'o2', state: 'TN', opportunity_kind: 'SCHOLARSHIP', amount_max: 1500, application_url: 'https://example.org/apply',
      title: 'Cleveland High School Alumni Association Scholarship', sponsor: 'Cleveland High School Alumni Association',
      description: 'Open to graduates of Cleveland High School pursuing any undergraduate degree in Tennessee. Scholarship for education and tuition.',
      categories: ['education', 'scholarship'], need_categories: ['education', 'student_aid'],
    })
    expect(alumni.decision).not.toBe('REJECT')
    const explain = alumni.match_explain ?? alumni.explain
    expect(explain.temporal_anchor?.verdict).toBe('fit_past')
    expect(explain.matchedSignals).toContain('temporal:fit_past')
  })

  it('POINTER WIRING: a stale temporal anchor is never relatable; a past/origin fit is relatable without present geography', async () => {
    const { pointerTruthVerdict } = await import('../crawler-os/pointerTruthPolicy.js')
    const base = { url: 'https://example.org/x', opportunity_kind: 'DIRECTORY', match_decision: 'review', match_score: 20 }
    const stale = pointerTruthVerdict({ ...base, match_explain_json: JSON.stringify({ matchedSignals: ['geo:state', 'needs'], matchedNeeds: ['education'], temporal_anchor: { verdict: 'stale' } }) })
    expect(stale.legs.relatable).toBe(false)
    const origin = pointerTruthVerdict({ ...base, match_explain_json: JSON.stringify({ matchedSignals: ['needs'], matchedNeeds: ['education'], temporal_anchor: { verdict: 'fit_origin' } }) })
    expect(origin.legs.relatable).toBe(true)
    // crawler-os's 'partial' location with no geo fact is not a tie to THIS profile.
    const partial = pointerTruthVerdict({ ...base, match_explain_json: JSON.stringify({ matched_needs: ['education'], matched_location: 'partial', matched_profile_facts: ['Need: education', 'Applicant type: student'] }) })
    expect(partial.legs.relatable).toBe(false)
  })

  it('originSearchTerms seeds the searches history and origin qualify the profile for', () => {
    const terms = originSearchTerms(studentSections({
      education: { high_school_name: 'Cleveland High School', high_school_graduation_year: 2026 },
      basic_information: { birthplace: 'Chattanooga, TN' },
    }), { now: NOW, limit: 10 })
    expect(terms).toEqual(expect.arrayContaining([
      'cleveland high school alumni scholarship',
      'cleveland state community college alumni scholarship',
      'russian heritage scholarship',
      'chattanooga native scholarship',
    ]))
    expect(terms).not.toContain('middle tennessee state university alumni scholarship')
  })
})
