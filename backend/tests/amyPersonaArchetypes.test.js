/**
 * amyPersonaArchetypes.test.js
 *
 * Part A of the persona coverage audit (2026-08-02): what Amy tests, and
 * whether what she finds can ever be CLOSED.
 *
 * Two defects are pinned here.
 *
 * (1) THE COHORT WAS SINGLE-AXIS. Every archetype named one fact — a veteran,
 *     or a business; a church, or a nonprofit; "at-risk" housing without saying
 *     which way. The planner gates on the INTERSECTION, so the four situations
 *     the owner named were untested by construction. Indiana was not even in
 *     the location list, so no Indiana profile had ever been crawled.
 *
 * (2) A FINDING WITH NO LEVER CANNOT CLOSE. Measured over the 21 cohort days in
 *     prod `system_kv amy_flywheel_cohort`, `institution_recall_miss` is the
 *     only finding present on 21 of 21 days (282 occurrences, never once green)
 *     while `weak_match` appeared on 2 days (11 occurrences) and led the report.
 *     `buildApprovalQueue` built items from status/false_positives/
 *     ineligible_accepts/sources_failed and NOTHING else — it never read
 *     `e.findings` — so a recall miss could not become an approval item, could
 *     not acquire a lever, and could not enter the durable ledger from #1085.
 */
import { describe, it, expect } from 'vitest'
import { CATEGORY_CATALOG, CATEGORY_IDS, generateScenarios } from '../services/amy/syntheticProfileCatalog.js'
import { buildApprovalQueue, CATEGORY_COVERAGE } from '../services/amy/crawlerTuner.js'
import { LANE_CATEGORY_AFFINITY } from '../services/coverageGapScoreboard.js'
import { FINDING_TYPES } from '../services/amy/amyConstants.js'
import { getSource } from '../crawler-os/sourceRegistry.js'

const NEW_CATEGORIES = ['veteran_entrepreneur', 'struggling_congregation', 'homeowner_foreclosure', 'renter_eviction']

describe('Amy tests the situations real applicants are actually in', () => {
  it('the four owner personas each have an archetype', () => {
    for (const id of NEW_CATEGORIES) {
      expect(CATEGORY_IDS, `${id} missing from the catalog`).toContain(id)
      expect(CATEGORY_CATALOG[id].label).toBeTruthy()
      expect(typeof CATEGORY_CATALOG[id].build).toBe('function')
    }
  })

  it('a veteran entrepreneur declares BOTH facts — the intersection is the point', () => {
    const s = CATEGORY_CATALOG.veteran_entrepreneur.build({ location: { city: 'Beckley', state: 'WV', county: 'Raleigh' }, rng: () => 0.5 })
    expect(s.military_service?.veteran).toBe(true)
    expect(s.occupation?.small_business_owner).toBe(true)
  })

  it('foreclosure and eviction are DIFFERENT profiles — owning vs renting', () => {
    const fc = CATEGORY_CATALOG.homeowner_foreclosure.build({ rng: () => 0.5 })
    const ev = CATEGORY_CATALOG.renter_eviction.build({ rng: () => 0.5 })
    expect(fc.housing.type).toBe('own')
    expect(ev.housing.type).toBe('rent')
    expect(fc.financial_information.bankruptcy_foreclosure).toBe(true)
    // Both must be at-risk — an "at-risk" flag alone was what made the old
    // `individual_assistance` archetype unable to distinguish them.
    expect(fc.housing.status).toBe('at-risk')
    expect(ev.housing.status).toBe('at-risk')
  })

  it('a struggling congregation declares a BUILDING problem, not just a mission', () => {
    const s = CATEGORY_CATALOG.struggling_congregation.build({ location: { county: 'Erie', state: 'OH' }, rng: () => 0.5 })
    expect(s.organization_details.organization_type).toBe('church')
    expect(s.programs_services.interests.join(' ')).toMatch(/building repair|historic preservation/)
  })

  it('every category is reachable from at least one coverage lane (affinity totality)', () => {
    const covered = new Set(Object.values(LANE_CATEGORY_AFFINITY).flat())
    for (const id of CATEGORY_IDS) {
      expect(covered.has(id), `${id} is in no LANE_CATEGORY_AFFINITY lane — gap pressure can never weight it`).toBe(true)
    }
    // And no affinity entry may name a category that does not exist.
    for (const [lane, cats] of Object.entries(LANE_CATEGORY_AFFINITY)) {
      for (const c of cats) expect(CATEGORY_IDS, `${lane} names unknown category ${c}`).toContain(c)
    }
  })

  it('the location list covers Indiana (it did not, so no IN profile was ever crawled)', () => {
    const states = new Set(generateScenarios({ runId: 'r', perCategory: 3 }).map((s) => s.expected.state))
    for (const st of ['IN', 'OH', 'WV']) expect(states, `${st} never appears in a cohort`).toContain(st)
  })
})

describe('a recall miss now has a lever, so it can be closed instead of re-reported', () => {
  const evalWith = (type, category, evidence = {}) => ({
    category,
    status: 'ok',
    false_positives: 0,
    ineligible_accepts: 0,
    sources_failed: 0,
    findings: [{ type, evidence }],
  })

  it('institution_recall_miss produces an approval item naming the query-breadth lever', () => {
    const items = buildApprovalQueue([
      evalWith(FINDING_TYPES.INSTITUTION_RECALL_MISS, 'college_student', { schools: ['Middle Tennessee State University'] }),
      evalWith(FINDING_TYPES.INSTITUTION_RECALL_MISS, 'college_student', { schools: ['The Ohio State University'] }),
    ])
    const item = items.find((i) => i.id === `${FINDING_TYPES.INSTITUTION_RECALL_MISS}:college_student`)
    expect(item, 'the 21-of-21-day finding still produces no approval item').toBeTruthy()
    expect(item.lever).toBe('query_breadth')
    expect(item.target_file).toBe('backend/crawler-os/webQueries.js')
    expect(item.evidence.profiles).toBe(2)
    // The concrete missed subjects travel with the item — that is what makes it
    // work someone can do, rather than a number.
    // `subjects`, not `missed_subjects`: this branch originally wrote the
    // latter, but `buildCodeBrief` reads `evidence.subjects` and so does the
    // registry-driven totality pass, so the brief this item now produces would
    // have named no school at all. See findingActorRegistry.js.
    expect(item.evidence.subjects).toEqual(
      expect.arrayContaining(['Middle Tennessee State University', 'The Ohio State University']),
    )
    expect(item.rationale).toMatch(/Middle Tennessee State University/)
  })

  it('hyperlocal_recall_miss gets the same lever, grouped per category', () => {
    const items = buildApprovalQueue([evalWith(FINDING_TYPES.HYPERLOCAL_RECALL_MISS, 'renter_eviction', { county: 'Montgomery County' })])
    const item = items.find((i) => i.id === `${FINDING_TYPES.HYPERLOCAL_RECALL_MISS}:renter_eviction`)
    expect(item).toBeTruthy()
    expect(item.lever).toBe('query_breadth')
    expect(item.evidence.subjects).toContain('Montgomery County')
  })

  it('a clean cohort produces NO recall item (the guard can fail)', () => {
    const items = buildApprovalQueue([{ category: 'college_student', status: 'ok', false_positives: 0, ineligible_accepts: 0, sources_failed: 0, findings: [] }])
    expect(items.filter((i) => i.lever === 'query_breadth')).toHaveLength(0)
  })

  it('an evaluation with no findings array does not throw (real evals predate the field)', () => {
    expect(() => buildApprovalQueue([{ category: 'x', status: 'ok', false_positives: 0, ineligible_accepts: 0, sources_failed: 0 }])).not.toThrow()
  })
})

describe('every catalog category has a coverage lane that names a REAL source', () => {
  // 2026-08-18: remaining catalog archetypes had no CATEGORY_COVERAGE entry, so
  // locator-only / persistent weak_match for them dead-ended at scoring_weights
  // — the lever Amy already trialled and auto-REVERTED. A missing lane is the
  // housing_authority class again.
  it('CATEGORY_COVERAGE covers every CATEGORY_IDS member with a live registry source', () => {
    for (const id of CATEGORY_IDS) {
      const cov = CATEGORY_COVERAGE[id]
      expect(cov, `${id} has no CATEGORY_COVERAGE lane — a locator-only weak_match cannot widen a source`).toBeTruthy()
      expect(cov.source, `${id} coverage lane names no source`).toBeTruthy()
      expect(getSource(cov.source), `${id} maps to unknown source ${cov.source}`).toBeTruthy()
    }
  })

  it('does not invent coverage keys that are not catalog categories', () => {
    for (const id of Object.keys(CATEGORY_COVERAGE)) {
      expect(CATEGORY_IDS, `CATEGORY_COVERAGE names unknown category ${id}`).toContain(id)
    }
  })
})
