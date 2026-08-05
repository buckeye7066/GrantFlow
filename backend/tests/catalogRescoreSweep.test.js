/**
 * catalogRescoreSweep — the continuous catalog-wide re-matching sweep (the
 * "general re-scoring sweep for the rolling snapshot" CLAUDE.md carried as
 * STILL OPEN WORK).
 *
 * The measurements these tests encode (read-only, prod, 2026-08-03):
 *   • 641 of 11,050 active non-pointer catalog rows (5.8%) have EVER carried a
 *     match row for ANY profile — the rolling snapshot erases what a run does
 *     not re-find, and nothing re-offers the rest.
 *   • A blind engine pass over a 2,500-row sample per golden profile ACCEPTs
 *     13.3–20.2% — including junk classes ("U.S. Embassy Luanda Small Grants"
 *     ACCEPT 11 for a TN individual) the fix/qa-36-profile-junk chain screens.
 *     THAT is why writes once defaulted OFF behind the fundability choke point.
 *     The junk chain (`passesFundabilityGate`) now lands; writes DEFAULT ON
 *     (`ENFORCE_CATALOG_RESCORE=0` for count-only).
 *
 * The engine here is INJECTED (deps.computeMatchDecision) so each test controls
 * verdicts exactly; the write/refusal mechanics under test are the sweep's own.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  CATALOG_RESCORE_MATCHER_VERSION,
  CATALOG_RESCORE_KV_KEY,
  isCatalogRescoreWriteEnabled,
  runCatalogRescoreSweep,
} from '../services/matching/catalogRescoreSweep.js'
import { SURFACED_MATCHER_VERSIONS } from '../config/matchSurfacing.js'

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, organization_id TEXT, display_name TEXT,
      primary_type TEXT, applicant_type TEXT, status TEXT, created_by TEXT,
      deleted_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE profile_sections (
      profile_id TEXT, section_key TEXT, data TEXT,
      PRIMARY KEY (profile_id, section_key)
    );
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT, sponsor TEXT, description TEXT,
      state TEXT, is_national INTEGER, opportunity_kind TEXT, source TEXT,
      source_url TEXT, application_url TEXT,
      is_directory_resource INTEGER, excluded_from_grant_scoring INTEGER,
      profile_id TEXT, is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE profile_opportunity_matches (
      id TEXT PRIMARY KEY, profile_id TEXT, opportunity_id TEXT,
      match_score INTEGER, match_decision TEXT, match_explanation TEXT,
      match_reasons TEXT, match_explain_json TEXT, source_query TEXT,
      discovered_via TEXT, matcher_version TEXT,
      computed_at DATETIME, updated_at DATETIME, evaluated_at DATETIME
    );
    CREATE UNIQUE INDEX idx_pom_profile_opp
      ON profile_opportunity_matches(profile_id, opportunity_id);
    CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
  `)
  return db
}

function addProfile(db, id, { createdBy = null, status = 'active', createdAt = '2026-01-01T00:00:00Z' } = {}) {
  db.prepare('INSERT INTO profiles (id, display_name, status, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, id, status, createdBy, createdAt)
  db.prepare("INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, 'basic_information', ?)")
    .run(id, JSON.stringify({ first_name: id, location: { city: 'Cleveland', state: 'TN' } }))
}

let oppSeq = 0
function addOpp(db, over = {}) {
  oppSeq += 1
  const o = {
    id: `opp-${String(oppSeq).padStart(3, '0')}`,
    title: `Real Scholarship ${oppSeq}`,
    sponsor: 'Real Sponsor',
    opportunity_kind: 'SCHOLARSHIP',
    // A fundable SIGNAL (the #1133 chain refuses signal-less rows): real
    // fixtures carry an apply URL unless a test removes it on purpose.
    application_url: 'https://example.org/apply',
    is_active: 1,
    created_at: `2026-02-01T00:00:${String(oppSeq % 60).padStart(2, '0')}Z`,
    ...over,
  }
  db.prepare(
    `INSERT INTO funding_opportunities
      (id, title, sponsor, opportunity_kind, application_url, source_url, is_active, created_at, is_directory_resource, excluded_from_grant_scoring)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(o.id, o.title, o.sponsor, o.opportunity_kind, o.application_url ?? null, o.source_url ?? null,
    o.is_active, o.created_at, o.is_directory_resource ?? null, o.excluded_from_grant_scoring ?? null)
  return o
}

/** Deterministic engine stub: verdict keyed off the row title. */
function stubEngine() {
  return (profile, opp) => {
    if (/JUNK/.test(opp.title)) return { decision: 'accept', score: 12, explanation: 'junk-accept' }
    if (/REVIEW/.test(opp.title)) return { decision: 'review', score: 40, explanation: 'review' }
    if (/REJECT/.test(opp.title)) return { decision: 'reject', score: 2, explanation: 'reject' }
    return { decision: 'accept', score: 85, explanation: 'accept' }
  }
}

const baseDeps = () => ({ computeMatchDecision: stubEngine() })

function matches(db, version = CATALOG_RESCORE_MATCHER_VERSION) {
  return db.prepare('SELECT * FROM profile_opportunity_matches WHERE matcher_version = ? ORDER BY id').all(version)
}

beforeEach(() => { delete process.env.ENFORCE_CATALOG_RESCORE; oppSeq = 0 })
afterEach(() => { delete process.env.ENFORCE_CATALOG_RESCORE })

describe('the write switch (the flood gate)', () => {
  it('defaults ON: unset env writes; ENFORCE_CATALOG_RESCORE=0 is count-only', () => {
    expect(isCatalogRescoreWriteEnabled({})).toBe(true)
    expect(isCatalogRescoreWriteEnabled({ ENFORCE_CATALOG_RESCORE: '' })).toBe(true)
    expect(isCatalogRescoreWriteEnabled({ ENFORCE_CATALOG_RESCORE: '0' })).toBe(false)
    expect(isCatalogRescoreWriteEnabled({ ENFORCE_CATALOG_RESCORE: 'false' })).toBe(false)
    expect(isCatalogRescoreWriteEnabled({ ENFORCE_CATALOG_RESCORE: '1' })).toBe(true)
    expect(isCatalogRescoreWriteEnabled({ ENFORCE_CATALOG_RESCORE: 'true' })).toBe(true)
  })

  it('default ON writes an ACCEPT when ENFORCE_CATALOG_RESCORE is unset', async () => {
    delete process.env.ENFORCE_CATALOG_RESCORE
    const db = makeDb()
    addProfile(db, 'p1')
    addOpp(db, { title: 'HOPE Scholarship' })
    const res = await runCatalogRescoreSweep(db, { deps: baseDeps() })
    expect(res.write_enabled).toBe(true)
    expect(res.linked).toBe(1)
    expect(matches(db)).toHaveLength(1)
    db.close()
  })

  it('count-only mode adjudicates and REPORTS but writes nothing at all', async () => {
    const db = makeDb()
    addProfile(db, 'p1')
    addOpp(db, { title: 'HOPE Scholarship' })
    addOpp(db, { title: 'JUNK Embassy Luanda Small Grants' })
    const res = await runCatalogRescoreSweep(db, { writeEnabled: false, deps: baseDeps() })
    expect(res.write_enabled).toBe(false)
    expect(res.would_link).toBe(2) // both ACCEPTs observed…
    expect(res.linked).toBe(0)
    expect(matches(db)).toHaveLength(0) // …and NOTHING written
    // A count-only pass is stateless: no cursor is persisted, so enabling
    // writes later starts from the top instead of skipping everything the
    // census walked past (the "green while doing nothing" class).
    expect(db.prepare('SELECT * FROM system_kv WHERE key = ?').get(CATALOG_RESCORE_KV_KEY)).toBeUndefined()
    db.close()
  })
})

describe('ACCEPT-only writes under the reconcile-surviving version', () => {
  it('links an engine ACCEPT and never a REVIEW or REJECT', async () => {
    const db = makeDb()
    addProfile(db, 'p1')
    addOpp(db, { title: 'HOPE Scholarship' })
    addOpp(db, { title: 'REVIEW Directory-adjacent Program' })
    addOpp(db, { title: 'REJECT Seniors-only Award' })
    const res = await runCatalogRescoreSweep(db, { writeEnabled: true, deps: baseDeps() })
    expect(res.linked).toBe(1)
    expect(res.review).toBe(1)
    expect(res.rejected_by_engine).toBe(1)
    const rows = matches(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].match_decision).toBe('accept')
    expect(rows[0].opportunity_id).toBe('opp-001')
    db.close()
  })

  it('persists under catalog-rescore-link, which SURFACED_MATCHER_VERSIONS reads back and the reconcile DELETE does not name', async () => {
    // Persisting under a reconcile-surviving version and then not reading it
    // back is the web-llm regression exactly.
    expect(SURFACED_MATCHER_VERSIONS).toContain(CATALOG_RESCORE_MATCHER_VERSION)
    expect(['crawler-os', 'crawler-os-xmatch']).not.toContain(CATALOG_RESCORE_MATCHER_VERSION)
    const db = makeDb()
    addProfile(db, 'p1')
    addOpp(db, { title: 'HOPE Scholarship' })
    await runCatalogRescoreSweep(db, { writeEnabled: true, deps: baseDeps() })
    // Simulate the rolling-snapshot reconcile (verbatim version list from
    // crawlerOsPersistenceCore.persistRun): the sweep's row survives.
    db.prepare("DELETE FROM profile_opportunity_matches WHERE profile_id = 'p1' AND matcher_version IN ('crawler-os', 'crawler-os-xmatch')").run()
    expect(matches(db)).toHaveLength(1)
    db.close()
  })

  it('a pair with ANY existing match row is excluded by the SQL predicate — a profile\'s own crawler-os verdict always wins', async () => {
    const db = makeDb()
    addProfile(db, 'p1')
    const opp = addOpp(db, { title: 'HOPE Scholarship' })
    db.prepare(
      `INSERT INTO profile_opportunity_matches (id, profile_id, opportunity_id, match_decision, matcher_version)
       VALUES ('existing', 'p1', ?, 'reject', 'crawler-os')`,
    ).run(opp.id)
    const res = await runCatalogRescoreSweep(db, { writeEnabled: true, deps: baseDeps() })
    expect(res.scanned).toBe(0)
    expect(matches(db)).toHaveLength(0)
    db.close()
  })
})

describe('what never reaches the engine', () => {
  it('pointer kinds are refused by the SQL predicate before adjudication', async () => {
    const db = makeDb()
    addProfile(db, 'p1')
    addOpp(db, { title: 'Findhelp locator', opportunity_kind: 'directory' })
    addOpp(db, { title: 'Eldercare referral', opportunity_kind: 'referral' })
    addOpp(db, { title: 'School portal pointer', opportunity_kind: 'school_portal' })
    let engineCalls = 0
    const deps = { computeMatchDecision: () => { engineCalls += 1; return { decision: 'accept', score: 90 } } }
    const res = await runCatalogRescoreSweep(db, { writeEnabled: true, deps })
    expect(engineCalls).toBe(0)
    expect(res.scanned).toBe(0)
    expect(matches(db)).toHaveLength(0)
    db.close()
  })

  it('the fundability choke point refuses legacy directory-signal rows before the engine', async () => {
    const db = makeDb()
    addProfile(db, 'p1')
    addOpp(db, { title: 'Directory row with no canonical kind', opportunity_kind: null, is_directory_resource: 1 })
    addOpp(db, { title: 'Excluded-from-scoring row', opportunity_kind: null, excluded_from_grant_scoring: 1 })
    addOpp(db, { title: 'HOPE Scholarship' })
    let engineCalls = 0
    const deps = { computeMatchDecision: () => { engineCalls += 1; return { decision: 'accept', score: 90 } } }
    const res = await runCatalogRescoreSweep(db, { writeEnabled: true, deps })
    expect(res.not_fundable).toBe(2)
    expect(engineCalls).toBe(1)
    expect(res.linked).toBe(1)
    db.close()
  })

  it('consumes the #1133 junk chain: regulatory notices, lead-gen "scholarships" and signal-less rows never reach the engine', async () => {
    // These are the EXACT classes the 2026-08-03 flood dry-run measured inside
    // the blind ACCEPT set (federal-register rows in every profile sample).
    // The sweep must consult the shared classifyFundingResult chain, never a
    // private copy of it.
    const db = makeDb()
    addProfile(db, 'p1')
    addOpp(db, {
      title: 'Privacy Act of 1974; System of Records',
      sponsor: 'Office of the Secretary',
      source_url: 'https://www.federalregister.gov/documents/2026/01/01/privacy-act',
      application_url: 'https://www.federalregister.gov/documents/2026/01/01/privacy-act',
      opportunity_kind: null,
    })
    addOpp(db, { title: 'Signal-less row', application_url: null })
    addOpp(db, { title: 'HOPE Scholarship' })
    let engineCalls = 0
    const deps = { computeMatchDecision: () => { engineCalls += 1; return { decision: 'accept', score: 90 } } }
    const res = await runCatalogRescoreSweep(db, { writeEnabled: true, deps })
    expect(res.not_fundable).toBe(2)
    expect(engineCalls).toBe(1)
    expect(res.linked).toBe(1)
    const rows = matches(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].opportunity_id).toBe('opp-003')
    db.close()
  })

  it('an INACTIVE row is never a candidate', async () => {
    const db = makeDb()
    addProfile(db, 'p1')
    addOpp(db, { title: 'Dead award', is_active: 0 })
    const res = await runCatalogRescoreSweep(db, { writeEnabled: true, deps: baseDeps() })
    expect(res.scanned).toBe(0)
    db.close()
  })

  it('Amy synthetic profiles are skipped on positive created_by evidence', async () => {
    const db = makeDb()
    addProfile(db, 'p-real')
    addProfile(db, 'p-synthetic', { createdBy: 'agent:amy' })
    addOpp(db, { title: 'HOPE Scholarship' })
    const res = await runCatalogRescoreSweep(db, { writeEnabled: true, deps: baseDeps() })
    expect(res.profiles_skipped_synthetic).toBe(1)
    const rows = matches(db)
    expect(rows.map((r) => r.profile_id)).toEqual(['p-real'])
    db.close()
  })
})

describe('the cursor (bounded, resumable, drift-reopening)', () => {
  it('a budget-truncated pass resumes past its watermark instead of re-scanning', async () => {
    const db = makeDb()
    addProfile(db, 'p1')
    for (let i = 0; i < 5; i += 1) addOpp(db, { title: `REVIEW filler ${i}` })
    const first = await runCatalogRescoreSweep(db, { writeEnabled: true, pairBudget: 2, deps: baseDeps() })
    expect(first.truncated).toBe(true)
    expect(first.adjudicated).toBe(2)
    const second = await runCatalogRescoreSweep(db, { writeEnabled: true, pairBudget: 100, deps: baseDeps() })
    // Only the 3 rows past the watermark are adjudicated — never the same pair twice.
    expect(second.adjudicated).toBe(3)
    expect(second.profiles_completed).toBe(1)
    db.close()
  })

  it('a completed profile is skipped until the active catalog materially drifts', async () => {
    const db = makeDb()
    addProfile(db, 'p1')
    addOpp(db, { title: 'REVIEW one' })
    await runCatalogRescoreSweep(db, { writeEnabled: true, deps: baseDeps() })
    const again = await runCatalogRescoreSweep(db, { writeEnabled: true, deps: baseDeps() })
    expect(again.adjudicated).toBe(0) // nothing re-scanned
    // The world moves 500+ active rows: the profile re-opens and NEW rows are seen.
    for (let i = 0; i < 501; i += 1) addOpp(db, { title: `REVIEW drift ${i}`, created_at: `2026-03-01T01:00:00Z` })
    const drift = await runCatalogRescoreSweep(db, { writeEnabled: true, pairBudget: 10_000, deps: baseDeps() })
    expect(drift.adjudicated).toBeGreaterThan(0)
    db.close()
  })

  it('is idempotent in write mode: a second full pass writes nothing new', async () => {
    const db = makeDb()
    addProfile(db, 'p1')
    addOpp(db, { title: 'HOPE Scholarship' })
    addOpp(db, { title: 'Second Real Scholarship' })
    await runCatalogRescoreSweep(db, { writeEnabled: true, deps: baseDeps() })
    const before = matches(db).length
    const res = await runCatalogRescoreSweep(db, { writeEnabled: true, deps: baseDeps() })
    expect(res.linked).toBe(0)
    expect(matches(db)).toHaveLength(before)
    db.close()
  })
})

describe('convergence', () => {
  it('removes this sweep\'s own link when its row goes inactive — and touches no other version', async () => {
    const db = makeDb()
    addProfile(db, 'p1')
    const opp = addOpp(db, { title: 'HOPE Scholarship' })
    const keep = addOpp(db, { title: 'REVIEW keep' })
    db.prepare(
      `INSERT INTO profile_opportunity_matches (id, profile_id, opportunity_id, match_decision, matcher_version)
       VALUES ('other-version', 'p1', ?, 'accept', 'crawler-os')`,
    ).run(keep.id)
    await runCatalogRescoreSweep(db, { writeEnabled: true, deps: baseDeps() })
    expect(matches(db)).toHaveLength(1)
    db.prepare('UPDATE funding_opportunities SET is_active = 0 WHERE id = ?').run(opp.id)
    const res = await runCatalogRescoreSweep(db, { writeEnabled: true, deps: baseDeps() })
    expect(res.stale_removed).toBe(1)
    expect(matches(db)).toHaveLength(0)
    expect(db.prepare("SELECT COUNT(*) c FROM profile_opportunity_matches WHERE matcher_version = 'crawler-os'").get().c).toBe(1)
    db.close()
  })
})

describe('honest reporting', () => {
  it('reports truncation when it runs exactly to the pair budget (the #1080 scanned==bound signature)', async () => {
    const db = makeDb()
    addProfile(db, 'p1')
    for (let i = 0; i < 4; i += 1) addOpp(db, { title: `REVIEW filler ${i}` })
    const res = await runCatalogRescoreSweep(db, { writeEnabled: true, pairBudget: 4, deps: baseDeps() })
    expect(res.adjudicated).toBe(4)
    expect(res.truncated).toBe(true)
    db.close()
  })

  it('an unscorable pair is counted, never written, and never kills the pass', async () => {
    const db = makeDb()
    addProfile(db, 'p1')
    addOpp(db, { title: 'Explodes' })
    addOpp(db, { title: 'HOPE Scholarship' })
    const deps = {
      computeMatchDecision: (profile, opp) => {
        if (/Explodes/.test(opp.title)) throw new Error('boom')
        return { decision: 'accept', score: 80 }
      },
    }
    const res = await runCatalogRescoreSweep(db, { writeEnabled: true, deps })
    expect(res.unscorable).toBe(1)
    expect(res.linked).toBe(1)
    db.close()
  })
})
