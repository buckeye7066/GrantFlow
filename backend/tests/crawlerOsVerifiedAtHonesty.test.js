/**
 * last_verified_at TIMESTAMP-HONESTY regression suite.
 *
 * BUG (found by adversarial review): the crawler-os persistence path stamped a
 * catalog row's `last_verified_at` from the SOURCE page's `fetched_at` — the
 * time we scraped the LISTING/aggregator, NOT the time we verified the
 * opportunity's own application target. That (1) showed a scrape time as a
 * "verified" time in the Source Trace UI, (2) made linkVerificationService SKIP
 * these rows for ~30 days (they looked freshly verified) so their real target
 * was never probed, and (3) let a fallback query ordered by last_verified_at
 * boost the falsely-"verified" rows.
 *
 * These tests pin the fix:
 *   (a) source capture (persistRun) no longer stamps last_verified_at;
 *   (b) only a genuine TARGET verification (linkVerificationService probing the
 *       final URL) sets last_verified_at;
 *   (c) the bounded backfill clears already-persisted false stamps and re-queues
 *       them (NULL → picked first by the verifier), preserves real verifications,
 *       and respects its per-boot bound.
 */
import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { persistRun } from '../services/crawlerOsPersistence.js'
import { runLinkVerification } from '../services/linkVerificationService.js'
import { enforceLiveCrawlVerifiedAtHonesty } from '../startup/enforceInvariants.js'

function makeDb() {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, sponsor TEXT, description TEXT,
      source TEXT, source_id TEXT, source_url TEXT, application_url TEXT, apply_url TEXT,
      deadline TEXT, deadline_type TEXT, amount_min REAL, amount_max REAL, amount_text TEXT, amount_status TEXT,
      amount_confidence REAL, is_loan INTEGER, requires_match INTEGER,
      is_national INTEGER, state TEXT, categories TEXT, opportunity_kind TEXT,
      source_trust_tier TEXT, reality_status TEXT, record_origin TEXT,
      canonical_opportunity_key TEXT, fingerprint TEXT, evidence_url TEXT,
      is_active INTEGER DEFAULT 1, is_hidden INTEGER DEFAULT 0, status TEXT DEFAULT 'active',
      last_crawled DATETIME, last_verified_at DATETIME, discovered_at DATETIME,
      updated_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      link_status TEXT DEFAULT 'unverified', link_status_code INTEGER,
      verification_method TEXT, verified_by TEXT, verification_error TEXT,
      final_url TEXT, http_status INTEGER,
      type TEXT, opportunity_type TEXT, result_kind TEXT
    );
    CREATE TABLE grants (id TEXT PRIMARY KEY, profile_id TEXT, funding_opportunity_id TEXT, status TEXT);
  `)
  raw.dialect = 'sqlite'
  return raw
}

/**
 * Minimal fake OS memory-store: persistRun only reads listCatalog (=
 * all('funding_opportunities')), all('opportunity_sources') and
 * all('profile_opportunity_matches').
 */
function makeMemStore({ catalog = [], sources = [], matches = [] } = {}) {
  return {
    all(table) {
      if (table === 'funding_opportunities') return catalog
      if (table === 'opportunity_sources') return sources
      if (table === 'profile_opportunity_matches') return matches
      return []
    },
  }
}

function osOpp(overrides = {}) {
  return {
    id: 'os-1',
    source_id: 'grants_gov',
    external_id: 'EXT-1',
    kind: 'direct',
    canonical_opportunity_key: 'ck-1',
    title: 'Rural Facilities Grant',
    sponsor: 'Dept of Test',
    summary: 'A real per-award grant of $20,000 for rural nonprofits.',
    apply_url: 'https://grants.example-agency.gov/apply/1',
    info_url: 'https://grants.example-agency.gov/1',
    deadline: '2099-12-31',
    amount_min: 20000,
    amount_max: 20000,
    is_loan: 0,
    requires_cost_share: 0,
    applicant_types_json: '[]',
    need_categories_json: '[]',
    geography_json: '{"national":true}',
    trust_tier: 'official_api',
    reality_status: 'allowed',
    evidence_url: 'https://grants.example-agency.gov/1',
    // The SOURCE scrape time — this is what the bug wrongly wrote into
    // last_verified_at.
    fetched_at: '2020-01-01T00:00:00.000Z',
    created_at: '2020-01-01T00:00:00.000Z',
    ...overrides,
  }
}

const savedEnv = {}
function setEnv(key, value) {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k]
})

describe('last_verified_at honesty — source capture', () => {
  it('(a) persistRun does NOT stamp last_verified_at from the source fetched_at', async () => {
    const db = makeDb()
    const memStore = makeMemStore({ catalog: [osOpp()] })
    await persistRun(db, memStore, {})

    const row = db.prepare('SELECT last_verified_at, record_origin, discovered_at FROM funding_opportunities WHERE id = ?').get('os-1')
    expect(row).toBeTruthy()
    // The false stamp is gone even though the OS row carried fetched_at.
    expect(row.last_verified_at).toBeNull()
    // Source provenance still lands honestly (record_origin + discovery time).
    expect(row.record_origin).toBe('live_crawl')
    expect(row.discovered_at).toBeTruthy()
  })

  it('persistRun never overwrites a prior REAL verification with a scrape time', async () => {
    const db = makeDb()
    // Pretend the verifier already target-verified this row.
    db.prepare(
      `INSERT INTO funding_opportunities
         (id, title, record_origin, canonical_opportunity_key, fingerprint,
          last_verified_at, verified_by, verification_method, link_status)
       VALUES ('os-1', 'Rural Facilities Grant', 'live_crawl', 'ck-1', 'ck-1',
               '2026-07-10T00:00:00.000Z', 'recurring-verifier', 'head', 'ok')`,
    ).run()

    // Re-crawl the same canonical opp (fetched_at is an OLD scrape time).
    await persistRun(db, makeMemStore({ catalog: [osOpp()] }), {})

    const row = db.prepare('SELECT last_verified_at, link_status FROM funding_opportunities WHERE id = ?').get('os-1')
    // The genuine verification timestamp survives (source capture omits the column).
    expect(row.last_verified_at).toBe('2026-07-10T00:00:00.000Z')
    expect(row.link_status).toBe('ok')
  })
})

describe('last_verified_at honesty — only target verification sets it', () => {
  it('(b) linkVerificationService stamps last_verified_at after a real target probe', async () => {
    const db = makeDb()
    // A crawler-persisted row with NO verification yet (last_verified_at NULL).
    db.prepare(
      `INSERT INTO funding_opportunities (id, title, record_origin, application_url, link_status)
       VALUES ('t-1', 'Target Grant', 'live_crawl', 'http://93.184.216.34/apply', 'unverified')`,
    ).run()

    const realFetch = global.fetch
    global.fetch = async (url) => ({ status: 200, url: String(url) })
    try {
      await runLinkVerification(db, { limit: 5, verifiedBy: 'test-verifier' })
    } finally {
      global.fetch = realFetch
    }

    const row = db.prepare('SELECT last_verified_at, link_status, verification_method, verified_by FROM funding_opportunities WHERE id = ?').get('t-1')
    // The REAL target check is the only thing that may set last_verified_at.
    expect(row.last_verified_at).toBeTruthy()
    expect(row.link_status).toBe('ok')
    expect(row.verification_method).toBe('head')
    expect(row.verified_by).toBe('test-verifier')
  })
})

describe('last_verified_at honesty — bounded backfill', () => {
  const insert = (db, id, over = {}) => {
    const r = {
      record_origin: 'live_crawl',
      last_verified_at: '2020-06-01T00:00:00.000Z',
      verified_by: null,
      verification_method: null,
      link_status: 'unverified',
      ...over,
    }
    db.prepare(
      `INSERT INTO funding_opportunities (id, title, record_origin, last_verified_at, verified_by, verification_method, link_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, id, r.record_origin, r.last_verified_at, r.verified_by, r.verification_method, r.link_status)
  }

  it('(c) clears false stamps, re-queues them (NULL), and never touches real verifications or non-live_crawl rows', async () => {
    const db = makeDb()
    insert(db, 'false-1') // falsely stamped live_crawl row → CLEAR
    insert(db, 'false-2')
    // Real target verification (evidence present) → PRESERVE.
    insert(db, 'real-1', { verified_by: 'recurring-verifier', verification_method: 'head', link_status: 'ok' })
    // Curated/baseline row (not live_crawl) → not this bug's class → PRESERVE.
    insert(db, 'curated-1', { record_origin: 'curated_verified' })

    const res = await enforceLiveCrawlVerifiedAtHonesty(db)
    expect(res.ok).toBe(true)
    expect(res.scanned).toBe(2)
    expect(res.repaired).toBe(2)

    const get = (id) => db.prepare('SELECT last_verified_at FROM funding_opportunities WHERE id = ?').get(id)
    // Re-queued: NULL is picked first by the verifier's candidate query.
    expect(get('false-1').last_verified_at).toBeNull()
    expect(get('false-2').last_verified_at).toBeNull()
    // Untouched.
    expect(get('real-1').last_verified_at).toBe('2020-06-01T00:00:00.000Z')
    expect(get('curated-1').last_verified_at).toBe('2020-06-01T00:00:00.000Z')
  })

  it('respects the per-boot bound so a big backlog cannot stampede the verifier', async () => {
    const db = makeDb()
    for (let i = 0; i < 5; i += 1) insert(db, `f-${i}`)
    setEnv('VERIFIED_AT_HONESTY_BOOT_LIMIT', '2')

    const res = await enforceLiveCrawlVerifiedAtHonesty(db)
    expect(res.repaired).toBe(2)

    const remaining = db
      .prepare(`SELECT COUNT(*) AS c FROM funding_opportunities WHERE record_origin = 'live_crawl' AND last_verified_at IS NOT NULL AND verified_by IS NULL`)
      .get().c
    expect(remaining).toBe(3)
  })

  it('is idempotent / count-only when disabled and a no-op on a clean DB', async () => {
    const db = makeDb()
    // Clean DB — nothing to repair.
    const clean = await enforceLiveCrawlVerifiedAtHonesty(db)
    expect(clean.repaired).toBe(0)
    expect(clean.scanned).toBe(0)

    insert(db, 'false-1')
    setEnv('ENFORCE_VERIFIED_AT_HONESTY', '0')
    const disabled = await enforceLiveCrawlVerifiedAtHonesty(db)
    expect(disabled.scanned).toBe(1)
    expect(disabled.repaired).toBe(0)
    expect(disabled.enforced).toBe(false)
    // The stamp is left in place in count-only mode.
    expect(db.prepare('SELECT last_verified_at FROM funding_opportunities WHERE id = ?').get('false-1').last_verified_at).toBeTruthy()
  })
})
