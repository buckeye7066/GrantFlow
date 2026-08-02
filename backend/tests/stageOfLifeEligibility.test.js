/**
 * A high-school senior cannot receive a medical-school scholarship, and an
 * award that says nothing about academic stage must never be refused.
 *
 * Every fixture below is a REAL prod row or profile field, read read-only on
 * 2026-08-02 against Anastasia White (`c4a92724-9cee-416f-ba30-e91b9b5cd885`),
 * a 17-year-old dual-enrolled high-school senior in Cleveland, TN:
 *
 *   • The catalog holds 21 active TN HOPE rows; she matched ZERO. Replaying the
 *     REAL `computeMatchDecision` on the unscored pair returns ACCEPT 100 —
 *     "Matches 70 of the profile's 70 data points".
 *   • The recall key that reaches HOPE also returned, as ACCEPTs: "Vanderbilt
 *     School of Medicine Merit Scholarship" (84), "Osher Reentry Scholarship"
 *     (84), "International Student Doctor of Chiropractic Scholarship" (81),
 *     "Tennessee HOPE Scholarship - Nontraditional" (84) and "UAB Blazer
 *     Graduate Research Fellowship" (40).
 *   • `eligibility_text` is EMPTY and `eligibility_bullets` is `[]` on ALL of
 *     them — the only stage statement lives in title, sponsor or the extracted
 *     summary, which is why the gate reads those and why silence must be safe.
 *   • Federal Work-Study's page says "part-time jobs for UNDERGRADUATE AND
 *     GRADUATE students". Without the inclusion guard the gate refused a
 *     100-scoring, entirely correct award on the strength of the word that
 *     INCLUDED her.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  STAGE_KNOWN,
  STAGE_REQUIREMENT_CLASSES,
  STAGE_DECLARATION_LIKE_PATTERNS,
  STUDENT_AID_NEED_CATEGORIES,
  STUDENT_STAGES,
  isStudentStage,
  detectDeclaredStageRequirement,
  stageOfLifeConflict,
  stageOfLifeConflictForSections,
} from '../config/stageOfLifeEligibility.js'
import { deriveStageOfLife } from '../config/profileDerivedFacts.js'
import { SURFACED_MATCHER_VERSIONS } from '../config/matchSurfacing.js'
import { makeDecision } from '../services/matchEngine.js'
import { allSources } from '../crawler-os/sourceRegistry.js'
import {
  enforceStageOfLifeMatchScope,
  enforceStudentAidInStateRecall,
} from '../startup/enforceInvariants.js'

const HS = 'dual_enrolled_incoming_freshman'

const ANASTASIA = {
  basic_information: {
    first_name: 'Anastasia',
    location: { city: 'Cleveland', state: 'TN', county: 'Bradley County', zip_code: '37312' },
    academic_status: { gpa: 3.84, act_score: 28, education_level: 'High School Senior', college_courses: 'Yes' },
  },
  education: {
    current_institution: 'Middle Tennessee State University',
    intended_major: 'Forensic Science',
    interests: ['Forensic Science', 'Criminal Justice', 'STEM'],
    aid_types_accepted: ['grant', 'endowment', 'scholarship'],
    pell_grant_eligible: true,
  },
  financial: { funding_needs: ['education'] },
}

/** A profile that states NO academic stage — the gate must say nothing. */
const NO_STAGE = {
  basic_information: { first_name: 'Ruth', location: { city: 'El Paso', state: 'TX', zip_code: '79901' } },
  education: {},
  financial: { funding_needs: ['housing'] },
}

// ── REAL prod catalog rows (title / sponsor / description verbatim) ──────────
const row = (o) => ({
  state: 'TN', is_national: 0, opportunity_kind: 'direct', source: 'web_search',
  is_active: 1, eligibility_text: '', eligibility_bullets: [], ...o,
})

const HOPE = row({
  id: 'row-hope', title: 'HOPE Scholarship', sponsor: 'Tennessee Lottery',
  description: 'The HOPE Scholarship pays up to $6,000 per year in college tuition at eligible two and four year colleges that provide on-campus housing, and is available to students with a minimum ACT score of 21 or a GPA of 3.0.',
  source_url: 'https://www.tn.gov/collegepays/money-for-college/tn-education-lottery-programs/tennessee-hope-scholarship.html',
  application_url: 'https://www.tn.gov/collegepays/', amount_max: 6000,
})
/** The row whose page names BOTH audiences — an inclusion, not a bar. */
const HOPE_TSAC = row({
  id: 'row-hope-tsac', title: 'HOPE Scholarship', sponsor: 'Tennessee Student Assistance Corporation',
  description: 'The HOPE Scholarship is available for eligible Tennessee high school graduates and some adult students, with specific GPA and timing rules.',
  source_url: 'https://www.tn.gov/collegepays/', application_url: 'https://www.tn.gov/collegepays/',
})
const VANDERBILT_MED = row({
  id: 'row-vandy', title: 'Vanderbilt School of Medicine Merit Scholarship',
  sponsor: 'Vanderbilt University, School of Medicine',
  description: 'The Vanderbilt School of Medicine Merit Scholarship is available to incoming students at Vanderbilt University, School of Medicine who demonstrate academic excellence.',
  source_url: 'https://medschool.vanderbilt.edu/financial-aid/', application_url: 'https://medschool.vanderbilt.edu/financial-aid/',
})
const OSHER_REENTRY = row({
  id: 'row-osher', title: 'Osher Reentry Scholarship', sponsor: 'The Bernard Osher Foundation',
  description: 'The Osher Reentry Scholarship is intended for nontraditional students seeking their first undergraduate degree at Middle Tennessee State University, demonstrating financial need and academic promise.',
  source_url: 'https://www.mtsu.edu/financial-aid/', application_url: 'https://www.mtsu.edu/financial-aid/',
})
const CHIROPRACTIC = row({
  id: 'row-chiro', title: 'International Student Doctor of Chiropractic Scholarship',
  sponsor: 'Cleveland University-Kansas City',
  description: 'A $1,000 scholarship for non-US citizens with a 3.0 or higher GPA enrolling in the Doctor of Chiropractic degree program at Cleveland on a first-time, full-time basis.',
  source_url: 'https://www.cleveland.edu/tuition-aid/', application_url: 'https://www.cleveland.edu/tuition-aid/',
})
const HOPE_NONTRAD = row({
  id: 'row-hope-nt', title: 'Tennessee HOPE Scholarship - Nontraditional',
  sponsor: 'Tennessee Student Assistance Corporation',
  description: 'This scholarship is for nontraditional age students and is established and funded from the net proceeds of the state lottery.',
  source_url: 'https://www.tn.gov/collegepays/', application_url: 'https://www.tn.gov/collegepays/',
})
const UAB_GRAD = row({
  id: 'row-uab', title: 'UAB Blazer Graduate Research Fellowship program', sponsor: 'UAB Graduate School',
  description: 'The UAB Graduate School awards Blazer Graduate Research Fellowships annually to highly qualified first-year doctoral candidates who are engaged in full-time research.',
  source_url: 'https://www.uab.edu/graduate/', application_url: 'https://www.uab.edu/graduate/',
})
/** Federal Work-Study: the inclusion guard's whole reason for existing. */
const FWS = row({
  id: 'row-fws', title: 'Federal Work-Study', sponsor: 'U.S. Department of Education',
  state: 'nationwide', is_national: 1,
  description: 'Official Federal Student Aid Work-Study page. Part-time jobs for undergraduate and graduate students with financial need to help pay education expenses; awarded by participating schools via the FAFSA.',
  source_url: 'https://studentaid.gov/understand-aid/types/work-study',
  application_url: 'https://studentaid.gov/h/apply-for-aid/fafsa',
})
/** Criminal-justice reentry — the WRONG sense of the word. */
const REO = row({
  id: 'row-reo', title: 'Reentry Employment Opportunities Program (REO)', sponsor: 'U.S. Department of Labor',
  state: 'nationwide', is_national: 1,
  description: 'The Reentry Employment Opportunities Program (REO) provides funding to support projects that assist individuals with criminal records in obtaining employment and reintegrating into society.',
  source_url: 'https://www.dol.gov/agencies/eta/reentry', application_url: 'https://www.dol.gov/agencies/eta/reentry',
})
/** "Nontraditional" as a WILDLIFE term. */
const ESA_NONTRAD = row({
  id: 'row-esa', title: '2026 Cooperative Endangered Species Conservation Fund: HCP Land Acquisition (Nontraditional Section 6)',
  sponsor: 'U.S. Fish and Wildlife Service', state: 'nationwide', is_national: 1,
  description: 'This fund supports land acquisition for habitat conservation plans that benefit endangered species.',
  source_url: 'https://www.fws.gov/service/cescf', application_url: 'https://www.fws.gov/service/cescf',
})
/** An NIH abstract naming the AWARDEE institution, not the audience. */
const NIH_AWARDEE = row({
  id: 'row-nih', title: 'Childhood Asthma in Urban Settings', sponsor: 'National Institutes of Health',
  state: 'nationwide', is_national: 1,
  description: 'Awardee: JOHNS HOPKINS UNIVERSITY SCHOOL OF MEDICINE\nPI: A Researcher\nThis project studies asthma outcomes.',
  source_url: 'https://reporter.nih.gov/', application_url: 'https://reporter.nih.gov/',
})
/** The negation case: the phrase declares the OPPOSITE. */
const UNDERGRAD_ONLY = row({
  id: 'row-ugonly', title: 'Rural Achievers Award', sponsor: 'A Foundation',
  description: 'Open to first-year applicants; graduate students are not eligible.',
  source_url: 'https://example.org/a', application_url: 'https://example.org/a',
})

const wrap = (db) => ({ dialect: 'sqlite', prepare: (sql) => db.prepare(sql) })

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
      eligibility_text TEXT, eligibility_bullets TEXT, entity_types_allowed TEXT,
      need_types_supported TEXT, profile_id TEXT, is_active INTEGER DEFAULT 1,
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
    // Anastasia's REAL prod row: `primary_type = 'student'` (prod `profiles`
    // has no `applicant_type`/`state` column at all — a live schema fact).
    id, extra.display_name ?? id, extra.primary_type ?? 'student',
    extra.applicant_type ?? 'student', extra.status ?? 'active',
    sections.basic_information?.location?.state ?? null,
    sections.basic_information?.location?.city ?? null,
    sections.basic_information?.location?.zip_code ?? null,
  )
  for (const [key, data] of Object.entries(sections)) {
    db.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
      .run(id, key, JSON.stringify(data))
  }
}

function addOpp(db, o) {
  db.prepare(
    `INSERT INTO funding_opportunities
       (id, title, sponsor, description, state, is_national, opportunity_kind, source,
        source_url, application_url, amount_min, amount_max, eligibility_text,
        eligibility_bullets, is_active, profile_id)
     VALUES (@id, @title, @sponsor, @description, @state, @is_national, @opportunity_kind,
             @source, @source_url, @application_url, @amount_min, @amount_max,
             @eligibility_text, @eligibility_bullets, @is_active, @profile_id)`,
  ).run({
    description: null, amount_min: null, amount_max: null, profile_id: null, ...o,
    eligibility_bullets: JSON.stringify(o.eligibility_bullets ?? []),
  })
}

function addMatch(db, id, profileId, oppId, version = 'crawler-os') {
  db.prepare(
    `INSERT INTO profile_opportunity_matches (id, profile_id, opportunity_id, match_score, match_decision, matcher_version)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, profileId, oppId, 80, 'accept', version)
}

let ENV_SNAPSHOT
beforeEach(() => { ENV_SNAPSHOT = { ...process.env } })
afterEach(() => { process.env = ENV_SNAPSHOT })

// ─────────────────────────────────────────────────────────────────────────────
describe('the stage-of-life registry is TOTAL', () => {
  it('classifies every stage deriveStageOfLife can return', () => {
    // Drive the real deriver through every branch its own literals describe.
    const cases = [
      [{ basic_information: { academic_status: { education_level: 'High School Senior', college_courses: 'Yes' } } }, 'dual_enrolled_incoming_freshman'],
      [{ basic_information: { academic_status: { education_level: 'High School Senior' } } }, 'high_school_student'],
      [{ education: { highest_level: 'Associates Degree' } }, 'undergraduate'],
      [{ education: { highest_level: "Master's Degree" } }, 'graduate_student'],
      [{ education: { highest_level: 'Trade certificate' } }, 'unclassified'],
    ]
    for (const [sections, expected] of cases) {
      expect(deriveStageOfLife(sections)?.value).toBe(expected)
      expect(STAGE_KNOWN).toContain(expected)
    }
    // A profile that says nothing gets no stage at all.
    expect(deriveStageOfLife({})).toBeNull()
  })

  it('gives every class pattern a covering SQL LIKE superset', () => {
    // A class whose vocabulary has no LIKE would be invisible to the boot sweep
    // while the per-call gate kept working — a half-enforced rule.
    const likes = STAGE_DECLARATION_LIKE_PATTERNS.map((p) => p.replace(/%/g, ''))
    const probes = {
      graduate_or_professional: [
        'graduate students', 'postgraduate', 'doctoral', 'doctorate', 'PhD',
        'Doctor of Chiropractic', "master's degree", 'MBA students',
        'School of Medicine', 'medical school', 'resident physicians',
      ],
      postdoctoral: ['postdoctoral', 'postdocs'],
      adult_reentry: [
        'Reentry Scholarship', 'nontraditional students', 'non-traditional students',
        'returning adults', 'adult learners', 'adults returning',
        'returning to college', 're-enrolling after',
      ],
    }
    for (const cls of STAGE_REQUIREMENT_CLASSES) {
      const mine = probes[cls.id]
      expect(mine, `no probes declared for class ${cls.id}`).toBeTruthy()
      for (const phrase of mine) {
        // the phrase must be DETECTED …
        const hit = detectDeclaredStageRequirement({ title: `Award — ${phrase}` })
        expect(hit.declared, `${cls.id}: "${phrase}" not detected`).toBe(true)
        // … and reachable by at least one LIKE superset entry.
        const lower = phrase.toLowerCase()
        expect(
          likes.some((l) => lower.includes(l)),
          `${cls.id}: "${phrase}" has no covering LIKE pattern`,
        ).toBe(true)
      }
    }
  })

  it('every STUDENT_AID_NEED_CATEGORY is declared by a real registry source', () => {
    const declared = new Set()
    for (const s of allSources()) for (const n of s.need_categories ?? []) declared.add(String(n).toLowerCase())
    for (const cat of STUDENT_AID_NEED_CATEGORIES) {
      expect(declared.has(cat), `no registry source declares need "${cat}"`).toBe(true)
    }
    expect(STUDENT_STAGES.every(isStudentStage)).toBe(true)
    expect(isStudentStage('unclassified')).toBe(false)
    expect(isStudentStage(null)).toBe(false)
  })

  it('publishes its recall matcher_version as a SURFACED one', () => {
    expect(SURFACED_MATCHER_VERSIONS).toContain('student-aid-instate-link')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('stageOfLifeConflict — the gate refuses, and only on a declaration', () => {
  const BAR = [
    ['Vanderbilt School of Medicine Merit Scholarship', VANDERBILT_MED, 'graduate_or_professional'],
    ['Osher Reentry Scholarship', OSHER_REENTRY, 'adult_reentry'],
    ['International Student Doctor of Chiropractic Scholarship', CHIROPRACTIC, 'graduate_or_professional'],
    ['Tennessee HOPE Scholarship - Nontraditional', HOPE_NONTRAD, 'adult_reentry'],
    ['UAB Blazer Graduate Research Fellowship', UAB_GRAD, 'graduate_or_professional'],
  ]
  for (const [label, opp, classId] of BAR) {
    it(`refuses "${label}" for a dual-enrolled high-school senior`, () => {
      const c = stageOfLifeConflict(HS, opp)
      expect(c, `${label} should conflict`).toBeTruthy()
      expect(c.classId).toBe(classId)
      expect(c.reason).toMatch(/Academic stage/)
      // The reason must QUOTE the source's own words and name the field.
      expect(opp[c.field.replace(/\[\d+\]$/, '')].toLowerCase()).toContain(c.phrase.toLowerCase())
    })
  }

  const KEEP = [
    ['HOPE Scholarship (Tennessee Lottery)', HOPE],
    ['HOPE Scholarship (TSAC) — "high school graduates AND SOME ADULT STUDENTS" is an inclusion', HOPE_TSAC],
    ['Federal Work-Study — "undergraduate and graduate students" is an inclusion', FWS],
    ['Reentry Employment Opportunities (criminal-justice sense)', REO],
    ['Endangered Species "Nontraditional Section 6"', ESA_NONTRAD],
    ['an NIH abstract naming its AWARDEE school of medicine', NIH_AWARDEE],
    ['a row whose prose NEGATES the phrase', UNDERGRAD_ONLY],
  ]
  for (const [label, opp] of KEEP) {
    it(`leaves ${label} alone`, () => {
      expect(stageOfLifeConflict(HS, opp)).toBeNull()
    })
  }

  it('does not undo the ECF CHOICES caregiver path #1086 repaired', () => {
    // She IS a caregiver (`family_life.caregiver = true`, translating and
    // advocating for her grandparents). The real tn_ecf_choices rows declare
    // no academic stage at all, so this gate must have nothing to say about
    // them — a stage rule that quietly re-broke the caregiver lane would cost
    // two owner-verified profiles their coverage for the second time in a day.
    const ecf = row({
      id: 'row-ecf', title: 'ECF CHOICES — Essential Family Supports',
      sponsor: 'Tennessee Division of TennCare',
      description: 'Employment and Community First CHOICES supports for people with intellectual and developmental disabilities and their family caregivers.',
      source_url: 'https://www.tn.gov/tenncare/long-term-services-supports/employment-and-community-first-choices.html',
      application_url: 'https://www.tn.gov/tenncare/',
    })
    expect(stageOfLifeConflict(HS, ecf)).toBeNull()
    expect(stageOfLifeConflictForSections(ANASTASIA, ecf)).toBeNull()
  })

  it('SILENCE IS NEVER A DENIAL — a row that states no stage is untouched', () => {
    expect(stageOfLifeConflict(HS, { title: 'Bradley County Bar Association Scholarship', sponsor: 'Cleveland State Foundation' })).toBeNull()
    expect(stageOfLifeConflict(HS, {})).toBeNull()
  })

  it('an unknown or unclassified profile stage is NEUTRAL', () => {
    expect(stageOfLifeConflict(null, VANDERBILT_MED)).toBeNull()
    expect(stageOfLifeConflict('', VANDERBILT_MED)).toBeNull()
    expect(stageOfLifeConflict('unclassified', VANDERBILT_MED)).toBeNull()
  })

  it('only PROVABLY impossible stages are barred', () => {
    // A graduating undergraduate applying to grad school is a real applicant.
    expect(stageOfLifeConflict('undergraduate', VANDERBILT_MED)).toBeNull()
    // A returning adult IS an undergraduate.
    expect(stageOfLifeConflict('undergraduate', OSHER_REENTRY)).toBeNull()
    // Nobody holds a doctorate without a bachelor's.
    const postdoc = row({ id: 'row-pd', title: 'NRSA Postdoctoral Fellowship', sponsor: 'NIH' })
    expect(stageOfLifeConflict('undergraduate', postdoc)?.classId).toBe('postdoctoral')
    expect(stageOfLifeConflict('graduate_student', postdoc)).toBeNull()
    expect(stageOfLifeConflict('graduate_student', VANDERBILT_MED)).toBeNull()
  })

  it('derives the stage from SECTIONS through the canonical deriver', () => {
    expect(stageOfLifeConflictForSections(ANASTASIA, VANDERBILT_MED)?.classId).toBe('graduate_or_professional')
    expect(stageOfLifeConflictForSections(NO_STAGE, VANDERBILT_MED)).toBeNull()
    expect(stageOfLifeConflictForSections(ANASTASIA, HOPE)).toBeNull()
  })

  it('never asserts an award IS winnable', () => {
    // The gate's only two outputs are a conflict object or null; there is no
    // "eligible" verdict anywhere in it.
    const verdict = stageOfLifeConflict(HS, HOPE)
    expect(verdict).toBeNull()
    expect(Object.keys(stageOfLifeConflict(HS, VANDERBILT_MED))).toEqual(
      expect.arrayContaining(['classId', 'label', 'phrase', 'field', 'reason']),
    )
  })

  it('tests fragments SEPARATELY so a join cannot fabricate a phrase (#1086)', () => {
    // "…Fellowship" + "Graduate School of Design" as two independent values
    // would read as "Fellowship Graduate" under a bare-space join; neither
    // fragment on its own declares a graduate audience here.
    const split = { title: 'Community Design Fellowship', sponsor: 'Graduate Center Alumni Fund' }
    // sponsor alone DOES say "Graduate Center", which is not in the vocabulary.
    expect(stageOfLifeConflict(HS, split)).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('makeDecision applies the gate at the one choke point', () => {
  const profile = { id: 'p1', primary_type: 'college_student', applicant_type: 'individual', state: 'TN' }

  it('REJECTS a medical-school scholarship for a high-school senior', () => {
    const d = makeDecision(84, profile, VANDERBILT_MED, null, null, null, ANASTASIA)
    expect(d.decision).toBe('REJECT')
    expect(d.explanation).toMatch(/Academic stage/)
    expect(d.explanation).toMatch(/School of Medicine/i)
  })

  it('does NOT reject the state award she can actually receive', () => {
    const d = makeDecision(100, profile, HOPE, null, null, null, ANASTASIA)
    expect(d.decision).not.toBe('REJECT')
  })

  it('says nothing when the caller supplies no sections (MISSING = NEUTRAL)', () => {
    const d = makeDecision(84, profile, VANDERBILT_MED, null, null, null, null)
    expect(d.explanation ?? '').not.toMatch(/Academic stage/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('enforceStageOfLifeMatchScope', () => {
  it('removes the surfaced awards the profile\'s stage cannot receive', async () => {
    const db = makeDb()
    addProfile(db, 'p-ana', ANASTASIA, { display_name: 'Anastasia Nicole White' })
    for (const o of [HOPE, VANDERBILT_MED, OSHER_REENTRY, FWS]) addOpp(db, o)
    addMatch(db, 'm1', 'p-ana', 'row-hope')
    addMatch(db, 'm2', 'p-ana', 'row-vandy')
    addMatch(db, 'm3', 'p-ana', 'row-osher')
    addMatch(db, 'm4', 'p-ana', 'row-fws')
    const res = await enforceStageOfLifeMatchScope(wrap(db))
    expect(res.repaired).toBe(2)
    const left = db.prepare('SELECT opportunity_id FROM profile_opportunity_matches ORDER BY opportunity_id').all()
    expect(left.map((r) => r.opportunity_id)).toEqual(['row-fws', 'row-hope'])
  })

  it('never touches a profile that states no stage', async () => {
    const db = makeDb()
    addProfile(db, 'p-none', NO_STAGE)
    addOpp(db, VANDERBILT_MED)
    addMatch(db, 'm1', 'p-none', 'row-vandy')
    const res = await enforceStageOfLifeMatchScope(wrap(db))
    expect(res.repaired).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM profile_opportunity_matches').get().c).toBe(1)
  })

  it('is idempotent — a second pass repairs nothing', async () => {
    const db = makeDb()
    addProfile(db, 'p-ana', ANASTASIA)
    addOpp(db, VANDERBILT_MED)
    addMatch(db, 'm1', 'p-ana', 'row-vandy')
    expect((await enforceStageOfLifeMatchScope(wrap(db))).repaired).toBe(1)
    expect((await enforceStageOfLifeMatchScope(wrap(db))).repaired).toBe(0)
  })

  it('counts without deleting when ENFORCE_STAGE_OF_LIFE_SCOPE=0', async () => {
    process.env.ENFORCE_STAGE_OF_LIFE_SCOPE = '0'
    const db = makeDb()
    addProfile(db, 'p-ana', ANASTASIA)
    addOpp(db, VANDERBILT_MED)
    addMatch(db, 'm1', 'p-ana', 'row-vandy')
    const res = await enforceStageOfLifeMatchScope(wrap(db))
    expect(res.enforced).toBe(false)
    expect(res.wouldRepair).toBe(1)
    expect(res.repaired).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM profile_opportunity_matches').get().c).toBe(1)
  })

  it('deletes the MATCH, never the catalog row', async () => {
    const db = makeDb()
    addProfile(db, 'p-ana', ANASTASIA)
    addOpp(db, VANDERBILT_MED)
    addMatch(db, 'm1', 'p-ana', 'row-vandy')
    await enforceStageOfLifeMatchScope(wrap(db))
    expect(db.prepare('SELECT COUNT(*) c FROM funding_opportunities').get().c).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('enforceStudentAidInStateRecall', () => {
  const linkRows = (db, id) =>
    db.prepare('SELECT * FROM profile_opportunity_matches WHERE profile_id=? AND matcher_version=?')
      .all(id, 'student-aid-instate-link')

  it('links the TN student to the TN HOPE Scholarship she could never see', async () => {
    const db = makeDb()
    addProfile(db, 'p-ana', ANASTASIA, { display_name: 'Anastasia Nicole White' })
    addOpp(db, HOPE)
    const res = await enforceStudentAidInStateRecall(wrap(db))
    expect(res.repaired).toBe(1)
    const rows = linkRows(db, 'p-ana')
    expect(rows).toHaveLength(1)
    expect(rows[0].opportunity_id).toBe('row-hope')
    expect(JSON.parse(rows[0].match_explain_json).state).toBe('Tennessee')
  })

  it('REFUSES a row the engine rejects — the stage gate is what makes the key safe', async () => {
    const db = makeDb()
    addProfile(db, 'p-ana', ANASTASIA)
    // Both are TN rows whose sponsor names Tennessee; only one is receivable.
    addOpp(db, HOPE)
    addOpp(db, { ...HOPE_NONTRAD, sponsor: 'Tennessee Student Assistance Corporation' })
    const res = await enforceStudentAidInStateRecall(wrap(db))
    expect(res.rejectedByEngine).toBeGreaterThanOrEqual(1)
    expect(linkRows(db, 'p-ana').map((r) => r.opportunity_id)).toEqual(['row-hope'])
  })

  it('does NOT link an in-state row that never NAMES the state (the 208→85 flood cut)', async () => {
    const db = makeDb()
    addProfile(db, 'p-ana', ANASTASIA)
    // Real prod shape: state column says TN, the row is an OHIO college's award.
    addOpp(db, row({
      id: 'row-cuyahoga', title: 'Bessie A. McNair Scholarship', sponsor: 'Cuyahoga Community College',
      description: 'An award for students at Cuyahoga Community College.',
      source_url: 'https://www.tri-c.edu/', application_url: 'https://www.tri-c.edu/',
    }))
    const res = await enforceStudentAidInStateRecall(wrap(db))
    expect(res.repaired).toBe(0)
    expect(linkRows(db, 'p-ana')).toHaveLength(0)
  })

  it('never links a profile that states no academic stage', async () => {
    const db = makeDb()
    addProfile(db, 'p-none', { ...NO_STAGE, basic_information: { ...NO_STAGE.basic_information, location: { state: 'TN', city: 'Cleveland' } } })
    addOpp(db, HOPE)
    const res = await enforceStudentAidInStateRecall(wrap(db))
    expect(res.repaired).toBe(0)
  })

  it('is idempotent — a second pass neither re-links nor deletes', async () => {
    const db = makeDb()
    addProfile(db, 'p-ana', ANASTASIA)
    addOpp(db, HOPE)
    const first = await enforceStudentAidInStateRecall(wrap(db))
    expect(first.repaired).toBe(1)
    const second = await enforceStudentAidInStateRecall(wrap(db))
    expect(second.repaired).toBe(0)
    expect(second.stale).toBe(0)
    expect(linkRows(db, 'p-ana')).toHaveLength(1)
  })

  it('converges: a link the gate no longer authorizes is dropped', async () => {
    const db = makeDb()
    addProfile(db, 'p-ana', ANASTASIA)
    addOpp(db, HOPE)
    await enforceStudentAidInStateRecall(wrap(db))
    expect(linkRows(db, 'p-ana')).toHaveLength(1)
    // The catalog row is deactivated → the gate can no longer authorize it.
    db.prepare('UPDATE funding_opportunities SET is_active = 0 WHERE id = ?').run('row-hope')
    const res = await enforceStudentAidInStateRecall(wrap(db))
    expect(res.stale).toBe(1)
    expect(linkRows(db, 'p-ana')).toHaveLength(0)
  })

  it('counts without writing when ENFORCE_STUDENT_AID_INSTATE_LINK=0', async () => {
    process.env.ENFORCE_STUDENT_AID_INSTATE_LINK = '0'
    const db = makeDb()
    addProfile(db, 'p-ana', ANASTASIA)
    addOpp(db, HOPE)
    const res = await enforceStudentAidInStateRecall(wrap(db))
    expect(res.enforced).toBe(false)
    expect(res.wouldRepair).toBe(1)
    expect(linkRows(db, 'p-ana')).toHaveLength(0)
  })
})
