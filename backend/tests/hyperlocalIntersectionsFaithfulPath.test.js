/**
 * hyperlocalIntersectionsFaithfulPath.test.js
 *
 * The four Amy intersections that motivated the 2026-09-12 hyperlocal repair,
 * driven through the REAL path a live crawl takes — scenario → profile signals
 * → thesis input → thesis → query plan — so the assertions bind the whole
 * chain, not a hand-built thesis. Measured BEFORE the repair (seed 0, max 28,
 * six-query execution window):
 *   - substance_recovery_org + visual_impairment + community_development (OH):
 *     the declared need was dropped between need_categories and thesis.needs
 *     (GENERATION), its only query sat past position 28 (CAP), and the nearest
 *     "town" was the ZIP holder "City National Bank" (two CORE slots).
 *   - school + visual_impairment + utilities (MS): 'utilities' dropped and a
 *     phantom 'housing' need minted (GENERATION); the county education
 *     foundation sat at position 9, outside the window (CAP/ORDER).
 *   - school_transportation + dialysis + environment (AK): 'environment'
 *     dropped (GENERATION); "Anchorage County, AK" invented in 4 queries and a
 *     fixed "STEM literacy" phrase for a transportation department (GENERATION).
 *   - school + amputee + education (OH): "City National Bank" took head slots
 *     5-6 (GENERATION); education foundation at position 9 (CAP/ORDER).
 * Dedupe was not a cause in any of the four. The cases are fixtures for the
 * general mechanism (need survival, place validity, county-equivalent naming,
 * need-keyed district family, head ordering) — nothing here is special-cased.
 */
import { describe, it, expect } from 'vitest'
import { buildIntersectionScenario } from '../services/amy/intersectionScenario.js'
import { buildProfileSignals } from '../services/profileHelpers.js'
import { profileContextToThesisInput } from '../services/crawlerOsPersistenceCore.js'
import { buildThesis } from '../crawler-os/profileIntelligence.js'
import { buildWebQueryPlan, WEB_QUERY_HEAD_WINDOW } from '../crawler-os/webQueries.js'

const CELLS = [
  { key: 'franklin_recovery_org', entity: 'substance_recovery_org', identity: 'health:visual_impairment', need: 'community_development', state: 'OH', county: /Franklin County, OH/ },
  { key: 'jackson_school_utilities', entity: 'school', identity: 'health:visual_impairment', need: 'utilities', state: 'MS', county: /Hinds County, MS/ },
  { key: 'anchorage_school_transport', entity: 'school_transportation', identity: 'health:dialysis', need: 'environment', state: 'AK', county: /Municipality of Anchorage, AK/ },
  { key: 'franklin_school_amputee', entity: 'school', identity: 'health:amputee', need: 'education', state: 'OH', county: /Franklin County, OH/ },
]

const INVENTED_GEO = /Anchorage County|City National Bank|Amsouth|Dept Of|\bBank\b|\bSvc\b/i
const INDIVIDUAL_SAFETY_NET = /benefits\.gov|211 community|churches that help|emergency assistance fund|Area Agency on Aging|vocational rehabilitation|LIHEAP/i

function faithfulPlan(cell, index) {
  const scenario = buildIntersectionScenario(cell, { runId: 'faithful-path-test', index })
  const profile = { id: `p-${index}`, display_name: scenario.display_name, primary_type: scenario.primary_type, status: 'active', tags: '[]' }
  const signals = buildProfileSignals({ profile, sections: scenario.sections })
  const input = profileContextToThesisInput({ profile, sections: scenario.sections, signals, profileId: profile.id })
  const thesis = buildThesis(input)
  const plan = buildWebQueryPlan(thesis, { year: 2026, max: 28, seed: 0 })
  return { thesis, plan }
}

describe('the four Amy intersections on the faithful scenario → thesis → plan path', () => {
  for (const [index, cell] of CELLS.entries()) {
    describe(cell.key, () => {
      const { thesis, plan } = faithfulPlan(cell, index)
      const head = plan.queries.slice(0, WEB_QUERY_HEAD_WINDOW)
      const needWord = cell.need.replace(/_/g, ' ')

      it('the DECLARED need survives to thesis.needs and is not type-defaulted', () => {
        expect(thesis.needs).toContain(cell.need)
        expect(thesis.needs_defaulted).toBe(false)
      })

      it('a query naming the declared need sits inside the six-query execution window', () => {
        expect(head.some((q) => q.toLowerCase().includes(needWord))).toBe(true)
      })

      it('a county-level (or county-equivalent) query sits inside the window, correctly named', () => {
        expect(head.some((q) => cell.county.test(q))).toBe(true)
      })

      it('no query names invented geography (a ZIP holder as a town, a non-existent Alaska county)', () => {
        expect(plan.queries.filter((q) => INVENTED_GEO.test(q))).toEqual([])
        for (const town of thesis.location.nearby_cities ?? []) expect(town.city).not.toMatch(INVENTED_GEO)
      })

      it('an organization never consumes individual safety-net slots', () => {
        expect(thesis.is_org).toBe(true)
        expect(plan.queries.filter((q) => INDIVIDUAL_SAFETY_NET.test(q))).toEqual([])
      })

      it('the head carries provenance and one rotated breadth slot', () => {
        expect(plan.entries).toHaveLength(plan.queries.length)
        expect(plan.entries.slice(0, WEB_QUERY_HEAD_WINDOW).some((e) => e.tier === 'breadth')).toBe(true)
        expect(plan.entries.slice(0, WEB_QUERY_HEAD_WINDOW).some((e) => e.tier === 'core' && e.gap_class === null)).toBe(true)
      })
    })
  }

  it('the utilities need never mints a phantom housing need on the faithful path', () => {
    const { thesis } = faithfulPlan(CELLS[1], 1)
    expect(thesis.needs).not.toContain('housing')
    expect(thesis.needs).toContain('energy')
  })

  it('a school district searches its declared need, not a fixed STEM phrase', () => {
    const { plan } = faithfulPlan(CELLS[2], 2)
    expect(plan.queries.some((q) => /^school district environment grants Municipality of Anchorage, AK$/.test(q))).toBe(true)
    expect(plan.queries.some((q) => /STEM literacy/.test(q))).toBe(false)
  })
})
