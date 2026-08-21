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
import { classifyLocatorKindFromRow } from '../services/sources/locatorUrlKind.js'

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

describe('crawler-os bridge — a re-crawl NEVER wipes a learned amount answer', () => {
  // THE #950 WIPE CLASS, CAUGHT LIVE (prod 2026-07-25). The deploy-boot sweep
  // wrote 7 real grants.gov award figures via the API adapter at 17:08Z; the
  // ordinary crawl cycle re-upserted those rows at 17:09–17:22Z with the
  // bridge's default `amount_min = excluded.amount_min` — every figure wiped
  // to NULL within minutes while each row stayed BURNED as answered. The
  // inserter path has carried COALESCE guards for these columns all along;
  // the bridge (the highest-volume writer) is what this suite pins.
  const seedAnswered = async (db, opp) => {
    await persistRun(db, makeMemStore({ catalog: [opp] }), {})
    db.prepare(
      `UPDATE funding_opportunities
          SET amount_min = 795000, amount_max = 800000, amount_status = 'range',
              amount_confidence = 0.9, amount_text = '$795k–$800k'
        WHERE id = ?`,
    ).run(opp.id)
  }
  const amountsOf = (db, id) =>
    db.prepare('SELECT amount_min, amount_max, amount_text, amount_status FROM funding_opportunities WHERE id = ?').get(id)

  it('a re-crawl carrying NO amounts leaves the stored answer intact', async () => {
    const db = makeDb()
    const opp = osOpp({ id: 'os-w1', canonical_opportunity_key: 'ck-w1', info_url: 'https://example.org/grant-w1' })
    await seedAnswered(db, opp)
    await persistRun(db, makeMemStore({ catalog: [{ ...opp, amount_min: null, amount_max: null }] }), {})
    const row = amountsOf(db, 'os-w1')
    expect(row.amount_max, 'silence must never clear a learned figure').toBe(800000)
    expect(row.amount_min).toBe(795000)
    expect(row.amount_status).toBe('range')
    expect(row.amount_text).toBe('$795k–$800k')
  })

  it('a re-crawl that DID extract a real amount still updates', async () => {
    const db = makeDb()
    const opp = osOpp({ id: 'os-w2', canonical_opportunity_key: 'ck-w2', info_url: 'https://example.org/grant-w2' })
    await seedAnswered(db, opp)
    await persistRun(db, makeMemStore({ catalog: [{ ...opp, amount_min: 10000, amount_max: 50000 }] }), {})
    const row = amountsOf(db, 'os-w2')
    expect(row.amount_max).toBe(50000)
    expect(row.amount_min).toBe(10000)
  })

  it('an evidenced denial (none_published) survives a silent re-crawl', async () => {
    const db = makeDb()
    const opp = osOpp({ id: 'os-w3', canonical_opportunity_key: 'ck-w3', info_url: 'https://example.org/grant-w3' })
    await persistRun(db, makeMemStore({ catalog: [opp] }), {})
    db.prepare(`UPDATE funding_opportunities SET amount_status = 'none_published' WHERE id = 'os-w3'`).run()
    await persistRun(db, makeMemStore({ catalog: [{ ...opp, amount_min: null, amount_max: null }] }), {})
    expect(amountsOf(db, 'os-w3').amount_status, 'a read denial is a learned fact, not clearable by silence').toBe('none_published')
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

describe('crawler-os bridge — a row that names its own state is never written NATIONAL', () => {
  // WRITER side of the 2026-08-01 GeneMac defect. County/city locator rows are
  // minted per-place with the place ONLY in the title and no geography_json, so
  // they landed `state = NULL, is_national = 1` — telling the geo gate that a
  // Polk County TN resource directory is a nationwide program. 89 active rows in
  // prod were in this shape, feeding 373 match rows across 37 of 39 profiles.
  // The boot net is enforceDeclaredGeoScope(); this is the first line of defense
  // so the sweep converges instead of repairing the same rows every night.
  const geoOf = (db, id) =>
    db.prepare('SELECT state, is_national FROM funding_opportunities WHERE id = ?').get(id)

  function locator(overrides = {}) {
    return osOpp({
      id: 'os-geo-1',
      source_id: 'findhelp_local_programs',
      external_id: null,
      kind: 'DIRECTORY',
      canonical_opportunity_key: 'ck-geo-1',
      title: 'Polk County, TN — Local assistance programs near you (findhelp)',
      sponsor: 'findhelp (Aunt Bertha)',
      summary: 'Local assistance programs near you.',
      info_url: 'https://www.findhelp.org/search_results/37323',
      geography_json: '{}', // exactly what the lane emits: no geography at all
      ...overrides,
    })
  }

  it('writes the state the title declares, and drops the national flag', async () => {
    const db = makeDb()
    await persistRun(db, makeMemStore({ catalog: [locator()] }), {})
    expect(geoOf(db, 'os-geo-1')).toMatchObject({ state: 'TN', is_national: 0 })
  })

  it('leaves a genuinely national row national', async () => {
    const db = makeDb()
    await persistRun(db, makeMemStore({
      catalog: [locator({
        id: 'os-geo-natl',
        canonical_opportunity_key: 'ck-geo-natl',
        title: '211 - Local help with rent, utilities, food & emergencies',
        info_url: 'https://www.211.org',
        geography_json: '{"national":true}',
      })],
    }), {})
    expect(geoOf(db, 'os-geo-natl')).toMatchObject({ state: null, is_national: 1 })
  })

  it('never overrides a state the SOURCE supplied', async () => {
    const db = makeDb()
    await persistRun(db, makeMemStore({
      catalog: [locator({
        id: 'os-geo-src',
        canonical_opportunity_key: 'ck-geo-src',
        geography_json: '{"states":["GA"]}',
      })],
    }), {})
    expect(geoOf(db, 'os-geo-src')).toMatchObject({ state: 'GA' })
  })
})

/**
 * 2026-08-21 — PURE SEARCH PRODUCTS classify as directories; platforms that
 * also serve real award pages DO NOT.
 *
 * The owner's Application Tracker held "College Board BigFuture Scholarship
 * Search" and a WeMakeScholars row as LEAF APPLICATIONS. Those hosts have no
 * award of their own, so whole-host is the right claim.
 *
 * scholarships.com / bold.org / fastweb.com / goingmerry.com are DELIBERATELY
 * absent: they serve individual award pages that state a real fixed award, and
 * `locatorUrlKind.test.js` already pins that ("classifies scholarships.com
 * BROWSE-TREE category pages but never individual award pages"). Blanket-
 * classifying them would retire real awards — the starving-recall end of the
 * locator defect. Their category pages are caught by TITLE shape instead
 * (`fundingResultFilters.SEARCH_SURFACE_TITLE_RX` / `aggregatorBrandSurface`).
 */
describe('pure search products classify as directories; mixed platforms do not', () => {
  const pureSearchProducts = [
    'https://bigfuture.collegeboard.org/scholarship-search',
    'https://www.wemakescholars.com/other-scholarships-in-gender-studies-to-study-abroad',
    'https://www.careeronestop.org/toolkit/training/find-scholarships.aspx',
  ]
  it.each(pureSearchProducts)('classifies %s as a directory', (url) => {
    expect(classifyLocatorKindFromRow({ source_url: url, application_url: url })?.kind).toBe('directory')
  })

  // RECALL GUARD — an individual award page must stay unclaimed, on an
  // aggregator platform as much as on a funder's own site.
  const mustStayUnclaimed = [
    'https://www.scholarships.com/scholarship/the-example-memorial-scholarship/',
    'https://bold.org/scholarships/the-example-memorial-scholarship/',
    'https://www.mtsu.edu/financial-aid/scholarships.php',
    'https://afte.org/awards-scholarships/scholarship-program',
    'https://www.coca-colascholarsfoundation.org/apply/',
  ]
  it.each(mustStayUnclaimed)('leaves %s alone', (url) => {
    const verdict = classifyLocatorKindFromRow({ source_url: url, application_url: url })
    expect(verdict?.kind === 'directory').toBe(false)
  })
})
