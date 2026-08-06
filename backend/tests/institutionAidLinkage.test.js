/**
 * institution_recall_miss — a student's OWN school's aid must reach that student.
 *
 * Every fixture below is a REAL prod row or profile field, read read-only on
 * 2026-08-01:
 *   • `Middle Tennessee State University` sponsors **52 active catalog rows**
 *     ("Peggy Perry Belcher Scholarship Fund", "MTSU Guaranteed Scholarship",
 *     "Buchanan Fellowship", …) and **not one of them carries a match row for
 *     any profile** — while Demo Tennessee STEM Student's `education.current_institution`
 *     IS "Middle Tennessee State University".
 *   • Her only university-sponsored matches are SEVEN
 *     `Wayne County Community College District` / `Wayne State University`
 *     (MICHIGAN) rows at scores 3–4 — cross-matched onto **28 profiles**
 *     fleet-wide. The false-positive flood and the blind spot are one defect.
 *
 * The engine was never the drop point: replaying the real
 * `computeMatchDecision` on (her live profile row + sections, the live
 * "Peggy Perry Belcher Scholarship Fund" row) returns ACCEPT / score 100.
 * The pair is simply never scored, because the match store is a rolling
 * snapshot that only ever holds what the LAST run re-found.
 *
 * These tests therefore assert TWO things that must both hold, forever:
 *   1. the student's own school reaches them, and SURVIVES a crawler-os
 *      reconcile (the exact mechanism that erased it); and
 *   2. no other school's aid rides along — the gate is the WHOLE name and
 *      ATTENDANCE, never aspiration.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  PROFILE_INSTITUTION_FIELDS,
  resolveAttendedInstitutions,
  resolveSeedInstitutions,
  opportunitySponsoredByInstitution,
  institutionSponsorLikePattern,
} from '../config/profileInstitutions.js'
import { SURFACED_MATCHER_VERSIONS } from '../config/matchSurfacing.js'
import { enforceInstitutionAidLinkage } from '../startup/enforceInvariants.js'

const MTSU = 'Middle Tennessee State University'

/** Demo Tennessee STEM Student's real education section (trimmed to the school fields). */
const ATTENDING_MTSU = {
  education: {
    current_institution: MTSU,
    intended_major: 'Forensic Science',
    gpa: '3.84',
    pell_grant_eligible: true,
    target_colleges: ['Ohio State University', 'University of Alabama', 'Harvard University'],
  },
  basic_information: {
    first_name: 'Demo Student',
    location: { city: 'Cleveland', state: 'TN', county: 'Bradley County', zip_code: '37311' },
  },
}

/** The returning-adult shape: a school named ONLY as an aspiration. */
const TARGETING_OSU_ONLY = {
  education: {
    highest_level: 'some college, returning adult',
    target_colleges: ['Ohio State University'],
    pell_grant_eligible: true,
  },
  basic_information: { location: { city: 'Columbus', state: 'OH', zip_code: '43201' } },
}

// ── Real prod catalog rows ───────────────────────────────────────────────────
const PEGGY = {
  id: 'e028059698070cd3c73195d9ce079c59d05c5c0bff9216edb0beb8fef654a9c3',
  title: 'Peggy Perry Belcher Scholarship Fund',
  sponsor: MTSU,
  state: 'TN',
  is_national: 0,
  opportunity_kind: 'DIRECT_GRANT',
  source: 'web_search',
  source_url: 'https://www.mtsu.edu/scholarships/',
  application_url: 'https://www.mtsu.edu/scholarships/',
  is_active: 1,
}
const WCCCD = {
  id: '1bec997e30894135324069aa86579781ca80acbd0660f5ebecd543ebc59374ab',
  title: 'Andrew R. Calhoun Scholarship Fund',
  sponsor: 'Wayne County Community College District',
  state: 'MI',
  is_national: 0,
  opportunity_kind: 'DIRECT_GRANT',
  source: 'web_search',
  source_url: 'https://www.wcccd.edu/scholarships',
  application_url: 'https://www.wcccd.edu/scholarships',
  is_active: 1,
}
const OSU_NURSING = {
  id: '8158c941214658b9cb0007d1b4b5d2ca4a73866a394e347a85e66c0a68a8a339',
  title: 'College of Nursing Student Hardship Fund',
  sponsor: 'The Ohio State University',
  state: 'OH',
  is_national: 0,
  opportunity_kind: 'DIRECT_GRANT',
  source: 'web_search',
  source_url: 'https://www.osu.edu/giving/explore/support-a-college/college-nursing',
  application_url: 'https://www.osu.edu/giving/explore/support-a-college/college-nursing',
  is_active: 1,
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
      is_active INTEGER DEFAULT 1
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
    `INSERT INTO profiles (id, primary_type, applicant_type, status, state, city, postal_code)
     VALUES (?, ?, ?, 'active', ?, ?, ?)`,
  ).run(
    id,
    extra.primary_type ?? 'college_student',
    extra.applicant_type ?? 'individual',
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
       (id, title, sponsor, state, is_national, opportunity_kind, source, source_url, application_url, is_active)
     VALUES (@id, @title, @sponsor, @state, @is_national, @opportunity_kind, @source, @source_url, @application_url, @is_active)`,
  ).run(o)
}

const linkRows = (db, profileId) =>
  db.prepare(
    `SELECT * FROM profile_opportunity_matches
      WHERE profile_id = ? AND matcher_version = 'institution-link'`,
  ).all(profileId)

// ─────────────────────────────────────────────────────────────────────────────
describe('the ATTENDANCE gate — the whole name, and only where the student IS', () => {
  it('links a school to its OWN aid', () => {
    expect(opportunitySponsoredByInstitution(MTSU, PEGGY)).toBe(true)
    expect(opportunitySponsoredByInstitution('Ohio State University', OSU_NURSING)).toBe(true) // "The " is generic
  })

  it('REFUSES the real prod false positives that flooded 28 profiles', () => {
    // One shared word is a coincidence, not an identity (the Yana-lead rule).
    expect(opportunitySponsoredByInstitution(MTSU, WCCCD)).toBe(false)
    expect(opportunitySponsoredByInstitution('Wayne State University', WCCCD)).toBe(false)
    // A SUBSET name is a different school — this is why the rule is bidirectional.
    expect(opportunitySponsoredByInstitution('Tennessee State University', PEGGY)).toBe(false)
    expect(opportunitySponsoredByInstitution(MTSU, { sponsor: 'Tennessee State University' })).toBe(false)
    // 'state' is NOT a generic word: these are two different real universities.
    expect(opportunitySponsoredByInstitution('Ohio University', OSU_NURSING)).toBe(false)
  })

  it('treats a blank / unknown sponsor as NEUTRAL, never as a match', () => {
    expect(opportunitySponsoredByInstitution(MTSU, { sponsor: null })).toBe(false)
    expect(opportunitySponsoredByInstitution(MTSU, { sponsor: 'The University' })).toBe(false)
    expect(opportunitySponsoredByInstitution('', PEGGY)).toBe(false)
  })

  it('separates ATTENDANCE from ASPIRATION', () => {
    expect(resolveAttendedInstitutions(ATTENDING_MTSU)).toEqual([MTSU])
    // 19 target colleges in the real profile — none of them authorize a match.
    expect(resolveAttendedInstitutions(TARGETING_OSU_ONLY)).toEqual([])
    // …but aspiration still SEEDS discovery queries, exactly as before.
    expect(resolveSeedInstitutions(TARGETING_OSU_ONLY)).toEqual(['Ohio State University'])
    expect(resolveSeedInstitutions(ATTENDING_MTSU)[0]).toBe(MTSU)
  })

  it('honors every ATTENDANCE field in the registry (totality)', () => {
    const attendance = PROFILE_INSTITUTION_FIELDS.filter((f) => f.kind === 'attendance')
    expect(attendance.length).toBeGreaterThan(0)
    const shapes = {
      'education.current_institution': { education: { current_institution: 'Aurora Institution X' } },
      'basic_information.current_school': { basic_information: { current_school: 'Aurora Institution X' } },
      'university_applications.applications[status=committed].name': {
        university_applications: { applications: [{ name: 'Aurora Institution X', status: 'committed' }] },
      },
      'education.schools.name': { education: { schools: { name: 'Aurora Institution X' } } },
    }
    for (const field of attendance) {
      expect(shapes[field.id], `no coverage shape for registry field ${field.id}`).toBeTruthy()
      expect(resolveAttendedInstitutions(shapes[field.id])).toEqual(['Aurora Institution X'])
    }
    // And every registry field, of either kind, is reachable by the seed path.
    for (const field of PROFILE_INSTITUTION_FIELDS) {
      expect(typeof field.read).toBe('function')
      expect(['attendance', 'aspiration']).toContain(field.kind)
    }
  })

  it('builds a SUPERSET SQL predicate, never a post-LIMIT filter', () => {
    const pattern = institutionSponsorLikePattern(MTSU)
    expect(pattern).toBe('%tennessee%') // longest distinctive token
    expect(PEGGY.sponsor.toLowerCase()).toContain('tennessee')
    expect(institutionSponsorLikePattern('   ')).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('enforceInstitutionAidLinkage — the sweep', () => {
  let db
  beforeEach(() => {
    db = makeDb()
    addProfile(db, 'p-demo_stem_student', ATTENDING_MTSU)
    addOpp(db, PEGGY)
    addOpp(db, WCCCD)
    addOpp(db, OSU_NURSING)
  })
  afterEach(() => {
    delete process.env.ENFORCE_INSTITUTION_AID_LINK
    delete process.env.INSTITUTION_AID_LINK_LIMIT
  })

  it("reaches the student's OWN school — the 52-rows-0-matches prod class", async () => {
    const res = await enforceInstitutionAidLinkage(db)
    expect(res.ok).not.toBe(false)
    const rows = linkRows(db, 'p-demo_stem_student')
    expect(rows.map((r) => r.opportunity_id)).toEqual([PEGGY.id])
    expect(Number(rows[0].match_score)).toBeGreaterThan(0)
    expect(['accept', 'review']).toContain(String(rows[0].match_decision).toLowerCase())
  })

  it('does NOT open a free-for-all: no other school rides along', async () => {
    await enforceInstitutionAidLinkage(db)
    const ids = linkRows(db, 'p-demo_stem_student').map((r) => r.opportunity_id)
    // The Michigan community college that really did reach 28 prod profiles.
    expect(ids).not.toContain(WCCCD.id)
    // …and a school she only TARGETS is not a school she attends.
    expect(ids).not.toContain(OSU_NURSING.id)
  })

  it('gives an ASPIRATION-only profile nothing at all', async () => {
    addProfile(db, 'p-returning-adult', TARGETING_OSU_ONLY)
    await enforceInstitutionAidLinkage(db)
    expect(linkRows(db, 'p-returning-adult')).toHaveLength(0)
  })

  it('leaves the ENGINE as the sole authority — a REJECT is never written', async () => {
    // Same sponsor, but administered from another jurisdiction: makeDecision
    // REJECTs it (#1080), and the sweep must respect that.
    addOpp(db, {
      ...PEGGY,
      id: 'mtsu-foreign',
      title: 'MTSU International Partner Award',
      source_url: 'https://www.gov.uk/mtsu-partner-award',
      application_url: 'https://www.gov.uk/mtsu-partner-award',
      state: null,
      is_national: 1,
    })
    const res = await enforceInstitutionAidLinkage(db)
    expect(linkRows(db, 'p-demo_stem_student').map((r) => r.opportunity_id)).not.toContain('mtsu-foreign')
    expect(res.rejectedByEngine).toBeGreaterThan(0)
  })

  it("never overwrites the profile's OWN crawler-os match for the same pair", async () => {
    db.prepare(
      `INSERT INTO profile_opportunity_matches (id, profile_id, opportunity_id, match_score, match_decision, matcher_version)
       VALUES ('own', 'p-demo_stem_student', ?, 88, 'accept', 'crawler-os')`,
    ).run(PEGGY.id)
    await enforceInstitutionAidLinkage(db)
    const all = db.prepare('SELECT * FROM profile_opportunity_matches WHERE opportunity_id = ?').all(PEGGY.id)
    expect(all).toHaveLength(1)
    expect(all[0].matcher_version).toBe('crawler-os')
    expect(all[0].match_score).toBe(88)
  })

  it('SURVIVES the crawler-os reconcile that erased it in prod', async () => {
    await enforceInstitutionAidLinkage(db)
    expect(linkRows(db, 'p-demo_stem_student')).toHaveLength(1)
    // Verbatim reconcile from crawlerOsPersistenceCore.persistRun — the exact
    // statement that wipes a profile's institution set on any registry-only run.
    db.prepare(
      `DELETE FROM profile_opportunity_matches
        WHERE profile_id = ? AND matcher_version IN ('crawler-os', 'crawler-os-xmatch')`,
    ).run('p-demo_stem_student')
    expect(linkRows(db, 'p-demo_stem_student')).toHaveLength(1)
  })

  it('is idempotent', async () => {
    await enforceInstitutionAidLinkage(db)
    const second = await enforceInstitutionAidLinkage(db)
    expect(second.repaired).toBe(0)
    expect(linkRows(db, 'p-demo_stem_student')).toHaveLength(1)
  })

  it('CONVERGES when the student changes schools', async () => {
    await enforceInstitutionAidLinkage(db)
    expect(linkRows(db, 'p-demo_stem_student')).toHaveLength(1)
    db.prepare('UPDATE profile_sections SET data = ? WHERE profile_id = ? AND section_key = ?')
      .run(JSON.stringify({ ...ATTENDING_MTSU.education, current_institution: 'Ohio State University' }),
        'p-demo_stem_student', 'education')
    await enforceInstitutionAidLinkage(db)
    const ids = linkRows(db, 'p-demo_stem_student').map((r) => r.opportunity_id)
    expect(ids).not.toContain(PEGGY.id)
  })

  it('ENFORCE_INSTITUTION_AID_LINK=0 counts without writing', async () => {
    process.env.ENFORCE_INSTITUTION_AID_LINK = '0'
    const res = await enforceInstitutionAidLinkage(db)
    expect(res.enforced).toBe(false)
    expect(res.wouldRepair).toBeGreaterThan(0)
    expect(linkRows(db, 'p-demo_stem_student')).toHaveLength(0)
  })

  it('never throws on a DB without the tables', async () => {
    const bare = new Database(':memory:')
    const res = await enforceInstitutionAidLinkage(bare)
    expect(res.ok).not.toBe(false)
    expect(res.repaired ?? 0).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('static drift tripwires', () => {
  it("surfaces 'institution-link' AND keeps it out of the reconcile DELETE", async () => {
    expect(SURFACED_MATCHER_VERSIONS).toContain('institution-link')
    const fs = await import('node:fs')
    const url = await import('node:url')
    const src = fs.readFileSync(
      url.fileURLToPath(new URL('../services/crawlerOsPersistenceCore.js', import.meta.url)),
      'utf8',
    )
    // The reconcile must never learn to delete the versions that exist to
    // survive it — that would silently restore the defect.
    const deleteScopes = [...src.matchAll(/matcher_version IN \(([^)]*)\)/g)].map((m) => m[1])
    expect(deleteScopes.length).toBeGreaterThan(0)
    for (const scope of deleteScopes) {
      expect(scope).not.toContain('institution-link')
      expect(scope).not.toContain('web-llm')
    }
  })
})
