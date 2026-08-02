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
      match_decision TEXT, matcher_version TEXT
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
    db.prepare('INSERT INTO profile_opportunity_matches VALUES (?,?,?,?,?)')
      .run(profileId, oid, 40, decision, 'crawler-os')
  }
  for (let k = 0; k < awards; k += 1) put('direct_grant', 'ACCEPT')
  for (let k = 0; k < locators; k += 1) put('directory', 'REVIEW')
}

beforeEach(() => { runLiveMock = vi.fn(async () => ({ ok: true })) })

describe('the result-floor backfill queue', () => {
  it('queues the pointer-padded profile FIRST — the deepest real shortfall, not the smallest total', async () => {
    const db = makeDb()
    try {
      // `padded` shows 25 "results" and has ZERO awards (the Melissa Justus
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
      runLiveMock = vi.fn(async ({ profileId }) => { seed(db, profileId, { awards: 3 }); return { ok: true } })
      const res = await runProfileCoverageSweep(db, { autoheal: true, maxHeal: 1 })
      const h = res.healed.find((x) => x.profile_id === 'p1')
      expect(h.before).toBe(2)
      expect(h.after).toBe(5)
      expect(h.target).toBe(10)
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

  it('a SKIPPED run (deleted profile / no sources selected) also spends no attempt', async () => {
    const db = makeDb()
    try {
      seed(db, 'p1', { awards: 1 })
      runLiveMock = vi.fn(async () => ({ ok: true, skipped: true, reason: 'no_sources_selected' }))
      await runProfileCoverageSweep(db, { autoheal: true, maxHeal: 1 })
      const ledger = await readFloorLedger(db)
      expect(ledger.profiles.p1.attempts).toBe(0)
    } finally { db.close() }
  })

  it('stops after MAX_ATTEMPTS fruitless crawls and records an EVIDENCED verdict', async () => {
    const db = makeDb()
    try {
      seed(db, 'niche', { awards: 2 })
      // The crawl runs and searches, but this niche genuinely has nothing more.
      runLiveMock = vi.fn(async () => ({
        ok: true, sources: [{}, {}, {}], web: { queries: ['a', 'b'], fetched: 5, extracted: 4, rejected: 4 },
      }))
      for (let i = 0; i < RESULT_FLOOR_MAX_ATTEMPTS; i += 1) {
        await runProfileCoverageSweep(db, { autoheal: true, maxHeal: 1 })
      }
      const ledger = await readFloorLedger(db)
      expect(ledger.profiles.niche.attempts).toBe(RESULT_FLOOR_MAX_ATTEMPTS)
      expect(ledger.profiles.niche.exhausted_at).toBeTruthy()
      expect(ledger.profiles.niche.exhausted_evidence).toMatchObject({
        target: 10, found: 2, lanes_queried: 3, queries_issued: 2, candidates_extracted: 4, rejected_by_engine: 4,
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
      expect(res.result_floor.exhausted[0].verdict).toContain('Found 2 of a requested 10')
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
        return { ok: true, sources: [{}], web: { queries: ['q'] } }
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
      seed(db, 'p1', { awards: 12 })
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
