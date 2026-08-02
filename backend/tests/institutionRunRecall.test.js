/**
 * institutionRunRecall — the IN-RUN half of the institution-attendance recall key.
 *
 * The boot net (enforceInstitutionAidLinkage, #1089) fixes the FLEET between
 * boots — but a profile that is created, crawled, and read between boots never
 * meets it: every Amy synthetic (created + crawled + evaluated + reaped inside
 * one run — why institution_recall_miss stayed red on 21 of 21 cohort days
 * AFTER the boot net shipped), and any newly-onboarded student's first crawl.
 * This step serves the DISCOVERING profile the same attendance-authorized look
 * at the catalog, inside runProfileDiscoveryLive.
 *
 * Fixtures mirror backend/tests/institutionAidLinkage.test.js (real prod rows).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { recallInstitutionAidForRun } from '../services/matching/institutionRunRecall.js'

const MTSU = 'Middle Tennessee State University'

const ATTENDING_MTSU_SECTIONS = {
  education: {
    current_institution: MTSU,
    intended_major: 'Forensic Science',
    gpa: '3.84',
    pell_grant_eligible: true,
    fafsa_completed: true,
    highest_level: 'undergraduate (in progress)',
  },
  basic_information: {
    location: { city: 'Cleveland', state: 'TN', county: 'Bradley County', zip_code: '37311' },
    age: 20,
  },
  financial_information: { household_income: 24000, household_size: 3, financial_need_level: 'high', low_income: true },
  narrative: { mission: 'Undergraduate forensic science student.', primary_goal: 'Scholarships and tuition aid.' },
  programs_services: {
    focus_areas: ['scholarship', 'education'],
    interests: ['scholarship', 'tuition', 'forensic science'],
    keywords: ['college scholarship', 'tuition'],
  },
}

const ASPIRATION_ONLY_SECTIONS = {
  education: {
    highest_level: 'some college, returning adult',
    target_colleges: ['Ohio State University'],
  },
  basic_information: { location: { city: 'Columbus', state: 'OH', zip_code: '43201' } },
}

const STUDENT_PROFILE = {
  id: 'p-student-mtsu',
  primary_type: 'college_student',
  state: 'TN',
  city: 'Cleveland',
}

const PEGGY = {
  id: 'opp-peggy',
  title: 'Peggy Perry Belcher Scholarship Fund',
  sponsor: MTSU,
  state: 'TN',
  is_national: 0,
  opportunity_kind: 'DIRECT_GRANT',
  source: 'web_search',
  source_url: 'https://www.mtsu.edu/scholarships/',
  application_url: 'https://www.mtsu.edu/scholarships/',
  is_active: 1,
  description:
    'Scholarship for students enrolled at Middle Tennessee State University. ' +
    'Individuals currently enrolled full-time may apply; awards support tuition and educational expenses.',
}
const WCCCD = {
  id: 'opp-wcccd',
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
// An MTSU-sponsored row the ENGINE must reject (already-awarded research record).
const MTSU_AWARDED = {
  id: 'opp-mtsu-awarded',
  title: 'Collaborative Research: Genomic Analysis of Microbial Communities',
  sponsor: MTSU,
  state: 'TN',
  is_national: 0,
  opportunity_kind: 'DIRECT_GRANT',
  source: 'nsf.awards',
  source_url: 'https://www.nsf.gov/awardsearch/showAward?AWD_ID=2012345',
  application_url: 'https://www.nsf.gov/awardsearch/showAward?AWD_ID=2012345',
  is_active: 1,
}

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT, sponsor TEXT, description TEXT,
      state TEXT, is_national INTEGER, opportunity_kind TEXT, source TEXT,
      source_url TEXT, application_url TEXT, amount_min NUMERIC, amount_max NUMERIC,
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

function addOpp(db, o) {
  db.prepare(
    `INSERT INTO funding_opportunities
       (id, title, sponsor, description, state, is_national, opportunity_kind, source, source_url, application_url, is_active)
     VALUES (@id, @title, @sponsor, @description, @state, @is_national, @opportunity_kind, @source, @source_url, @application_url, @is_active)`,
  ).run({ description: null, ...o })
}

const linkRows = (db, profileId) =>
  db.prepare(
    `SELECT * FROM profile_opportunity_matches
      WHERE profile_id = ? AND matcher_version = 'institution-link'`,
  ).all(profileId)

let db
beforeEach(() => { db = makeDb() })

describe('recallInstitutionAidForRun — the just-crawled student reaches their OWN school', () => {
  it("recommends the student's own school's aid and writes the institution-link row", async () => {
    addOpp(db, PEGGY)
    addOpp(db, WCCCD)
    const res = await recallInstitutionAidForRun(db, {
      profile: STUDENT_PROFILE,
      sections: ATTENDING_MTSU_SECTIONS,
    })
    expect(res.schools).toBe(1)
    // The other school's aid never rides along (whole-name sponsor equality).
    expect(res.scanned).toBe(1)
    expect(res.recommendations.map((r) => r.opportunity_id)).toEqual([PEGGY.id])
    expect(res.recommendations[0].decision).toBe('ACCEPT')
    expect(res.recommendations[0].discovered_via).toBe('institution_attendance_link')

    const rows = linkRows(db, STUDENT_PROFILE.id)
    expect(rows.map((r) => r.opportunity_id)).toEqual([PEGGY.id])
    expect(rows[0].id).toBe(`il:${STUDENT_PROFILE.id}:${PEGGY.id}`)
    expect(rows[0].discovered_via).toBe('institution_attendance_link')
  })

  it('an engine REJECT is never written and never recommended', async () => {
    addOpp(db, MTSU_AWARDED)
    const res = await recallInstitutionAidForRun(db, {
      profile: STUDENT_PROFILE,
      sections: ATTENDING_MTSU_SECTIONS,
    })
    expect(res.scanned).toBe(1)
    expect(res.rejectedByEngine).toBe(1)
    expect(res.recommendations).toEqual([])
    expect(linkRows(db, STUDENT_PROFILE.id)).toEqual([])
  })

  it('ASPIRATION never authorizes: a target-college-only profile recalls nothing', async () => {
    addOpp(db, { ...PEGGY, id: 'opp-osu', sponsor: 'The Ohio State University', state: 'OH' })
    const res = await recallInstitutionAidForRun(db, {
      profile: { id: 'p-aspiring', primary_type: 'individual', state: 'OH' },
      sections: ASPIRATION_ONLY_SECTIONS,
    })
    expect(res.skipped).toBe('no_attended_institution')
    expect(res.recommendations).toEqual([])
    expect(linkRows(db, 'p-aspiring')).toEqual([])
  })

  it('dryRun computes but writes NOTHING', async () => {
    addOpp(db, PEGGY)
    const res = await recallInstitutionAidForRun(db, {
      profile: STUDENT_PROFILE,
      sections: ATTENDING_MTSU_SECTIONS,
      dryRun: true,
    })
    expect(res.linked).toBe(1)
    expect(linkRows(db, STUDENT_PROFILE.id)).toEqual([])
  })

  it('a row the run already recommends is not duplicated (idRemap-aware)', async () => {
    addOpp(db, PEGGY)
    const idRemap = new Map([['os-run-id-1', PEGGY.id]])
    const res = await recallInstitutionAidForRun(db, {
      profile: STUDENT_PROFILE,
      sections: ATTENDING_MTSU_SECTIONS,
      idRemap,
      existingRecommendations: [{ opportunity_id: 'os-run-id-1', title: PEGGY.title }],
    })
    // Still linked in the match table (idempotent identity), but NOT re-recommended.
    expect(res.recommendations).toEqual([])
    expect(linkRows(db, STUDENT_PROFILE.id).length).toBe(1)
  })

  it('an existing match row for the pair is left alone (ON CONFLICT DO NOTHING)', async () => {
    addOpp(db, PEGGY)
    db.prepare(
      `INSERT INTO profile_opportunity_matches
         (id, profile_id, opportunity_id, match_score, match_decision, matcher_version)
       VALUES (?, ?, ?, ?, ?, 'crawler-os')`,
    ).run(`own:${STUDENT_PROFILE.id}:${PEGGY.id}`, STUDENT_PROFILE.id, PEGGY.id, 95, 'accept')
    await recallInstitutionAidForRun(db, {
      profile: STUDENT_PROFILE,
      sections: ATTENDING_MTSU_SECTIONS,
    })
    const all = db.prepare('SELECT * FROM profile_opportunity_matches WHERE profile_id = ?')
      .all(STUDENT_PROFILE.id)
    expect(all.length).toBe(1)
    expect(all[0].matcher_version).toBe('crawler-os') // the profile's own match wins
  })
})
