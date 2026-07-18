/**
 * Phase 0.1 web-lane de-contamination — page-fact provenance storage plumbing.
 *
 * ADDITIVE, NULL-default. These tests pin that:
 *   (a) osOppToLiveRow + persistRun on an OS row that carries NONE of the new
 *       fields writes the EXACT same live row as before — it never even names
 *       the new columns, so a minimal fixture table that lacks them keeps
 *       working (backward-compat / zero behavior change);
 *   (b) when the OS row DOES carry the fields they round-trip faithfully into
 *       the live catalog columns (eligibility_text / eligibility_bullets /
 *       page_fact_schema_version / field_provenance) — the plumbing a later
 *       profile-blind extractor will populate; and
 *   (c) the numbered migration adds the columns on a DB that lacks them and is
 *       idempotent (re-running is a tolerated no-op).
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import { persistRun } from '../services/crawlerOsPersistence.js'
import { ensurePageFactProvenanceColumns } from '../startup/ensureSchemaInvariants.js'
import { checkFundingOpportunitiesSchema } from '../services/diagnosticsService.js'

// Minimal live-catalog table WITHOUT the page-fact columns — mirrors the many
// fixture tables across the suite and prod BEFORE migration 144. Used to prove
// (a): persistRun must not reference a page-fact column for an unset OS row.
function makeLegacyDb() {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, sponsor TEXT, description TEXT,
      source TEXT, source_id TEXT, source_url TEXT, application_url TEXT, apply_url TEXT,
      deadline TEXT, amount_min REAL, amount_max REAL, amount_text TEXT, amount_status TEXT,
      amount_confidence REAL, is_loan INTEGER, requires_match INTEGER,
      is_national INTEGER, state TEXT, categories TEXT, opportunity_kind TEXT,
      source_trust_tier TEXT, reality_status TEXT, record_origin TEXT,
      canonical_opportunity_key TEXT, fingerprint TEXT, evidence_url TEXT,
      is_active INTEGER DEFAULT 1, is_hidden INTEGER DEFAULT 0,
      last_crawled DATETIME, last_verified_at DATETIME, discovered_at DATETIME,
      updated_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE grants (id TEXT PRIMARY KEY, profile_id TEXT, funding_opportunity_id TEXT, status TEXT);
  `)
  raw.dialect = 'sqlite'
  return raw
}

// Same table PLUS the page-fact columns — mirrors a migrated (post-144) catalog.
function makeMigratedDb() {
  const raw = makeLegacyDb()
  raw.exec(`
    ALTER TABLE funding_opportunities ADD COLUMN eligibility_text TEXT;
    ALTER TABLE funding_opportunities ADD COLUMN eligibility_bullets TEXT;
    ALTER TABLE funding_opportunities ADD COLUMN page_fact_schema_version INTEGER;
    ALTER TABLE funding_opportunities ADD COLUMN field_provenance TEXT;
  `)
  return raw
}

// persistRun only reads all('funding_opportunities' | 'opportunity_sources' |
// 'profile_opportunity_matches') off the mem store.
function makeMemStore(catalog = []) {
  return {
    all(table) {
      if (table === 'funding_opportunities') return catalog
      return []
    },
  }
}

// One OS memory-store catalog row (the shape listCatalog returns) — no page-fact
// fields set.
function osRow(over = {}) {
  return {
    id: 'os-1', source_id: 'grants_gov', external_id: 'EXT-1', kind: 'direct',
    canonical_opportunity_key: 'ck-1', title: 'Rural Facilities Grant',
    sponsor: 'Dept of Test', summary: 'A per-award grant of $20,000 for rural nonprofits.',
    apply_url: 'https://grants.example-agency.gov/apply/1',
    info_url: 'https://grants.example-agency.gov/1', deadline: '2099-12-31',
    amount_min: 20000, amount_max: 20000, is_loan: 0, requires_cost_share: 0,
    applicant_types_json: '[]', need_categories_json: '[]',
    geography_json: '{"national":true}', trust_tier: 'official_api',
    reality_status: 'allowed', evidence_url: 'https://grants.example-agency.gov/1',
    created_at: '2020-01-01T00:00:00.000Z',
    ...over,
  }
}

describe('page-fact provenance — zero behavior change when unset', () => {
  it('(a) persistRun writes the row on a table that LACKS the page-fact columns', async () => {
    const db = makeLegacyDb()
    const res = await persistRun(db, makeMemStore([osRow()]), {})
    expect(res.opportunities).toBe(1)

    const row = db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get('os-1')
    expect(row).toBeTruthy()
    // Core fields land exactly as before — nothing about the row moved.
    expect(row.title).toBe('Rural Facilities Grant')
    expect(row.amount_min).toBe(20000)
    expect(row.record_origin).toBe('live_crawl')
    // The insert never NAMED a page-fact column (else this legacy table errors).
  })

  it('leaves the page-fact columns NULL on a migrated table when the OS row is unset', async () => {
    const db = makeMigratedDb()
    await persistRun(db, makeMemStore([osRow()]), {})
    const row = db
      .prepare('SELECT eligibility_text, eligibility_bullets, page_fact_schema_version, field_provenance FROM funding_opportunities WHERE id = ?')
      .get('os-1')
    expect(row.eligibility_text).toBeNull()
    expect(row.eligibility_bullets).toBeNull()
    expect(row.page_fact_schema_version).toBeNull()
    expect(row.field_provenance).toBeNull()
  })

  it('does NOT downgrade previously-stored provenance to null on a re-crawl that lacks it', async () => {
    const db = makeMigratedDb()
    // Pretend a prior run stored provenance.
    db.prepare(
      `INSERT INTO funding_opportunities (id, title, canonical_opportunity_key, fingerprint,
         eligibility_text, page_fact_schema_version, field_provenance)
       VALUES ('os-1', 'Rural Facilities Grant', 'ck-1', 'ck-1',
               'Nonprofits only.', 1, '{"national":{"value":true}}')`,
    ).run()
    // Re-crawl with an OS row that carries NO page facts.
    await persistRun(db, makeMemStore([osRow()]), {})
    const row = db
      .prepare('SELECT eligibility_text, page_fact_schema_version, field_provenance FROM funding_opportunities WHERE id = ?')
      .get('os-1')
    // Conditional emit preserves the stored provenance (never wipes it).
    expect(row.eligibility_text).toBe('Nonprofits only.')
    expect(row.page_fact_schema_version).toBe(1)
    expect(JSON.parse(row.field_provenance)).toEqual({ national: { value: true } })
  })
})

describe('page-fact provenance — LIVE-DB per-key provenance merge (finding #1)', () => {
  it('two persists of the same live row MERGE provenance per key (both survive)', async () => {
    const db = makeMigratedDb()
    // First run learns is_loan; second run (same id) learns national.
    await persistRun(db, makeMemStore([osRow({
      field_provenance_json: JSON.stringify({ is_loan: { value: false, source: 'https://a' } }),
    })]), {})
    await persistRun(db, makeMemStore([osRow({
      field_provenance_json: JSON.stringify({ national: { value: true, source: 'https://b' } }),
    })]), {})
    const prov = JSON.parse(
      db.prepare('SELECT field_provenance FROM funding_opportunities WHERE id = ?').get('os-1').field_provenance,
    )
    expect(prov.is_loan.value).toBe(false) // preserved from the first write
    expect(prov.national.value).toBe(true) // added by the second write
  })

  it('a re-crawl that lacks provenance leaves the stored live provenance untouched', async () => {
    const db = makeMigratedDb()
    await persistRun(db, makeMemStore([osRow({
      field_provenance_json: JSON.stringify({ is_loan: { value: false } }),
    })]), {})
    await persistRun(db, makeMemStore([osRow()]), {}) // no provenance this run
    const prov = JSON.parse(
      db.prepare('SELECT field_provenance FROM funding_opportunities WHERE id = ?').get('os-1').field_provenance,
    )
    expect(prov).toEqual({ is_loan: { value: false } })
  })

  it('CONCURRENT persists to the same live row both survive (atomic in-SQL merge, many iterations)', async () => {
    const db = makeMigratedDb()
    for (let i = 0; i < 25; i += 1) {
      const id = `race-${i}`
      const ck = `ck-race-${i}`
      const a = makeMemStore([osRow({ id, canonical_opportunity_key: ck,
        field_provenance_json: JSON.stringify({ is_loan: { value: false, source: 'https://a' } }) })])
      const b = makeMemStore([osRow({ id, canonical_opportunity_key: ck,
        field_provenance_json: JSON.stringify({ national: { value: true, source: 'https://b' } }) })])
      // Interleave two persists of the SAME live row. A non-atomic read-then-write
      // would let one overwrite the other; the in-SQL json_patch/jsonb merge can't.
      await Promise.all([persistRun(db, a, {}), persistRun(db, b, {})])
      const prov = JSON.parse(
        db.prepare('SELECT field_provenance FROM funding_opportunities WHERE id = ?').get(id).field_provenance,
      )
      expect(prov.is_loan?.value, `iter ${i} is_loan`).toBe(false)
      expect(prov.national?.value, `iter ${i} national`).toBe(true)
    }
  })

  it('a partial dedup write onto an existing live canonical row keeps prior keys', async () => {
    const db = makeMigratedDb()
    // Seed a live row (id os-1) with is_loan provenance already stored.
    db.prepare(
      `INSERT INTO funding_opportunities (id, title, canonical_opportunity_key, fingerprint, field_provenance)
       VALUES ('os-1', 'Rural Facilities Grant', 'ck-1', 'ck-1', '{"is_loan":{"value":false}}')`,
    ).run()
    // A new OS id that dedups to os-1 via the SAME canonical key, carrying national.
    await persistRun(db, makeMemStore([osRow({
      id: 'os-2',
      field_provenance_json: JSON.stringify({ national: { value: true } }),
    })]), {})
    const prov = JSON.parse(
      db.prepare('SELECT field_provenance FROM funding_opportunities WHERE id = ?').get('os-1').field_provenance,
    )
    expect(prov.is_loan.value).toBe(false)
    expect(prov.national.value).toBe(true)
  })
})

describe('page-fact provenance — round-trips when provided', () => {
  it('(b) osOppToLiveRow carries the fields into the live catalog columns', async () => {
    const db = makeMigratedDb()
    const provenance = {
      is_loan: { value: false, evidence_snippet: 'This is a grant.', source: 'https://x/1' },
      national: { value: true, evidence_snippet: 'nationwide', source: 'https://x/1' },
    }
    await persistRun(db, makeMemStore([osRow({
      eligibility_text: '501(c)(3) nonprofits in rural counties.',
      eligibility_bullets_json: JSON.stringify(['Must be a 501(c)(3)', 'Rural county']),
      page_fact_schema_version: 3,
      field_provenance_json: JSON.stringify(provenance),
    })]), {})

    const row = db
      .prepare('SELECT eligibility_text, eligibility_bullets, page_fact_schema_version, field_provenance FROM funding_opportunities WHERE id = ?')
      .get('os-1')
    expect(row.eligibility_text).toBe('501(c)(3) nonprofits in rural counties.')
    expect(JSON.parse(row.eligibility_bullets)).toEqual(['Must be a 501(c)(3)', 'Rural county'])
    expect(row.page_fact_schema_version).toBe(3)
    expect(JSON.parse(row.field_provenance)).toEqual(provenance)
    // Tri-state: is_loan is stated-false; requires_cost_share is ABSENT = not stated.
    expect(JSON.parse(row.field_provenance).is_loan.value).toBe(false)
    expect('requires_cost_share' in JSON.parse(row.field_provenance)).toBe(false)
  })
})

describe('page-fact provenance — persist-layer validation (finding #3)', () => {
  const seedRealProvenance = (db) =>
    db.prepare(
      `INSERT INTO funding_opportunities (id, title, canonical_opportunity_key, fingerprint,
         eligibility_text, page_fact_schema_version, field_provenance)
       VALUES ('os-1', 'Rural Facilities Grant', 'ck-1', 'ck-1',
               'Real text.', 2, '{"is_loan":{"value":false}}')`,
    ).run()

  it('omits blank text / empty bullets / empty object / non-positive version — never overwrites live', async () => {
    const db = makeMigratedDb()
    seedRealProvenance(db)
    await persistRun(db, makeMemStore([osRow({
      eligibility_text: '   ',
      eligibility_bullets_json: '[]',
      page_fact_schema_version: '', // Postgres would reject '' for the INTEGER column
      field_provenance_json: '{}',
    })]), {})
    const row = db
      .prepare('SELECT eligibility_text, page_fact_schema_version, field_provenance FROM funding_opportunities WHERE id = ?')
      .get('os-1')
    expect(row.eligibility_text).toBe('Real text.')
    expect(row.page_fact_schema_version).toBe(2)
    expect(JSON.parse(row.field_provenance)).toEqual({ is_loan: { value: false } })
  })

  it('omits malformed provenance JSON rather than writing garbage', async () => {
    const db = makeMigratedDb()
    seedRealProvenance(db)
    await persistRun(db, makeMemStore([osRow({ field_provenance_json: 'not json at all' })]), {})
    const row = db.prepare('SELECT field_provenance FROM funding_opportunities WHERE id = ?').get('os-1')
    expect(JSON.parse(row.field_provenance)).toEqual({ is_loan: { value: false } })
  })

  it('a valid POSITIVE integer version DOES round-trip', async () => {
    const db = makeMigratedDb()
    await persistRun(db, makeMemStore([osRow({ page_fact_schema_version: 5 })]), {})
    const row = db.prepare('SELECT page_fact_schema_version FROM funding_opportunities WHERE id = ?').get('os-1')
    expect(row.page_fact_schema_version).toBe(5)
  })
})

describe('page-fact provenance — boot invariant + drift check (finding #4)', () => {
  it('the drift check flags the page-fact columns when missing, and clears once healed', async () => {
    const db = makeLegacyDb() // funding_opportunities WITHOUT the page-fact columns
    const before = await checkFundingOpportunitiesSchema(db)
    const missingBefore = before?.details?.missing_columns || []
    for (const c of ['eligibility_text', 'page_fact_schema_version', 'field_provenance']) {
      expect(missingBefore).toContain(`funding_opportunities.${c}`)
    }
    // The boot schema invariant heals them (this is what a boot does).
    await ensurePageFactProvenanceColumns(db)
    const after = await checkFundingOpportunitiesSchema(db)
    const missingAfter = after?.details?.missing_columns || []
    for (const c of ['eligibility_text', 'page_fact_schema_version', 'field_provenance']) {
      expect(missingAfter).not.toContain(`funding_opportunities.${c}`)
    }
  })

  it('ensurePageFactProvenanceColumns is idempotent (heals a legacy DB, no-op when already healed)', async () => {
    const db = makeLegacyDb()
    await ensurePageFactProvenanceColumns(db)
    await ensurePageFactProvenanceColumns(db) // second run must not throw
    const cols = db.prepare('PRAGMA table_info(funding_opportunities)').all().map((c) => c.name)
    for (const c of ['eligibility_text', 'page_fact_schema_version', 'field_provenance']) {
      expect(cols).toContain(c)
    }
  })
})

describe('migration 144 — page-fact provenance columns', () => {
  const sqlitePath = path.join(process.cwd(), 'backend/db/migrations/144_page_fact_provenance.sql')
  const pgPath = path.join(process.cwd(), 'backend/db/postgres/migrations/0148_page_fact_provenance.sql')

  it('exists as a numbered twin pair', () => {
    expect(fs.existsSync(sqlitePath)).toBe(true)
    expect(fs.existsSync(pgPath)).toBe(true)
    // PG uses IF NOT EXISTS (strict runner, no swallow); sqlite is plain ALTER.
    expect(fs.readFileSync(pgPath, 'utf8')).toMatch(/ADD COLUMN IF NOT EXISTS/)
  })

  it('carries the @sqlite-continue-on-idempotent-errors directive', () => {
    // Without it, on a PARTIALLY-drifted table the first duplicate column aborts
    // the transaction and the runner stamps the WHOLE migration applied, leaving
    // later columns permanently missing.
    expect(fs.readFileSync(sqlitePath, 'utf8')).toMatch(/@sqlite-continue-on-idempotent-errors/)
  })

  // Mirror the migrate runner's directive path: run each statement, skip ONLY
  // the "duplicate column name" error.
  const applyWithDirective = (db) => {
    const sql = fs.readFileSync(sqlitePath, 'utf8')
    const stmts = sql
      .split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n')
      .split(';').map((s) => s.trim()).filter(Boolean)
    for (const stmt of stmts) {
      try {
        db.exec(`${stmt};`)
      } catch (e) {
        if (!/duplicate column name/i.test(String(e?.message || e))) throw e
      }
    }
  }
  const cols = (db) => db.prepare('PRAGMA table_info(funding_opportunities)').all().map((c) => c.name)
  const ALL = ['eligibility_text', 'page_fact_schema_version', 'field_provenance']

  it('applies cleanly from a NONE state (no page-fact columns)', () => {
    const db = makeLegacyDb()
    applyWithDirective(db)
    for (const c of ALL) expect(cols(db)).toContain(c)
  })

  it('applies cleanly from a PARTIAL-drift state (one column already present)', () => {
    const db = makeLegacyDb()
    db.exec('ALTER TABLE funding_opportunities ADD COLUMN eligibility_text TEXT') // pre-existing drift
    applyWithDirective(db)
    // The directive skips the duplicate on eligibility_text and STILL adds the rest.
    for (const c of ALL) expect(cols(db)).toContain(c)
  })

  it('is a clean no-op from an ALL-present state, and idempotent', () => {
    const db = makeMigratedDb() // already has all three
    expect(() => applyWithDirective(db)).not.toThrow()
    expect(() => applyWithDirective(db)).not.toThrow()
    for (const c of ALL) expect(cols(db)).toContain(c)
  })
})
