/**
 * robertSourceAcquisition.test.js — Robert as an ACTIVE source-finder
 * (owner directive 2026-08-23).
 *
 * Exercises the REAL four gates (no engine mock — a gate that cannot fail proves
 * nothing) against a mixed fixture, and the two owner-named halves:
 *   - a real APPLICATION URL is auto-added to a QUALIFYING profile as apply_ready,
 *     and a NON-qualifying profile does NOT get it;
 *   - a grantmaker/info page that qualifies but is NOT structurally applyable is
 *     auto-added as a funder_lead — never apply_ready (the Hamilton cold-submit
 *     safety rule);
 *   - a ScholarshipOwl-style HUB is decomposed into the individual awards it
 *     lists (through the REAL canonical decomposer, fakes only at the LLM + DB
 *     insert boundaries), and those awards become the auto-add candidates;
 *   - a NEW profile is parsed against the catalog and gains its qualifiers.
 *
 * Same fixture conventions as pipelinePrecisionSweep.test.js.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'b'.repeat(64)

const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')
const { decomposeListing, listingHostSponsor, buildOpportunityRecord } = await import('../services/hamilton/listingDecomposition.js')
const { canonicalOpportunityKey } = await import('../crawler-os/contract.js')
const {
  acquireKnownSources,
  parseOpportunitiesAgainstProfiles,
  parseCatalogForProfiles,
  cleanupNonQualifyingAcquiredGrants,
  backfillDecomposedSponsors,
  runSourceAcquisitionCycle,
  parseNewProfileAgainstCatalog,
  qualifyForProfile,
  classifyPipelineCategory,
  structuralApplyable,
} = await import('../services/robert/robertSourceAcquisition.js')

const STUDENT = 'acq-student'
const BIZ = 'acq-business'

function makeDb() {
  const sqlite = new Database(':memory:')
  sqlite.dialect = 'sqlite'
  sqlite.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, display_name TEXT, applicant_type TEXT, primary_type TEXT,
      organization_id TEXT, status TEXT, tags TEXT, deleted_at DATETIME, created_at DATETIME
    );
    CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT);
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT, sponsor TEXT, description TEXT,
      eligibility_text TEXT, eligibility_bullets TEXT, entity_types_allowed TEXT,
      need_types_supported TEXT, categories TEXT, keywords TEXT,
      opportunity_kind TEXT, opportunity_type TEXT, funding_category TEXT,
      source TEXT, record_origin TEXT, source_url TEXT, application_url TEXT, apply_url TEXT,
      final_url TEXT, evidence_url TEXT, external_id TEXT, state TEXT,
      is_national INTEGER, deadline TEXT, deadline_type TEXT,
      amount_min REAL, amount_max REAL, amount_text TEXT, is_active INTEGER,
      link_status TEXT, canonical_opportunity_key TEXT, created_at DATETIME
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY, organization_id TEXT, profile_id TEXT, funding_opportunity_id TEXT,
      title TEXT, funder TEXT, status TEXT, notes TEXT, deadline TEXT,
      pipeline_category TEXT, funder_lead_state TEXT, matcher_version TEXT,
      application_url TEXT, url TEXT, source_url TEXT,
      amount_requested REAL, amount_min REAL, amount_max REAL, amount_awarded REAL,
      match_score REAL, match_decision TEXT, updated_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE profile_opportunity_matches (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      profile_id TEXT NOT NULL,
      opportunity_id TEXT NOT NULL,
      match_score REAL,
      match_confidence REAL,
      match_decision TEXT,
      match_explanation TEXT,
      match_reasons TEXT,
      match_explain_json TEXT,
      matcher_version TEXT,
      computed_at DATETIME,
      updated_at DATETIME,
      evaluated_at DATETIME,
      UNIQUE (profile_id, opportunity_id)
    );
    CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME);
  `)
  const p = sqlite.prepare('INSERT INTO profiles (id, display_name, primary_type, status, tags) VALUES (?, ?, ?, ?, ?)')
  p.run(STUDENT, 'Acq Student', 'college_student', 'active', '[]')
  p.run(BIZ, 'Acq Business', 'small_business', 'active', '[]')
  const sec = sqlite.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
  sec.run(STUDENT, 'basic_information', JSON.stringify({ city: 'Murfreesboro', state: 'TN', profile_category: 'college_student' }))
  sec.run(STUDENT, 'education', JSON.stringify({ current_institution: 'Middle Tennessee State University', highest_level: 'College Student - Currently in undergraduate program' }))
  sec.run(STUDENT, 'financial_information', JSON.stringify({ needs: ['education'] }))
  sec.run(BIZ, 'basic_information', JSON.stringify({ city: 'Nashville', state: 'TN', profile_category: 'small_business' }))
  sec.run(BIZ, 'financial_information', JSON.stringify({ needs: ['business'] }))
  return { sqlite, db: wrapSqlite(sqlite) }
}

function insertOpp(sqlite, o) {
  sqlite.prepare(`INSERT INTO funding_opportunities
    (id, title, sponsor, entity_types_allowed, need_types_supported, categories,
     opportunity_kind, source, record_origin, source_url, application_url, is_active, created_at)
    VALUES (@id, @title, @sponsor, @ent, @needs, @cats, @kind, @source, @origin, @url, @apply, 1, @created)`)
    .run({
      id: o.id, title: o.title, sponsor: o.sponsor,
      ent: JSON.stringify(o.ent ?? []), needs: JSON.stringify(o.needs ?? []), cats: JSON.stringify(o.cats ?? []),
      kind: o.kind ?? 'scholarship', source: o.source ?? 'curated_verified', origin: o.origin ?? 'curated_verified',
      url: o.url, apply: o.apply ?? o.url, created: o.created ?? '2026-08-23T00:00:00Z',
    })
}

const grantsFor = (sqlite, pid) => sqlite.prepare('SELECT * FROM grants WHERE profile_id = ? ORDER BY id').all(pid)

// A student scholarship with a real APPLICATION path → apply-ready for the student.
const SCHOLARSHIP = {
  id: 'fo-schol', title: 'MTSU Guaranteed Scholarship', sponsor: 'Middle Tennessee State University',
  ent: ['student'], needs: ['education'], cats: ['education'], url: 'https://mtsu.edu/scholarships/apply',
}
// A real award a student qualifies for whose application is an ACCOUNT PORTAL
// (studentaid.gov — the person must sign in). #2's classifyApplyability rules it
// account_portal → NOT applyable → funder_lead, never apply-ready (the Hamilton
// cold-submit safety rule), even though its URL path contains "apply".
const ACCOUNT_PORTAL_AWARD = {
  id: 'fo-portal', title: 'Federal Student Aid — Grant (account sign-in required)', sponsor: 'Federal Student Aid',
  ent: ['student'], needs: ['education'], cats: ['education'], kind: 'grant',
  url: 'https://studentaid.gov/apply-for-aid/fafsa',
}

describe('robertSourceAcquisition — parse added sources against profiles + auto-add', () => {
  let sqlite, db
  beforeEach(() => { ({ sqlite, db } = makeDb()) })

  it('auto-adds a real application URL to the QUALIFYING profile as apply_ready, and NOT to a non-qualifying one', async () => {
    insertOpp(sqlite, SCHOLARSHIP)
    const out = await parseOpportunitiesAgainstProfiles(db, { opportunityIds: [SCHOLARSHIP.id] })

    const studentGrants = grantsFor(sqlite, STUDENT)
    const bizGrants = grantsFor(sqlite, BIZ)

    // Qualifying student gets it, apply-ready, under Robert's matcher version.
    expect(studentGrants).toHaveLength(1)
    expect(studentGrants[0].pipeline_category).toBe('apply_ready')
    expect(studentGrants[0].funder_lead_state).toBeNull()
    expect(studentGrants[0].matcher_version).toBe('robert-source-acquisition')
    expect(studentGrants[0].status).toBe('saved')

    // NON-qualifying business profile does NOT get a student-only scholarship.
    // (This is the assertion that fails if the QUALIFIES gate is bypassed.)
    expect(bizGrants).toHaveLength(0)

    expect(out.added).toBe(1)
    expect(out.addedLeads).toBe(0)
    // The business pair was scanned and rejected on qualification, not silently.
    expect(Object.keys(out.byReason).length).toBeGreaterThan(0)
  })

  it('keeps a qualifying-but-not-applyable account portal catalog-only (never apply_ready)', async () => {
    insertOpp(sqlite, ACCOUNT_PORTAL_AWARD)
    const out = await parseOpportunitiesAgainstProfiles(db, { opportunityIds: [ACCOUNT_PORTAL_AWARD.id] })

    // An account portal is discovery evidence, not a leaf application. It stays
    // in the catalog until decomposition finds a real application surface.
    expect(grantsFor(sqlite, STUDENT)).toHaveLength(0)
    expect(out.catalogLeads).toBe(1)
    expect(out.addedLeads).toBe(0)
    expect(out.added).toBe(0)

    // The business (need mismatch: business_funding) does not get it.
    expect(grantsFor(sqlite, BIZ)).toHaveLength(0)
  })

  it('is idempotent — a source already on the profile is skipped, not duplicated', async () => {
    insertOpp(sqlite, SCHOLARSHIP)
    await parseOpportunitiesAgainstProfiles(db, { opportunityIds: [SCHOLARSHIP.id] })
    const second = await parseOpportunitiesAgainstProfiles(db, { opportunityIds: [SCHOLARSHIP.id] })
    expect(second.added).toBe(0)
    expect(second.skippedExisting).toBeGreaterThanOrEqual(1)
    expect(grantsFor(sqlite, STUDENT)).toHaveLength(1)
  })

  it('a new profile is parsed against the catalog and gains its qualifiers', async () => {
    insertOpp(sqlite, SCHOLARSHIP)
    // parseNewProfileAgainstCatalog scopes to ONE profile and scans recent catalog.
    const out = await parseNewProfileAgainstCatalog(db, STUDENT)
    expect(out.parse.added + out.parse.addedLeads).toBeGreaterThanOrEqual(1)
    const studentGrants = grantsFor(sqlite, STUDENT)
    expect(studentGrants.map((g) => g.funding_opportunity_id)).toContain(SCHOLARSHIP.id)
    // Bounded to THIS profile — the business profile is untouched.
    expect(grantsFor(sqlite, BIZ)).toHaveLength(0)
  })

  it('parseCatalogForProfiles auto-adds a qualifying EXISTING catalog row (LLM-independent) and EXCLUDES 990/directory churn from the window', async () => {
    // A real small-business grant already sitting in the catalog — no acquisition,
    // no hub decomposition, no LLM. This is the path that surfaces buried real
    // sources (e.g. small-business grants for Olivia) to existing profiles.
    insertOpp(sqlite, {
      id: 'fo-sbg', title: 'Nashville Small Business Growth Grant', sponsor: 'Metro Nashville',
      ent: ['small_business'], needs: ['business'], cats: ['business'], kind: 'grant',
      url: 'https://nashville.gov/programs/small-business-grant/apply',
    })
    // NEWER ProPublica 990 directory rows (the churn that dominates "newest N").
    // The candidate window must EXCLUDE these so the real grant is still in scope;
    // otherwise a small per-profile slice fills with un-addable directories.
    for (let i = 0; i < 30; i += 1) {
      insertOpp(sqlite, {
        id: `fo-990-${i}`, title: `Some Foundation ${i}`, sponsor: `Foundation ${i}`,
        ent: ['nonprofit'], needs: [], cats: [], kind: 'directory', source: 'propublica_990', origin: 'live_crawl',
        url: `https://projects.propublica.org/nonprofits/organizations/${i}`, created: '2026-08-23T12:00:00Z',
      })
    }
    // Tiny window: if the 990 rows were NOT excluded they'd crowd out the grant.
    const out = await parseCatalogForProfiles(db, { catalogLimitPerProfile: 5 })
    expect(out.added).toBe(1)
    const biz = grantsFor(sqlite, BIZ)
    expect(biz).toHaveLength(1)
    expect(biz[0].pipeline_category).toBe('apply_ready')
    expect(grantsFor(sqlite, STUDENT)).toHaveLength(0)
  })

  it('runSourceAcquisitionCycle persists a read-back summary to system_kv', async () => {
    // Scope to a non-existent profile so no network/ingest happens; we only assert
    // the fire-and-forget run leaves an observable summary.
    await runSourceAcquisitionCycle(db, { profileIds: ['no-such-profile'], allowHubDecomposition: false })
    const row = sqlite.prepare("SELECT value FROM system_kv WHERE key = 'robert_source_acquisition_last_run'").get()
    expect(row).toBeTruthy()
    const summary = JSON.parse(row.value)
    expect(summary).toHaveProperty('at')
    expect(summary).toHaveProperty('catalogParse')
    expect(summary).toHaveProperty('acquisition')
  })

  it('does NOT auto-add a source with no DECLARED-need overlap (positive-need admission bar)', async () => {
    // A real, student-eligible award that states NO need vocabulary (the shape of
    // the job-postings / generic rows that flooded Olivia). It qualifies on
    // type+geo, but auto-add requires a POSITIVE declared-need match.
    insertOpp(sqlite, {
      id: 'fo-noneed', title: 'Generic Student Opportunity', sponsor: 'Someone',
      ent: ['student'], needs: [], cats: [], kind: 'scholarship',
      url: 'https://example-generic.org/opportunity/apply',
    })
    const out = await parseOpportunitiesAgainstProfiles(db, { opportunityIds: ['fo-noneed'] })
    expect(out.added).toBe(0)
    expect(out.addedLeads).toBe(0)
    expect(grantsFor(sqlite, STUDENT)).toHaveLength(0)
    expect(out.byReason['covers_need:no_positive_declared_match']).toBeGreaterThan(0)
  })

  it('cleanupNonQualifyingAcquiredGrants removes a no-longer-qualifying acquired row, keeps a qualifier, and never touches a protected (submitted) row', async () => {
    insertOpp(sqlite, SCHOLARSHIP) // education — matches the student
    insertOpp(sqlite, { id: 'fo-noneed2', title: 'Generic', sponsor: 'X', ent: ['student'], needs: [], cats: [], kind: 'scholarship', url: 'https://example-generic.org/x/apply' })
    const ins = sqlite.prepare(`INSERT INTO grants (id, profile_id, funding_opportunity_id, title, funder, status, matcher_version) VALUES (?, ?, ?, ?, ?, ?, 'robert-source-acquisition')`)
    ins.run('g-keep', STUDENT, SCHOLARSHIP.id, SCHOLARSHIP.title, SCHOLARSHIP.sponsor, 'saved')       // qualifies → kept
    ins.run('g-drop', STUDENT, 'fo-noneed2', 'Generic', 'X', 'saved')                                  // no need overlap → removed
    ins.run('g-protected', STUDENT, 'fo-noneed2', 'Generic', 'X', 'submitted')                         // protected → untouched

    const out = await cleanupNonQualifyingAcquiredGrants(db)
    expect(out.removed).toBe(1)
    expect(out.protected).toBe(1)
    const ids = grantsFor(sqlite, STUDENT).map((g) => g.id).sort()
    expect(ids).toEqual(['g-keep', 'g-protected'])
  })

  it('count-only mode adjudicates without writing', async () => {
    insertOpp(sqlite, SCHOLARSHIP)
    const out = await parseOpportunitiesAgainstProfiles(db, { opportunityIds: [SCHOLARSHIP.id], countOnly: true })
    expect(out.wouldAdd).toBeGreaterThanOrEqual(1)
    expect(out.added).toBe(0)
    expect(grantsFor(sqlite, STUDENT)).toHaveLength(0)
  })
})

describe('robertSourceAcquisition — hub decomposition into individual awards', () => {
  let sqlite, db
  beforeEach(() => { ({ sqlite, db } = makeDb()) })

  it('decomposes a ScholarshipOwl-style hub into the individual awards it lists (through the REAL canonical decomposer)', async () => {
    // Fake ONLY the true I/O boundaries the real decomposer touches: the LLM
    // enumerator and the DB inserter. The real decomposeListing wiring runs.
    const enumerate = async () => ({
      items: [
        { title: 'STEM Excellence Scholarship', sponsor: 'ScholarshipOwl Partner', applyUrl: 'https://scholarshipowl.com/awards/stem-excellence/apply', amount: 5000, evidence: 'STEM Excellence Scholarship' },
        { title: 'First-Gen Leaders Award', sponsor: 'ScholarshipOwl Partner', applyUrl: 'https://scholarshipowl.com/awards/first-gen/apply', amount: 2500, evidence: 'First-Gen Leaders Award' },
      ],
      rejected: [], notFound: [], raw: { attempted: true },
    })
    let nextId = 0
    const insert = async (_db, record) => {
      const id = `hub-award-${nextId += 1}`
      insertOpp(sqlite, {
        id, title: record.title, sponsor: record.sponsor, ent: ['student'], needs: ['education'],
        cats: ['education'], kind: 'scholarship', origin: 'scholarship_crawler', source: 'scholarship_crawler',
        url: record.application_url || record.source_url,
      })
      return { id, inserted: true }
    }
    // Wire my acquisition to a hub seed + a live-ish fetch + the REAL decomposer.
    const deps = {
      knownSeedSourcesForProfile: () => ([{ title: 'ScholarshipOwl', url: 'https://scholarshipowl.com/scholarships', shape: 'hub', applicant_types: ['student'], need_categories: ['education'] }]),
      fetchPage: async () => ({ text: 'STEM Excellence Scholarship. First-Gen Leaders Award.', links: ['https://scholarshipowl.com/awards/stem-excellence/apply'], title: 'ScholarshipOwl' }),
      decomposeListing: (args) => decomposeListing(args, { enumerate, insert }),
    }
    const acq = await acquireKnownSources(db, { profileIds: [STUDENT], deps, allowHubDecomposition: true })

    expect(acq.hubsDecomposed).toBe(1)
    expect(acq.decomposedAdmitted).toBe(2)
    expect(acq.admittedOpportunityIds).toHaveLength(2)

    // And the admitted awards auto-add to the qualifying student.
    const parse = await parseOpportunitiesAgainstProfiles(db, { opportunityIds: acq.admittedOpportunityIds, profileIds: [STUDENT] })
    expect(parse.added).toBe(2)
    const titles = grantsFor(sqlite, STUDENT).map((g) => g.title).sort()
    expect(titles).toEqual(['First-Gen Leaders Award', 'STEM Excellence Scholarship'])
  })

  it('honestly reports a hub as unavailable when no fetcher is wired (never crashes the cadence)', async () => {
    const deps = { knownSeedSourcesForProfile: () => ([{ title: 'Hub', url: 'https://example-hub.org/list', shape: 'hub' }]) }
    const acq = await acquireKnownSources(db, { profileIds: [STUDENT], deps, allowHubDecomposition: true })
    expect(acq.hubsSkipped).toBe(1)
    expect(acq.decomposedAdmitted).toBe(0)
    expect(acq.byReason.hub_fetch_unavailable).toBe(1)
  })
})

describe('backfillDecomposedSponsors — dedup-safe sponsor attachment', () => {
  let sqlite, db
  beforeEach(() => { ({ sqlite, db } = makeDb()) })

  // Insert a prior decomposed award minted with a NULL sponsor and a key that
  // (correctly, for a null sponsor) has no sponsor component.
  function insertNullSponsor(id, title, url) {
    sqlite.prepare(`INSERT INTO funding_opportunities (id, title, sponsor, source, record_origin, source_url, application_url, canonical_opportunity_key, is_active, created_at)
      VALUES (?, ?, NULL, 'scholarship_crawler', 'scholarship_crawler', ?, ?, ?, 1, '2026-08-23T00:00:00Z')`)
      .run(id, title, url, url, canonicalOpportunityKey({ title, sponsor: null, apply_url: url, info_url: url }))
  }

  it('attaches the hub host sponsor and re-keys so re-enumeration dedupes (no duplicate)', async () => {
    insertNullSponsor('a1', 'Bright Lite Scholarship', 'https://bold.org/scholarships/bright-lite-scholarship/')
    const before = sqlite.prepare('SELECT sponsor, canonical_opportunity_key FROM funding_opportunities WHERE id=?').get('a1')
    expect(before.sponsor).toBeNull()

    const out = await backfillDecomposedSponsors(db)
    expect(out.updated).toBe(1)
    expect(out.rekeyed).toBe(1)

    const after = sqlite.prepare('SELECT sponsor, canonical_opportunity_key FROM funding_opportunities WHERE id=?').get('a1')
    expect(after.sponsor).toBe('Bold.org') // curated hub display, a REAL host
    // The re-keyed value MUST equal what a fresh enumeration of the same award
    // (now minted WITH the host sponsor) will compute — that is the dedup-safety.
    const rec = buildOpportunityRecord({ title: 'Bright Lite Scholarship', applyUrl: 'https://bold.org/scholarships/bright-lite-scholarship/' }, { listingUrl: 'https://bold.org/scholarships/category/x' })
    const reenumKey = canonicalOpportunityKey({ title: rec.title, sponsor: rec.sponsor, apply_url: rec.application_url, info_url: rec.source_url })
    expect(after.canonical_opportunity_key).toBe(reenumKey)
  })

  it('is idempotent — a row that already has a sponsor is never touched', async () => {
    insertNullSponsor('b1', 'Some Award', 'https://scholarshipowl.com/x/apply')
    await backfillDecomposedSponsors(db)
    const first = sqlite.prepare('SELECT sponsor, canonical_opportunity_key FROM funding_opportunities WHERE id=?').get('b1')
    const out2 = await backfillDecomposedSponsors(db)
    expect(out2.scanned).toBe(0) // no null-sponsor rows remain
    const second = sqlite.prepare('SELECT sponsor, canonical_opportunity_key FROM funding_opportunities WHERE id=?').get('b1')
    expect(second).toEqual(first)
  })

  it('on a key collision, sets the sponsor for display but leaves the key (unique index holds)', async () => {
    // A canonical twin already holds the re-keyed value.
    const title = 'Twin Award'
    const url = 'https://fastweb.com/scholarships/twin/'
    const twinKey = canonicalOpportunityKey({ title, sponsor: 'Fastweb', apply_url: url, info_url: url })
    sqlite.prepare(`INSERT INTO funding_opportunities (id, title, sponsor, source, record_origin, source_url, application_url, canonical_opportunity_key, is_active, created_at)
      VALUES ('twin', ?, 'Fastweb', 'scholarship_crawler', 'scholarship_crawler', ?, ?, ?, 1, '2026-08-22T00:00:00Z')`).run(title, url, url, twinKey)
    insertNullSponsor('c1', title, url) // same title/url, null sponsor, old key

    const out = await backfillDecomposedSponsors(db)
    expect(out.collisions).toBe(1)
    const row = sqlite.prepare('SELECT sponsor, canonical_opportunity_key FROM funding_opportunities WHERE id=?').get('c1')
    expect(row.sponsor).toBe('Fastweb')          // display improved
    expect(row.canonical_opportunity_key).not.toBe(twinKey) // key untouched, no unique violation
  })

  it('leaves a row whose URL yields no host untouched (never fabricates)', async () => {
    sqlite.prepare(`INSERT INTO funding_opportunities (id, title, sponsor, source, record_origin, source_url, application_url, canonical_opportunity_key, is_active, created_at)
      VALUES ('d1', 'No Host Award', NULL, 'scholarship_crawler', 'scholarship_crawler', 'not a url', NULL, 't:award host no', 1, '2026-08-23T00:00:00Z')`).run()
    const out = await backfillDecomposedSponsors(db)
    expect(out.noHost).toBe(1)
    expect(out.updated).toBe(0)
    const row = sqlite.prepare('SELECT sponsor FROM funding_opportunities WHERE id=?').get('d1')
    expect(row.sponsor).toBeNull()
  })
})

describe('robertSourceAcquisition — unit gates', () => {
  it('qualifyForProfile marks a hub/pointer as harvest_first (never auto-added whole)', () => {
    const facts = { applicantType: 'college_student', states: ['TN'], needs: new Set(['education']), profile: {}, sections: {} }
    const hub = { title: 'College Board BigFuture Scholarship Search', sponsor: 'College Board', opportunity_kind: 'directory', application_url: 'https://bigfuture.collegeboard.org/scholarship-search', source_url: 'https://bigfuture.collegeboard.org/scholarship-search' }
    const v = qualifyForProfile(hub, facts)
    expect(v.pass).toBe(false)
    expect(v.harvest_first).toBe(true)
  })

  it('structuralApplyable: an application path is apply-ready; a bare hub homepage is not', () => {
    expect(structuralApplyable({ application_url: 'https://x.org/scholarship/apply' })).toBe(true)
    expect(structuralApplyable({ application_url: 'https://x.org/' })).toBe(false)
    // A decomposed listing award (scholarship_crawler) with any usable link is apply-ready.
    expect(structuralApplyable({ record_origin: 'scholarship_crawler', application_url: 'https://x.org/awards/123' })).toBe(true)
  })

  it('classifyPipelineCategory prefers #2 classifyApplyability when present', async () => {
    const applyReady = await classifyPipelineCategory({ application_url: 'https://x.org/' }, { deps: { classifyApplyability: () => ({ apply_ready: true }) } })
    expect(applyReady).toBe('apply_ready')
    const lead = await classifyPipelineCategory({ application_url: 'https://x.org/scholarship/apply' }, { deps: { classifyApplyability: () => ({ apply_ready: false }) } })
    expect(lead).toBe('funder_lead')
  })
})
