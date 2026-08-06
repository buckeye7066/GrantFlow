/**
 * A profile's DECLARED field of study must reach the catalog rows that name it,
 * and a household's DECLINED aid type must never reach it anywhere.
 *
 * Every fixture below is a REAL prod row or profile field, read read-only on
 * 2026-08-02 against Demo Tennessee STEM Student (`00000000-0000-4000-8000-000000000001`):
 *
 *   • `education.intended_major` = "Forensic Science";
 *     `education.interests` = [Forensic Science, Criminal Justice, STEM,
 *     DNA Analysis, Crime Scene Investigation].
 *   • The catalog holds 13 active forensic rows and 12 active criminal-justice
 *     rows. She carried a match row for exactly ONE of each.
 *   • Replaying the REAL `services/matchEngine.computeMatchDecision` on the
 *     pairs nobody had ever scored returns ACCEPT 83 for "AFTE Forensic Science
 *     Scholarship", ACCEPT 79 for "Floyd E. McDonald Scholarship" and ACCEPT 79
 *     for "Johnson-Whyte Memorial Foundation Fund Scholarship". The ENGINE was
 *     never the drop point — there was simply no key that could reach a
 *     topically-relevant row.
 *   • `education.aid_types_accepted` = ["grant","endowment","scholarship"] — no
 *     work-study, no loans — and "Federal Work-Study" sat in her Funding Sources
 *     list as an ACCEPT at score 100, plus two Federal Work-Study pipeline rows.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { DERIVED_FACT_FIELDS, titleStatesTerm } from '../config/profileDerivedFacts.js'
import { SURFACED_MATCHER_VERSIONS } from '../config/matchSurfacing.js'
import { enforceDeclaredFieldOfStudyRecall } from '../startup/enforceInvariants.js'
import { makeDecision } from '../services/matchEngine.js'
import { evaluateOpportunityAgainstPreferences } from '../config/aidTypePreferences.js'
import { buildThesis } from '../crawler-os/profileIntelligence.js'
import { buildWebQueries } from '../crawler-os/webQueries.js'

const LINK_VERSION = 'field-of-study-link'

const demo_stem_student = {
  basic_information: {
    first_name: 'Demo Student',
    location: { city: 'Cleveland', state: 'TN', county: 'Bradley County', zip_code: '37312' },
    academic_status: { gpa: 3.84, act_score: 28, education_level: 'High School Senior', college_courses: 'Yes' },
  },
  education: {
    current_institution: 'Middle Tennessee State University',
    intended_major: 'Forensic Science',
    interests: ['Forensic Science', 'Criminal Justice', 'STEM', 'DNA Analysis', 'Crime Scene Investigation'],
    aid_types_accepted: ['grant', 'endowment', 'scholarship'],
    pell_grant_eligible: true,
  },
  financial: { funding_needs: ['education'] },
}

/** A profile that declares NO field of study — must never be linked by this gate. */
const NO_FIELD = {
  basic_information: { first_name: 'Ruth', location: { city: 'El Paso', state: 'TX', zip_code: '79901' } },
  education: {},
  financial: { funding_needs: ['housing'] },
}

// ── Real prod catalog rows ───────────────────────────────────────────────────
const AFTE = {
  id: 'row-afte', title: 'AFTE Forensic Science Scholarship',
  sponsor: 'Association of Firearm and Tool Mark Examiners',
  state: null, is_national: 1, opportunity_kind: 'direct', source: 'web_search',
  source_url: 'https://afte.org/resources/scholarships',
  application_url: 'https://afte.org/resources/scholarships', is_active: 1,
}
/** The subject is in the SPONSOR, not the title — a person's name is the title. */
const MCDONALD = {
  id: 'row-mcdonald', title: 'Floyd E. McDonald Scholarship',
  sponsor: 'Southwestern Association of Forensic Science',
  state: null, is_national: 1, opportunity_kind: 'direct', source: 'web_search',
  source_url: 'https://swafs.us/scholarships',
  application_url: 'https://swafs.us/scholarships', is_active: 1,
}
const CJ_DIRECTORY = {
  id: 'row-cj-dir', title: 'Criminal Justice & Forensics Scholarship Directory',
  sponsor: 'National Program',
  state: 'nationwide', is_national: 1, opportunity_kind: 'directory', source: 'verified_real',
  source_url: 'https://www.criminaljusticeprogramsdirectory.org/scholarships',
  application_url: 'https://www.criminaljusticeprogramsdirectory.org/scholarships', is_active: 1,
}
/**
 * The false positive the DESCRIPTION haystack would have admitted: a housing
 * scholarship whose page merely MENTIONS forensic science. Title and sponsor
 * say nothing about the subject, so this gate must not reach it.
 */
const BOLD_HOUSING = {
  id: 'row-bold', title: 'Bold.org — Housing & Living Expense Scholarships',
  sponsor: 'National Program',
  description: 'Awards for students in many fields including forensic science, nursing and education.',
  state: 'nationwide', is_national: 1, opportunity_kind: 'directory', source: 'curated_benefits',
  source_url: 'https://bold.org/scholarships/housing/',
  application_url: 'https://bold.org/scholarships/housing/', is_active: 1,
}
/** Token-boundary guard: "science" must not reach every STEM row. */
const GENERIC_STEM = {
  id: 'row-stem', title: 'National Science Foundation STEM Scholarships',
  sponsor: 'National Science Foundation',
  state: 'nationwide', is_national: 1, opportunity_kind: 'direct', source: 'grants_gov',
  source_url: 'https://www.nsf.gov/funding/', application_url: 'https://www.nsf.gov/funding/', is_active: 1,
}
/** The declined aid type, verbatim from her live Funding Sources list. */
const FWS = {
  id: 'row-fws', title: 'Federal Work-Study',
  sponsor: 'U.S. Department of Education',
  state: 'nationwide', is_national: 1, opportunity_kind: 'benefit', source: 'studentaid_gov',
  source_url: 'https://studentaid.gov/understand-aid/types/work-study',
  application_url: 'https://studentaid.gov/h/apply-for-aid/fafsa', is_active: 1,
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
    id, extra.display_name ?? id, extra.primary_type ?? 'college_student',
    extra.applicant_type ?? 'individual', extra.status ?? 'active',
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
        source_url, application_url, is_active, profile_id)
     VALUES (@id, @title, @sponsor, @description, @state, @is_national, @opportunity_kind,
             @source, @source_url, @application_url, @is_active, @profile_id)`,
  ).run({ description: null, profile_id: null, ...o })
}

const linkRows = (db, profileId) =>
  db.prepare('SELECT * FROM profile_opportunity_matches WHERE profile_id = ? AND matcher_version = ?')
    .all(profileId, LINK_VERSION)

const wrap = (db) => ({ dialect: 'sqlite', prepare: (sql) => db.prepare(sql) })

let ENV_SNAPSHOT
beforeEach(() => { ENV_SNAPSHOT = { ...process.env } })
afterEach(() => { process.env = ENV_SNAPSHOT })

// ─────────────────────────────────────────────────────────────────────────────
describe('enforceDeclaredFieldOfStudyRecall', () => {
  it('links the forensic scholarship the student could never see', async () => {
    const db = makeDb()
    addProfile(db, 'p-ana', demo_stem_student, { display_name: 'Demo Tennessee STEM Student' })
    addOpp(db, AFTE)
    const res = await enforceDeclaredFieldOfStudyRecall(wrap(db))
    expect(res.repaired).toBe(1)
    const rows = linkRows(db, 'p-ana')
    expect(rows).toHaveLength(1)
    expect(rows[0].opportunity_id).toBe('row-afte')
    expect(['accept', 'review']).toContain(rows[0].match_decision)
  })

  it('reaches a row whose subject is in the SPONSOR, not the title', async () => {
    // "Floyd E. McDonald Scholarship" is named after a person; only the sponsor
    // says forensic science. Title-only would have missed it (ACCEPT 79 in prod).
    const db = makeDb()
    addProfile(db, 'p-ana', demo_stem_student)
    addOpp(db, MCDONALD)
    const res = await enforceDeclaredFieldOfStudyRecall(wrap(db))
    expect(res.repaired).toBe(1)
    expect(linkRows(db, 'p-ana')[0].opportunity_id).toBe('row-mcdonald')
  })

  it('records WHICH profile field authorized the look', async () => {
    const db = makeDb()
    addProfile(db, 'p-ana', demo_stem_student)
    addOpp(db, AFTE)
    await enforceDeclaredFieldOfStudyRecall(wrap(db))
    const explain = JSON.parse(linkRows(db, 'p-ana')[0].match_explain_json)
    expect(explain.gate).toBe('declared_field_of_study')
    expect(explain.term).toBe('forensic science')
    expect(explain.evidence).toBe('education.intended_major')
    // Provenance must name a REGISTRY field, not a free string.
    expect(DERIVED_FACT_FIELDS.map((f) => f.id)).toContain(explain.evidence)
  })

  it('NEVER reaches a row that only MENTIONS the subject in its description', async () => {
    // The precision rule: title + sponsor are curated identity fields;
    // `description` is unbounded prose (the #1089 "evidence is the SPONSOR
    // only" doctrine). Admitting it made a housing scholarship a forensic row.
    const db = makeDb()
    addProfile(db, 'p-ana', demo_stem_student)
    addOpp(db, BOLD_HOUSING)
    const res = await enforceDeclaredFieldOfStudyRecall(wrap(db))
    // The row never even reaches the adjudicator: the exclusion is enforced
    // TWICE — the SQL superset only LIKEs title+sponsor, and the JS haystack is
    // title+sponsor. Asserting `repaired === 0` alone would be a check that
    // cannot fail (the engine might reject the row anyway), so assert the
    // adjudicator never saw it AND prove the exclusion is load-bearing: the
    // term IS present in the description and WOULD have matched.
    expect(res.scanned).toBe(0)
    expect(res.repaired).toBe(0)
    expect(linkRows(db, 'p-ana')).toHaveLength(0)
    expect(titleStatesTerm('forensic science', `${BOLD_HOUSING.title} ${BOLD_HOUSING.sponsor}`)).toBe(false)
    expect(titleStatesTerm('forensic science', `${BOLD_HOUSING.title} ${BOLD_HOUSING.sponsor} ${BOLD_HOUSING.description}`)).toBe(true)
  })

  it('a single generic word never becomes a key ("science" ⊄ 258 STEM rows)', async () => {
    const db = makeDb()
    addProfile(db, 'p-ana', demo_stem_student)
    addOpp(db, GENERIC_STEM)
    const res = await enforceDeclaredFieldOfStudyRecall(wrap(db))
    expect(res.repaired).toBe(0)
  })

  it('a profile that declares NO field of study is never linked', async () => {
    const db = makeDb()
    addProfile(db, 'p-ruth', NO_FIELD, { display_name: 'Ruth Alvarez' })
    addOpp(db, AFTE); addOpp(db, CJ_DIRECTORY)
    const res = await enforceDeclaredFieldOfStudyRecall(wrap(db))
    expect(res.repaired).toBe(0)
    expect(res.profilesWithTerms).toBe(0)
  })

  it('is IDEMPOTENT — a second boot writes nothing new', async () => {
    const db = makeDb()
    addProfile(db, 'p-ana', demo_stem_student)
    addOpp(db, AFTE); addOpp(db, MCDONALD)
    const first = await enforceDeclaredFieldOfStudyRecall(wrap(db))
    expect(first.repaired).toBe(2)
    const second = await enforceDeclaredFieldOfStudyRecall(wrap(db))
    expect(second.repaired).toBe(0)
    expect(second.scanned).toBe(0)
    expect(linkRows(db, 'p-ana')).toHaveLength(2)
  })

  it('CONVERGES: a link the gate no longer authorizes is dropped', async () => {
    const db = makeDb()
    addProfile(db, 'p-ana', demo_stem_student)
    addOpp(db, AFTE)
    await enforceDeclaredFieldOfStudyRecall(wrap(db))
    expect(linkRows(db, 'p-ana')).toHaveLength(1)
    // The student changes major; the forensic link must not survive.
    db.prepare('UPDATE profile_sections SET data = ? WHERE profile_id = ? AND section_key = ?')
      .run(JSON.stringify({ ...demo_stem_student.education, intended_major: 'Accounting', interests: ['Accounting'] }), 'p-ana', 'education')
    const res = await enforceDeclaredFieldOfStudyRecall(wrap(db))
    expect(res.stale).toBe(1)
    expect(linkRows(db, 'p-ana')).toHaveLength(0)
  })

  it('never writes an engine REJECT', async () => {
    const db = makeDb()
    addProfile(db, 'p-ana', demo_stem_student)
    // A forensic row that is categorically unavailable: a foreign-jurisdiction
    // host (#1080's gate) — the engine REJECTs, so the sweep must not link.
    addOpp(db, {
      ...AFTE, id: 'row-foreign', title: 'Forensic Science Bursary',
      source_url: 'https://www.gov.uk/forensic-science-bursary',
      application_url: 'https://www.gov.uk/forensic-science-bursary',
    })
    const res = await enforceDeclaredFieldOfStudyRecall(wrap(db))
    expect(res.repaired).toBe(0)
    expect(res.rejectedByEngine).toBeGreaterThan(0)
  })

  it('ENFORCE_FIELD_OF_STUDY_LINK=0 counts without writing', async () => {
    const db = makeDb()
    addProfile(db, 'p-ana', demo_stem_student)
    addOpp(db, AFTE)
    process.env.ENFORCE_FIELD_OF_STUDY_LINK = '0'
    const res = await enforceDeclaredFieldOfStudyRecall(wrap(db))
    expect(res.enforced).toBe(false)
    expect(res.wouldRepair).toBe(1)
    expect(res.repaired).toBe(0)
    expect(linkRows(db, 'p-ana')).toHaveLength(0)
  })

  it('an inactive catalog row is never linked', async () => {
    const db = makeDb()
    addProfile(db, 'p-ana', demo_stem_student)
    addOpp(db, { ...AFTE, is_active: 0 })
    expect((await enforceDeclaredFieldOfStudyRecall(wrap(db))).repaired).toBe(0)
  })

  it('the LIKE superset is adjudicated by token boundary, not trusted', async () => {
    // `%dna analysis%` is a substring predicate; a row that survives it but
    // fails the boundary rule must be counted OUT, never linked.
    const db = makeDb()
    addProfile(db, 'p-ana', demo_stem_student)
    addOpp(db, {
      ...AFTE, id: 'row-boundary', title: 'Grand NA Analysis Fellowship',
      sponsor: 'Unrelated Foundation',
    })
    const res = await enforceDeclaredFieldOfStudyRecall(wrap(db))
    expect(res.repaired).toBe(0)
  })

  it('its matcher_version is SURFACED — persisting under an unread version is the web-llm bug', () => {
    expect(SURFACED_MATCHER_VERSIONS).toContain(LINK_VERSION)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('the derived facts REACH query building (the wiring, not just the module)', () => {
  it('buildThesis prefers derived terms over the unranked mined bag', () => {
    // THE REGRESSION, verbatim from prod 2026-08-02: `tags` is
    // `signals.keywords`, an unranked 453-entry bag whose first twelve entries
    // were Demo Student's name and gender synonyms. `buildThesis` sliced twelve off
    // the front, so her declared major never reached a single search.
    const minedBagAsProdHadIt = [
      'student', 'demo_stem_student', 'nicole', 'white', 'female', 'woman', 'women',
      'girls', 'female-led', 'led', 'female identifying', 'identifying',
      'young adult', 'forensic science', 'criminal justice',
    ]
    const thesis = buildThesis({
      id: 'p-ana',
      profile_type: 'student',
      tags: minedBagAsProdHadIt,
      derived_interest_terms: ['forensic science', 'criminal justice', 'dna analysis'],
      location: { state: 'TN', city: 'Cleveland' },
      sections: [],
    })
    expect(thesis.interest_terms.slice(0, 3)).toEqual(['forensic science', 'criminal justice', 'dna analysis'])
    // Every mined-bag entry that survives at all now ranks BELOW the derived
    // terms; the ones the bound drops are the weakest evidence, not the major.
    for (const junk of ['demo_stem_student', 'nicole', 'white', 'female']) {
      const at = thesis.interest_terms.indexOf(junk)
      if (at >= 0) expect(at).toBeGreaterThan(thesis.interest_terms.indexOf('dna analysis'))
    }
  })

  it("a declared topic reaches the CORE query set, which the per-run cap cannot truncate", () => {
    // The interest-keyed queries live in the ROTATED EXTRA pool and the final
    // `.slice(0, max)` truncates from the END. Measured on Demo Student's live
    // profile: at the live cap (maxQueries 14) all fourteen executed queries
    // were school/geo CORE and ZERO were topical.
    const thesis = buildThesis({
      id: 'p-ana',
      profile_type: 'student',
      derived_interest_terms: ['forensic science', 'criminal justice'],
      schools: ['Middle Tennessee State University', 'Cleveland State Community College'],
      field_of_study: 'Forensic Science',
      location: { state: 'TN', city: 'Cleveland', county: 'Bradley' },
      sections: [],
    })
    const queries = buildWebQueries(thesis, { max: 14, seed: 0, year: 2026 })
    expect(queries).toContain('criminal justice scholarships 2026')
    // And it survives EVERY rotation of the broadening pool — CORE is never rotated.
    for (const seed of [0, 3, 7, 11, 97]) {
      expect(buildWebQueries(thesis, { max: 14, seed, year: 2026 }))
        .toContain('criminal justice scholarships 2026')
    }
  })

  it('a profile with NO declared topic gains no topical query', () => {
    const thesis = buildThesis({
      id: 'p-none', profile_type: 'student', derived_interest_terms: [],
      location: { state: 'TX', city: 'El Paso' }, sections: [],
    })
    const queries = buildWebQueries(thesis, { max: 14, seed: 0, year: 2026 })
    expect(queries.some((q) => /scholarships 2026$/.test(q) && !/^scholarships/.test(q))).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('the DECLINED aid type is refused at the matching choke point', () => {
  const anaProfile = { id: 'p-ana', primary_type: 'college_student', state: 'TN' }

  it('Federal Work-Study is REJECTED for a student who declined work-study', () => {
    const d = makeDecision(100, anaProfile, FWS, null, null, null, demo_stem_student)
    expect(d.decision).toBe('REJECT')
    expect(d.explanation).toMatch(/does not accept Work-study/i)
  })

  it('the same row is NOT rejected for a profile that stated no preference', () => {
    // The default is "everything except debt" — an absent section must never
    // manufacture an exclusion.
    const d = makeDecision(100, anaProfile, FWS, null, null, null, { education: {} })
    expect(d.decision).not.toBe('REJECT')
  })

  it('nothing at all in `sections` is neutral, not exclusionary', () => {
    const d = makeDecision(100, anaProfile, FWS, null, null, null, null)
    expect(d.decision).not.toBe('REJECT')
  })

  it('a scholarship she DOES accept still passes the gate', () => {
    const d = makeDecision(83, anaProfile, AFTE, null, null, null, demo_stem_student)
    expect(d.decision).not.toBe('REJECT')
  })

  it('classification reads the TITLE, never the description prose', () => {
    // A scholarship page that merely MENTIONS work-study must not be denied.
    const mentions = {
      title: 'Cleveland State Community College Nursing Scholarship',
      description: 'Recipients may also be offered federal work-study and a direct subsidized loan.',
    }
    expect(evaluateOpportunityAgainstPreferences(mentions, demo_stem_student.education).accepted).toBe(true)
    expect(evaluateOpportunityAgainstPreferences({ title: 'Federal Work-Study' }, demo_stem_student.education).accepted).toBe(false)
  })

  it('an unnamed aid type is never excluded', () => {
    expect(evaluateOpportunityAgainstPreferences({ title: 'Bradley County Bar Association Award' }, demo_stem_student.education).aidType)
      .toBe('unknown')
    expect(evaluateOpportunityAgainstPreferences({ title: 'Bradley County Bar Association Award' }, demo_stem_student.education).accepted)
      .toBe(true)
  })
})
