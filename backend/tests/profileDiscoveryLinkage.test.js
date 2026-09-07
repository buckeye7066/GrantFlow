/**
 * A catalog row that RECORDS the profile it was discovered for must reach that
 * profile — the rolling-snapshot erasure, fleet-wide edition.
 *
 * Every fixture below is a REAL prod row or profile field, read read-only on
 * 2026-08-01:
 *   • `funding_opportunities.profile_id` is populated on 174 active rows
 *     (61 `web_search`, 113 `school_portal`). It names the profile the row was
 *     discovered FOR — the only per-row discovery provenance that survives the
 *     crawler-os reconcile. 169 of those 174 carry NO match row for their own
 *     profile.
 *   • Robert Michael White (Cleveland, TN) has 8 such rows — "Grants - Bradley
 *     County Schools", "Family Promise of Bradley County", "BRADLEY CLEVELAND
 *     PUBLIC EDUCATION FOUNDATION" — none of which he can see.
 *   • 107 of the 113 `school_portal` rows were minted from ONE student's
 *     nineteen `education.target_colleges` (Harvard, Oberlin, Penn State …).
 *     Linking on provenance alone would re-admit, through a different door,
 *     exactly the aspiration set #1089 excluded.
 *
 * The engine was never the drop point: replaying the real
 * `computeMatchDecision` over the exact shipped gate in prod returns
 * 20 ACCEPT / 34 REVIEW / 7 REJECT on the 61 scored pairs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  PROFILE_INSTITUTION_FIELDS,
  MAX_ASPIRATIONAL_INSTITUTIONS,
  resolveAspirationalInstitutions,
  resolveAttendedInstitutions,
} from '../config/profileInstitutions.js'
import { SURFACED_MATCHER_VERSIONS } from '../config/matchSurfacing.js'
import { enforceProfileDiscoveredCatalogLinkage } from '../startup/enforceInvariants.js'

const LINK_VERSION = 'profile-discovery-link'

/** Robert Michael White's real shape (Cleveland, TN; Lee University committed). */
const ROBERT = {
  basic_information: {
    first_name: 'Robert',
    location: { city: 'Cleveland', state: 'TN', county: 'Bradley', zip_code: '37312' },
  },
  education: {
    current_institution: 'Cleveland State Community College',
    target_colleges: ['Lee University', 'University of Tennessee Chattanooga'],
    pell_grant_eligible: true,
  },
  financial: { funding_needs: ['education', 'housing'] },
}

/** Demo Tennessee STEM Student's real shape: NINETEEN target colleges, one attended school. */
const demo_stem_student = {
  basic_information: {
    first_name: 'Demo Student',
    location: { city: 'Cleveland', state: 'TN', county: 'Bradley County', zip_code: '37312' },
  },
  education: {
    current_institution: 'Middle Tennessee State University',
    target_colleges: [
      'Middle Tennessee State University', 'University of Central Florida', 'University of New Haven',
      'Penn State University', 'Trevecca Nazarene University', 'Austin Peay State University',
      'Carson-Newman', 'Centre College', 'Christian Brothers University', 'Oberlin College',
      'Seton Hall University', 'Ohio State University', 'University of Alabama',
      'University of Tennessee Chattanooga', 'University of Tennessee Knoxville',
      'University of Michigan', 'Florida International University', 'Harvard University',
      'Lee University',
    ],
    pell_grant_eligible: true,
  },
  financial: { funding_needs: ['education'] },
}

// ── Real prod catalog rows (profile_id is the row's own recorded provenance) ──
const BRADLEY_SCHOOLS = {
  id: 'row-bradley-county-schools',
  title: 'Grants - Bradley County Schools',
  sponsor: 'Bradley County Schools',
  state: 'TN', is_national: 0, opportunity_kind: 'benefit', source: 'web_search',
  source_url: 'https://www.bradleyschools.org/grants',
  application_url: 'https://www.bradleyschools.org/grants',
  is_active: 1, profile_id: 'p-robert',
}
const FAMILY_PROMISE = {
  id: 'row-family-promise-bradley',
  title: 'Family Promise of Bradley County| Cleveland TN Nonprofit | Cleveland, TN, USA',
  sponsor: 'Family Promise of Bradley County',
  state: 'TN', is_national: 0, opportunity_kind: 'benefit', source: 'web_search',
  source_url: 'https://familypromisebradley.org/',
  application_url: 'https://familypromisebradley.org/',
  is_active: 1, profile_id: 'p-robert',
}
/** The aspiration flood: a target-college locator carrying the student's id. */
const HARVARD_AID = {
  id: 'row-harvard-financial-aid',
  title: 'Harvard University — Financial Aid',
  sponsor: 'Harvard University',
  state: 'nationwide', is_national: 1, opportunity_kind: 'directory', source: 'school_portal',
  source_url: 'https://college.harvard.edu/financial-aid',
  application_url: 'https://college.harvard.edu/financial-aid',
  is_active: 1, profile_id: 'p-demo_stem_student',
}
/** The ATTENDED school's twin of the same shape — must still be linked. */
const MTSU_AID = {
  id: 'row-mtsu-financial-aid',
  title: 'Middle Tennessee State University — Institutional Scholarships & Grants',
  sponsor: 'Middle Tennessee State University',
  state: 'nationwide', is_national: 1, opportunity_kind: 'directory', source: 'school_portal',
  source_url: 'https://www.mtsu.edu/financial-aid/',
  application_url: 'https://www.mtsu.edu/financial-aid/',
  is_active: 1, profile_id: 'p-demo_stem_student',
}
/**
 * The real prod row behind the 2026-09-06 report: an OTHER school's aid portal
 * that reached a Tennessee student because a crawl run for her returned it.
 * bradley.edu is Bradley University in Peoria, ILLINOIS — the page is a
 * transfer scholarship for Illinois Central College students — and the
 * crawl-stamped `state` reads 'TN', so geography cannot catch it.
 */
const BRADLEY_UNIVERSITY_PORTAL = {
  id: 'row-bradley-university-portal',
  title: 'Scholarships & Grants - Bradley University',
  sponsor: 'bradley.edu',
  state: 'TN', is_national: 0, opportunity_kind: 'school_portal', source: 'web_search',
  source_url: 'https://www.bradley.edu/admissions/cost/scholarships/',
  application_url: 'https://www.bradley.edu/admissions/cost/scholarships/',
  is_active: 1, profile_id: 'p-demo_stem_student',
}
/** The same SHAPE for a school the student's own profile names. */
const MTSU_PORTAL = {
  id: 'row-mtsu-portal',
  title: 'Middle Tennessee State University — Scholarships',
  sponsor: 'Middle Tennessee State University',
  state: 'TN', is_national: 0, opportunity_kind: 'school_portal', source: 'web_search',
  source_url: 'https://www.mtsu.edu/financial-aid/scholarships.php',
  application_url: 'https://www.mtsu.edu/financial-aid/scholarships.php',
  is_active: 1, profile_id: 'p-demo_stem_student',
}

/** Provenance naming a profile that no longer exists (3 such rows in prod). */
const ORPHANED = {
  id: 'row-orphan-provenance',
  title: 'Scholarship Opportunities - CFOV',
  sponsor: 'Community Foundation of the Ocoee Region',
  state: 'TN', is_national: 0, opportunity_kind: 'benefit', source: 'web_search',
  source_url: 'https://cfocoee.org/scholarships',
  application_url: 'https://cfocoee.org/scholarships',
  is_active: 1, profile_id: 'p-deleted-long-ago',
}
/** No provenance at all: the 7,555 web_search rows we deliberately cannot link. */
const NO_PROVENANCE = {
  id: 'row-no-provenance',
  title: 'Disability Employment and Vocational Rehabilitation Grants',
  sponsor: 'Department of Education',
  state: null, is_national: 1, opportunity_kind: 'directory', source: 'web_search',
  source_url: 'https://www.ed.gov/grants-and-programs',
  application_url: 'https://www.ed.gov/grants-and-programs',
  is_active: 1, profile_id: null,
}

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, organization_id TEXT, display_name TEXT,
      primary_type TEXT, applicant_type TEXT, status TEXT, deleted_at DATETIME,
      state TEXT, city TEXT, postal_code TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE profile_sections (
      profile_id TEXT, section_key TEXT, data TEXT,
      PRIMARY KEY (profile_id, section_key)
    );
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT, sponsor TEXT, description TEXT,
      state TEXT, is_national INTEGER, opportunity_kind TEXT, source TEXT,
      source_url TEXT, application_url TEXT, amount_min NUMERIC, amount_max NUMERIC,
      eligibility_text TEXT, entity_types_allowed TEXT, need_types_supported TEXT,
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
  `)
  return db
}

function addProfile(db, id, sections, extra = {}) {
  db.prepare(
    `INSERT INTO profiles (id, display_name, primary_type, applicant_type, status, state, city, postal_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    extra.display_name ?? id,
    extra.primary_type ?? 'college_student',
    extra.applicant_type ?? 'individual',
    extra.status ?? 'active',
    extra.state ?? sections.basic_information?.location?.state ?? null,
    extra.city ?? sections.basic_information?.location?.city ?? null,
    extra.zip ?? sections.basic_information?.location?.zip_code ?? null,
  )
  for (const [key, data] of Object.entries(sections)) {
    db.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
      .run(id, key, JSON.stringify(data))
  }
}

function addOpp(db, o) {
  db.prepare(
    `INSERT INTO funding_opportunities
       (id, title, sponsor, state, is_national, opportunity_kind, source, source_url,
        application_url, is_active, profile_id)
     VALUES (@id, @title, @sponsor, @state, @is_national, @opportunity_kind, @source,
             @source_url, @application_url, @is_active, @profile_id)`,
  ).run(o)
}

const linkRows = (db, profileId) =>
  db.prepare(
    `SELECT * FROM profile_opportunity_matches
      WHERE profile_id = ? AND matcher_version = ?`,
  ).all(profileId, LINK_VERSION)

// The invariant runner takes the better-sqlite3 handle directly; `prepare(...)`
// returns the same {get,all,run} shape enforceInvariants expects.
const wrap = (db) => ({ dialect: 'sqlite', prepare: (sql) => db.prepare(sql) })

let ENV_SNAPSHOT
beforeEach(() => { ENV_SNAPSHOT = { ...process.env } })
afterEach(() => { process.env = ENV_SNAPSHOT })

// ─────────────────────────────────────────────────────────────────────────────
describe('the ASPIRATION guard (the second door onto the #1089 defect)', () => {
  it('reads every ASPIRATION field in the registry (totality)', () => {
    const aspiration = PROFILE_INSTITUTION_FIELDS.filter((f) => f.kind === 'aspiration')
    expect(aspiration.length).toBeGreaterThan(0)
    const shapes = {
      'university_applications.applications[*].name': {
        university_applications: { applications: [{ name: 'Aurora Institution X', status: 'submitted' }] },
      },
      'education.target_colleges': { education: { target_colleges: ['Aurora Institution X'] } },
    }
    for (const field of aspiration) {
      expect(Object.keys(shapes)).toContain(field.id)
      expect(resolveAspirationalInstitutions(shapes[field.id])).toContain('Aurora Institution X')
    }
  })

  it('never truncates the refusal set below a real profile\'s target list', () => {
    // Demo Student lists NINETEEN. A cap of 3 (the ATTENDANCE cap) would let 16 of
    // them through the guard they exist to trip.
    expect(MAX_ASPIRATIONAL_INSTITUTIONS).toBeGreaterThanOrEqual(19)
    expect(resolveAspirationalInstitutions(demo_stem_student)).toHaveLength(19)
    expect(resolveAspirationalInstitutions(demo_stem_student)).toContain('Harvard University')
  })

  it('keeps ATTENDANCE and ASPIRATION disjoint in what they authorize', () => {
    expect(resolveAttendedInstitutions(demo_stem_student)).toEqual(['Middle Tennessee State University'])
    expect(resolveAspirationalInstitutions({ education: { current_institution: 'Only Attended U' } })).toEqual([])
  })
})

describe('enforceProfileDiscoveredCatalogLinkage', () => {
  let db
  beforeEach(() => {
    db = makeDb()
    addProfile(db, 'p-robert', ROBERT, { display_name: 'Robert Michael White' })
    addProfile(db, 'p-demo_stem_student', demo_stem_student, { display_name: 'Demo Tennessee STEM Student' })
  })

  it('links a row to the profile its OWN provenance names', async () => {
    addOpp(db, BRADLEY_SCHOOLS)
    addOpp(db, FAMILY_PROMISE)
    const res = await enforceProfileDiscoveredCatalogLinkage(wrap(db))
    expect(res.enforced).toBe(true)
    const rows = linkRows(db, 'p-robert')
    expect(rows.map((r) => r.opportunity_id).sort())
      .toEqual([BRADLEY_SCHOOLS.id, FAMILY_PROMISE.id].sort())
    // Provenance is recorded on the row, not inferred.
    expect(rows[0].discovered_via).toBe('profile_discovery_provenance')
    expect(JSON.parse(rows[0].match_explain_json).gate).toBe('recorded_discovery_provenance')
    expect(Number(rows[0].match_score)).toBeGreaterThan(0)
    expect(['accept', 'review']).toContain(String(rows[0].match_decision))
  })

  it('REFUSES a target-college row and still links the ATTENDED school\'s twin', async () => {
    addOpp(db, HARVARD_AID)
    addOpp(db, MTSU_AID)
    const res = await enforceProfileDiscoveredCatalogLinkage(wrap(db))
    const ids = linkRows(db, 'p-demo_stem_student').map((r) => r.opportunity_id)
    expect(ids).not.toContain(HARVARD_AID.id)
    expect(ids).toContain(MTSU_AID.id)
    expect(res.aspirationRefused).toBe(1)
  })

  it('REFUSES a school portal the profile does not NAME, and keeps the one it does', async () => {
    // A school's own aid portal is institution-scoped: only a student connected
    // to that school can use it. Provenance is only "a crawl for this profile
    // returned this page", and geography cannot help — the Peoria row's
    // crawl-stamped state reads 'TN'.
    addOpp(db, BRADLEY_UNIVERSITY_PORTAL)
    addOpp(db, MTSU_PORTAL)
    const res = await enforceProfileDiscoveredCatalogLinkage(wrap(db))
    const ids = linkRows(db, 'p-demo_stem_student').map((r) => r.opportunity_id)
    expect(ids).not.toContain(BRADLEY_UNIVERSITY_PORTAL.id)
    expect(ids).toContain(MTSU_PORTAL.id)
    expect(res.institutionUnconnectedRefused).toBe(1)
  })

  it('composes with the ASPIRATION rule rather than double-counting it', async () => {
    // Harvard is on this student's target-college list, so the OLDER aspiration
    // guard refuses its portal before the institution rule is reached. The two
    // rules therefore never both fire on one row, and the counters stay honest.
    addOpp(db, {
      ...BRADLEY_UNIVERSITY_PORTAL,
      id: 'row-harvard-portal',
      title: 'Harvard University — Financial Aid',
      sponsor: 'Harvard University',
      source_url: 'https://college.harvard.edu/financial-aid',
      application_url: 'https://college.harvard.edu/financial-aid',
    })
    const res = await enforceProfileDiscoveredCatalogLinkage(wrap(db))
    expect(linkRows(db, 'p-demo_stem_student').map((r) => r.opportunity_id)).not.toContain('row-harvard-portal')
    expect(res.aspirationRefused).toBe(1)
    expect(res.institutionUnconnectedRefused).toBe(0)
  })

  it('CONVERGES: a portal already linked to an unconnected profile is removed', async () => {
    // The refusal alone cannot reach a row that is already linked — the
    // candidate query excludes those by design — so the net re-derives this one
    // refusal from the profile itself and drops the residue.
    addOpp(db, MTSU_PORTAL)
    addOpp(db, BRADLEY_UNIVERSITY_PORTAL)
    const legacy = db.prepare(`INSERT INTO profile_opportunity_matches
      (id, profile_id, opportunity_id, match_score, match_decision, matcher_version)
      VALUES (?, ?, ?, ?, 'review', 'profile-discovery-link')`)
    legacy.run('pd:legacy-mtsu', 'p-demo_stem_student', MTSU_PORTAL.id, 20)
    legacy.run('pd:legacy-bradley', 'p-demo_stem_student', BRADLEY_UNIVERSITY_PORTAL.id, 26)

    await enforceProfileDiscoveredCatalogLinkage(wrap(db))
    const ids = linkRows(db, 'p-demo_stem_student').map((r) => r.opportunity_id)
    expect(ids).not.toContain(BRADLEY_UNIVERSITY_PORTAL.id)
    expect(ids).toContain(MTSU_PORTAL.id)
  })

  it('never links a row to a profile its provenance does NOT name', async () => {
    addOpp(db, BRADLEY_SCHOOLS) // p-robert
    addOpp(db, MTSU_AID)        // p-demo_stem_student
    await enforceProfileDiscoveredCatalogLinkage(wrap(db))
    expect(linkRows(db, 'p-demo_stem_student').map((r) => r.opportunity_id)).not.toContain(BRADLEY_SCHOOLS.id)
    expect(linkRows(db, 'p-robert').map((r) => r.opportunity_id)).not.toContain(MTSU_AID.id)
  })

  it('THE ENGINE IS THE SOLE AUTHORITY — a REJECT is never written', async () => {
    // Recorded provenance authorizes a LOOK, never a verdict. A foreign
    // jurisdiction is a hard REJECT in `matchEngine.makeDecision` (#1080), and
    // provenance must not override it.
    const IRISH = {
      ...BRADLEY_SCHOOLS,
      id: 'row-irish-housing-grant',
      title: 'Housing Adaptation Grant for People with a Disability',
      sponsor: 'Citizens Information',
      state: null, is_national: 0,
      source_url: 'https://www.citizensinformation.ie/en/housing/housing-grants-and-schemes/',
      application_url: 'https://www.citizensinformation.ie/en/housing/housing-grants-and-schemes/',
    }
    addOpp(db, IRISH)
    const res = await enforceProfileDiscoveredCatalogLinkage(wrap(db))
    expect(res.scanned).toBe(1)
    expect(res.rejectedByEngine).toBe(1)
    expect(res.repaired).toBe(0)
    expect(linkRows(db, 'p-robert')).toHaveLength(0)
  })

  it('never links a row with NO provenance (the 7,555 unrecoverable rows)', async () => {
    addOpp(db, NO_PROVENANCE)
    const res = await enforceProfileDiscoveredCatalogLinkage(wrap(db))
    expect(res.scanned).toBe(0)
    expect(res.repaired).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM profile_opportunity_matches').get().c).toBe(0)
  })

  it('COUNTS a row whose named profile is gone — never re-points it', async () => {
    addOpp(db, ORPHANED)
    const res = await enforceProfileDiscoveredCatalogLinkage(wrap(db))
    expect(res.orphanProfile).toBe(1)
    expect(db.prepare('SELECT COUNT(*) c FROM profile_opportunity_matches').get().c).toBe(0)
  })

  it('skips a DELETED / archived profile the same way', async () => {
    addOpp(db, BRADLEY_SCHOOLS)
    db.prepare(`UPDATE profiles SET status='archived' WHERE id='p-robert'`).run()
    const res = await enforceProfileDiscoveredCatalogLinkage(wrap(db))
    expect(res.orphanProfile).toBe(1)
    expect(linkRows(db, 'p-robert')).toHaveLength(0)
  })

  it('skips an INACTIVE catalog row', async () => {
    addOpp(db, { ...BRADLEY_SCHOOLS, is_active: 0 })
    const res = await enforceProfileDiscoveredCatalogLinkage(wrap(db))
    expect(res.scanned).toBe(0)
    expect(linkRows(db, 'p-robert')).toHaveLength(0)
  })

  it('is IDEMPOTENT — a second pass has nothing left to scan', async () => {
    addOpp(db, BRADLEY_SCHOOLS)
    addOpp(db, FAMILY_PROMISE)
    const first = await enforceProfileDiscoveredCatalogLinkage(wrap(db))
    expect(first.repaired).toBeGreaterThan(0)
    const second = await enforceProfileDiscoveredCatalogLinkage(wrap(db))
    // The exclusion is a SQL predicate, so a linked row leaves the candidate set.
    expect(second.scanned).toBe(0)
    expect(second.repaired).toBe(0)
    expect(linkRows(db, 'p-robert')).toHaveLength(first.repaired)
  })

  it('CANDIDATE DISCOVERY IS A SQL PREDICATE, not a post-LIMIT JS filter', async () => {
    // The #944 signature: a sweep that SELECTs LIMIT N and drops already-done
    // rows in JS can only ever see its own bound. Here 5 rows are already
    // linked and the bound is 3 — a post-LIMIT filter would scan 0.
    process.env.PROFILE_DISCOVERY_LINK_LIMIT = '3'
    for (let i = 0; i < 5; i += 1) {
      addOpp(db, { ...BRADLEY_SCHOOLS, id: `done-${i}` })
      db.prepare(
        `INSERT INTO profile_opportunity_matches (id, profile_id, opportunity_id, matcher_version)
         VALUES (?, 'p-robert', ?, 'crawler-os')`,
      ).run(`m-${i}`, `done-${i}`)
    }
    addOpp(db, BRADLEY_SCHOOLS)
    addOpp(db, FAMILY_PROMISE)
    const res = await enforceProfileDiscoveredCatalogLinkage(wrap(db))
    expect(res.scanned).toBe(2)
    expect(linkRows(db, 'p-robert').map((r) => r.opportunity_id).sort())
      .toEqual([BRADLEY_SCHOOLS.id, FAMILY_PROMISE.id].sort())
  })

  it('COUNT-ONLY mode reports what it would do and writes nothing', async () => {
    process.env.ENFORCE_PROFILE_DISCOVERY_LINK = '0'
    addOpp(db, BRADLEY_SCHOOLS)
    addOpp(db, FAMILY_PROMISE)
    const res = await enforceProfileDiscoveredCatalogLinkage(wrap(db))
    expect(res.enforced).toBe(false)
    expect(res.wouldRepair).toBeGreaterThan(0)
    expect(res.repaired).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM profile_opportunity_matches').get().c).toBe(0)
  })

  it('CONVERGES: a row whose provenance was re-pointed loses its link', async () => {
    addOpp(db, BRADLEY_SCHOOLS)
    await enforceProfileDiscoveredCatalogLinkage(wrap(db))
    expect(linkRows(db, 'p-robert')).toHaveLength(1)
    db.prepare(`UPDATE funding_opportunities SET is_active = 0 WHERE id = ?`).run(BRADLEY_SCHOOLS.id)
    // Give the pass a live candidate for this profile so it re-derives the set.
    addOpp(db, FAMILY_PROMISE)
    await enforceProfileDiscoveredCatalogLinkage(wrap(db))
    expect(linkRows(db, 'p-robert').map((r) => r.opportunity_id)).toEqual([FAMILY_PROMISE.id])
  })

  it('never deletes another lane\'s match rows', async () => {
    addOpp(db, BRADLEY_SCHOOLS)
    addOpp(db, FAMILY_PROMISE)
    db.prepare(
      `INSERT INTO profile_opportunity_matches (id, profile_id, opportunity_id, matcher_version)
       VALUES ('keep-me', 'p-robert', ?, 'crawler-os')`,
    ).run(BRADLEY_SCHOOLS.id)
    await enforceProfileDiscoveredCatalogLinkage(wrap(db))
    expect(db.prepare(`SELECT COUNT(*) c FROM profile_opportunity_matches WHERE id='keep-me'`).get().c).toBe(1)
  })
})

describe('the lane SURVIVES the mechanism that erased the match', () => {
  it('is registered as a surfaced matcher version', () => {
    expect(SURFACED_MATCHER_VERSIONS).toContain(LINK_VERSION)
  })

  it('is NOT named by the crawler-os reconcile DELETE (the rolling snapshot)', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.promises.readFile(new URL('../services/crawlerOsPersistenceCore.js', import.meta.url), 'utf8'))
    const reconcile = src.slice(src.indexOf('DELETE FROM profile_opportunity_matches'))
    expect(reconcile.slice(0, 220)).not.toContain(LINK_VERSION)
  })

  it('the need-first reconciler reads the REGISTRY, not a hand-typed copy', async () => {
    // #1089 added `institution-link` to the registry but not to this file's
    // hand-written Set, so those rows were silently skipped. A literal list here
    // is the drift the registry exists to prevent.
    const src = await import('node:fs').then((fs) =>
      fs.promises.readFile(new URL('../services/matching/needFirstReconciler.js', import.meta.url), 'utf8'))
    expect(src).toContain('SURFACED_MATCHER_VERSIONS')
    expect(src).not.toMatch(/SURFACED_LANES\s*=\s*new Set\(\s*\[/)
  })
})
