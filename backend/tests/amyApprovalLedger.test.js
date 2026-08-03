/**
 * amyApprovalLedger.test.js
 *
 * Guards for the 2026-08-01 write-only-queue fix.
 *
 * Prod evidence this was written against (read-only, 2026-07-31):
 *  - `amy_recent_runs` shows a NON-EMPTY approval queue on all 20 retained runs
 *    (size 1 for the eighteen runs 2026-07-15 → 2026-07-29, then 4, then 6).
 *  - the only apply path in the product (`POST /api/amy/relevance-vocabulary`)
 *    writes `system_kv amy_generic_title_additions` — a key that DOES NOT EXIST
 *    in the production database. Zero items have ever been actioned.
 *  - the 2026-07-30 queue held four `scoring_weights` items (tribal_org,
 *    community_development_corp, housing_authority, workforce_org) whose
 *    evaluations were LOCATOR-ONLY (top_score 54 / 10 / 10 / 10 with
 *    accepted=0), i.e. asks against a lever that provably cannot move the
 *    final score.
 */

import { describe, it, expect } from 'vitest'
import {
  foldApprovalLedger,
  decorateApprovalQueue,
  leverActionability,
  LEVER_REGISTRY,
  ACTIONABILITY,
  RESOLUTION,
  LEDGER_MAX_ENTRIES,
} from '../services/amy/approvalLedger.js'
import { buildApprovalQueue, proposeCoverageOverrides } from '../services/amy/crawlerTuner.js'
import { POINTER_KINDS } from '../config/opportunityKindClasses.js'
import { evaluateDiscovery } from '../services/amy/amyReport.js'
import { isGenericOnly } from '../config/genericTitleVocabulary.js'

const D1 = '2026-07-25T04:00:00.000Z' // ET 2026-07-25
const D2 = '2026-07-26T04:00:00.000Z'
const D3 = '2026-07-27T04:00:00.000Z'

const item = (id, lever, category) => ({ id, lever, category, severity: 'high' })

describe('approval ledger — the queue can finally tell night 1 from night 30', () => {
  it('stamps first_seen_at and AGES an item that keeps reproducing', () => {
    let led = null
    let fold = foldApprovalLedger(led, { items: [item('a', 'relevance_precision', 'foster_youth')], runId: 'r1', at: D1 })
    expect(fold.decorated[0].nights_open).toBe(1)
    expect(fold.decorated[0].first_seen_at).toBe(D1)

    led = fold.ledger
    fold = foldApprovalLedger(led, { items: [item('a', 'relevance_precision', 'foster_youth')], runId: 'r2', at: D2 })
    expect(fold.decorated[0].nights_open).toBe(2)
    expect(fold.decorated[0].first_seen_at).toBe(D1)
    expect(fold.decorated[0].runs_seen).toBe(2)
  })

  it('CLOSES an item that stops reproducing — the only proof this loop converges', () => {
    const first = foldApprovalLedger(null, { items: [item('a', 'relevance_precision', 'foster_youth')], runId: 'r1', at: D1 })
    const second = foldApprovalLedger(first.ledger, { items: [], runId: 'r2', at: D2 })
    expect(second.closed).toHaveLength(1)
    expect(second.closed[0].id).toBe('a')
    expect(second.closed[0].resolution).toBe(RESOLUTION.STOPPED_REPRODUCING)
    expect(second.ledger.entries.a.resolved_at).toBe(D2)
  })

  it('an APPLIED lever does not close the item — only the finding going away does', () => {
    // "We applied a change" is not evidence the change worked. This repo has
    // paid for that inference before (a fix reading green while doing nothing).
    const applied = { ...item('a', 'scoring_weights', 'tribal_org'), auto_applied: { lever: 'scoring_weights', kept: true } }
    const first = foldApprovalLedger(null, { items: [applied], runId: 'r1', at: D1 })
    expect(first.ledger.entries.a.resolved_at).toBeNull()
    expect(first.ledger.entries.a.last_auto_applied_at).toBe(D1)

    // Still reproducing the next night → still open, and now two nights old.
    const second = foldApprovalLedger(first.ledger, { items: [applied], runId: 'r2', at: D2 })
    expect(second.ledger.entries.a.resolved_at).toBeNull()
    expect(second.ledger.entries.a.nights_open).toBe(2)

    // Gone the night after → NOW it closes, credited to the auto-apply.
    const third = foldApprovalLedger(second.ledger, { items: [], runId: 'r3', at: D3 })
    expect(third.closed[0].resolution).toBe(RESOLUTION.AUTO_APPLIED)
  })

  it('a REOPENED item restarts its clock but records that it came back', () => {
    const a = item('a', 'relevance_precision', 'foster_youth')
    const one = foldApprovalLedger(null, { items: [a], runId: 'r1', at: D1 })
    const two = foldApprovalLedger(one.ledger, { items: [], runId: 'r2', at: D2 })
    expect(two.ledger.entries.a.resolution).toBe(RESOLUTION.STOPPED_REPRODUCING)
    const three = foldApprovalLedger(two.ledger, { items: [a], runId: 'r3', at: D3 })
    expect(three.ledger.entries.a.resolved_at).toBeNull()
    expect(three.ledger.entries.a.nights_open).toBe(1)
    expect(three.ledger.entries.a.first_seen_at).toBe(D3)
    expect(three.ledger.entries.a.reopened_count).toBe(1)
  })

  it('re-folding the SAME run is idempotent — a retry never ages anything twice', () => {
    const a = item('a', 'relevance_precision', 'foster_youth')
    const one = foldApprovalLedger(null, { items: [a], runId: 'r1', at: D1 })
    const dup = foldApprovalLedger(one.ledger, { items: [a], runId: 'r1', at: D2 })
    expect(dup.duplicate).toBe(true)
    expect(dup.ledger).toBe(one.ledger)
    expect(dup.decorated[0].nights_open).toBe(1)
  })

  it('escalates a STALE non-auto item, and never escalates an AUTO one', () => {
    const stale = process.env.AMY_APPROVAL_STALE_NIGHTS
    process.env.AMY_APPROVAL_STALE_NIGHTS = '2'
    try {
      let ledger = null
      // Three consecutive ET days for BOTH an owner_api and an auto lever.
      for (const [runId, at] of [['r1', D1], ['r2', D2], ['r3', D3]]) {
        ledger = foldApprovalLedger(ledger, {
          items: [item('a', 'relevance_precision', 'foster_youth'), item('b', 'scoring_weights', 'tribal_org')],
          runId,
          at,
        }).ledger
      }
      const fold = foldApprovalLedger(ledger, {
        items: [item('a', 'relevance_precision', 'foster_youth'), item('b', 'scoring_weights', 'tribal_org')],
        runId: 'r4',
        at: '2026-07-28T04:00:00.000Z',
      })
      const staleIds = fold.stale.map((e) => e.id)
      expect(staleIds).toContain('a')
      // `scoring_weights` is an AUTO lever — Amy's own work is never "stale on
      // the owner", so escalating it would be noise the owner cannot act on.
      expect(staleIds).not.toContain('b')
      expect(fold.decorated.find((d) => d.id === 'a').stale).toBe(true)
      expect(fold.decorated.find((d) => d.id === 'b').stale).toBe(false)
    } finally {
      if (stale === undefined) delete process.env.AMY_APPROVAL_STALE_NIGHTS
      else process.env.AMY_APPROVAL_STALE_NIGHTS = stale
    }
  })

  it('never drops an OPEN entry when trimming to the cap', () => {
    const many = Array.from({ length: LEDGER_MAX_ENTRIES + 20 }, (_, i) => item(`i${i}`, 'relevance_precision', `c${i}`))
    const fold = foldApprovalLedger(null, { items: many, runId: 'r1', at: D1 })
    const kept = Object.values(fold.ledger.entries)
    expect(kept).toHaveLength(LEDGER_MAX_ENTRIES)
    expect(kept.every((e) => !e.resolved_at)).toBe(true)
  })
})

describe('lever actionability registry — every emitted lever declares how it closes', () => {
  // TOTALITY (the registry rule): a new lever must not be able to fall out of
  // the actionability contract and silently render as an unclosable owner ask.
  it('every lever buildApprovalQueue can emit is registered', () => {
    const evals = [
      { status: 'zero', category: 'foster_youth' },
      { status: 'zero', category: 'foster_youth' },
      { status: 'ok', category: 'foster_youth', false_positives: 1 },
      { status: 'ok', category: 'homeschool_family', ineligible_accepts: 2 },
      { status: 'weak', category: 'housing_authority', locator_only: true },
      { status: 'weak', category: 'senior_citizen', locator_only: false },
      { status: 'ok', category: 'veteran', sources_failed: 1 },
    ]
    const levers = new Set(buildApprovalQueue(evals).map((i) => i.lever))
    expect(levers.size).toBeGreaterThanOrEqual(5)
    for (const lever of levers) {
      expect(Object.keys(LEVER_REGISTRY)).toContain(lever)
    }
  })

  it('every OWNER_API lever names a route that actually exists', async () => {
    const fs = await import('node:fs/promises')
    const url = await import('node:url')
    const routeFile = url.fileURLToPath(new URL('../routes/amy.js', import.meta.url))
    const src = await fs.readFile(routeFile, 'utf8')
    const ownerLevers = Object.entries(LEVER_REGISTRY).filter(([, v]) => v.actionability === ACTIONABILITY.OWNER_API)
    expect(ownerLevers.length).toBeGreaterThan(0)
    for (const [lever, meta] of ownerLevers) {
      expect(meta.surface, `${lever} must name a surface`).toBeTruthy()
      const m = /(GET|POST|PUT|PATCH|DELETE)\s+\/api\/amy(\/[a-z0-9\-/]*)/i.exec(meta.surface)
      expect(m, `${lever} surface must name an /api/amy route`).toBeTruthy()
      const [, verb, path] = m
      // Literal substring, never a constructed RegExp: escaping a path into a
      // pattern is exactly the partial-sanitization shape CodeQL blocks, and a
      // plain `includes` is both safer and a stricter check.
      const needle = `router.${verb.toLowerCase()}('${path}'`
      expect(src.includes(needle), `${lever}: ${verb} ${path} is not defined in routes/amy.js`).toBe(true)
    }
  })

  it('every human-gated lever explains WHY (an unexplained gate becomes wallpaper)', () => {
    for (const [lever, meta] of Object.entries(LEVER_REGISTRY)) {
      if (meta.actionability === ACTIONABILITY.AUTO) continue
      expect(meta.why, `${lever} must explain its human gate`).toBeTruthy()
    }
  })

  it('an UNREGISTERED lever is honestly unactionable, never silently auto', () => {
    const meta = leverActionability('something_new')
    expect(meta.actionability).toBe(ACTIONABILITY.CODE_CHANGE)
    expect(meta.unregistered).toBe(true)
  })

  it('requires_approval means a human CAN approve — not that one is being asked', () => {
    const decorated = decorateApprovalQueue([
      item('a', 'relevance_precision', 'foster_youth'),
      item('b', 'scoring_weights', 'tribal_org'),
      item('c', 'eligibility_gate', 'homeschool_family'),
    ], null)
    expect(decorated[0].requires_approval).toBe(true)
    expect(decorated[1].requires_approval).toBe(false)
    expect(decorated[2].requires_approval).toBe(false)
    expect(decorated[2].actionability).toBe(ACTIONABILITY.CODE_CHANGE)
  })
})

describe('locator-only weak matches are a COVERAGE gap, not a scoring-weights gap', () => {
  // The prod pairs: `isRecommendable` admits an ACCEPT of any kind plus a
  // DIRECTORY locator at REVIEW, and computeMatchDecision never lets a locator
  // ACCEPT — so a recommendation list with zero ACCEPTs is, by construction,
  // all locators. Asking the owner to approve a scoring-weight change for it
  // was an ask no approval could close.
  const scenario = { scenario_id: 'housing_authority-v1', category: 'housing_authority', label: 'Housing Authority', expected: {} }
  const locatorRun = {
    run: {
      run_id: 'run-1',
      stored: 190,
      recommendations: Array.from({ length: 31 }, (_, i) => ({
        title: `Local assistance programs near you ${i}`,
        kind: 'DIRECTORY',
        decision: 'REVIEW',
        match_score: i === 0 ? 10 : 4,
      })),
      sources: [],
    },
    thesis: {},
  }

  it('reports a locator-only outcome as ZERO direct awards, not a near-miss top score', () => {
    const ev = evaluateDiscovery(scenario, 'p1', locatorRun)
    expect(ev.status).toBe('weak')
    expect(ev.locator_only).toBe(true)
    expect(ev.direct_recommendations).toBe(0)
    expect(ev.locator_recommendations).toBe(31)
    expect(ev.top_direct_score).toBe(0)
    const weak = ev.findings.find((f) => f.type === 'weak_match')
    expect(weak.message).toMatch(/ZERO direct awards were recommended/)
    expect(weak.message).toMatch(/can never claim ACCEPT/)
    expect(weak.message).toMatch(/COVERAGE gap/)
    // The pre-fix message quoted the locator's score as "top score", which
    // reads as "we nearly had a strong match".
    expect(weak.message).not.toMatch(/top score 10 \(review-band only\)/)
  })

  // ── the pointer set comes from the REGISTRY, not from a kind typed here ──
  // #1088 fixed exactly this shape one level over: `pipeline.amountCoverage`
  // hand-typed ('directory','benefit') while prod carries `referral` (119) and
  // `school_portal` (102) as well. This split is a NEW consumer of the same
  // classification, so it must read `POINTER_KINDS`.
  it('every POINTER kind counts as a pointer, not as a direct award', () => {
    for (const kind of POINTER_KINDS) {
      const ev = evaluateDiscovery(scenario, 'p1', {
        run: {
          run_id: 'r',
          stored: 50,
          recommendations: [{ title: `A ${kind} row`, kind, decision: 'REVIEW', match_score: 9 }],
          sources: [],
        },
        thesis: {},
      })
      expect(ev.locator_only, `${kind} must classify as a pointer`).toBe(true)
      expect(ev.direct_recommendations).toBe(0)
    }
  })

  it('prod casing is handled in both directions (directory AND DIRECTORY)', () => {
    // Prod holds `directory` 4271 AND `DIRECTORY` 224 on the same column.
    for (const kind of ['directory', 'DIRECTORY', 'School_Portal', ' referral ']) {
      const ev = evaluateDiscovery(scenario, 'p1', {
        run: { run_id: 'r', stored: 50, recommendations: [{ title: 't', kind, decision: 'REVIEW', match_score: 9 }], sources: [] },
        thesis: {},
      })
      expect(ev.locator_only, `${JSON.stringify(kind)} must classify as a pointer`).toBe(true)
    }
  })

  it('a BENEFIT is a DIRECT award, never a pointer (511 prod match rows ride on this)', () => {
    // A benefit program publishes no fixed figure but IS the thing you apply
    // to. Using NO_PER_AWARD_FIGURE_KINDS here would flip real profiles to
    // locator_only and misroute them at the coverage lever.
    const ev = evaluateDiscovery(scenario, 'p1', {
      run: {
        run_id: 'r',
        stored: 50,
        recommendations: [{ title: 'Federal Pell Grant', kind: 'benefit', decision: 'ACCEPT', match_score: 20 }],
        sources: [],
      },
      thesis: {},
    })
    expect(ev.locator_only).toBe(false)
    expect(ev.direct_recommendations).toBe(1)
  })

  it('a weak run WITH direct awards is still routed at scoring weights', () => {
    const ev = evaluateDiscovery(scenario, 'p1', {
      run: {
        run_id: 'run-2',
        stored: 40,
        recommendations: [
          { title: 'Real Program', kind: 'PROGRAM', decision: 'ACCEPT', match_score: 12 },
          { title: 'Directory', kind: 'DIRECTORY', decision: 'REVIEW', match_score: 9 },
        ],
        sources: [],
      },
      thesis: {},
    })
    // An ACCEPT exists → not weak at all; the direct/locator split is still recorded.
    expect(ev.direct_recommendations).toBe(1)
    expect(ev.locator_only).toBe(false)
  })

  it('buildApprovalQueue routes locator-only weakness at the COVERAGE lever', () => {
    const queue = buildApprovalQueue([
      { status: 'weak', category: 'housing_authority', locator_only: true },
      { status: 'weak', category: 'tribal_org', locator_only: true },
    ])
    const levers = queue.map((i) => i.lever)
    expect(levers).toContain('source_keyword_coverage')
    // The pre-fix code minted `scoring_weights` for every weak category.
    expect(levers).not.toContain('scoring_weights')
    for (const i of queue) {
      expect(i.actionability).toBe(ACTIONABILITY.AUTO)
      expect(i.requires_approval).toBe(false)
    }
  })

  it('a weak category with real direct awards still gets the scoring lever', () => {
    const queue = buildApprovalQueue([{ status: 'weak', category: 'senior_citizen', locator_only: false }])
    expect(queue.map((i) => i.lever)).toContain('scoring_weights')
  })

  it('a locator-only category with NO coverage lane says so instead of pretending', () => {
    const queue = buildApprovalQueue([{ status: 'weak', category: 'not_a_real_category', locator_only: true }])
    expect(queue[0].evidence.has_coverage_lane).toBe(false)
    expect(queue[0].rationale).toMatch(/NO entry in CATEGORY_COVERAGE/)
  })

  it('the coverage editor can now ACT on a locator-only gap (both prod categories map to a real source)', () => {
    const proposal = proposeCoverageOverrides([
      { status: 'weak', category: 'housing_authority', locator_only: true },
      { status: 'weak', category: 'tribal_org', locator_only: true },
    ], { liveOverrides: {} })
    expect(proposal.change).toBe(true)
    const cats = proposal.additions.map((a) => a.category).sort()
    expect(cats).toEqual(['housing_authority', 'tribal_org'])
    expect(proposal.additions.every((a) => a.gap_kind === 'locator_only')).toBe(true)
    expect(proposal.additions.every((a) => typeof a.source_id === 'string' && a.source_id.length > 0)).toBe(true)
  })

  it('a plain weak (non-locator-only) evaluation never widens coverage', () => {
    const proposal = proposeCoverageOverrides([
      { status: 'weak', category: 'housing_authority', locator_only: false },
    ], { liveOverrides: {} })
    expect(proposal.change).toBe(false)
  })

  it('coverage proposals stay idempotent — a second pass over live overrides is a no-op', () => {
    const first = proposeCoverageOverrides(
      [{ status: 'weak', category: 'tribal_org', locator_only: true }],
      { liveOverrides: {} },
    )
    const second = proposeCoverageOverrides(
      [{ status: 'weak', category: 'tribal_org', locator_only: true }],
      { liveOverrides: first.next },
    )
    expect(second.change).toBe(false)
  })
})

// ── false_positive reads the CAP'S text, not a narrower one (2026-08-02) ────
//
// The engine's generic-only ACCEPT cap (matchEngine computeMatchDecision)
// evaluates `title + description`: a concrete anchor in the DESCRIPTION
// ("rent") deliberately rescues a generically-titled row and the ACCEPT
// stands. Amy's false_positive detector used to test the TITLE alone, so it
// flagged exactly the rows the cap had deliberately rescued — and minted an
// approval item (`false_positive:veteran`, the El Paso County General
// Assistance Program item, 3 active TX rows) that NO approval could close:
// the baseline vocabulary already matched "general assistance", so the only
// approvable additions were a no-op or an over-block. These guards pin the
// detector to the cap's own text.
//
// MUTATION-VERIFIED: revert amyReport's `genericOnly: isGenericOnly(capTextOf(r))`
// to `isGenericOnly(r.title)` and the El Paso tests below go red.
describe('false_positive — the detector evaluates the SAME text as the generic-title cap', () => {
  const scenario = { scenario_id: 'veteran-v1', category: 'veteran', label: 'Veteran Household' }
  const runWith = (recommendations) => ({
    run: { run_id: 'r-fp-cap-text', stored: recommendations.length, recommendations, sources: [] },
    persisted: { opportunities: recommendations.length },
    thesis: {},
  })

  // The live prod shape this fix retires: generic TITLE ("general assistance"
  // is baseline vocabulary), concrete anchors ONLY in the description.
  const elPaso = {
    opportunity_id: 'opp-el-paso',
    title: 'El Paso County General Assistance Program',
    description:
      'Emergency help for El Paso County residents with rent, utility bills, and food for eligible households.',
    sponsor: 'El Paso County',
    kind: 'PROGRAM',
    match_score: 21,
    decision: 'ACCEPT',
  }

  it('a row the cap deliberately RESCUED (concrete anchor in the description) is NOT a false positive', () => {
    const ev = evaluateDiscovery(scenario, 'p-veteran', runWith([elPaso]))
    expect(ev.false_positives).toBe(0)
    expect(ev.false_positive_titles).toEqual([])
    expect(ev.findings.some((f) => f.type === 'false_positive')).toBe(false)
    // The candidate record agrees: generic by TITLE (naming convention), but
    // not generic-only on the cap's text.
    expect(ev.candidates[0].generic).toBe(true)
    expect(ev.candidates[0].genericOnly).toBe(false)
  })

  it('…and produces NO false_positive approval item — the unfillable owner ask is retired', () => {
    const ev = evaluateDiscovery(scenario, 'p-veteran', runWith([elPaso]))
    const items = buildApprovalQueue([ev])
    expect(items.filter((i) => String(i.id).startsWith('false_positive:'))).toEqual([])
  })

  it('a row generic across title AND description that still cleared ACCEPT is a CAP LEAK and STILL flags', () => {
    // No CONCRETE_RE anchor anywhere: if this is ACCEPT, the cap leaked.
    const leak = {
      opportunity_id: 'opp-leak',
      title: 'Statewide Funding Finder',
      description: 'A search portal with a list of programs and other ways to find funding in your area.',
      sponsor: 'State Office',
      kind: 'PROGRAM',
      match_score: 20,
      decision: 'ACCEPT',
    }
    const ev = evaluateDiscovery(scenario, 'p-veteran', runWith([leak]))
    expect(ev.false_positives).toBe(1)
    expect(ev.false_positive_titles).toEqual(['Statewide Funding Finder'])
    const finding = ev.findings.find((f) => f.type === 'false_positive')
    expect(finding).toBeTruthy()
    expect(finding.evidence.false_positive_titles).toEqual(['Statewide Funding Finder'])
    // The detector keeps its actor: the leak still reaches the approval queue.
    const items = buildApprovalQueue([ev])
    const item = items.find((i) => i.id === 'false_positive:veteran')
    expect(item).toBeTruthy()
    expect(item.lever).toBe('relevance_precision')
  })

  it('a legacy recommendation with NO description field keeps the old title-only behavior (fail-noisy, never fail-silent)', () => {
    const legacy = {
      opportunity_id: 'opp-legacy',
      title: 'Funding Finder',
      sponsor: 'Somewhere',
      kind: 'PROGRAM',
      match_score: 20,
      decision: 'ACCEPT',
    }
    const ev = evaluateDiscovery(scenario, 'p-veteran', runWith([legacy]))
    expect(ev.false_positives).toBe(1)
  })

  it('the cap and the detector cannot disagree about the El Paso text (same predicate, same text)', () => {
    // The exact construction matchEngine uses for its cap check.
    const capText = `${elPaso.title || ''} ${elPaso.description || ''}`.toLowerCase()
    expect(isGenericOnly(capText)).toBe(false) // the cap rescues it…
    expect(isGenericOnly(elPaso.title)).toBe(true) // …while a TITLE-ONLY reading (the old detector) flags it
  })
})
