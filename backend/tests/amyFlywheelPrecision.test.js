import { describe, expect, it } from 'vitest'
import { evaluateDiscovery } from '../services/amy/amyReport.js'
import { buildWebQueries } from '../crawler-os/webQueries.js'

const homeschoolScenario = {
  scenario_id: 'homeschool-v1',
  category: 'family',
  label: 'Homeschool Family',
  expected: { state: 'TN', needs: ['education', 'curriculum'] },
}

function evaluateHomeschool(recommendations) {
  return evaluateDiscovery(homeschoolScenario, 'p-homeschool', {
    run: {
      run_id: 'amy-precision-test',
      stored: recommendations.length,
      sources: [],
      recommendations,
    },
    persisted: { opportunities: recommendations.length },
    thesis: {
      applicant_types: ['family', 'individual'],
      needs: ['education', 'curriculum'],
      is_student: false,
      location: { state: 'TN' },
    },
  })
}

function evaluateSchoolRecall(school, recommendation) {
  return evaluateDiscovery(
    {
      scenario_id: 'student-school-alias-v1',
      category: 'student',
      label: 'Named School Student',
      expected: { state: 'OH' },
    },
    'p-school-alias',
    {
      run: {
        run_id: 'amy-school-alias-test',
        stored: 1,
        sources: [],
        recommendations: [recommendation],
      },
      persisted: { opportunities: 1 },
      thesis: {
        applicant_types: ['student', 'individual'],
        needs: ['scholarship', 'education'],
        is_student: true,
        schools: [school],
        location: { state: 'OH' },
      },
    },
  )
}

describe('Amy canonical recommendation decisions', () => {
  it('does not relabel an explicit REVIEW as ACCEPT merely because its raw score is high', () => {
    const evaluation = evaluateHomeschool([
      { title: 'Tennessee HOPE Scholarship', sponsor: 'TSAC', match_score: 88, decision: 'REVIEW' },
      { title: 'Homeschool Curriculum Mini-Grant', sponsor: 'Community Foundation', match_score: 82, decision: 'ACCEPT' },
    ])

    expect(evaluation.accepted).toBe(1)
    expect(evaluation.review).toBe(1)
    expect(evaluation.ineligible_accepts).toBe(0)
    expect(evaluation.findings.some((finding) => finding.type === 'ineligible_match')).toBe(false)
  })

  it('reads the canonical match_decision alias used by persisted and display rows', () => {
    const evaluation = evaluateHomeschool([
      { title: 'Federal Pell Grant', sponsor: 'U.S. Department of Education', match_score: 38, match_decision: 'REVIEW' },
    ])

    expect(evaluation.accepted).toBe(0)
    expect(evaluation.review).toBe(1)
    expect(evaluation.ineligible_accepts).toBe(0)
  })

  it('fails closed to REVIEW when a legacy recommendation has a high score but no canonical decision', () => {
    const evaluation = evaluateHomeschool([
      { title: 'Federal Pell Grant', sponsor: 'U.S. Department of Education', match_score: 38 },
    ])

    expect(evaluation.accepted).toBe(0)
    expect(evaluation.review).toBe(1)
    expect(evaluation.ineligible_accepts).toBe(0)
    expect(evaluation.findings.some((finding) => finding.type === 'ineligible_match')).toBe(false)
  })

  it('keeps an explicit REJECT out of ACCEPT and REVIEW even when the raw score is high', () => {
    const evaluation = evaluateHomeschool([
      { title: 'Tennessee HOPE Scholarship', sponsor: 'TSAC', match_score: 95, decision: 'REJECT' },
    ])

    expect(evaluation.accepted).toBe(0)
    expect(evaluation.review).toBe(0)
    expect(evaluation.ineligible_accepts).toBe(0)
  })
})

describe('Amy flywheel discovery priorities', () => {
  it('recognizes a precise acronym-plus-campus alias in institution recall', () => {
    const evaluation = evaluateSchoolRecall('Montana State University Billings', {
      title: 'MSU Billings Foundation Scholarships',
      sponsor: 'MSU Billings Foundation',
      match_score: 82,
      decision: 'ACCEPT',
    })

    expect(evaluation.findings.some((finding) => finding.type === 'institution_recall_miss')).toBe(false)
  })

  it('recognizes the protected Ohio State publication name for The Ohio State University', () => {
    const evaluation = evaluateSchoolRecall('The Ohio State University', {
      title: 'Ohio State Nursing Alumni Scholarship',
      sponsor: 'Ohio State College of Nursing',
      match_score: 18,
      decision: 'ACCEPT',
    })

    expect(evaluation.findings.some((finding) => finding.type === 'institution_recall_miss')).toBe(false)
  })

  it('pins an exact named-school query inside the default cap', () => {
    const queries = buildWebQueries({
      applicant_types: ['student', 'individual'],
      is_student: true,
      schools: ['Middle Tennessee State University'],
      field_of_study: 'Computer Science',
      needs: ['scholarship', 'education', 'tuition'],
      location: { city: 'Murfreesboro', state: 'TN', county: 'Rutherford County' },
    }, { year: 2026, max: 6 })

    expect(queries[0]).toBe('"Middle Tennessee State University" scholarships')
    expect(queries.some((query) => query === 'Middle Tennessee State University scholarships')).toBe(true)
  })

  it('pins the Ohio State publication-name query inside the default cap', () => {
    const queries = buildWebQueries({
      applicant_types: ['student', 'individual'],
      is_student: true,
      schools: ['The Ohio State University'],
      field_of_study: 'Nursing',
      needs: ['scholarship', 'education', 'tuition'],
      location: { city: 'Columbus', state: 'OH', county: 'Franklin County' },
    }, { year: 2026, max: 6 })

    expect(queries[0]).toBe('"The Ohio State University" scholarships')
    expect(queries).toContain('"Ohio State" scholarships')
  })

  it('pins CDBG, HOME/CHDO, and CDFI searches for a community-development corporation', () => {
    const queries = buildWebQueries({
      applicant_types: ['nonprofit'],
      needs: ['housing development', 'economic development', 'community facilities', 'capacity building'],
      location: { city: 'Cleveland', state: 'TN', county: 'Bradley County' },
    }, { year: 2026, max: 6 })

    expect(queries.some((query) => /community development block grant TN/i.test(query))).toBe(true)
    expect(queries.some((query) => /HOME CHDO affordable housing funding TN/i.test(query))).toBe(true)
    expect(queries.some((query) => /CDFI Fund community development grants 2026/i.test(query))).toBe(true)
  })

  it('pins the HUD program family for a public housing authority', () => {
    const queries = buildWebQueries({
      applicant_types: ['government'],
      needs: ['housing', 'housing development', 'community facilities'],
      location: { city: 'Albuquerque', state: 'NM', county: 'Bernalillo County' },
    }, { year: 2026, max: 6 })

    expect(queries.some((query) => /HUD Public Housing Capital Fund 2026/i.test(query))).toBe(true)
    expect(queries.some((query) => /HUD Choice Neighborhoods grants 2026/i.test(query))).toBe(true)
    expect(queries.some((query) => /HUD ROSS resident services funding 2026/i.test(query))).toBe(true)
  })

  it('pins WIOA, apprenticeship, and ETA searches for a workforce organization', () => {
    const queries = buildWebQueries({
      applicant_types: ['nonprofit', 'government'],
      needs: ['workforce', 'employment', 'economic development', 'programs'],
      location: { city: 'Nashville', state: 'TN', county: 'Davidson County' },
    }, { year: 2026, max: 6 })

    expect(queries.some((query) => /WIOA workforce development funding TN/i.test(query))).toBe(true)
    expect(queries.some((query) => /Department of Labor apprenticeship grants 2026/i.test(query))).toBe(true)
    expect(queries.some((query) => /Employment and Training Administration funding opportunities 2026/i.test(query))).toBe(true)
  })
})
