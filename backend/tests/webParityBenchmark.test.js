/**
 * The "Google bar" benchmark (owner directive: for each golden profile,
 * GrantFlow's results must beat what a web-search session produces; failures
 * become Amy's work queue; the system must only get better).
 *
 * Proves:
 *   - overlap / web_only / grantflow_only classification against stored top
 *     matches (url identity → title identity → domain fallback), with
 *     search-engine / social / aggregator / non-funding noise excluded
 *   - parity math (points 0–100), incl. zero-web-results ⇒ parity 100 not NaN
 *   - bounded budget: ≤ MAX_QUERIES_PER_PROFILE searches, ≤ MAX_RESULTS_PER_QUERY
 *   - persistence: system_kv `web_parity_benchmark` history ring (last 30) +
 *     `latest`; telemetry event emitted
 *   - failures feed forward: web_only finds append to the
 *     `web_parity_gap_queue` candidate queue (deduped; honest shape; nothing
 *     auto-inserted to the catalog)
 *   - Sam's `coverage.webParityBenchmark` check: fail-open, never-run,
 *     stale, regression ratchet, green
 *   - Anya's "Google-bar benchmark" morning-report section (parity per golden
 *     profile, trend arrow, top web-only finds)
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  KV_KEY,
  GAP_QUEUE_KV_KEY,
  GOLDEN_KV_KEY,
  MAX_QUERIES_PER_PROFILE,
  MAX_RESULTS_PER_QUERY,
  MAX_RUN_HISTORY,
  isWebParityBenchmarkEnabled,
  normalizeUrlKey,
  isRealFundingHit,
  isOutOfStateGovHit,
  parityScore,
  classifyWebResults,
  readWebParityBenchmark,
  readWebParityGapQueue,
  appendGapCandidates,
  runWebParityBenchmark,
  loadGapSeedPagesForProfile,
  markGapCandidateOutcomes,
  GAP_SEED_LIMIT_PER_RUN,
} from '../services/webParityBenchmark.js'
import { getCheckById } from '../services/sam/samRegistry.js'
import { buildOwnerReport, summarizeWebParity } from '../services/anya/anyaDailyOwnerReport.js'

// ── Test fixtures ────────────────────────────────────────────────────────────

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT, sponsor TEXT,
      application_url TEXT, apply_url TEXT, source_url TEXT
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

function seedStoredMatches(db, profileId = 'gilbert') {
  db.prepare("INSERT INTO funding_opportunities (id, title, sponsor, application_url) VALUES ('o1', 'Medical Bills Assistance Grant', 'TN Foundation', 'https://tnfoundation.org/grants/medical-bills/')").run()
  db.prepare("INSERT INTO funding_opportunities (id, title, sponsor, application_url) VALUES ('o2', 'Utility Relief Program', 'Utility Help', 'https://utilityhelp.org/apply')").run()
  db.prepare('INSERT INTO profile_opportunity_matches (profile_id, opportunity_id, match_score) VALUES (?, ?, 60)').run(profileId, 'o1')
  db.prepare('INSERT INTO profile_opportunity_matches (profile_id, opportunity_id, match_score) VALUES (?, ?, 40)').run(profileId, 'o2')
}

const THESIS = {
  applicant_types: ['individual'],
  needs: ['medical bills', 'home repair'],
  location: { state: 'TN', city: 'Cleveland' },
}

// A canned web session: one overlap (same page as stored o1), one REAL
// web-only find, and four flavors of noise that must all be excluded.
const WEB_HITS = [
  { url: 'https://www.tnfoundation.org/grants/medical-bills', title: 'Medical Bills Assistance Grant', snippet: 'Apply for help with medical bills in Tennessee.' },
  { url: 'https://neighborfund.org/apply', title: 'Neighbor Emergency Assistance Grant', snippet: 'grants for medical bills in Tennessee' },
  { url: 'https://www.google.com/search?q=medical+bill+grants', title: 'medical bill grants - Google Search', snippet: 'search results' },
  { url: 'https://facebook.com/somecharity', title: 'Some Charity grants page', snippet: 'grants' },
  { url: 'https://www.grantwatch.com/grant/12345', title: 'Grants for individuals', snippet: 'grant listings directory' },
  { url: 'https://citynews.com/story', title: 'Local council meets Tuesday', snippet: 'weather and roads' },
]

function benchmarkDeps(overrides = {}) {
  let calls = 0
  return {
    searchWeb: vi.fn(async (q, { count } = {}) => {
      expect(count).toBeLessThanOrEqual(MAX_RESULTS_PER_QUERY)
      // Return the whole canned session on the first query, nothing after —
      // the run dedupes by url anyway.
      return calls++ === 0 ? WEB_HITS : []
    }),
    buildThesis: vi.fn(async () => THESIS),
    emitTelemetry: vi.fn(async () => {}),
    now: new Date('2026-07-07T04:00:00Z'),
    ...overrides,
  }
}

afterEach(() => {
  delete process.env.WEB_PARITY_BENCHMARK
})

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe('pure helpers', () => {
  it('normalizeUrlKey folds protocol/www/hash/trailing slash', () => {
    expect(normalizeUrlKey('https://www.Foo.org/grants/')).toBe('foo.org/grants')
    expect(normalizeUrlKey('http://foo.org/grants#apply')).toBe('foo.org/grants')
    expect(normalizeUrlKey('not-a-url')).toBe('')
  })

  it('isRealFundingHit excludes search-engine, social, aggregator, placeholder and non-funding pages', () => {
    expect(isRealFundingHit(WEB_HITS[1])).toBe(true) // neighborfund
    expect(isRealFundingHit(WEB_HITS[2])).toBe(false) // google SERP
    expect(isRealFundingHit(WEB_HITS[3])).toBe(false) // facebook
    expect(isRealFundingHit(WEB_HITS[4])).toBe(false) // grantwatch aggregator
    expect(isRealFundingHit(WEB_HITS[5])).toBe(false) // no funding signal
    expect(isRealFundingHit({ url: 'https://example.com/grants', title: 'Grants', snippet: '' })).toBe(false) // placeholder
  })

  it('parityScore: 0 web results ⇒ 100, never NaN; standard ratio otherwise', () => {
    expect(parityScore(0, 0)).toBe(100)
    expect(parityScore(1, 1)).toBe(50)
    expect(parityScore(2, 1)).toBe(66.7)
    expect(Number.isNaN(parityScore(0, 0))).toBe(false)
  })

  it('classifyWebResults: overlap by url identity, web_only for real finds, grantflow_only counts unclaimed stored rows', () => {
    const stored = [
      { id: 'o1', title: 'Medical Bills Assistance Grant', sponsor: 'TN Foundation', application_url: 'https://tnfoundation.org/grants/medical-bills/' },
      { id: 'o2', title: 'Utility Relief Program', sponsor: 'Utility Help', application_url: 'https://utilityhelp.org/apply' },
    ]
    const { overlap, web_only, grantflow_only } = classifyWebResults(WEB_HITS, stored, { needs: THESIS.needs })
    expect(overlap).toHaveLength(1)
    expect(overlap[0].url).toMatch(/tnfoundation\.org/)
    expect(web_only).toHaveLength(1)
    expect(web_only[0].url).toBe('https://neighborfund.org/apply')
    expect(web_only[0].need).toBe('medical bills') // honest need attribution
    expect(grantflow_only).toBe(1) // o2 was never surfaced by the web session
  })

  it('isRealFundingHit excludes consumer-health info sites and SEO lead-gen (2026-07-12 noise class)', () => {
    expect(isRealFundingHit({ url: 'https://www.webmd.com/', title: 'WebMD - Better information. Better health.', snippet: 'health benefits information' })).toBe(false)
    expect(isRealFundingHit({ url: 'https://sslg.com/social-security-disability-benefits-pay-chart/', title: 'SSDI Pay Chart 2026: Monthly Disability Benefit Amounts', snippet: '' })).toBe(false)
  })

  it('isOutOfStateGovHit: filters other states\' portals, keeps own state, federal, and unknown domains', () => {
    // California portals against a TN profile — the 2026-07-12 parity crater.
    expect(isOutOfStateGovHit('https://www.dhcs.ca.gov/medi-cal/', 'TN')).toBe(true)
    expect(isOutOfStateGovHit('https://benefitscal.com/Help/program/medical/HCPDE?lang=en', 'TN')).toBe(true)
    expect(isOutOfStateGovHit('https://compass.state.pa.us/', 'TN')).toBe(true)
    // The profile's OWN state is never filtered.
    expect(isOutOfStateGovHit('https://www.tn.gov/humanservices.html', 'TN')).toBe(false)
    // Federal domains are never filtered — va.gov is Veterans Affairs, not Virginia.
    expect(isOutOfStateGovHit('https://www.va.gov/disability/', 'TN')).toBe(false)
    expect(isOutOfStateGovHit('https://www.grants.gov/', 'TN')).toBe(false)
    // Unknown/unattributable domains and unknown profile state: never filtered.
    expect(isOutOfStateGovHit('https://neighborfund.org/apply', 'TN')).toBe(false)
    expect(isOutOfStateGovHit('https://www.dhcs.ca.gov/medi-cal/', null)).toBe(false)
  })

  it('classifyWebResults drops out-of-state government hits when a state is provided', () => {
    const hits = [
      { url: 'https://www.dhcs.ca.gov/medi-cal/', title: 'Medi-Cal - DHCS', snippet: 'health coverage assistance' },
      { url: 'https://neighborfund.org/apply', title: 'Neighbor Grant', snippet: 'grant for medical bills' },
    ]
    const { web_only, web_real } = classifyWebResults(hits, [], { needs: [], state: 'TN' })
    expect(web_only).toHaveLength(1)
    expect(web_only[0].url).toBe('https://neighborfund.org/apply')
    expect(web_real).toBe(1)
  })

  it('classifyWebResults: title identity and domain fallback both count as overlap', () => {
    const stored = [{ id: 'o3', title: 'The Riverside Teacher Fund', sponsor: 'Riverside CF', application_url: 'https://riversidecf.org/programs' }]
    // Same title, re-punctuated + reordered host page → title-identity overlap.
    const byTitle = classifyWebResults(
      [{ url: 'https://othersite.org/teacher', title: 'Riverside Teacher Fund, The', snippet: 'grant program' }],
      stored,
    )
    expect(byTitle.overlap).toHaveLength(1)
    // Different page on the SAME funder domain → domain-fallback overlap.
    const byDomain = classifyWebResults(
      [{ url: 'https://riversidecf.org/other-grants', title: 'Community grants', snippet: 'funding for teachers' }],
      stored,
    )
    expect(byDomain.overlap).toHaveLength(1)
    expect(byDomain.grantflow_only).toBe(0)
  })
})

// ── The benchmark run ────────────────────────────────────────────────────────

describe('runWebParityBenchmark', () => {
  it('scores golden profiles against a mocked web session, persists history + latest, queues web-only candidates, emits telemetry', async () => {
    const db = makeDb()
    try {
      seedGolden(db)
      seedStoredMatches(db)
      const deps = benchmarkDeps()
      const res = await runWebParityBenchmark(db, deps)

      expect(res.ran).toBe(true)
      expect(res.per_profile).toHaveLength(1)
      const p = res.per_profile[0]
      expect(p.profile_id).toBe('gilbert')
      expect(p.overlap_count).toBe(1)
      expect(p.web_only_count).toBe(1)
      expect(p.grantflow_only).toBe(1)
      expect(p.parity).toBe(50)
      expect(res.fleet_parity).toBe(50)

      // Budget: never more than MAX_QUERIES_PER_PROFILE searches per profile.
      expect(deps.searchWeb.mock.calls.length).toBeLessThanOrEqual(MAX_QUERIES_PER_PROFILE)

      // Persistence: history ring + latest snapshot.
      const store = await readWebParityBenchmark(db)
      expect(store.latest.fleet_parity).toBe(50)
      expect(store.runs).toHaveLength(1)
      expect(store.latest.per_profile[0].web_only_top[0].url).toBe('https://neighborfund.org/apply')

      // Failure fed forward: candidate queue in the Amy-drivable shape,
      // honest provenance, NOT inserted into funding_opportunities.
      const queue = await readWebParityGapQueue(db)
      expect(queue).toHaveLength(1)
      expect(queue[0]).toMatchObject({
        url: 'https://neighborfund.org/apply',
        title: 'Neighbor Emergency Assistance Grant',
        profile_id: 'gilbert',
        need: 'medical bills',
        source: 'web_parity_benchmark',
        status: 'candidate',
      })
      const catalogCount = db.prepare('SELECT COUNT(*) AS n FROM funding_opportunities').get().n
      expect(catalogCount).toBe(2) // unchanged — candidates only

      // Telemetry emitted.
      expect(deps.emitTelemetry).toHaveBeenCalledTimes(1)
      const evt = deps.emitTelemetry.mock.calls[0][1]
      expect(evt.agent_name).toBe('sam')
      expect(evt.event_type).toBe('sam.web_parity_benchmark')
      expect(evt.metric_value).toBe(50)
    } finally {
      db.close()
    }
  })

  it('zero web results ⇒ parity 100 (not NaN) with an honest outage flag', async () => {
    const db = makeDb()
    try {
      seedGolden(db)
      seedStoredMatches(db)
      const res = await runWebParityBenchmark(db, benchmarkDeps({ searchWeb: vi.fn(async () => []) }))
      expect(res.per_profile[0].parity).toBe(100)
      expect(res.fleet_parity).toBe(100)
      expect(res.per_profile[0].web_outage_suspected).toBe(true)
      expect(Number.isNaN(res.fleet_parity)).toBe(false)
    } finally {
      db.close()
    }
  })

  it('keeps only the last 30 runs in the history ring', async () => {
    const db = makeDb()
    try {
      seedGolden(db)
      const oldRuns = Array.from({ length: MAX_RUN_HISTORY }, (_, i) => ({
        generated_at: new Date(2026, 5, i + 1).toISOString(),
        fleet_parity: 40 + i,
        per_profile: [],
      }))
      db.prepare('INSERT OR REPLACE INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)')
        .run(KV_KEY, JSON.stringify({ runs: oldRuns, latest: null }), new Date().toISOString())

      await runWebParityBenchmark(db, benchmarkDeps({ searchWeb: vi.fn(async () => []) }))
      const store = await readWebParityBenchmark(db)
      expect(store.runs).toHaveLength(MAX_RUN_HISTORY)
      expect(store.runs[0].fleet_parity).toBe(41) // oldest dropped
      expect(store.runs[MAX_RUN_HISTORY - 1].fleet_parity).toBe(100) // newest appended
    } finally {
      db.close()
    }
  })

  it('gap queue appends are deduped by (profile_id, url) across runs', async () => {
    const db = makeDb()
    try {
      seedGolden(db)
      seedStoredMatches(db)
      const first = await runWebParityBenchmark(db, benchmarkDeps())
      expect(first.gap_queue.appended).toBe(1)
      const second = await runWebParityBenchmark(db, benchmarkDeps())
      expect(second.gap_queue.appended).toBe(0)
      expect((await readWebParityGapQueue(db))).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  it('is honest when it cannot measure: disabled env gate, no golden profiles, undiscoverable profile', async () => {
    const db = makeDb()
    try {
      process.env.WEB_PARITY_BENCHMARK = 'false'
      expect(isWebParityBenchmarkEnabled()).toBe(false)
      expect((await runWebParityBenchmark(db, benchmarkDeps())).ran).toBe(false)
      delete process.env.WEB_PARITY_BENCHMARK

      // No golden profiles → no hollow green run persisted.
      const res = await runWebParityBenchmark(db, benchmarkDeps())
      expect(res).toMatchObject({ ran: false, reason: 'no_golden_profiles' })
      expect(await readWebParityBenchmark(db)).toBeNull()

      // Golden profile that resolves to no thesis → per-profile error, excluded from fleet parity.
      seedGolden(db)
      const res2 = await runWebParityBenchmark(db, benchmarkDeps({ buildThesis: vi.fn(async () => null) }))
      expect(res2.ran).toBe(true)
      expect(res2.per_profile[0].error).toBe('profile_not_discoverable')
      expect(res2.fleet_parity).toBeNull()
    } finally {
      db.close()
    }
  })

  it('appendGapCandidates is bounded and keeps the newest entries', async () => {
    const db = makeDb()
    try {
      const many = Array.from({ length: 250 }, (_, i) => ({
        url: `https://funder${i}.org/grant`,
        title: `Grant ${i}`,
        profile_id: 'gilbert',
        need: null,
      }))
      const res = await appendGapCandidates(db, many)
      expect(res.total).toBe(200) // GAP_QUEUE_CAP
      const queue = await readWebParityGapQueue(db)
      expect(queue[queue.length - 1].url).toBe('https://funder249.org/grant')
    } finally {
      db.close()
    }
  })
})

// ── Sam check: coverage.webParityBenchmark ───────────────────────────────────

describe('sam check coverage.webParityBenchmark', () => {
  const check = getCheckById('coverage.webParityBenchmark')

  function kvDb() {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)')
    return db
  }
  const put = (db, payload, updatedAt = new Date().toISOString()) =>
    db.prepare('INSERT OR REPLACE INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)')
      .run(KV_KEY, JSON.stringify(payload), updatedAt)
  const hoursAgo = (h) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString()
  const freshStore = (fleet, prevFleet, extra = {}) => ({
    generated_at: hoursAgo(1),
    runs: [
      { generated_at: hoursAgo(25), fleet_parity: prevFleet, per_profile: [] },
      { generated_at: hoursAgo(1), fleet_parity: fleet, per_profile: [] },
    ],
    latest: {
      generated_at: hoursAgo(1),
      fleet_parity: fleet,
      per_profile: [
        { profile_id: 'gilbert', label: 'Gilbert', parity: fleet, overlap_count: 3, web_only_count: 1, grantflow_only: 2, web_only_top: [{ url: 'https://neighborfund.org/apply', title: 'Neighbor Grant', domain: 'neighborfund.org', need: 'medical bills' }] },
      ],
      ...extra,
    },
  })

  it('is registered as a non-heavy internal check with medium severity', () => {
    expect(check).toBeTruthy()
    expect(check.kind).toBe('internal')
    expect(check.heavy).toBeFalsy()
    expect(check.severityOnFailure).toBe('medium')
  })

  it('fails open on environment gaps (no db, system_kv missing) and when disabled', async () => {
    expect((await check.run({})).ok).toBe(true)
    const noKv = new Database(':memory:')
    try {
      const res = await check.run({ db: noKv })
      expect(res.ok).toBe(true)
      expect(res.skipped).toBe(true)
    } finally { noKv.close() }
    process.env.WEB_PARITY_BENCHMARK = 'false'
    try {
      const db = kvDb()
      try {
        const res = await check.run({ db })
        expect(res.ok).toBe(true)
        expect(res.skipped).toBe(true)
      } finally { db.close() }
    } finally { delete process.env.WEB_PARITY_BENCHMARK }
  })

  it('goes RED when the benchmark has never run', async () => {
    const db = kvDb()
    try {
      const res = await check.run({ db })
      expect(res.ok).toBe(false)
      expect(res.summary).toMatch(/never run/i)
      expect(res.recommended_fix).toMatch(/golden_outcome_expectations/)
    } finally { db.close() }
  })

  it('goes RED when the latest run is stale (>8 days)', async () => {
    const db = kvDb()
    try {
      const store = freshStore(80, 75)
      store.latest.generated_at = hoursAgo(9 * 24)
      store.generated_at = store.latest.generated_at
      put(db, store)
      const res = await check.run({ db })
      expect(res.ok).toBe(false)
      expect(res.summary).toMatch(/stale/i)
    } finally { db.close() }
  })

  it('goes RED on a fleet-parity regression >10 points vs the trailing median (the ratchet)', async () => {
    const db = kvDb()
    try {
      put(db, freshStore(60, 80))
      const res = await check.run({ db })
      expect(res.ok).toBe(false)
      expect(res.summary).toMatch(/regression/i)
      expect(res.evidence.trailing_median_fleet_parity).toBe(80)
      expect(res.evidence.top_web_only[0].url).toBe('https://neighborfund.org/apply')
      expect(res.recommended_fix).toMatch(/web_parity_gap_queue/)
    } finally { db.close() }
  })

  it('is GREEN when fresh and parity held or improved (small dips within 10 points tolerated)', async () => {
    const db = kvDb()
    try {
      put(db, freshStore(80, 75))
      const res = await check.run({ db })
      expect(res.ok).toBe(true)
      expect(res.summary).toMatch(/fleet parity 80/)
      put(db, freshStore(72, 80)) // -8: within the ratchet tolerance
      expect((await check.run({ db })).ok).toBe(true)
    } finally { db.close() }
  })

  it('does NOT red-flag a return to the historical band after a single-night spike (median ratchet)', async () => {
    const db = kvDb()
    try {
      // 2026-07-12 prod shape: 18.8, 34.8, 26.3 baseline; 64.6 one-night spike; latest 15.
      // Old prior-run delta read this as -49.6; the trailing median (26.3) is
      // within tolerance of 15? 26.3-15=11.3 > 10 — pick baseline so the return
      // is honestly inside tolerance: median of [18.8, 34.8, 26.3, 64.6] = 30.55…
      // Use a band where the spike alone would have red-flagged but the median
      // does not: priors [20, 25, 26, 64.6], latest 22 → median 25.5, delta 3.5.
      const store = freshStore(22, 64.6)
      store.runs = [
        { generated_at: hoursAgo(97), fleet_parity: 20, per_profile: [] },
        { generated_at: hoursAgo(73), fleet_parity: 25, per_profile: [] },
        { generated_at: hoursAgo(49), fleet_parity: 26, per_profile: [] },
        { generated_at: hoursAgo(25), fleet_parity: 64.6, per_profile: [] },
        store.runs[store.runs.length - 1],
      ]
      put(db, store)
      const res = await check.run({ db })
      expect(res.ok).toBe(true)
    } finally { db.close() }
  })

  it('still reds when the latest run is materially below the whole recent norm', async () => {
    const db = kvDb()
    try {
      const store = freshStore(15, 60)
      store.runs = [
        { generated_at: hoursAgo(97), fleet_parity: 55, per_profile: [] },
        { generated_at: hoursAgo(73), fleet_parity: 62, per_profile: [] },
        { generated_at: hoursAgo(49), fleet_parity: 58, per_profile: [] },
        { generated_at: hoursAgo(25), fleet_parity: 60, per_profile: [] },
        store.runs[store.runs.length - 1],
      ]
      put(db, store)
      const res = await check.run({ db })
      expect(res.ok).toBe(false)
      expect(res.summary).toMatch(/regression/i)
    } finally { db.close() }
  })
})

// ── Anya morning-report section ──────────────────────────────────────────────

describe('Anya "Google-bar benchmark" report section', () => {
  const parityStore = {
    generated_at: '2026-07-07T08:00:00Z',
    runs: [
      { generated_at: '2026-07-06T08:00:00Z', fleet_parity: 70, per_profile: [{ profile_id: 'gilbert', parity: 70 }] },
      { generated_at: '2026-07-07T08:00:00Z', fleet_parity: 75, per_profile: [{ profile_id: 'gilbert', parity: 75 }] },
    ],
    latest: {
      generated_at: '2026-07-07T08:00:00Z',
      fleet_parity: 75,
      per_profile: [{
        profile_id: 'gilbert', label: 'Gilbert', parity: 75,
        overlap_count: 3, web_only_count: 1, grantflow_only: 2,
        web_only_top: [{ url: 'https://neighborfund.org/apply', title: 'Neighbor Grant', domain: 'neighborfund.org', need: 'medical bills' }],
      }],
    },
  }

  it('summarizeWebParity: null-safe, renders parity, trend arrow and top web-only finds', () => {
    expect(summarizeWebParity(null)).toBeNull()
    expect(summarizeWebParity({ latest: null })).toBeNull()
    const ps = summarizeWebParity(parityStore)
    expect(ps.headline).toMatch(/Fleet parity 75\/100/)
    expect(ps.headline).toMatch(/▲ \+5 vs prior/)
    expect(ps.perProfile[0]).toMatch(/Gilbert: parity 75\/100 ▲ \+5 vs prior/)
    expect(ps.perProfile[0]).toMatch(/3 shared, 1 web-only, 2 GrantFlow-only/)
    expect(ps.webOnlyTop[0]).toMatch(/Neighbor Grant/)
    expect(ps.webOnlyTop[0]).toMatch(/need: medical bills/)
  })

  it('buildOwnerReport renders the section in text + HTML, and omits it when the benchmark never ran', () => {
    const run = { id: 'sam-1', health_score: 100, findings: [] }
    const withParity = buildOwnerReport(run, { parity: parityStore })
    expect(withParity.text).toMatch(/GOOGLE-BAR BENCHMARK/)
    expect(withParity.text).toMatch(/Gilbert: parity 75\/100/)
    // The queue is now a work item the crawler drains, not homework for the owner.
    expect(withParity.text).toMatch(/queued — seeded into each profile/i)
    expect(withParity.html).toMatch(/Google-bar benchmark/)
    expect(withParity.html).toMatch(/Neighbor Grant/)

    const without = buildOwnerReport(run, {})
    expect(without.text).not.toMatch(/GOOGLE-BAR BENCHMARK/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The owner rule: a funding source found to meet a profile's needs gets ADDED.
//
// Before this, the gap queue was WRITE-ONLY: the benchmark found real funding
// pages GrantFlow lacked, filed them honestly as candidates, and nothing ever
// read the file — so the same pages were re-found and re-filed every night and
// the owner was asked to adjudicate them by hand ("candidate queue — nothing
// auto-added", 2026-07-15). These two functions are the consumer that drains it.
// ─────────────────────────────────────────────────────────────────────────────

function seedQueue(db, candidates) {
  db.prepare('INSERT OR REPLACE INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)')
    .run(GAP_QUEUE_KV_KEY, JSON.stringify({ updated_at: 'x', candidates }), 'x')
}

describe('loadGapSeedPagesForProfile', () => {
  it("hands the profile's pending candidates to its next discovery run", async () => {
    const db = makeDb()
    seedQueue(db, [
      { url: 'https://tndisability.org/small-grants', title: 'Small Grants', profile_id: 'gilbert', need: 'disability', status: 'candidate' },
      { url: 'https://other.org/x', title: 'Other', profile_id: 'kimberly', status: 'candidate' },
    ])
    const seeds = await loadGapSeedPagesForProfile(db, 'gilbert')
    expect(seeds).toHaveLength(1)
    expect(seeds[0]).toMatchObject({ url: 'https://tndisability.org/small-grants', title: 'Small Grants' })
    // The need travels as page context for the extractor.
    expect(seeds[0].snippet).toContain('disability')
  })

  it('does not re-offer a candidate the gates have already judged', async () => {
    // Otherwise every crawl re-fetches and re-extracts pages already refused —
    // paying an LLM call per page to be told the same thing forever.
    const db = makeDb()
    seedQueue(db, [
      { url: 'https://a.org/x', profile_id: 'gilbert', status: 'adopted' },
      { url: 'https://b.org/x', profile_id: 'gilbert', status: 'gated_out' },
      { url: 'https://c.org/x', profile_id: 'gilbert', status: 'candidate' },
    ])
    const seeds = await loadGapSeedPagesForProfile(db, 'gilbert')
    expect(seeds.map((s) => s.url)).toEqual(['https://c.org/x'])
  })

  it('treats a legacy entry with no status as pending', async () => {
    const db = makeDb()
    seedQueue(db, [{ url: 'https://legacy.org/x', profile_id: 'gilbert' }])
    expect(await loadGapSeedPagesForProfile(db, 'gilbert')).toHaveLength(1)
  })

  it('bounds the seeds handed to one run (each costs a fetch + an LLM call)', async () => {
    const db = makeDb()
    seedQueue(db, Array.from({ length: 25 }, (_, i) => ({ url: `https://f${i}.org/x`, profile_id: 'gilbert', status: 'candidate' })))
    const seeds = await loadGapSeedPagesForProfile(db, 'gilbert')
    expect(seeds).toHaveLength(GAP_SEED_LIMIT_PER_RUN)
  })

  it('drops junk urls and returns [] for an empty queue / missing profile', async () => {
    const db = makeDb()
    seedQueue(db, [{ url: 'javascript:alert(1)', profile_id: 'gilbert', status: 'candidate' }, { url: '', profile_id: 'gilbert' }])
    expect(await loadGapSeedPagesForProfile(db, 'gilbert')).toEqual([])
    expect(await loadGapSeedPagesForProfile(makeDb(), 'nobody')).toEqual([])
    expect(await loadGapSeedPagesForProfile(null, 'gilbert')).toEqual([])
  })
})

describe('markGapCandidateOutcomes', () => {
  it('records what the GATES decided, not what we attempted', async () => {
    // The honesty bar: "we seeded 2 pages" must never be reported as "we added
    // 2 sources" — the read-green-while-doing-nothing class.
    const db = makeDb()
    seedQueue(db, [
      { url: 'https://good.org/x', profile_id: 'gilbert', status: 'candidate' },
      { url: 'https://refused.org/x', profile_id: 'gilbert', status: 'candidate' },
    ])
    const res = await markGapCandidateOutcomes(db, {
      offeredUrls: ['https://good.org/x', 'https://refused.org/x'],
      adoptedUrls: ['https://good.org/x'],
      profileId: 'gilbert',
    })
    expect(res).toEqual({ adopted: 1, gated_out: 1 })
    const q = await readWebParityGapQueue(db)
    expect(q.find((c) => c.url === 'https://good.org/x').status).toBe('adopted')
    expect(q.find((c) => c.url === 'https://refused.org/x').status).toBe('gated_out')
  })

  it('never touches another profile’s candidates', async () => {
    const db = makeDb()
    seedQueue(db, [
      { url: 'https://shared.org/x', profile_id: 'gilbert', status: 'candidate' },
      { url: 'https://shared.org/x', profile_id: 'kimberly', status: 'candidate' },
    ])
    await markGapCandidateOutcomes(db, { offeredUrls: ['https://shared.org/x'], adoptedUrls: ['https://shared.org/x'], profileId: 'gilbert' })
    const q = await readWebParityGapQueue(db)
    expect(q.find((c) => c.profile_id === 'kimberly').status).toBe('candidate')
  })

  it('leaves candidates that were never offered alone', async () => {
    const db = makeDb()
    seedQueue(db, [{ url: 'https://untouched.org/x', profile_id: 'gilbert', status: 'candidate' }])
    const res = await markGapCandidateOutcomes(db, { offeredUrls: ['https://other.org/y'], adoptedUrls: [], profileId: 'gilbert' })
    expect(res).toEqual({ adopted: 0, gated_out: 0 })
    expect((await readWebParityGapQueue(db))[0].status).toBe('candidate')
  })

  it('matches urls by normalized identity (trailing slash / www / scheme)', async () => {
    const db = makeDb()
    seedQueue(db, [{ url: 'https://www.good.org/x/', profile_id: 'gilbert', status: 'candidate' }])
    const res = await markGapCandidateOutcomes(db, { offeredUrls: ['https://www.good.org/x/'], adoptedUrls: ['http://good.org/x'], profileId: 'gilbert' })
    expect(res.adopted).toBe(1)
  })

  it('is a no-op when nothing was offered', async () => {
    const db = makeDb()
    expect(await markGapCandidateOutcomes(db, { offeredUrls: [] })).toEqual({ adopted: 0, gated_out: 0 })
  })
})
