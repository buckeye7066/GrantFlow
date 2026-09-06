/**
 * Owner 2026-09-05 (the MTSU scholarship list): a funder that states a minimum
 * ACT/SAT/GPA has made a positive claim; a profile that declares its scores has
 * made one too. Live case: ACT 28 / SAT 1230 / GPA 3.84 carried the Buchanan
 * Fellowship (ACT 30 or SAT 1360) and the TN General Assembly Merit
 * Scholarship (3.75 GPA AND 29 ACT or 1330 SAT) in her pipeline.
 */
import { describe, expect, it } from 'vitest'
import {
  evaluateNeedFirstMatchPolicy,
  positiveFactMismatches,
  profileDeclaredScores,
  statedScoreMinimums,
} from '../services/matching/needFirstMatchPolicyV2.js'

const student = {
  profile: { id: 'p-a', primary_type: 'college_student' },
  sections: {
    basic_information: {
      state: 'TN',
      date_of_birth: '2008-07-19',
      academic_status: { act_score: 28, sat_score: 1230, gpa: 3.84, education_level: 'College Freshman (incoming), Associate degree earned May 2026' },
    },
    education: { current_institution: 'Middle Tennessee State University', gpa: '3.84', act_score: '28', intended_major: 'Forensic Science' },
    university_applications: { applications: [{ name: 'Middle Tennessee State University', status: 'committed' }] },
  },
}

const scholarship = (title, eligibility_text, extra = {}) => ({
  title, sponsor: 'Middle Tennessee State University', eligibility_text, opportunity_kind: 'scholarship',
  categories: ['education'], need_types_supported: ['education'], entity_types_allowed: ['student'], ...extra,
})

describe('statedScoreMinimums / profileDeclaredScores', () => {
  it('reads the lowest stated bar of each kind, ignores renewal sentences, and detects a direct test-or-GPA disjunction', () => {
    const honors = statedScoreMinimums('(27 ACT (1280-1300 SAT) and high school GPA of 3.3 or higher) OR (25 ACT (1200-1230 SAT) and high school GPA of 3.5 or higher) OR (24 ACT (1160-1190 SAT) and high school GPA of 3.7 or higher). To renew, maintain a 3.0 GPA.')
    expect(honors).toEqual({ act: 24, sat: 1160, gpa: 3.3, testOrGpa: false })
    const gams = statedScoreMinimums('minimum 3.75 GPA AND 29 ACT or a minimum 1330 SAT from Tennessee public schools.')
    expect(gams).toEqual({ act: 29, sat: 1330, gpa: 3.75, testOrGpa: false })
    const hope = statedScoreMinimums('available to students with a minimum ACT score of 21 or a GPA of 3.0.')
    expect(hope).toEqual({ act: 21, sat: null, gpa: 3.0, testOrGpa: true })
    expect(statedScoreMinimums('Recipients must be full-time students majoring in business.')).toEqual({ act: null, sat: null, gpa: null, testOrGpa: false })
  })

  it('reads declared scores from structured fields only, never prose', () => {
    expect(profileDeclaredScores(student)).toEqual({ act: 28, sat: 1230, gpa: 3.84 })
    expect(profileDeclaredScores({ sections: { narrative: { primary_goal: 'I scored a 34 on the ACT' } } })).toEqual({ act: null, sat: null, gpa: null })
  })
})

describe('academic-threshold rule inside the need-first policy', () => {
  const evaluate = (opp) => evaluateNeedFirstMatchPolicy({ profileContext: student, opportunity: opp, dataPointEval: {}, matchedNeeds: ['education'] })

  it('REJECTS the Buchanan Fellowship (ACT 30 or SAT 1360) for ACT 28 / SAT 1230', () => {
    const r = evaluate(scholarship('The Buchanan Fellowship', 'ACT composite score of 30 or higher, or SAT score of 1360 or higher. Minimum unweighted GPA of 3.5 on a 4.0 scale.'))
    expect(r.hardMismatches.some((m) => /ACT 30 or SAT 1360/.test(m) && /ACT 28/.test(m))).toBe(true)
  })

  it('REJECTS General Assembly Merit (3.75 GPA AND 29 ACT or 1330 SAT) — the GPA passes but neither test does', () => {
    const r = evaluate(scholarship('Tennessee General Assembly Merit Scholarship', 'minimum 3.75 GPA AND 29 ACT or a minimum 1330 SAT from Tennessee public or private schools.', { sponsor: 'Tennessee Student Assistance Corporation' }))
    expect(r.hardMismatches.some((m) => /Stated minimum ACT 29 or SAT 1330/.test(m))).toBe(true)
  })

  it('KEEPS the Honors Freshman Scholarship (its most lenient OR clause is 24 ACT / GPA 3.7) and the Presidential tier (ACT 25-29, GPA 3.5)', () => {
    const honors = evaluate(scholarship('Honors Freshman Scholarship', '(27 ACT (1280-1300 SAT) and high school GPA of 3.3 or higher) OR (25 ACT (1200-1230 SAT) and high school GPA of 3.5 or higher) OR (24 ACT (1160-1190 SAT) and high school GPA of 3.7 or higher).'))
    expect(honors.hardMismatches.filter((m) => /Stated minimum/.test(m))).toEqual([])
    const presidential = evaluate(scholarship('Presidential Scholarship', 'ACT 25-29 and a 3.50 GPA. Application for admission by December 1.'))
    expect(presidential.hardMismatches.filter((m) => /Stated minimum/.test(m))).toEqual([])
  })

  it('KEEPS HOPE ("ACT 21 or GPA 3.0") and a direct test-OR-GPA award the GPA alone satisfies', () => {
    const hope = evaluate(scholarship('HOPE Scholarship', 'available to students with a minimum ACT score of 21 or a GPA of 3.0.', { sponsor: 'Tennessee Lottery' }))
    expect(hope.hardMismatches.filter((m) => /Stated minimum/.test(m))).toEqual([])
    const either = evaluate(scholarship('Dean\'s Award', 'ACT score of 30 or higher, or a GPA of 3.8.'))
    expect(either.hardMismatches.filter((m) => /Stated minimum/.test(m))).toEqual([])
  })

  it('REJECTS a GPA bar the profile misses, and a stated test the profile never declared is NEUTRAL', () => {
    const gpa = evaluate(scholarship('Chancellor Award', 'Applicants must hold a cumulative GPA of 3.9 or higher.'))
    expect(gpa.hardMismatches.some((m) => /Stated minimum GPA 3.9 exceeds the profile's declared GPA 3.84/.test(m))).toBe(true)
    const satOnlyProfile = { ...student, sections: { ...student.sections, basic_information: { ...student.sections.basic_information, academic_status: { sat_score: 1230 } }, education: { intended_major: 'Forensic Science' } } }
    const actOnlyAward = evaluateNeedFirstMatchPolicy({ profileContext: satOnlyProfile, opportunity: scholarship('Trustee Scholarship', 'ACT 30-33 and a 3.50 GPA.'), dataPointEval: {}, matchedNeeds: ['education'] })
    expect(actOnlyAward.hardMismatches.filter((m) => /Stated minimum/.test(m))).toEqual([])
  })

  it('a profile with NO declared scores is never barred (silence is neutral)', () => {
    const silent = { profile: { primary_type: 'college_student' }, sections: { education: { intended_major: 'Forensic Science' } } }
    const r = evaluateNeedFirstMatchPolicy({ profileContext: silent, opportunity: scholarship('The Buchanan Fellowship', 'ACT composite score of 30 or higher.'), dataPointEval: {}, matchedNeeds: ['education'] })
    expect(r.hardMismatches.filter((m) => /Stated minimum/.test(m))).toEqual([])
  })
})

describe('positiveFactMismatches — the exported positive-fact subset', () => {
  it('names the adult-learner, K-12, discipline, and academic bars for the live student, and nothing for a fitting award', () => {
    const reconnect = positiveFactMismatches({ profileContext: student, opportunity: scholarship('Tennessee Reconnect Scholarship', 'last-dollar scholarship for eligible adult students in Tennessee', { sponsor: 'Tennessee Reconnect Act' }) })
    expect(reconnect.some((m) => /Adult-learner/.test(m))).toBe(true)
    const efs = positiveFactMismatches({ profileContext: student, opportunity: scholarship('Education Freedom Scholarships', 'approximately $7,300 per year to Tennessee students for the costs of attending private school', { sponsor: 'Tennessee Department of Education' }) })
    expect(efs.some((m) => /K-12/.test(m))).toBe(true)
    const business = positiveFactMismatches({ profileContext: student, opportunity: scholarship('Adams Family Foundation Scholarship in Business', 'Recipients must be full-time students majoring in a Jones College of Business program with a GPA of 3.0 or greater.') })
    expect(business.some((m) => /Field-of-study restriction \(business\)/.test(m))).toBe(true)
    const buchanan = positiveFactMismatches({ profileContext: student, opportunity: scholarship('The Buchanan Fellowship', 'ACT composite score of 30 or higher, or SAT score of 1360 or higher.') })
    expect(buchanan.some((m) => /Stated minimum ACT 30/.test(m))).toBe(true)
    const afte = positiveFactMismatches({ profileContext: student, opportunity: scholarship('AFTE Forensic Science Scholarship', 'students pursuing degrees in hard sciences related to forensic science', { sponsor: 'AFTE' }) })
    expect(afte).toEqual([])
  })

  it('never emits a purpose/need-coverage reject — silence stays neutral', () => {
    const plain = positiveFactMismatches({ profileContext: student, opportunity: { title: 'Community Improvement Grant', description: 'Supports local projects.', categories: ['community'] } })
    expect(plain).toEqual([])
  })
})
