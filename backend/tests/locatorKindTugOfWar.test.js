/**
 * opportunity_kind TUG-OF-WAR regression suite (2026-07-25).
 *
 * BUG. The locator_kind_classification boot sweep (#1007) repaired ~387 rows
 * EVERY night and never converged, because the WRITERS kept restamping
 * machine-generated kinds over the sweep's verified structural classification
 * on every re-crawl:
 *
 *   - crawlerOsPersistence.osOppToLiveRow wrote the OS pipeline's kind
 *     ('PROGRAM'/'DIRECT_GRANT') verbatim, and its ON CONFLICT UPDATE clause
 *     clobbered whatever the sweep had written;
 *   - opportunityRealityGate.classifyOpportunityKind (consulted by
 *     opportunityInserter on every ingest) recomputed a heuristic kind with no
 *     knowledge of the structural URL rules.
 *
 * Measured in prod 2026-07-25: 130 sam.gov /fal/ + 233 ProPublica-990 rows
 * still stamped 'PROGRAM' hours after the morning sweep, keeping 10 active
 * pipeline rows in the census's `unreadable` bucket forever.
 *
 * THE FIX is the repo's own invariant doctrine — the per-call WRITER is the
 * first line of defense, the boot sweep is only the net:
 *   (a) both writers consult the same structural rule the sweep applies
 *       (classifyLocatorKindFromRow), and
 *   (b) the OS bridge's ON CONFLICT UPDATE never downgrades a stored canonical
 *       'directory'/'benefit' to a generic machine kind (GENERIC_OVERRIDABLE_KINDS),
 *       and an incoming NULL never wipes a stored kind.
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { persistRun } from '../services/crawlerOsPersistence.js'
import { classifyOpportunityKind } from '../services/opportunityRealityGate.js'

function makeDb() {
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

function makeMemStore({ catalog = [] } = {}) {
  return {
    all(table) {
      if (table === 'funding_opportunities') return catalog
      return []
    },
  }
}

function osOpp(overrides = {}) {
  return {
    id: 'os-1',
    source_id: 'sam_gov',
    external_id: '93.867',
    kind: 'PROGRAM', // the machine-stamped generic the OS pipeline emits
    canonical_opportunity_key: 'ck-1',
    title: 'Vision Research',
    sponsor: 'NIH',
    summary: 'Assistance listing.',
    apply_url: null,
    info_url: 'https://sam.gov/fal/d346cf7415ab47fa8840260fc5fff1c2/view',
    deadline: null,
    is_loan: 0,
    requires_cost_share: 0,
    applicant_types_json: '[]',
    need_categories_json: '[]',
    geography_json: '{"national":true}',
    trust_tier: 'official_api',
    reality_status: 'allowed',
    evidence_url: null,
    created_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  }
}

const kindOf = (db, id) =>
  db.prepare('SELECT opportunity_kind FROM funding_opportunities WHERE id = ?').get(id)?.opportunity_kind

describe('crawler-os bridge — the writer honors the structural rule', () => {
  it('writes the structural kind over the OS machine stamp on INSERT', async () => {
    const db = makeDb()
    await persistRun(db, makeMemStore({ catalog: [osOpp()] }), {})
    expect(kindOf(db, 'os-1'), 'a sam.gov /fal/ assistance listing is a directory, not a PROGRAM').toBe('directory')
  })

  it('re-crawl does NOT restamp a sweep-classified row back to a generic kind', async () => {
    // The nightly flywheel: sweep writes 'directory' at boot, the day's crawl
    // re-upserts with 'PROGRAM'. The stored canonical kind must survive even
    // for a URL the classifier makes no claim about (an admin/sweep judgment).
    const db = makeDb()
    const opp = osOpp({
      id: 'os-2',
      canonical_opportunity_key: 'ck-2',
      info_url: 'https://example.org/program-list', // classifier claims nothing here
    })
    await persistRun(db, makeMemStore({ catalog: [opp] }), {})
    expect(kindOf(db, 'os-2')).toBe('PROGRAM') // no structural claim → OS kind lands
    db.prepare(`UPDATE funding_opportunities SET opportunity_kind = 'directory' WHERE id = 'os-2'`).run()

    await persistRun(db, makeMemStore({ catalog: [opp] }), {})
    expect(kindOf(db, 'os-2'), 'a canonical classification is never downgraded by a machine stamp').toBe('directory')
  })

  it('an incoming NULL kind never wipes a stored kind', async () => {
    const db = makeDb()
    const opp = osOpp({ id: 'os-3', canonical_opportunity_key: 'ck-3', info_url: 'https://example.org/x', kind: 'DIRECT_GRANT' })
    await persistRun(db, makeMemStore({ catalog: [opp] }), {})
    expect(kindOf(db, 'os-3')).toBe('DIRECT_GRANT')
    await persistRun(db, makeMemStore({ catalog: [{ ...opp, kind: null }] }), {})
    expect(kindOf(db, 'os-3')).toBe('DIRECT_GRANT')
  })

  it('a NON-generic stored kind still updates normally (only canonical values are shielded)', async () => {
    // The shield is narrow: 'directory'/'benefit' vs the generic list. An
    // ordinary kind refresh (e.g. DIRECT_GRANT → PROGRAM) stays live.
    const db = makeDb()
    const opp = osOpp({ id: 'os-4', canonical_opportunity_key: 'ck-4', info_url: 'https://example.org/y', kind: 'DIRECT_GRANT' })
    await persistRun(db, makeMemStore({ catalog: [opp] }), {})
    await persistRun(db, makeMemStore({ catalog: [{ ...opp, kind: 'PROGRAM' }] }), {})
    expect(kindOf(db, 'os-4')).toBe('PROGRAM')
  })
})

describe('reality gate — classifyOpportunityKind consults the structural rule', () => {
  it('a machine-stamped PROGRAM on a sam.gov /fal/ URL classifies as directory', () => {
    expect(
      classifyOpportunityKind({
        opportunity_kind: 'PROGRAM',
        source_url: 'https://sam.gov/fal/d346cf7415ab47fa8840260fc5fff1c2/view',
      }),
    ).toBe('directory')
  })

  it('an ssa.gov benefit page classifies as benefit regardless of the stamp', () => {
    expect(
      classifyOpportunityKind({
        opportunity_kind: 'DIRECT_GRANT',
        source_url: 'https://www.ssa.gov/benefits/ssi/apply.html',
      }),
    ).toBe('benefit')
  })

  it('an explicit CANONICAL kind still wins (a curated judgment is never overridden)', () => {
    expect(
      classifyOpportunityKind({
        opportunity_kind: 'direct',
        source_url: 'https://sam.gov/fal/d346cf7415ab47fa8840260fc5fff1c2/view',
      }),
    ).toBe('direct')
  })

  it('an ordinary award page is unaffected', () => {
    expect(
      classifyOpportunityKind({
        opportunity_kind: 'PROGRAM',
        source_url: 'https://www.cocacolascholarsfoundation.org/apply/',
      }),
    ).toBe('direct')
  })
})
