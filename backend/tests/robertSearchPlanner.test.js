import { describe, it, expect } from 'vitest'
import { buildSearchPlans } from '../services/robert/robertSearchPlanner.js'

// Regression: Robert's planner must search the profile's EMPLOYER, SCHOOL, and
// OCCUPATION — not just "<applicant-type> grant <geo>" boilerplate — so a real
// niche local award (e.g. the Bradley County EMS scholarship for paramedics at
// Cleveland State Community College) is actually queried.
describe('robertSearchPlanner targeted (identity-specific) plans', () => {
  const demand = {
    profile_id: 'p1',
    primary_type: 'student',
    location: { state: 'TN', city: 'Cleveland', county: 'Bradley' },
    needs: ['education'],
    employment: { employer: 'Bradley County EMS', title: 'Paramedic' },
    education: { institution: 'Cleveland State Community College', major: 'Forensic Science' },
  }

  it('queries the employer by name', () => {
    const plans = buildSearchPlans(demand, { maxPlans: 30 })
    const queries = plans.map((p) => p.search_query.toLowerCase())
    expect(queries.some((q) => q.includes('bradley county ems') && q.includes('scholarship'))).toBe(true)
  })

  it('queries occupation + school together', () => {
    const plans = buildSearchPlans(demand, { maxPlans: 30 })
    const queries = plans.map((p) => p.search_query.toLowerCase())
    expect(queries.some((q) => q.includes('paramedic') && q.includes('cleveland state community college'))).toBe(true)
  })

  it('ranks targeted plans above generic geo templates', () => {
    const plans = buildSearchPlans(demand, { maxPlans: 5 })
    // With only 5 slots, the top plans should be the identity-specific ones.
    expect(plans[0].location_scope).toBe('targeted')
    expect(plans[0].priority).toBeGreaterThanOrEqual(80)
  })

  it('does not emit placeholder queries when employer/school are missing', () => {
    const bare = { profile_id: 'p2', primary_type: 'individual', location: { state: 'OH' }, needs: ['housing'] }
    const plans = buildSearchPlans(bare, { maxPlans: 30 })
    const queries = plans.map((p) => p.search_query.toLowerCase())
    expect(queries.every((q) => !q.includes('null') && !q.includes('undefined'))).toBe(true)
  })
})
