/**
 * Google-bar web parity — identity, stored-side kind semantics, and per-result
 * DISPOSITIONS (prod-readiness issue 4, 2026-09-12).
 *
 * Production facts driving these tests (system_kv dumps 2026-09-12): both
 * golden profiles read parity 0 (overlap 0 / web_only 14) with every query
 * served from the SERP cache at unknown age, the gap queue held 200 terminal
 * rows (48 adopted / 152 gated_out) with no gate record, and every LLM
 * provider had been dead for two weeks — so a "gated_out" seed was an
 * extraction failure wearing a gate verdict's costume.
 *
 * Proves:
 *   webparity-1  ONE URL normalizer on both sides: scheme/www/default port/
 *                fragment/trailing slash/tracking params/locale+session params
 *                collapse; identity-bearing params do NOT (a `?id=` collision
 *                would manufacture overlap)
 *   webparity-2  a POINTER row (directory/referral/school_portal/past_award_intel)
 *                is not GrantFlow "found funding": it can never raise parity
 *   webparity-9  identity is checked BEFORE the funding-signal text heuristic
 *                (a covered page with a sparse snippet is still overlap), while
 *                an out-of-state portal is excluded on BOTH sides
 *   webparity-8  need attribution is token-bounded ('ssi' never inside 'assistance')
 *   webparity-7  a pending candidate the benchmark did not re-find is RETAINED,
 *                not deleted (it was never offered to the gates)
 *   webparity-3/4 every web-only result carries exactly one disposition, the
 *                gap queue carries it too, and 'gated_out' is written ONLY on a
 *                recorded gate verdict — an extraction failure is
 *                'not_evaluated:<class>' and stays eligible for re-seeding
 *   webparity-6  ranks/queries the lane cannot structurally reach are recorded
 *   envelope     the persisted run carries buildMetricEnvelope() with search
 *                cache provenance flagged when every query is cache at unknown age
 */

import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import {
  BENCHMARK_SEMANTICS_VERSION,
  GAP_QUEUE_KV_KEY,
  GOLDEN_KV_KEY,
  GAP_SEED_MAX_OFFERS,
  NOT_EVALUATED_RESEED_COOLDOWN_MS,
  WEB_ONLY_DISPOSITIONS,
  normalizeUrlKey,
  classifyWebResults,
  parityScore,
  appendGapCandidates,
  markGapCandidateOutcomes,
  loadGapSeedPagesForProfile,
  readWebParityGapQueue,
  readWebParityBenchmark,
  runWebParityBenchmark,
  disposeWebOnlyHit,
} from '../services/webParityBenchmark.js'

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT, sponsor TEXT,
      application_url TEXT, apply_url TEXT, source_url TEXT,
      final_url TEXT, evidence_url TEXT, opportunity_kind TEXT,
      canonical_opportunity_key TEXT,
      is_active INTEGER DEFAULT 1, is_hidden INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active'
    );
    CREATE TABLE profile_opportunity_matches (
      profile_id TEXT, opportunity_id TEXT, match_score REAL, match_decision TEXT
    );
  `)
  return db
}

function seedGolden(db, entries = [{ profile_id: 'gilbert', label: 'Gilbert', require_sources: ['grants_gov'] }]) {
  db.prepare('INSERT OR REPLACE INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)')
    .run(GOLDEN_KV_KEY, JSON.stringify(entries), new Date().toISOString())
}

function seedQueue(db, candidates) {
  db.prepare('INSERT OR REPLACE INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)')
    .run(GAP_QUEUE_KV_KEY, JSON.stringify({ updated_at: 'x', candidates }), 'x')
}

const CTX = { needs: ['medical bills', 'disability'], state: 'TN', applicantTypes: ['individual'] }

// ── webparity-1: ONE normalizer ─────────────────────────────────────────────

describe('webparity-1 normalizeUrlKey is the shared identity on both sides', () => {
  const bare = normalizeUrlKey('https://tn.gov/humanservices/apply.html')

  it.each([
    ['utm_* tracking', 'https://tn.gov/humanservices/apply.html?utm_source=google&utm_medium=cpc'],
    ['gclid', 'https://tn.gov/humanservices/apply.html?gclid=abc123'],
    ['fbclid', 'https://tn.gov/humanservices/apply.html?fbclid=IwAR0x'],
    ['mc_* (Mailchimp)', 'https://tn.gov/humanservices/apply.html?mc_cid=1&mc_eid=2'],
    ['ref', 'https://tn.gov/humanservices/apply.html?ref=newsletter'],
    ['lang / locale', 'https://tn.gov/humanservices/apply.html?lang=en'],
    ['session id', 'https://tn.gov/humanservices/apply.html?PHPSESSID=deadbeef'],
    ['default port', 'https://tn.gov:443/humanservices/apply.html'],
    ['http scheme + www', 'http://www.tn.gov/humanservices/apply.html'],
    ['uppercase host', 'https://TN.GOV/humanservices/apply.html'],
    ['fragment', 'https://tn.gov/humanservices/apply.html#eligibility'],
    ['trailing slash', 'https://tn.gov/humanservices/apply.html/'],
  ])('collapses the %s variant onto the bare key', (_label, variant) => {
    expect(normalizeUrlKey(variant)).toBe(bare)
    expect(bare).toBe('tn.gov/humanservices/apply.html')
  })

  it('keeps identity-bearing query params (a ?id collision would manufacture overlap) but ignores their order', () => {
    const a = normalizeUrlKey('https://portal.example/apply.php?id=A&utm_source=x')
    const b = normalizeUrlKey('https://portal.example/apply.php?id=B')
    expect(a).not.toBe(b)
    expect(a).toBe('portal.example/apply.php?id=a')
    expect(normalizeUrlKey('https://portal.example/apply.php?page=2&id=A'))
      .toBe(normalizeUrlKey('https://portal.example/apply.php?id=A&page=2'))
  })

  it('keeps the ssa.gov program/apply alias fold and rejects non-http input', () => {
    expect(normalizeUrlKey('https://www.ssa.gov/applyfordisability/?utm_source=g')).toBe('ssa.gov/disability')
    expect(normalizeUrlKey('javascript:alert(1)')).toBe('')
    expect(normalizeUrlKey('')).toBe('')
  })

  it('classifyWebResults: a SERP url carrying tracking params overlaps the stored bare url', () => {
    const res = classifyWebResults(
      [{ url: 'https://tnfoundation.org/grants/medical-bills?utm_source=google', title: 'Medical Bills Assistance Grant', snippet: 'grants for medical bills' }],
      [{ title: 'Other', application_url: 'https://tnfoundation.org/grants/medical-bills/' }],
      CTX,
    )
    expect(res.overlap).toHaveLength(1)
    expect(res.web_only).toHaveLength(0)
  })

  it('bumped the semantics version because identity + eligibility semantics changed', () => {
    expect(BENCHMARK_SEMANTICS_VERSION).toBeGreaterThanOrEqual(4)
  })
})

// ── webparity-2: pointer rows never raise parity ─────────────────────────────

describe('webparity-2 a stored POINTER row is not GrantFlow "found funding"', () => {
  const hit = {
    url: 'https://bradleycountytn.gov/departments/health-department/',
    title: 'Health Department - Bradley County, TN',
    snippet: 'Assistance programs and financial assistance for residents',
  }
  const realHit = { url: 'https://neighborfund.org/apply', title: 'Neighbor Emergency Assistance Grant', snippet: 'grants for medical bills' }
  const directoryRow = {
    id: 'dir-1', title: 'Health Department', sponsor: 'Bradley County',
    source_url: 'https://bradleycountytn.gov/departments/health-department/', opportunity_kind: 'DIRECTORY',
  }

  it('a hit matching only a DIRECTORY row is never overlap', () => {
    const res = classifyWebResults([hit], [directoryRow], CTX)
    expect(res.overlap).toHaveLength(0)
  })

  it('admitting a directory row CANNOT change parity (identical classification with and without it)', () => {
    const without = classifyWebResults([hit, realHit], [], CTX)
    const withDir = classifyWebResults([hit, realHit], [directoryRow], CTX)
    expect(parityScore(withDir.overlap.length, withDir.web_only.length))
      .toBe(parityScore(without.overlap.length, without.web_only.length))
    expect(withDir.web_only.map((w) => w.url).sort()).toEqual(without.web_only.map((w) => w.url).sort())
    // The pointer match is RECORDED as evidence (the catalog already judged the
    // page a pointer), never as coverage.
    const pointerHit = withDir.web_only.find((w) => w.url === hit.url)
    if (pointerHit) expect(pointerHit.catalog_pointer).toMatchObject({ kind: 'directory' })
    expect(withDir.stored_pointer_rows).toBe(1)
    expect(without.stored_pointer_rows).toBe(0)
  })

  it('pointer rows are excluded from grantflow_only too (they are not found funding)', () => {
    const res = classifyWebResults([], [directoryRow, { id: 'p', title: 'Real Program', application_url: 'https://real.org/apply' }], CTX)
    expect(res.grantflow_only).toBe(1)
    expect(res.stored_pointer_rows).toBe(1)
  })

  it.each(['directory', 'referral', 'school_portal', 'past_award_intel', 'DIRECTORY'])('treats kind %s as a pointer', (kind) => {
    const res = classifyWebResults([hit], [{ ...directoryRow, opportunity_kind: kind }], CTX)
    expect(res.overlap).toHaveLength(0)
    expect(res.stored_pointer_rows).toBe(1)
  })

  it('a web-side directory/index page cannot raise parity either (it is dropped, not counted)', () => {
    const indexHit = { url: 'https://foundation.example/our-grantees', title: 'Our Grantees', snippet: 'past grantees and awards made' }
    const base = classifyWebResults([realHit], [], CTX)
    const withIndex = classifyWebResults([realHit, indexHit], [], CTX)
    expect(parityScore(withIndex.overlap.length, withIndex.web_only.length))
      .toBe(parityScore(base.overlap.length, base.web_only.length))
    expect(withIndex.web_real).toBe(base.web_real)
  })
})

// ── webparity-9: identity before the funding-signal heuristic ────────────────

describe('webparity-9 identity is checked before the funding-signal text heuristic', () => {
  it('a covered page with a sparse snippet is overlap (the SERP text is not an eligibility judgment)', () => {
    const res = classifyWebResults(
      [{ url: 'https://www.ssa.gov/applyfordisability/', title: 'Apply Online | SSA', snippet: 'People with disabilities can apply online.' }],
      [{ title: 'Apply Online', sponsor: 'SSA', source_url: 'https://www.ssa.gov/applyfordisability/' }],
      CTX,
    )
    expect(res.overlap).toHaveLength(1)
    expect(res.web_real).toBe(1)
  })

  it('still excludes search-engine / aggregator / placeholder urls even when a stored row carries them', () => {
    const res = classifyWebResults(
      [{ url: 'https://www.causeiq.com/organizations/the-caring-place,900051191/', title: 'The Caring Place | Cause IQ', snippet: 'grants' }],
      [{ title: 'The Caring Place', source_url: 'https://www.causeiq.com/organizations/the-caring-place,900051191/' }],
      CTX,
    )
    expect(res.overlap).toHaveLength(0)
    expect(res.web_only).toHaveLength(0)
  })

  it("never admits another state's portal on EITHER side (an ineligible page cannot raise parity)", () => {
    const res = classifyWebResults(
      [{ url: 'https://www.dhcs.ca.gov/services/medi-cal', title: 'Medi-Cal', snippet: 'benefits for California residents' }],
      [{ title: 'Medi-Cal', source_url: 'https://www.dhcs.ca.gov/services/medi-cal' }],
      CTX,
    )
    expect(res.overlap).toHaveLength(0)
    expect(res.web_only).toHaveLength(0)
    expect(res.web_real).toBe(0)
  })
})

// ── webparity-8: need attribution ────────────────────────────────────────────

describe('webparity-8 need attribution is token-bounded', () => {
  it("attributes 'utility assistance', never 'ssi' inside 'assistance'", () => {
    const res = classifyWebResults(
      [{ url: 'https://x.org/apply', title: 'Utility Assistance Program for individuals', snippet: 'apply for utility assistance' }],
      [],
      { needs: ['ssi', 'utility assistance'], applicantTypes: ['individual'] },
    )
    expect(res.web_only).toHaveLength(1)
    expect(res.web_only[0].need).toBe('utility assistance')
  })

  it('a coincidental fragment never wins over the need the page actually states', () => {
    // 'ssi' is declared FIRST; the old substring rule returned it from
    // "assistance" before ever looking at the real 'emergency' statement.
    const res = classifyWebResults(
      [{ url: 'https://x.org/apply', title: 'Emergency Assistance Grant', snippet: 'apply for emergency financial assistance' }],
      [],
      { needs: ['ssi', 'emergency'], applicantTypes: ['individual'] },
    )
    expect(res.web_only).toHaveLength(1)
    expect(res.web_only[0].need).toBe('emergency')
  })
})

// ── webparity-7: never-offered candidates are retained ───────────────────────

describe('webparity-7 appendGapCandidates retains pending candidates the run did not re-find', () => {
  it('keeps a never-offered candidate (with a not-refound record) instead of deleting it', async () => {
    const db = makeDb()
    await appendGapCandidates(db, [{ url: 'https://a.org/grant', title: 'A', profile_id: 'p' }], { now: new Date('2026-09-10T00:00:00Z') })
    const res = await appendGapCandidates(db, [{ url: 'https://b.org/grant', title: 'B', profile_id: 'p' }], { now: new Date('2026-09-11T00:00:00Z'), profileIds: ['p'] })
    const queue = await readWebParityGapQueue(db)
    const a = queue.find((c) => c.url === 'https://a.org/grant')
    expect(a).toBeDefined()
    expect(a.status).toBe('candidate')
    expect(a.not_refound_runs).toBe(1)
    expect(a.not_refound_at).toBe('2026-09-11T00:00:00.000Z')
    expect(res).toMatchObject({ appended: 1, retained_not_refound: 1, total: 2 })
    expect(res).not.toHaveProperty('pruned')
    // It is still eligible for seeding — it was never handed to the gates.
    expect((await loadGapSeedPagesForProfile(db, 'p')).map((s) => s.url)).toContain('https://a.org/grant')
  })

  it('a re-found candidate keeps its first_found_at and offer bookkeeping across refreshes', async () => {
    const db = makeDb()
    seedQueue(db, [{ url: 'https://a.org/grant', title: 'Old', profile_id: 'p', status: 'candidate', found_at: '2026-09-01T00:00:00.000Z', offered_at: '2026-09-02T00:00:00.000Z', offer_count: 1 }])
    await appendGapCandidates(db, [{ url: 'https://a.org/grant', title: 'New', profile_id: 'p' }], { now: new Date('2026-09-11T00:00:00Z') })
    const [a] = await readWebParityGapQueue(db)
    expect(a).toMatchObject({ title: 'New', first_found_at: '2026-09-01T00:00:00.000Z', offered_at: '2026-09-02T00:00:00.000Z', offer_count: 1, last_refound_at: '2026-09-11T00:00:00.000Z' })
  })
})

// ── webparity-3/4: gated_out only on a recorded gate verdict ─────────────────

describe('webparity-3/4 markGapCandidateOutcomes writes gated_out ONLY on a recorded gate verdict', () => {
  it('without any per-seed ledger an unadopted seed is not_evaluated:lane_ledger_unavailable, not gated_out', async () => {
    const db = makeDb()
    seedQueue(db, [{ url: 'https://refused.org/x', profile_id: 'g', status: 'candidate' }])
    const res = await markGapCandidateOutcomes(db, { offeredUrls: ['https://refused.org/x'], adoptedUrls: [], profileId: 'g', now: new Date('2026-09-12T00:00:00Z') })
    expect(res).toMatchObject({ adopted: 0, gated_out: 0, not_evaluated: 1 })
    const [c] = await readWebParityGapQueue(db)
    expect(c.status).toBe('not_evaluated:lane_ledger_unavailable')
    expect(c.offered_at).toBe('2026-09-12T00:00:00.000Z')
    expect(c.offer_count).toBe(1)
  })

  it('a run whose lane fetched pages but extracted nothing marks unadopted seeds not_evaluated:extraction_failed', async () => {
    const db = makeDb()
    seedQueue(db, [{ url: 'https://refused.org/x', profile_id: 'g', status: 'candidate' }])
    await markGapCandidateOutcomes(db, {
      offeredUrls: ['https://refused.org/x'], adoptedUrls: [], profileId: 'g',
      laneRun: { fetched: 40, extracted: 0, stored: 0 },
    })
    const [c] = await readWebParityGapQueue(db)
    expect(c.status).toBe('not_evaluated:extraction_failed')
  })

  it('a recorded reality-gate rejection IS gated_out and names the gate', async () => {
    const db = makeDb()
    seedQueue(db, [
      { url: 'https://refused.org/x', profile_id: 'g', status: 'candidate' },
      { url: 'https://dead.org/x', profile_id: 'g', status: 'candidate' },
      { url: 'https://thin.org/x', profile_id: 'g', status: 'candidate' },
      { url: 'https://good.org/x', profile_id: 'g', status: 'candidate' },
    ])
    const res = await markGapCandidateOutcomes(db, {
      offeredUrls: ['https://refused.org/x', 'https://dead.org/x', 'https://thin.org/x', 'https://good.org/x'],
      adoptedUrls: ['https://good.org/x'],
      profileId: 'g',
      seedOutcomes: [
        { url: 'https://refused.org/x', outcome: 'gate_rejected', gate: 'reality', reason: 'no_apply_target' },
        { url: 'https://dead.org/x', outcome: 'fetch_failed', reason: 'http_404' },
        { url: 'https://thin.org/x', outcome: 'extraction_failed', reason: 'extractor_returned_nothing' },
      ],
    })
    expect(res).toMatchObject({ adopted: 1, gated_out: 1, not_evaluated: 2 })
    const q = await readWebParityGapQueue(db)
    const byUrl = Object.fromEntries(q.map((c) => [c.url, c]))
    expect(byUrl['https://refused.org/x']).toMatchObject({ status: 'gated_out', gate: 'reality', gate_reason: 'no_apply_target' })
    expect(byUrl['https://dead.org/x'].status).toBe('not_evaluated:fetch_failed')
    expect(byUrl['https://thin.org/x'].status).toBe('not_evaluated:extraction_failed')
    expect(byUrl['https://good.org/x'].status).toBe('adopted')
  })

  it('a not_evaluated candidate is re-seeded only after the cooldown, and exhausts after GAP_SEED_MAX_OFFERS', async () => {
    const db = makeDb()
    const offeredAt = new Date('2026-09-12T00:00:00Z')
    seedQueue(db, [
      { url: 'https://fresh.org/x', profile_id: 'g', status: 'candidate' },
      { url: 'https://cooling.org/x', profile_id: 'g', status: 'not_evaluated:extraction_failed', offered_at: offeredAt.toISOString(), offer_count: 1 },
    ])
    // Inside the cooldown: only the fresh candidate is offered.
    const soon = new Date(offeredAt.getTime() + 60_000)
    expect((await loadGapSeedPagesForProfile(db, 'g', { now: soon })).map((s) => s.url)).toEqual(['https://fresh.org/x'])
    // After the cooldown: the not-evaluated page gets another look, after fresh ones.
    const later = new Date(offeredAt.getTime() + NOT_EVALUATED_RESEED_COOLDOWN_MS + 1)
    expect((await loadGapSeedPagesForProfile(db, 'g', { now: later })).map((s) => s.url)).toEqual(['https://fresh.org/x', 'https://cooling.org/x'])
    // Offers are bounded: the last permitted offer without a verdict is terminal.
    seedQueue(db, [{ url: 'https://cooling.org/x', profile_id: 'g', status: 'not_evaluated:extraction_failed', offered_at: offeredAt.toISOString(), offer_count: GAP_SEED_MAX_OFFERS - 1 }])
    await markGapCandidateOutcomes(db, { offeredUrls: ['https://cooling.org/x'], adoptedUrls: [], profileId: 'g', now: later })
    const [c] = await readWebParityGapQueue(db)
    expect(c.status).toBe('not_evaluated:exhausted')
    expect(c.offer_count).toBe(GAP_SEED_MAX_OFFERS)
    expect(await loadGapSeedPagesForProfile(db, 'g', { now: new Date(later.getTime() + NOT_EVALUATED_RESEED_COOLDOWN_MS * 2) })).toEqual([])
  })
})

// ── the seeding caller hands the lane's evidence to the outcome writer ───────

describe('crawlerOsService wires the lane run totals into markGapCandidateOutcomes', () => {
  it('passes laneRun (and any per-seed ledger) so an extraction failure can be classified, not defaulted to lane_ledger_unavailable', () => {
    // Static tripwire (the runProfileDiscovery harness is too heavy for a unit
    // test): without `laneRun`, every unadopted seed in production lands as
    // `not_evaluated:lane_ledger_unavailable` and the dead-LLM signature
    // (fetched > 0, extracted 0) can never be written as extraction_failed.
    const src = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../services/crawlerOsService.js'), 'utf8')
    const call = src.slice(src.indexOf('parity.markGapCandidateOutcomes('))
    const args = call.slice(0, call.indexOf('});') + 3)
    expect(args).toMatch(/laneRun:\s*webTelemetry/)
    expect(args).toMatch(/seedOutcomes:/)
  })
})

// ── dispositions on every web-only result ────────────────────────────────────

const THESIS = { applicant_types: ['individual'], needs: ['medical bills', 'home repair'], location: { state: 'TN', city: 'Cleveland' } }

function serp(results, meta = { provider: 'searxng', provenance: 'live', status: 'ok', cache_age_ms: null }) {
  Object.defineProperty(results, 'searchMeta', { value: meta, enumerable: false })
  return results
}

describe('web-only dispositions (webparity-3/4/6) and the metric envelope', () => {
  it('exports the closed disposition vocabulary', () => {
    expect(WEB_ONLY_DISPOSITIONS).toEqual(expect.arrayContaining([
      'never_generated_capable_query', 'generated_not_executed_cap', 'provider_failure', 'extraction_failed',
      'fetch_failed', 'canonical_duplicate', 'correctly_rejected_at_gate:reality', 'correctly_rejected_at_gate:eligibility',
      'correctly_rejected_at_gate:need', 'correctly_rejected_at_gate:apply_target', 'incorrectly_lost_qualified_source',
      'lane_ledger_unavailable',
    ]))
  })

  it('disposeWebOnlyHit: pure precedence over plan / lane ledger / queue / catalog evidence', () => {
    const laneDefaults = { resultsPerQuery: 8, maxPages: 44, maxQueries: 28 }
    const base = { url: 'https://a.org/apply', canonical_key: 'a.org/apply', query: 'medical bills grants TN', query_index: 0, rank: 3 }
    const plan = { queries: ['medical bills grants TN', 'home repair grants TN'], source: 'test' }
    const ledger = {
      available: true,
      run: {
        queries: ['medical bills grants TN'],
        skipped_budget: ['home repair grants TN'],
        search_provenance: [{ query: 'medical bills grants TN', status: 'ok' }],
        results_per_query: 8,
        max_pages: 44,
        fetched: 10,
        extracted: 4,
        pages: [],
      },
    }
    // g) reachable, executed, healthy extraction, nothing recorded → the true recall gap.
    expect(disposeWebOnlyHit(base, { plan, laneLedger: ledger, laneDefaults }).disposition).toBe('incorrectly_lost_qualified_source')
    // a) a query outside the plan.
    expect(disposeWebOnlyHit({ ...base, query: 'something the plan never builds' }, { plan, laneLedger: ledger, laneDefaults }).disposition)
      .toBe('never_generated_capable_query')
    // b) in the plan, skipped for budget.
    const skipped = disposeWebOnlyHit({ ...base, query: 'home repair grants TN', query_index: 1 }, { plan, laneLedger: ledger, laneDefaults })
    expect(skipped.disposition).toBe('generated_not_executed_cap')
    expect(skipped.evidence.skipped_budget).toBe(true)
    // b) webparity-6: rank beyond the lane's per-query head is structurally unreachable, ledger or not.
    const deep = disposeWebOnlyHit({ ...base, rank: 9 }, { plan, laneLedger: { available: false, reason: 'x' }, laneDefaults })
    expect(deep.disposition).toBe('generated_not_executed_cap')
    expect(deep.structural.rank_beyond_lane_head).toBe(true)
    // c) the lane's own search for that query failed.
    const failed = { ...ledger, run: { ...ledger.run, search_provenance: [{ query: 'medical bills grants TN', status: 'error' }] } }
    expect(disposeWebOnlyHit(base, { plan, laneLedger: failed, laneDefaults }).disposition).toBe('provider_failure')
    // d) per-page ledger: fetched, extraction failed.
    const thin = { ...ledger, run: { ...ledger.run, pages: [{ url: 'https://a.org/apply', fetched: true, extracted: 0 }] } }
    expect(disposeWebOnlyHit(base, { plan, laneLedger: thin, laneDefaults }).disposition).toBe('extraction_failed')
    const dead = { ...ledger, run: { ...ledger.run, pages: [{ url: 'https://a.org/apply', fetched: false, reason: 'http_404' }] } }
    expect(disposeWebOnlyHit(base, { plan, laneLedger: dead, laneDefaults }).disposition).toBe('fetch_failed')
    // d) run-wide: the lane fetched pages and extracted nothing at all.
    const deadLlm = { ...ledger, run: { ...ledger.run, fetched: 40, extracted: 0 } }
    const inferred = disposeWebOnlyHit(base, { plan, laneLedger: deadLlm, laneDefaults })
    expect(inferred.disposition).toBe('extraction_failed')
    expect(inferred.evidence.inferred_from).toBe('lane_run_totals')
    // f) a recorded gate verdict — from the page ledger or the queue.
    const gated = { ...ledger, run: { ...ledger.run, pages: [{ url: 'https://a.org/apply', fetched: true, extracted: 1, gate: 'eligibility', reason: 'applicant_type_mismatch' }] } }
    expect(disposeWebOnlyHit(base, { plan, laneLedger: gated, laneDefaults }).disposition).toBe('correctly_rejected_at_gate:eligibility')
    expect(disposeWebOnlyHit(base, { plan, laneLedger: ledger, laneDefaults, queueEntry: { status: 'gated_out', gate: 'need' } }).disposition)
      .toBe('correctly_rejected_at_gate:need')
    // a legacy gated_out with NO gate record is not a verdict.
    const legacy = disposeWebOnlyHit(base, { plan, laneLedger: { available: false, reason: 'no_ledger' }, laneDefaults, queueEntry: { status: 'gated_out' } })
    expect(legacy.disposition).toBe('lane_ledger_unavailable')
    expect(legacy.evidence.legacy_gated_out_without_gate_record).toBe(true)
    // e) canonical duplicate: adopted under another url, or the catalog already carries the key.
    expect(disposeWebOnlyHit(base, { plan, laneLedger: ledger, laneDefaults, queueEntry: { status: 'adopted' } }).disposition).toBe('canonical_duplicate')
    expect(disposeWebOnlyHit(base, { plan, laneLedger: ledger, laneDefaults, catalogDuplicate: { opportunity_id: 'o9', url: 'https://a.org/other' } }).disposition)
      .toBe('canonical_duplicate')
    // f) the catalog holds the page as a POINTER: no apply target of its own.
    expect(disposeWebOnlyHit({ ...base, catalog_pointer: { kind: 'directory' } }, { plan, laneLedger: ledger, laneDefaults }).disposition)
      .toBe('correctly_rejected_at_gate:apply_target')
    // ledger absent and nothing else decides.
    expect(disposeWebOnlyHit(base, { plan, laneLedger: { available: false, reason: 'getLastWebLaneRun_not_exported' }, laneDefaults }).disposition)
      .toBe('lane_ledger_unavailable')
    // PRECEDENCE: a per-URL queue VERDICT outranks the run-wide dead-extraction
    // inference (an adopted page still web-only is an identity loss, whatever
    // tonight's lane did); a legacy gated_out without a gate does not.
    expect(disposeWebOnlyHit(base, { plan, laneLedger: deadLlm, laneDefaults, queueEntry: { status: 'adopted' } }).disposition).toBe('canonical_duplicate')
    expect(disposeWebOnlyHit(base, { plan, laneLedger: deadLlm, laneDefaults, queueEntry: { status: 'gated_out', gate: 'reality' } }).disposition).toBe('correctly_rejected_at_gate:reality')
    const legacyDead = disposeWebOnlyHit(base, { plan, laneLedger: deadLlm, laneDefaults, queueEntry: { status: 'gated_out' } })
    expect(legacyDead.disposition).toBe('extraction_failed')
    expect(legacyDead.evidence.legacy_gated_out_without_gate_record).toBe(true)
  })

  it('runWebParityBenchmark persists a disposition on EVERY web-only result, on the gap queue, and carries the envelope', async () => {
    const db = makeDb()
    try {
      seedGolden(db)
      db.prepare("INSERT INTO funding_opportunities (id, title, sponsor, application_url) VALUES ('o1', 'Medical Bills Assistance Grant', 'TN Foundation', 'https://tnfoundation.org/grants/medical-bills/')").run()
      db.prepare("INSERT INTO profile_opportunity_matches (profile_id, opportunity_id, match_score) VALUES ('gilbert', 'o1', 60)").run()
      const cacheMeta = { provider: 'cache', provenance: 'cache', status: 'ok', cache_age_ms: null, reason: 'cache_age_not_exposed_by_cache_contract' }
      const searchWeb = vi.fn(async (q, { count }) => {
        if (/medical bills/i.test(q)) {
          return serp(Array.from({ length: count }, (_, i) => i === 0
            ? { url: 'https://www.tnfoundation.org/grants/medical-bills?utm_source=g', title: 'Medical Bills Assistance Grant', snippet: 'grants for medical bills' }
            : { url: `https://fund${i}.org/apply`, title: `Medical Bills Grant ${i}`, snippet: 'grants for medical bills for individuals in Tennessee' }), cacheMeta)
        }
        return serp([], cacheMeta)
      })
      const res = await runWebParityBenchmark(db, {
        searchWeb,
        buildThesis: async () => THESIS,
        emitTelemetry: async () => {},
        loadLaneLedger: async () => ({ available: false, reason: 'getLastWebLaneRun_not_exported' }),
        now: new Date('2026-09-12T08:31:00Z'),
      })
      const p = res.per_profile[0]
      expect(p.overlap_count).toBe(1)
      expect(p.web_only_count).toBe(9)
      expect(Array.isArray(p.web_only)).toBe(true)
      expect(p.web_only).toHaveLength(9)
      for (const w of p.web_only) {
        expect(WEB_ONLY_DISPOSITIONS).toContain(w.disposition)
        expect(w).toMatchObject({ canonical_key: expect.any(String), query_index: 0, rank: expect.any(Number) })
        expect(w.evidence).toBeTruthy()
      }
      // Ranks 9 and 10 are structurally unreachable by the lane (8 results/query).
      const deep = p.web_only.filter((w) => w.rank > 8)
      expect(deep.length).toBe(2)
      for (const w of deep) expect(w.disposition).toBe('generated_not_executed_cap')
      const shallow = p.web_only.filter((w) => w.rank <= 8)
      for (const w of shallow) expect(w.disposition).toBe('lane_ledger_unavailable')
      expect(p.disposition_counts).toMatchObject({ generated_not_executed_cap: 2, lane_ledger_unavailable: 7 })
      expect(p.structurally_unreachable).toMatchObject({ rank_beyond_lane_head: 2 })

      const store = await readWebParityBenchmark(db)
      expect(store.latest.per_profile[0].web_only).toHaveLength(9)
      expect(store.latest.semantics_version).toBe(BENCHMARK_SEMANTICS_VERSION)
      // web_only_top is retained for existing consumers (Sam / Anya).
      expect(store.latest.per_profile[0].web_only_top.length).toBeGreaterThan(0)

      // Envelope: window=run, population = golden profiles, all-cache-unknown-age flagged.
      expect(store.latest.envelope).toMatchObject({
        metric_envelope_version: 1,
        measurement_window: { kind: 'run' },
        evaluated_population: { kind: 'golden_profiles' },
        evaluated_count: 1,
        unevaluated_count: 0,
        freshness_at: '2026-09-12T08:31:00.000Z',
      })
      expect(store.latest.envelope.provider_health.search).toBe('degraded')
      expect(store.latest.envelope.provider_health.flags).toContain('search_all_cache_unknown_age')
      expect(store.latest.envelope.provider_health.lane_ledger).toBe('unavailable')
      expect(store.latest.envelope.code_version).toHaveProperty('commit_sha')
      expect(store.runs[0].envelope.provider_health.flags).toContain('search_all_cache_unknown_age')

      // Gap queue candidates carry the disposition.
      const queue = await readWebParityGapQueue(db)
      expect(queue).toHaveLength(9)
      for (const c of queue) {
        expect(WEB_ONLY_DISPOSITIONS).toContain(c.disposition)
        expect(c.disposition_at).toBe('2026-09-12T08:31:00.000Z')
        expect(c.canonical_key).toEqual(expect.any(String))
      }
    } finally {
      db.close()
    }
  })

  it('a healthy live search is not flagged, and an injected lane ledger yields the true recall gap', async () => {
    const db = makeDb()
    try {
      seedGolden(db)
      const searchWeb = vi.fn(async (q) => /medical bills/i.test(q)
        ? serp([{ url: 'https://fund.org/apply', title: 'Medical Bills Grant', snippet: 'grants for medical bills for individuals in Tennessee' }])
        : serp([]))
      const executedQueries = []
      const res = await runWebParityBenchmark(db, {
        searchWeb,
        buildThesis: async () => THESIS,
        emitTelemetry: async () => {},
        loadStoredMatches: async () => [],
        buildQueryPlan: (thesis) => {
          expect(thesis).toBe(THESIS)
          return { queries: [...searchWeb.mock.calls.map(([q]) => q)], source: 'test_plan' }
        },
        loadLaneLedger: async () => {
          for (const [q] of searchWeb.mock.calls) executedQueries.push(q)
          return { available: true, run: { queries: executedQueries, results_per_query: 8, fetched: 12, extracted: 5, pages: [] } }
        },
        now: new Date('2026-09-12T08:31:00Z'),
      })
      const p = res.per_profile[0]
      expect(p.web_only[0].disposition).toBe('incorrectly_lost_qualified_source')
      expect(p.web_only[0].evidence.plan_source).toBe('test_plan')
      const store = await readWebParityBenchmark(db)
      expect(store.latest.envelope.provider_health.search).toBe('healthy')
      expect(store.latest.envelope.provider_health.flags).not.toContain('search_all_cache_unknown_age')
      expect(store.latest.envelope.provider_health.lane_ledger).toBe('available')
    } finally {
      db.close()
    }
  })
})
