import { describe, it, expect } from 'vitest'
import {
  selectVisibleCatalog,
  mergeDiscoveryResults,
  buildResultsReconciliation,
} from './discoverResultsMerge.js'

// Build a distinct opportunity (unique title + url so dedupe never collapses
// two different programs together).
function opp(i, { title, sponsor, score }) {
  return {
    id: `opp-${i}`,
    title,
    program_name: title,
    sponsor,
    application_url: `https://example-funder-${i}.org/apply`,
    url: `https://example-funder-${i}.org/apply`,
    match_score: score,
    source: 'catalog',
  }
}

// Two profile SHAPES to prove the merge/keep-last-good/reconciliation logic is
// profile-type-agnostic (owner: "make this a GLOBAL fix"). The helpers never
// read profile type — these fixtures only differ in their program names.
const INDIVIDUAL_CATALOG = [
  opp(1, { title: 'DOL ETA Workforce Grant', sponsor: 'US DOL', score: 22 }),
  opp(2, { title: 'Copay Assistance Foundation Aid', sponsor: 'Copay Foundation', score: 18 }),
  opp(3, { title: 'State Rental Assistance', sponsor: 'State HFA', score: 14 }),
  opp(4, { title: 'Community Utility Relief', sponsor: 'City Fund', score: 11 }),
  opp(5, { title: 'Local Food Security Program', sponsor: 'Regional Bank', score: 9 }),
]
const INDIVIDUAL_LIVE = [
  opp(90, { title: 'Emergency Broadband Benefit', sponsor: 'FCC', score: 12 }),
  opp(91, { title: 'Diaper Bank Support', sponsor: 'Nonprofit X', score: 8 }),
]

const ORG_CATALOG = [
  opp(101, { title: 'SBIR Phase I Solicitation', sponsor: 'NIH', score: 25 }),
  opp(102, { title: 'Nonprofit Capacity Building Grant', sponsor: 'Community Foundation', score: 19 }),
  opp(103, { title: 'Rural Broadband Infrastructure', sponsor: 'USDA', score: 15 }),
  opp(104, { title: 'Arts Organization Operating Support', sponsor: 'State Arts Council', score: 12 }),
  opp(105, { title: 'Small Business Innovation Voucher', sponsor: 'State EDA', score: 10 }),
]
const ORG_LIVE = [
  opp(190, { title: 'Foundation General Operating Award', sponsor: 'Family Foundation', score: 13 }),
  opp(191, { title: 'Workforce Development Partnership', sponsor: 'Regional Chamber', score: 7 }),
]

describe('mergeDiscoveryResults — live run AUGMENTS, never replaces the stored catalog', () => {
  for (const [label, catalog, live] of [
    ['individual', INDIVIDUAL_CATALOG, INDIVIDUAL_LIVE],
    ['org/nonprofit', ORG_CATALOG, ORG_LIVE],
  ]) {
    it(`[${label}] shows all N catalog matches + the live 2 (not just the 2)`, () => {
      const merged = mergeDiscoveryResults(catalog, live)
      // The collapse bug rendered only the live run's 2 results. The union must
      // keep every stored catalog match.
      expect(merged.length).toBe(catalog.length + live.length)
      for (const c of catalog) {
        expect(merged.some((m) => m.title === c.title)).toBe(true)
      }
      // Sorted by score descending.
      const scores = merged.map((m) => m.match_score)
      expect(scores).toEqual([...scores].sort((a, b) => b - a))
    })
  }

  it('handles empty live run — catalog still fully shown', () => {
    const merged = mergeDiscoveryResults(INDIVIDUAL_CATALOG, [])
    expect(merged.length).toBe(INDIVIDUAL_CATALOG.length)
  })
})

describe('selectVisibleCatalog — a transient 503 refetch never blanks a loaded list', () => {
  for (const [label, catalog, live] of [
    ['individual', INDIVIDUAL_CATALOG, INDIVIDUAL_LIVE],
    ['org/nonprofit', ORG_CATALOG, ORG_LIVE],
  ]) {
    it(`[${label}] keeps the last good catalog when the query errors (fresh=empty)`, () => {
      // First: a successful load populates the "last good" set.
      const good = selectVisibleCatalog({ hasFreshSuccess: true, fresh: catalog, lastGood: [] })
      expect(good.length).toBe(catalog.length)

      // Then a concurrent crawl makes the refetch 503 → no fresh data. The view
      // must keep the last good set, not blank it.
      const duringError = selectVisibleCatalog({ hasFreshSuccess: false, fresh: [], lastGood: good })
      expect(duringError.length).toBe(catalog.length)

      // And the combined view during the error still shows catalog + live.
      const merged = mergeDiscoveryResults(duringError, live)
      expect(merged.length).toBe(catalog.length + live.length)
    })
  }

  it('an empty SUCCESS legitimately clears the list (user raised the score floor)', () => {
    const visible = selectVisibleCatalog({ hasFreshSuccess: true, fresh: [], lastGood: INDIVIDUAL_CATALOG })
    expect(visible.length).toBe(0)
  })
})

describe('buildResultsReconciliation — honest displayed-vs-matched line', () => {
  it('flags hidden matches when some scored below the filter (both profile shapes)', () => {
    for (const matched of [20, 6]) {
      const rec = buildResultsReconciliation({
        shownCount: 2,
        matchedSourceCount: matched,
        belowFloorCount: 8,
        minScore: 19,
      })
      expect(rec).not.toBeNull()
      expect(rec.hidden).toBe(true)
      expect(rec.matched).toBe(matched)
      expect(rec.belowFloorCount).toBe(8)
      expect(rec.minScore).toBe(19)
    }
  })

  it('not hidden when nothing is below the floor, but still reports matched sources', () => {
    const rec = buildResultsReconciliation({
      shownCount: 10,
      matchedSourceCount: 10,
      belowFloorCount: 0,
      minScore: 8,
    })
    expect(rec).not.toBeNull()
    expect(rec.hidden).toBe(false)
    expect(rec.matched).toBe(10)
  })

  it('returns null when there is nothing to reconcile', () => {
    expect(
      buildResultsReconciliation({ shownCount: 0, matchedSourceCount: 0, belowFloorCount: 0, minScore: 8 }),
    ).toBeNull()
  })
})
