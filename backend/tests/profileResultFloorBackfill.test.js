/**
 * The RESULT-FLOOR BACKFILL — the ACTOR half of the per-profile result floor.
 *
 * The boot census (`enforceProfileResultFloor`) counts and records; this is the
 * loop that actually goes and searches, and then STOPS. Every assertion here is
 * about a defect that shipped in the previous version of the heal queue, all of
 * them visible in prod on 2026-08-01:
 *
 *   - it ranked by the POINTER-PADDED count, so a profile with 25 directories
 *     and zero awards queued behind profiles that already had real funding;
 *   - it re-ran `runProfileDiscoveryLive` with identical arguments every night
 *     with no memory of what had been tried, so an unsatisfiable gap was a
 *     permanent nightly retry (Noor Hassan's `institution_gap:Lewiston High
 *     School`, +1 result per night);
 *   - a crawl that failed was indistinguishable from a crawl that found nothing.
 *
 * The mock discovery function here NEVER adds a row unless the test says so —
 * the point is that the loop's accounting is honest about what it got.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import Database from 'better-sqlite3'
import { verifiedFourTruthExplain } from './helpers/fourTruthFixture.js'

let runLiveMock = vi.fn(async () => ({ ok: true }))
vi.mock('../services/crawlerOsService.js', async (importOriginal) => {
  const actual = await importOriginal().catch(() => ({}))
  return { ...actual, runProfileDiscoveryLive: (...a) => runLiveMock(...a) }
})

const { runProfileCoverageSweep } = await import('../services/coverageAudit/profileResultCoverageAudit.js')
const { readFloorLedger, writeFloorLedger } = await import('../services/coverageAudit/profileResultFloorLedger.js')
const { RESULT_FLOOR_MAX_ATTEMPTS } = await import('../config/profileResultFloor.js')

const HERE = path.dirname(fileURLToPath(import.meta.url))

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, display_name TEXT, status TEXT DEFAULT 'active',
      deleted_at TEXT, created_by TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT, updated_at TEXT);
    CREATE TABLE profile_opportunity_matches (
      profile_id TEXT, opportunity_id TEXT, match_score INTEGER,
      match_decision TEXT, matcher_version TEXT, match_explain_json TEXT
    );
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT, sponsor TEXT, description TEXT, categories TEXT,
      opportunity_kind TEXT, deadline TEXT, deadline_at TEXT, deadline_type TEXT, is_active INTEGER
    );
  `)
  return db
}

/** Give `profileId` `awards` real awards and `locators` pointer rows. */
function seed(db, profileId, { awards = 0, locators = 0, name = profileId } = {}) {
  const exists = db.prepare('SELECT 1 FROM profiles WHERE id = ?').get(profileId)
  if (!exists) db.prepare('INSERT INTO profiles (id, display_name) VALUES (?,?)').run(profileId, name)
  const n = db.prepare('SELECT COUNT(*) c FROM profile_opportunity_matches WHERE profile_id = ?').get(profileId).c
  let i = n
  const put = (kind, decision) => {
    const oid = `${profileId}-o${i++}`
    db.prepare('INSERT INTO funding_opportunities (id, title, opportunity_kind, is_active) VALUES (?,?,?,1)')
      .run(oid, `${kind} ${i}`, kind)
    db.prepare('INSERT INTO profile_opportunity_matches VALUES (?,?,?,?,?,?)')
      .run(profileId, oid, 40, decision, 'crawler-os', decision === 'ACCEPT' ? verifiedFourTruthExplain() : null)
  }
  for (let k = 0; k < awards; k += 1) put('direct_grant', 'ACCEPT')
  for (let k = 0; k < locators; k += 1) put('directory', 'REVIEW')
}

/**
 * The REAL return shape of runProfileDiscoveryLive (crawlerOsService.js):
 * `{ run, persisted, thesis, opportunities }` — lane telemetry lives at
 * `run.web_lane`, never at a top-level `web`, and there is no top-level `ok`.
 * The previous mocks returned `{ ok, sources, web }`, a shape production never
 * produces, which is how the sweep read `run.ok`/`run.web.*` for a month
 * without a test noticing (sweepheal-1).
 */
function liveResult(runOver = {}) {
  return {
    run: { run_id: 'r', profile_id: 'p', planned: 1, stored: 0, rejected: 0, sources: [], zero_result: null, ...runOver },
    persisted: { opportunities: 0, matches: 0, sources: 0, rejected: 0, pipelinePruned: 0 },
    thesis: {},
    opportunities: [],
  }
}

beforeEach(() => { runLiveMock = vi.fn(async () => liveResult()) })

describe('the result-floor backfill queue', () => {
  it('queues the pointer-padded profile FIRST — the deepest real shortfall, not the smallest total', async () => {
    const db = makeDb()
    try {
      // `padded` shows 25 "results" and has ZERO awards (the Demo General Support Persona
      // shape). `thin` shows 9 and has 9 real awards. The OLD queue, ordered by
      // the padded actionable count, put `thin` first.
      seed(db, 'padded', { locators: 25 })
      seed(db, 'thin', { awards: 9 })
      seed(db, 'served', { awards: 20 })

      const res = await runProfileCoverageSweep(db, { autoheal: true, maxHeal: 1 })
      expect(res.result_floor.below_target).toBe(2)
      expect(runLiveMock).toHaveBeenCalledTimes(1)
      expect(runLiveMock.mock.calls[0][0].profileId).toBe('padded')
      // `served` is never touched.
      expect(res.healed.map((h) => h.profile_id)).not.toContain('served')
    } finally { db.close() }
  })

  it('reports BEFORE/AFTER in AWARDABLE results, not in the padded total', async () => {
    const db = makeDb()
    try {
      seed(db, 'p1', { awards: 2, locators: 40 })
      runLiveMock = vi.fn(async ({ profileId }) => { seed(db, profileId, { awards: 3 }); return liveResult() })
      const res = await runProfileCoverageSweep(db, { autoheal: true, maxHeal: 1 })
      const h = res.healed.find((x) => x.profile_id === 'p1')
      expect(h.before).toBe(2)
      expect(h.after).toBe(5)
      expect(h.target).toBe(20)
    } finally { db.close() }
  })

  it('a CRAWL FAILURE spends no attempt — an outage must not cost a profile its chance', async () => {
    const db = makeDb()
    try {
      seed(db, 'p1', { awards: 1 })
      runLiveMock = vi.fn(async () => { throw new Error('searxng 502') })
      for (let i = 0; i < RESULT_FLOOR_MAX_ATTEMPTS + 2; i += 1) {
        await runProfileCoverageSweep(db, { autoheal: true, maxHeal: 1 })
      }
      const ledger = await readFloorLedger(db)
      expect(ledger.profiles.p1.attempts).toBe(0)
      expect(ledger.profiles.p1.exhausted_at ?? null).toBeNull()
      expect(ledger.profiles.p1.last_outcome).toBe('transient')
    } finally { db.close() }
  })

  it('a SKIPPED run (deleted / unconfigured profile) — in the REAL { run, persisted } shape — spends no attempt', async () => {
    // sweepheal-1 / discovery-attrib-1: runProfileDiscoveryLive returns
    // `{ run:{ skipped:true, … }, persisted:{ skipped:true }, thesis:null }`;
    // the old loop read a top-level `skipped` that never existed and burned
    // an attempt on every skip.
    const db = makeDb()
    try {
      seed(db, 'p1', { awards: 1 })
      runLiveMock = vi.fn(async () => ({
        run: { skipped: true, reason: 'profile_unconfigured', profile_id: 'p1', planned: 0, stored: 0, rejected: 0, sources: [], zero_result: null },
        persisted: { opportunities: 0, matches: 0, sources: 0, rejected: 0, pipelinePruned: 0, skipped: true, reason: 'profile_unconfigured' },
        thesis: null,
      }))
      await runProfileCoverageSweep(db, { autoheal: true, maxHeal: 1 })
      const ledger = await readFloorLedger(db)
      expect(ledger.profiles.p1.attempts).toBe(0)
      expect(ledger.profiles.p1.last_outcome).toBe('transient')
    } finally { db.close() }
  })

  it('a run whose open-web lane was DEAD (LLM unavailable) told us nothing about the ceiling — no attempt spent', async () => {
    const db = makeDb()
    try {
      seed(db, 'p1', { awards: 1 })
      runLiveMock = vi.fn(async () => liveResult({
        web_lane: {
          ok: true, queries: ['a', 'b'], pages: 40, fetched: 38, extracted: 0, rejected: 0,
          provider_health: { search: 'healthy', llm: 'unavailable' },
          primary_attribution: 'extraction_failed:llm_quota',
        },
      }))
      for (let i = 0; i < RESULT_FLOOR_MAX_ATTEMPTS + 1; i += 1) {
        await runProfileCoverageSweep(db, { autoheal: true, maxHeal: 1 })
      }
      const ledger = await readFloorLedger(db)
      expect(ledger.profiles.p1.attempts).toBe(0)
      expect(ledger.profiles.p1.exhausted_at ?? null).toBeNull()
      expect(ledger.profiles.p1.last_outcome).toBe('transient')
    } finally { db.close() }
  })

  it('a PROVIDER OUTAGE on the FIRST heal attempt of a sweep spends the rest of the queue\'s slots on NOTHING — it stops instead of burning them on the same dead lane', async () => {
    // Three profiles, all fresh (0 attempts), ordered by shortfall descending
    // (deepest-shortfall-first, since orderFloorQueue ties on attempts): alpha
    // (0 awards, biggest gap) sorts first, then bravo, then charlie. Every call
    // to runProfileDiscoveryLive would report the SAME dead open-web lane (a
    // fleet-wide outage), so without the short-circuit all 3 slots would be
    // spent finding out the identical fact three times.
    const db = makeDb()
    try {
      seed(db, 'alpha', {})
      seed(db, 'bravo', { awards: 5 })
      seed(db, 'charlie', { awards: 10 })
      const deadLane = liveResult({
        web_lane: {
          ok: true, queries: ['a', 'b'], pages: 40, fetched: 38, extracted: 0, rejected: 0,
          provider_health: { search: 'healthy', llm: 'unavailable' },
          primary_attribution: 'extraction_failed:llm_quota',
        },
      })
      runLiveMock = vi.fn(async () => deadLane)

      const res = await runProfileCoverageSweep(db, { autoheal: true, maxHeal: 3 })

      // Only the FIRST candidate was ever attempted — the queue's other two
      // slots were spent on nothing, not on rediscovering the same outage.
      expect(runLiveMock).toHaveBeenCalledTimes(1)
      expect(runLiveMock.mock.calls[0][0].profileId).toBe('alpha')

      // The sweep names the outage, who revealed it, and who was spared.
      expect(res.result_floor.provider_outage).toMatchObject({
        detected_on_profile_id: 'alpha',
        reason: 'llm_unavailable',
      })
      expect(res.result_floor.provider_outage.skipped_profile_ids).toEqual(['bravo', 'charlie'])

      // No attempt was spent anywhere: the outage-revealing profile stays
      // transient (never burns, per the existing single-profile rule), and the
      // spared profiles were never touched at all — not even folded as
      // transient — so they carry NO ledger entry.
      const ledger = await readFloorLedger(db)
      expect(ledger.profiles.alpha.attempts).toBe(0)
      expect(ledger.profiles.alpha.last_outcome).toBe('transient')
      expect(ledger.profiles.bravo).toBeUndefined()
      expect(ledger.profiles.charlie).toBeUndefined()
    } finally { db.close() }
  })

  it('a HEALTHY first heal attempt does not trip the outage short-circuit — the rest of the queue still runs', async () => {
    const db = makeDb()
    try {
      seed(db, 'alpha', {})
      seed(db, 'bravo', { awards: 5 })
      runLiveMock = vi.fn(async () => liveResult({
        sources: [{}],
        web_lane: { ok: true, queries: ['a'], pages: 2, fetched: 2, extracted: 1, rejected: 0, provider_health: { search: 'healthy', llm: 'healthy' } },
      }))
      const res = await runProfileCoverageSweep(db, { autoheal: true, maxHeal: 2 })
      expect(runLiveMock).toHaveBeenCalledTimes(2)
      expect(res.result_floor.provider_outage).toBeNull()
    } finally { db.close() }
  })

  // ─── 2026-09-12: heal-queue starvation during an extended provider outage ──
  //
  // discoveryRanOk's blanket "a dead web lane never burns an attempt" rule is
  // right when NOTHING ran (covered above), but wrong when the run's REGISTRY
  // lanes actually executed — that is real signal about the profile's ceiling,
  // and treating it as a free, never-burning TRANSIENT let a dead-web-lane
  // profile sit at attempts:0 forever, permanently out-ranking (fewest-
  // attempts-first) every profile carrying real attempts. A real 9-day
  // LLM/search outage (2026-09-03..09-12) would have let a handful of such
  // profiles monopolize every one of the 5 nightly heal slots for its whole
  // duration.

  it('a run whose REGISTRY lanes executed but whose web lane was DEAD spends a REAL attempt, not a free transient', async () => {
    const db = makeDb()
    try {
      seed(db, 'p1', { awards: 1 })
      runLiveMock = vi.fn(async () => liveResult({
        sources: [{ source_id: 'benefits_gov', outcome: 'ok' }, { source_id: 'hrsa', outcome: 'empty' }],
        web_lane: {
          ok: true, queries: ['a', 'b'], pages: 40, fetched: 38, extracted: 0, rejected: 0,
          provider_health: { search: 'healthy', llm: 'unavailable' },
          primary_attribution: 'extraction_failed:llm_quota',
        },
      }))
      const res = await runProfileCoverageSweep(db, { autoheal: true, maxHeal: 1 })
      const ledger = await readFloorLedger(db)
      // THE DEFECT THIS PINS: pre-fix, ranOk is false purely because the web
      // lane is dead, so the whole attempt folds as TRANSIENT (attempts stay
      // 0) even though two registry sources actually ran and told us
      // something real about this profile.
      expect(ledger.profiles.p1.attempts).toBe(1)
      expect(ledger.profiles.p1.last_outcome).not.toBe('transient')
      expect(ledger.profiles.p1.web_lane_dead).toBe(true)
      expect(ledger.profiles.p1.last_web_lane_outage_at).toBeTruthy()
      const h = res.healed.find((x) => x.profile_id === 'p1')
      expect(h.floor_attempt_kind).toBe('web_lane_outage')
    } finally { db.close() }
  })

  it('a MET floor is recognised even when the web lane was dead — a registry-lane addition still counts', async () => {
    const db = makeDb()
    try {
      seed(db, 'p1', { awards: 19 }) // one short of the fleet default target (20)
      runLiveMock = vi.fn(async ({ profileId }) => {
        // The registry lane found the missing award; the web lane is dead.
        seed(db, profileId, { awards: 1 })
        return liveResult({
          sources: [{ source_id: 'benefits_gov', outcome: 'ok' }],
          web_lane: {
            ok: true, queries: ['a'], pages: 5, fetched: 5, extracted: 0, rejected: 0,
            provider_health: { search: 'healthy', llm: 'unavailable' },
            primary_attribution: 'extraction_failed:llm_quota',
          },
        })
      })
      const res = await runProfileCoverageSweep(db, { autoheal: true, maxHeal: 1 })
      const h = res.healed.find((x) => x.profile_id === 'p1')
      expect(h.after).toBe(20)
      const ledger = await readFloorLedger(db)
      // THE DEFECT THIS PINS: pre-fix, this folds as TRANSIENT (ranOk false),
      // which never even reaches the "floor met" check, so the profile stays
      // recorded as short and gets re-queued every night the web lane is dead
      // — even though it has already reached its requested number.
      expect(ledger.profiles.p1.attempts).toBe(0)
      expect(ledger.profiles.p1.exhausted_at ?? null).toBeNull()
      expect(ledger.profiles.p1.last_outcome).toBe('added')
    } finally { db.close() }
  })

  it('a dead-web-lane profile does not monopolize the heal queue forever — a waiting profile finally gets its turn (starvation reproduction, real exported functions)', async () => {
    // THE STARVATION THIS PINS. 'waiting' already carries ONE real attempt
    // (pre-seeded, as if it lost a fair coin-flip on a previous night) and a
    // DEEPER shortfall (0 awards -> shortfall 20) than 'sickly' (5 awards ->
    // shortfall 15). 'sickly' starts fresh at attempts:0.
    //
    // NIGHT 1: fewest-attempts-first picks 'sickly' (0 < waiting's 1)
    // regardless of the fix — this night looks identical either way.
    //
    // NIGHT 2 is where they diverge. PRE-FIX: discoveryRanOk is false purely
    // because 'sickly's web lane is dead, so its whole attempt folds as
    // TRANSIENT and its attempts count NEVER moves off 0 — it re-wins the
    // fewest-attempts tie-break against 'waiting' (stuck at 1) FOREVER, and
    // 'waiting' is never attempted again no matter how many more nights pass.
    // POST-FIX: night 1 was a REAL spend for 'sickly' (its registry lanes
    // ran), so it now ties 'waiting' at attempts:1 — and the tie-break
    // (deepest shortfall first) hands 'waiting' its turn on night 2.
    const db = makeDb()
    try {
      seed(db, 'sickly', { awards: 5 }) // shortfall 15 once counted
      seed(db, 'waiting', {}) // shortfall 20 — deeper
      await writeFloorLedger(db, {
        targets: {},
        profiles: { waiting: { attempts: 1, target: 20, awardable: 0, last_attempt_at: '2026-09-01T00:00:00Z' } },
      })
      runLiveMock = vi.fn(async ({ profileId }) => {
        if (profileId === 'sickly') {
          return liveResult({
            sources: [{ source_id: 'benefits_gov', outcome: 'ok' }],
            web_lane: {
              ok: true, queries: ['a'], pages: 10, fetched: 10, extracted: 0, rejected: 0,
              provider_health: { search: 'healthy', llm: 'unavailable' },
              primary_attribution: 'extraction_failed:llm_quota',
            },
          })
        }
        return liveResult({
          sources: [{ source_id: 'benefits_gov', outcome: 'empty' }],
          web_lane: { ok: true, queries: ['a'], pages: 5, fetched: 5, extracted: 0, rejected: 0, provider_health: { search: 'healthy', llm: 'healthy' } },
        })
      })

      // NIGHT 1 — identical under both old and new code: 'sickly' (0 attempts)
      // is picked over 'waiting' (1 attempt).
      await runProfileCoverageSweep(db, { autoheal: true, maxHeal: 1 })
      let ledger = await readFloorLedger(db)
      expect(ledger.profiles.waiting.attempts).toBe(1) // untouched this night

      // NIGHT 2 — THE ASSERTION THAT PINS THE DEFECT. Pre-fix, 'sickly' is
      // STILL picked (its dead-web-lane attempt never advanced past 0 on
      // night 1 either), so 'waiting.attempts' would still read 1 here.
      await runProfileCoverageSweep(db, { autoheal: true, maxHeal: 1 })
      ledger = await readFloorLedger(db)
      expect(ledger.profiles.waiting.attempts).toBe(2)
      expect(ledger.profiles.sickly.attempts).toBe(1)
    } finally { db.close() }
  })

  it('stops after MAX_ATTEMPTS fruitless crawls and records an EVIDENCED verdict', async () => {
    const db = makeDb()
    try {
      seed(db, 'niche', { awards: 2 })
      // The crawl runs and searches, but this niche genuinely has nothing more.
      // REAL return shape: { run:{ sources, web_lane }, persisted, thesis }.
      runLiveMock = vi.fn(async () => liveResult({
        sources: [{}, {}, {}],
        web_lane: { ok: true, queries: ['a', 'b'], queries_planned: ['a', 'b', 'c'], pages: 6, fetched: 5, extracted: 4, rejected: 4, provider_health: { search: 'healthy', llm: 'healthy' }, primary_attribution: 'gate_rejected:reality' },
      }))
      for (let i = 0; i < RESULT_FLOOR_MAX_ATTEMPTS; i += 1) {
        await runProfileCoverageSweep(db, { autoheal: true, maxHeal: 1 })
      }
      const ledger = await readFloorLedger(db)
      expect(ledger.profiles.niche.attempts).toBe(RESULT_FLOOR_MAX_ATTEMPTS)
      expect(ledger.profiles.niche.exhausted_at).toBeTruthy()
      expect(ledger.profiles.niche.exhausted_evidence).toMatchObject({
        target: 20, found: 2, lanes_queried: 3, queries_issued: 2, pages_fetched: 5, candidates_extracted: 4, rejected_by_engine: 4,
        primary_attribution: 'gate_rejected:reality',
      })

      // …and the NEXT nightly run does not crawl it again. THIS is the
      // convergence the old loop lacked: it re-ran the same profile forever.
      const callsBefore = runLiveMock.mock.calls.length
      const res = await runProfileCoverageSweep(db, { autoheal: true, maxHeal: 1 })
      expect(runLiveMock.mock.calls.length).toBe(callsBefore)
      expect(res.result_floor.skipped_by_ledger.map((s) => s.profile_id)).toContain('niche')
      expect(res.result_floor.skipped_by_ledger[0].reason).toBe('exhausted')
      // The verdict is REPORTED, not just silently absent.
      expect(res.result_floor.exhausted.map((e) => e.profile_id)).toContain('niche')
      expect(res.result_floor.exhausted[0].verdict).toContain('Found 2 of a requested 20')
    } finally { db.close() }
  })

  it('a productive crawl resets the budget instead of counting down to a premature verdict', async () => {
    const db = makeDb()
    try {
      seed(db, 'p1', { awards: 1 })
      let calls = 0
      runLiveMock = vi.fn(async ({ profileId }) => {
        calls += 1
        if (calls === 2) seed(db, profileId, { awards: 2 })  // productive on pass 2
        return liveResult({ sources: [{}], web_lane: { ok: true, queries: ['q'], pages: 1, fetched: 1, extracted: 0, rejected: 0, provider_health: { search: 'healthy', llm: 'healthy' } } })
      })
      for (let i = 0; i < 3; i += 1) await runProfileCoverageSweep(db, { autoheal: true, maxHeal: 1 })
      const ledger = await readFloorLedger(db)
      // pass1 fruitless (1), pass2 productive (reset to 0), pass3 fruitless (1)
      expect(ledger.profiles.p1.attempts).toBe(1)
      expect(ledger.profiles.p1.exhausted_at ?? null).toBeNull()
      expect(ledger.profiles.p1.best_awardable).toBe(3)
    } finally { db.close() }
  })

  it('reaching the target clears an exhausted verdict and stops the crawling', async () => {
    const db = makeDb()
    try {
      seed(db, 'p1', { awards: 22 })
      await writeFloorLedger(db, { targets: {}, profiles: { p1: { attempts: 3, exhausted_at: '2026-01-01T00:00:00Z' } } })
      const res = await runProfileCoverageSweep(db, { autoheal: true, maxHeal: 5 })
      expect(runLiveMock).not.toHaveBeenCalled()
      expect(res.result_floor.below_target).toBe(0)
      const ledger = await readFloorLedger(db)
      expect(ledger.profiles.p1.exhausted_at).toBeNull()
    } finally { db.close() }
  })

  it('honours a per-profile requested number — a profile that asked for 3 and has 4 is not crawled', async () => {
    const db = makeDb()
    try {
      seed(db, 'niche', { awards: 4 })
      await writeFloorLedger(db, { targets: { niche: 3 }, profiles: {} })
      const res = await runProfileCoverageSweep(db, { autoheal: true, maxHeal: 5 })
      expect(runLiveMock).not.toHaveBeenCalled()
      expect(res.result_floor.below_target).toBe(0)
    } finally { db.close() }
  })

  it('THE LEDGER HAS A CONSUMER — a static tripwire against rebuilding a write-only queue', () => {
    // CLAUDE.md records two separate write-only queues in this codebase
    // (`web_parity_gap_queue`, the adapter wishlist): a finding that was right
    // every night with nothing acting on it. If the sweep ever stops reading the
    // ledger, the floor degrades into exactly that.
    const sweep = readFileSync(path.join(HERE, '..', 'services/coverageAudit/profileResultCoverageAudit.js'), 'utf8')
    expect(sweep).toContain('assessProfileFloor')
    expect(sweep).toContain('recordFloorAttempt')
    expect(sweep).toContain('runProfileDiscoveryLive')
    const boot = readFileSync(path.join(HERE, '..', 'startup/enforceInvariants.js'), 'utf8')
    expect(boot).toContain('enforceProfileResultFloor')
  })
})
