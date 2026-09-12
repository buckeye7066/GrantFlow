/**
 * crawlerDoctorQueryBudget.test.js
 *
 * webq-9: the crawler doctor diffed a max-32 steered plan against a max-26
 * base plan, so for any profile whose pool exceeds 26 up to six ordinary
 * baseline queries were reported as gap-driven "expansions", and next_queries
 * did not reflect the live lane budget. The diagnostics must use ONE budget
 * (the live WEB_LANE_MAX_QUERIES-resolved value) and compute expansions
 * against an uncapped baseline so only genuinely added queries are listed.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { buildDoctorQueryDiagnostics } from '../services/crawlerDoctorService.js'
import { buildWebQueries } from '../crawler-os/webQueries.js'

// Query-rich: two schools + field + county + towns + needs + interests (> 32 queries).
const RICH = {
  applicant_types: ['student', 'individual'], is_student: true,
  needs: ['tuition', 'textbooks', 'housing', 'food', 'transportation'],
  schools: ['Cleveland State Community College', 'Chattanooga State Community College'],
  field_of_study: 'Paramedic',
  interest_terms: ['emergency medical services', 'nursing', 'paramedicine', 'anatomy'],
  location: {
    state: 'TN', city: 'Cleveland', county: 'Bradley County', zip: '37311',
    nearby_cities: [{ city: 'Charleston', state: 'TN', miles: 6 }, { city: 'Athens', state: 'TN', miles: 20 }],
  },
}

describe('crawler doctor query diagnostics use one budget and an uncapped baseline', () => {
  const saved = process.env.WEB_LANE_MAX_QUERIES
  afterEach(() => {
    if (saved === undefined) delete process.env.WEB_LANE_MAX_QUERIES
    else process.env.WEB_LANE_MAX_QUERIES = saved
  })

  it('suggested_expansions lists only queries the gap classes ADD, never baseline queries the cap hid', () => {
    delete process.env.WEB_LANE_MAX_QUERIES
    const baselineUniverse = new Set(buildWebQueries(RICH, { max: 10000, seed: 0 }).map((q) => q.toLowerCase()))
    expect(baselineUniverse.size).toBeGreaterThan(32)
    const diag = buildDoctorQueryDiagnostics(RICH, ['low_results'])
    expect(diag.suggested_expansions.length).toBeGreaterThan(0)
    for (const q of diag.suggested_expansions) {
      expect(baselineUniverse.has(q.toLowerCase())).toBe(false)
    }
    // low_results adds the state financial-aid phrasing (genuinely new) and
    // FORCES "<need> grant funding student" — a query the ordinary pool already
    // holds, so it is a PROMOTION into the budget, never an "expansion".
    expect(diag.suggested_expansions.some((q) => /scholarship financial aid programs/i.test(q))).toBe(true)
    expect(diag.steering_promoted.some((q) => /grant funding student/i.test(q))).toBe(true)
    for (const q of diag.steering_promoted) {
      expect(baselineUniverse.has(q.toLowerCase())).toBe(true)
      expect(diag.next_queries).not.toContain(q)
    }
  })

  it('next_queries is planned at the live lane budget (default 28) and reports that budget', () => {
    delete process.env.WEB_LANE_MAX_QUERIES
    const diag = buildDoctorQueryDiagnostics(RICH, [])
    expect(diag.query_budget).toBe(28)
    expect(diag.next_queries).toHaveLength(28)
    expect(diag.next_queries).toEqual(buildWebQueries(RICH, { max: 28, seed: 0 }))
    expect(diag.suggested_expansions).toEqual([])
  })

  it('honours WEB_LANE_MAX_QUERIES like the lane does and ignores garbage', () => {
    process.env.WEB_LANE_MAX_QUERIES = '10'
    expect(buildDoctorQueryDiagnostics(RICH, []).query_budget).toBe(10)
    expect(buildDoctorQueryDiagnostics(RICH, []).next_queries).toHaveLength(10)
    process.env.WEB_LANE_MAX_QUERIES = 'lots'
    expect(buildDoctorQueryDiagnostics(RICH, []).query_budget).toBe(28)
  })

  it('exposes the plan provenance so the doctor can say which queries are anchors, core or breadth', () => {
    delete process.env.WEB_LANE_MAX_QUERIES
    const diag = buildDoctorQueryDiagnostics({ ...RICH, learned_gaps: { classes: ['low_results', 'result_floor_shortfall'] } }, [])
    expect(diag.next_query_plan).toHaveLength(diag.next_queries.length)
    expect(diag.next_query_plan[0].tier).toBe('anchor')
    expect(diag.next_query_plan.every((e, i) => e.query === diag.next_queries[i])).toBe(true)
  })
})
