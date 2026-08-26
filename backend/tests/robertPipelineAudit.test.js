/**
 * robertPipelineAudit.test.js — Robert's four-gate pipeline verifier, exercised
 * against the OWNER'S VERBATIM 2026-08-21 report.
 *
 * Every title in the RECONSTRUCTED_QUEUE below is one the owner read off the
 * production Application Tracker for the profile in the owner's report (150
 * tasks / 105 In Progress) — an individual undergraduate at Middle Tennessee
 * State University in Murfreesboro, Tennessee, studying forensic science and
 * seeking tuition / housing / emergency aid.
 *
 * These are not invented fixtures. The KEEP list is as load-bearing as the
 * REMOVE list: the owner's standing rule is "achieve precision via junk
 * CLASSIFICATION, never by starving recall", so a gate that removes Pell, HOPE,
 * TSAC, FAFSA, the MTSU institutional funds or the Tennessee benefits programs
 * is a BUG, not a success.
 *
 * MUTATION DISCIPLINE: each of the four gates is also exercised with an input
 * it MUST reject and an input it MUST keep. A gate that cannot fail proves
 * nothing — this repo has already shipped dead eligibility gates twice
 * (`matchesAnyPattern` stringifying RegExps; `applicantTypeGate` reading four
 * field names that are not columns).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'b'.repeat(64)

const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')
const audit = await import('../services/robert/robertPipelineAudit.js')

const {
  auditProfilePipeline, gateRelatable, gateQualifies, gateCoversNeed, gateReal,
  programIdentityKey, sameProgram, rankDuplicate, buildAmyNotation, isAmyAutonomousLever,
  loadGapNotesForAmy, GATES,
} = audit

const PROFILE_ID = 'owner-report-2026-08-21-undergrad'

/** Every URL answers 200 unless the test says otherwise. */
const aliveCheckUrl = async () => ({ status: 'ok', code: 200, method: 'head', error: null })

// ---------------------------------------------------------------------------
// The owner's reported queue.
// `remove` names the gate that MUST reject it; `keep: true` means it must
// survive all four.
// ---------------------------------------------------------------------------
const RECONSTRUCTED_QUEUE = [
  // ── WRONG APPLICANT TYPE — institutional awards an individual cannot apply to
  { t: 'FY25 Long Range Broad Agency Announcement (BAA) for Navy and Marine Corps Science and Technology', s: 'Office of Naval Research', ent: ['nonprofit', 'school', 'government', 'business'], remove: GATES.QUALIFIES },
  { t: 'Developmental Sciences', s: 'U.S. National Science Foundation', ent: ['nonprofit', 'school', 'government', 'business'], remove: GATES.QUALIFIES },
  { t: 'The Research on Research Security Program', s: 'U.S. National Science Foundation', ent: ['nonprofit', 'school', 'government', 'business'], remove: GATES.QUALIFIES },
  { t: 'Research Experiences for Undergraduates', s: 'U.S. National Science Foundation', ent: ['nonprofit', 'school', 'government', 'business'], remove: GATES.QUALIFIES },
  { t: 'Conservation Innovation Grants (CIG)', s: 'Natural Resources Conservation Service', ent: ['farm', 'government', 'business', 'nonprofit'], remove: GATES.QUALIFIES },
  { t: 'Federal Transit Administration (FTA) Grant Programs', s: 'U.S. Department of Transportation', ent: ['government', 'tribal', 'nonprofit'], remove: GATES.QUALIFIES },
  { t: 'Economic Development Administration', s: 'U.S. Department of Commerce', ent: ['government', 'tribal', 'nonprofit', 'business'], remove: GATES.QUALIFIES },
  { t: 'HUD Grant Programs', s: 'U.S. Department of Housing and Urban Development', ent: ['government', 'tribal', 'nonprofit'], remove: GATES.QUALIFIES },
  // The six-in-a-row ACL cluster — a whole crawler lane with no applicant gate.
  { t: 'U.S. Administration on Aging, National Resource Centers on Older Indians, Alaska Natives and Native Hawaiian Programs', s: 'Administration for Community Living', ent: ['nonprofit', 'tribal', 'government'], remove: GATES.QUALIFIES },
  { t: 'Strengthening Aging Services for Minority Populations Through Technical Assistance, Resource Development, and Program Coordination', s: 'Administration for Community Living', ent: ['nonprofit', 'government'], remove: GATES.QUALIFIES },
  { t: 'Advancing Strategies to Enhance Preventative Health to Older Adults in the Senior Nutrition Program', s: 'Administration for Community Living', ent: ['nonprofit', 'government'], remove: GATES.QUALIFIES },
  { t: 'UCEDD National Training Initiative to Support Youth with Intellectual and Developmental Disabilities involved with the Juvenile Justice System', s: 'Administration for Community Living', ent: ['school', 'nonprofit'], remove: GATES.QUALIFIES },
  { t: 'Peer Supports for Augmentative and Alternative Communication', s: 'Administration for Community Living', ent: ['nonprofit', 'school'], remove: GATES.QUALIFIES },
  { t: 'Legal Assistance Enhancement Program Grants', s: 'Administration for Community Living', ent: ['nonprofit', 'government'], remove: GATES.QUALIFIES },
  { t: 'NASE Growth Grants', s: 'National Association for the Self-Employed', ent: ['business'], remove: GATES.QUALIFIES },
  { t: 'NeighborWorks America', s: 'NeighborWorks America', ent: ['nonprofit'], remove: GATES.QUALIFIES },

  // ── WRONG GEOGRAPHY (she is in Murfreesboro, Tennessee) ──────────────────
  { t: 'Community Action Agency near Auburn, ME', s: 'Community Action', ent: ['individual', 'family'], remove: GATES.RELATABLE },
  { t: 'Community Action Agency near Russellville, AL', s: 'Community Action', ent: ['individual', 'family'], remove: GATES.RELATABLE },
  { t: 'Community Action Agency near Big Piney, WY', s: 'Community Action', ent: ['individual', 'family'], remove: GATES.RELATABLE },
  { t: 'United Way near Austin, TX', s: 'United Way', ent: ['individual', 'family'], remove: GATES.RELATABLE },

  // ── EXPIRED / STALE — the program's own name says it is over ─────────────
  { t: 'Affordable Connectivity Program (ACP) — Ended May 2024', s: 'FCC', ent: ['individual', 'family'], remove: GATES.REAL },
  { t: 'Community Foundation of Cleveland and Bradley County 2022 Community Grant Cycle', s: 'Community Foundation of Cleveland and Bradley County', ent: ['individual', 'student'], remove: GATES.REAL },

  // ── AGGREGATORS — discovery surfaces, not applications ───────────────────
  { t: 'Scholarships.com — Free Scholarship Search', s: 'Scholarships.com', url: 'https://www.scholarships.com/financial-aid/college-scholarships', ent: ['student'], remove: GATES.RELATABLE, harvest: true },
  { t: 'Fastweb — Room & Board / Housing Scholarships', s: 'Fastweb', url: 'https://www.fastweb.com/college-scholarships/articles/housing', ent: ['student'], remove: GATES.RELATABLE, harvest: true },
  { t: 'Bold.org — No-Essay & Traditional Scholarships', s: 'Bold.org', url: 'https://bold.org/scholarships/', ent: ['student'], remove: GATES.RELATABLE, harvest: true },
  { t: 'Going Merry — Apply to Multiple Scholarships', s: 'Going Merry', url: 'https://www.goingmerry.com/scholarships', ent: ['student'], remove: GATES.RELATABLE, harvest: true },
  { t: 'College Board BigFuture Scholarship Search', s: 'College Board', url: 'https://bigfuture.collegeboard.org/scholarship-search', ent: ['student'], remove: GATES.RELATABLE, harvest: true },
  { t: 'Education Future International Scholarship - USA & Non-USA 2026', s: 'WeMakeScholars', url: 'https://www.wemakescholars.com/other-scholarships-in-gender-studies-to-study-abroad', ent: ['student'], remove: GATES.RELATABLE, harvest: true },

  // ── THE GOOD MATCHES. These MUST survive. ────────────────────────────────
  { t: 'Federal Pell Grant', s: 'Federal Student Aid', ent: ['student', 'family'], cats: ['education'], url: 'https://studentaid.gov/pell', keep: true },
  { t: 'Free Application for Federal Student Aid (FAFSA)', s: 'Federal Student Aid', ent: ['student', 'family'], cats: ['education'], url: 'https://studentaid.gov/fafsa', keep: true },
  { t: 'Tennessee HOPE Scholarship (2026-27)', s: 'Tennessee Student Assistance Corporation', ent: ['student'], cats: ['education'], url: 'https://www.tn.gov/collegepays/hope', keep: true },
  { t: 'Tennessee Student Assistance Award (TSAA)', s: 'Tennessee Student Assistance Corporation', ent: ['student'], cats: ['education'], url: 'https://www.tn.gov/collegepays/tsaa', keep: true },
  { t: 'MTSU Guaranteed Scholarship', s: 'Middle Tennessee State University', ent: ['student'], cats: ['education'], url: 'https://www.mtsu.edu/financial-aid/guaranteed.php', keep: true },
  { t: 'Federal Work-Study at Middle Tennessee State University (2026-27)', s: 'Middle Tennessee State University', ent: ['student', 'family'], cats: ['education'], url: 'https://www.mtsu.edu/financial-aid/work-study.php', keep: true },
  // Benefits programs are NOT "grants" but ARE plausibly right for a needy
  // student — the owner said so explicitly. They must not be swept out.
  { t: 'Supplemental Nutrition Assistance Program (SNAP) — Tennessee', s: 'Tennessee Department of Human Services', ent: ['individual', 'family', 'student'], cats: ['food'], url: 'https://www.tn.gov/humanservices/snap.html', keep: true },
  { t: 'Low Income Home Energy Assistance Program (LIHEAP) — Tennessee', s: 'Tennessee Housing Development Agency', ent: ['individual', 'family'], cats: ['energy', 'housing'], url: 'https://thda.org/liheap', keep: true },
  { t: 'Salvation Army Murfreesboro — Emergency Rent & Utility Assistance', s: 'The Salvation Army', ent: ['individual', 'family'], cats: ['housing'], url: 'https://salvationarmymurfreesboro.org/assistance', keep: true },
]

/** Duplicated program identities the owner listed, for the dedup assertions. */
const DUPLICATE_PAIRS = [
  ['Federal Pell Grant', 'Pell Grant'],
  ['Tennessee Reconnect', 'Tennessee Reconnect Grant'],
  ['QuestBridge National College Match', 'QuestBridge'],
  ['Coca-Cola Scholars Program', 'Coca-Cola Scholars'],
  ['HOPE Scholarship', 'Tennessee HOPE Scholarship (2026-27)'],
]

function seed(rows = RECONSTRUCTED_QUEUE) {
  const sqlite = new Database(':memory:')
  sqlite.dialect = 'sqlite'
  sqlite.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, display_name TEXT, applicant_type TEXT, primary_type TEXT,
      status TEXT, tags TEXT, deleted_at DATETIME
    );
    CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT);
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT, sponsor TEXT, description TEXT,
      eligibility_text TEXT, eligibility_bullets TEXT, entity_types_allowed TEXT,
      need_types_supported TEXT, categories TEXT, keywords TEXT,
      opportunity_kind TEXT, opportunity_type TEXT, funding_category TEXT,
      source TEXT, source_url TEXT, application_url TEXT, apply_url TEXT,
      final_url TEXT, evidence_url TEXT, external_id TEXT, state TEXT,
      is_national INTEGER, deadline TEXT, deadline_type TEXT,
      amount_min REAL, amount_max REAL, amount_text TEXT, is_active INTEGER,
      link_status TEXT, canonical_opportunity_key TEXT
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY, profile_id TEXT, funding_opportunity_id TEXT, title TEXT,
      funder TEXT, status TEXT, deadline TEXT, application_url TEXT, url TEXT,
      amount_requested REAL, match_score REAL, match_decision TEXT,
      fingerprint TEXT, updated_at DATETIME
    );
    CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME);
  `)

  sqlite.prepare(
    'INSERT INTO profiles (id, display_name, primary_type, status, tags) VALUES (?, ?, ?, ?, ?)',
  ).run(PROFILE_ID, 'MTSU Forensic Science Undergraduate', 'college_student', 'active', '[]')

  // What the profile DECLARES — the ground truth every gate reads.
  const sec = sqlite.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
  sec.run(PROFILE_ID, 'basic_information', JSON.stringify({
    first_name: 'Test', last_name: 'Undergraduate',
    city: 'Murfreesboro', state: 'TN', profile_category: 'college_student',
  }))
  sec.run(PROFILE_ID, 'education', JSON.stringify({
    current_institution: 'Middle Tennessee State University',
    intended_major: 'Forensic Science',
    highest_level: 'College Student - Currently in undergraduate program',
  }))
  sec.run(PROFILE_ID, 'financial_information', JSON.stringify({
    needs: ['education', 'housing', 'food'],
  }))

  const fo = sqlite.prepare(`INSERT INTO funding_opportunities
    (id, title, sponsor, entity_types_allowed, categories, opportunity_kind, source, source_url,
     application_url, deadline, deadline_type, is_active, state)
    VALUES (@id, @title, @sponsor, @ent, @cats, @kind, @source, @url, @url, @deadline, NULL, 1, NULL)`)
  const g = sqlite.prepare(`INSERT INTO grants
    (id, profile_id, funding_opportunity_id, title, funder, status, updated_at)
    VALUES (?, ?, ?, ?, ?, 'discovered', '2026-08-20T00:00:00Z')`)

  rows.forEach((r, i) => {
    const id = `fo-${i}`
    fo.run({
      id,
      title: r.t,
      sponsor: r.s ?? null,
      ent: JSON.stringify(r.ent ?? []),
      cats: JSON.stringify(r.cats ?? []),
      kind: r.kind ?? null,
      source: r.source ?? 'test_lane',
      url: r.url ?? `https://example-funder-${i}.org/apply`,
      deadline: r.deadline ?? null,
    })
    g.run(`g-${i}`, PROFILE_ID, id, r.t, r.s ?? null)
  })

  return { sqlite, db: wrapSqlite(sqlite), rows }
}

// ---------------------------------------------------------------------------

describe('robertPipelineAudit — the owner\'s 2026-08-21 queue', () => {
  let db
  let result
  beforeEach(async () => {
    ({ db } = seed())
    result = await auditProfilePipeline(db, PROFILE_ID, { checkUrl: aliveCheckUrl, now: new Date('2026-08-21T12:00:00Z') })
  })

  it('reads the profile\'s declared attributes rather than guessing them', () => {
    expect(result.applicant_type).toBe('college_student')
    expect(result.declared_states).toContain('TN')
    expect(result.declared_needs.length).toBeGreaterThan(0)
  })

  it('BALANCES its accounting — candidates == kept + protected + removed + deduped + unverifiable + failed', () => {
    // The owner's #1 recurring defect is a silent no-op reported as success.
    expect(result.accounting.balanced).toBe(true)
    expect(result.accounting.candidates).toBe(RECONSTRUCTED_QUEUE.length)
  })

  it('removes something — a zero-removal run on THIS queue would be the dead gate', () => {
    expect(result.removed).toBeGreaterThan(20)
  })

  for (const row of RECONSTRUCTED_QUEUE.filter((r) => r.remove)) {
    it(`removes at the ${row.remove} gate: "${row.t.slice(0, 56)}"`, () => {
      const removal = result.removals.find((x) => x.title === row.t)
      expect(removal, `no verdict recorded for "${row.t}"`).toBeTruthy()
      expect(removal.outcome).toBe('removed')
      expect(removal.gate).toBe(row.remove)
      // Every removal is individually inspectable: which gate, on what evidence.
      expect(removal.evidence).toBeTruthy()
    })
  }

  for (const row of RECONSTRUCTED_QUEUE.filter((r) => r.keep)) {
    it(`KEEPS the good match: "${row.t.slice(0, 56)}"`, () => {
      const removal = result.removals.find((x) => x.title === row.t)
      expect(removal, `"${row.t}" was removed — that is a bug in the gates, not a success`).toBeFalsy()
    })
  }

  it('hands aggregators to the decomposer BEFORE removing them (recall is not starved)', () => {
    const harvested = result.harvest_first.map((h) => h.title)
    expect(harvested).toContain('Scholarships.com — Free Scholarship Search')
    expect(harvested).toContain('Bold.org — No-Essay & Traditional Scholarships')
    expect(harvested).toContain('College Board BigFuture Scholarship Search')
  })

  it('reports per-gate and per-reason counts, not a bare total', () => {
    expect(result.removed_by_gate.qualifies).toBeGreaterThan(0)
    expect(result.removed_by_gate.relatable).toBeGreaterThan(0)
    expect(result.removed_by_gate.real).toBeGreaterThan(0)
    expect(Object.keys(result.removed_by_reason).length).toBeGreaterThan(1)
  })
})

// ---------------------------------------------------------------------------
// Each gate must be able to REJECT. A check that cannot fail proves nothing.
// ---------------------------------------------------------------------------

describe('every gate can actually reject, and can actually pass', () => {
  const facts = {
    profileId: PROFILE_ID,
    profile: { id: PROFILE_ID, primary_type: 'college_student' },
    sections: { basic_information: { state: 'TN', profile_category: 'college_student' } },
    applicantType: 'college_student',
    states: ['TN'],
    needs: ['education', 'housing'],
  }

  it('RELATABLE rejects a scholarship search engine and passes a real award', () => {
    const aggregator = { title: 'Scholarships.com — Free Scholarship Search', source_url: 'https://www.scholarships.com/x', application_url: 'https://www.scholarships.com/x', opportunity_kind: 'directory' }
    expect(gateRelatable(aggregator).pass).toBe(false)
    expect(gateRelatable(aggregator).harvest_first).toBe(true)
    const real = { title: 'AFTE Forensic Science Scholarship', sponsor: 'AFTE', application_url: 'https://afte.org/scholarship', deadline: '2026-12-01' }
    expect(gateRelatable(real).pass).toBe(true)
  })

  it('QUALIFIES rejects an institutional NOFO and passes Pell', () => {
    const nofo = { title: 'Developmental Sciences', sponsor: 'U.S. National Science Foundation', entity_types_allowed: '["nonprofit","school","government","business"]' }
    expect(gateQualifies(nofo, facts).pass).toBe(false)
    const pell = { title: 'Federal Pell Grant', sponsor: 'Federal Student Aid', entity_types_allowed: '["student","family"]' }
    expect(gateQualifies(pell, facts).pass).toBe(true)
  })

  it('QUALIFIES rejects an ACADEMIC-STAGE mismatch (a postdoctoral award for an undergraduate) via the stage-of-life gate', () => {
    const undergradFacts = {
      ...facts,
      sections: { basic_information: { state: 'TN', profile_category: 'college_student', academic_status: { education_level: 'College Freshman (incoming), Associate degree earned May 2026' } } },
    }
    const postdoc = { title: 'Postdoctoral Research Fellowship', sponsor: 'Example Foundation', eligibility_text: 'Open to postdoctoral scholars only.', entity_types_allowed: '["individual"]' }
    const verdict = gateQualifies(postdoc, undergradFacts)
    expect(verdict.pass).toBe(false)
    expect(verdict.evidence.gate).toBe('stage_of_life')
    // A row with NO stage-declaring text is neutral (missing = neutral).
    const plain = { title: 'General Community Scholarship', sponsor: 'Example', entity_types_allowed: '["individual"]' }
    expect(gateQualifies(plain, undergradFacts).pass).toBe(true)
  })

  it('QUALIFIES rejects an out-of-state place-declaring row and keeps an in-state one', () => {
    const outOfState = { title: 'Polk County, GA — Local assistance programs', sponsor: 'Findhelp', entity_types_allowed: '["individual"]' }
    expect(gateQualifies(outOfState, facts).pass).toBe(false)
    const inState = { title: 'Rutherford County, TN — Local assistance programs', sponsor: 'Findhelp', entity_types_allowed: '["individual"]' }
    expect(gateQualifies(inState, facts).pass).toBe(true)
  })

  it('COVERS_NEED rejects an unrelated need and accepts PARTIAL coverage', () => {
    // A CANONICAL need the profile did not declare. A NON-canonical category
    // ("animal_welfare") is silence, not contradiction, and correctly passes —
    // the gate only fires on a need vocabulary it can actually compare.
    const unrelated = { title: 'Rural Transit Rider Assistance', categories: '["transportation"]' }
    expect(gateCoversNeed(unrelated, facts).pass).toBe(false)
    // "at least PART" is the owner's explicit bar — one overlapping need is enough.
    const partial = { title: 'Campus Book Voucher', categories: '["education"]' }
    expect(gateCoversNeed(partial, facts).pass).toBe(true)
  })

  it('COVERS_NEED is NEUTRAL when the profile declares nothing (silence never deletes)', () => {
    const blank = { ...facts, needs: [] }
    expect(gateCoversNeed({ title: 'Anything', categories: '["transportation"]' }, blank).pass).toBe(true)
  })

  it('REAL rejects a 404 and passes a live page', async () => {
    const row = { title: 'Some Program', application_url: 'https://example.org/gone' }
    const dead = await gateReal(row, { checkUrl: async () => ({ status: 'broken', code: 404 }), attempts: 1 })
    expect(dead.pass).toBe(false)
    const alive = await gateReal(row, { checkUrl: aliveCheckUrl, attempts: 1 })
    expect(alive.pass).toBe(true)
  })

  it('REAL rejects a program whose own title says it ended', async () => {
    const row = { title: 'Affordable Connectivity Program (ACP) — Ended May 2024', application_url: 'https://fcc.gov/acp' }
    const v = await gateReal(row, { checkUrl: aliveCheckUrl, now: new Date('2026-08-21') })
    expect(v.pass).toBe(false)
    expect(String(v.evidence.detail)).toContain('ended')
  })

  it('REAL calls a 503 UNVERIFIABLE — it never deletes a grant because a server had a bad afternoon', async () => {
    const row = { title: 'Real Grant', application_url: 'https://example.org/live' }
    const v = await gateReal(row, { checkUrl: async () => ({ status: 'broken', code: 503 }), attempts: 2 })
    expect(v.unverifiable).toBe(true)
    expect(v.pass).toBeUndefined()
  })

  it('REAL calls a TIMEOUT unverifiable, not dead', async () => {
    const v = await gateReal(
      { title: 'Real Grant', application_url: 'https://example.org/slow' },
      { checkUrl: async () => ({ status: 'broken', code: null, error: 'timeout' }), attempts: 2 },
    )
    expect(v.unverifiable).toBe(true)
  })
})

describe('an unverifiable row STAYS in the pipeline and is reported separately', () => {
  it('keeps it, counts it, and never records a removal for it', async () => {
    const { db } = seed([
      { t: 'Real But Unreachable Grant', s: 'Some Funder', ent: ['student'], cats: ['education'], url: 'https://example.org/slow' },
    ])
    const res = await auditProfilePipeline(db, PROFILE_ID, {
      checkUrl: async () => ({ status: 'broken', code: 503, error: 'Service Unavailable' }),
    })
    expect(res.unverifiable).toBe(1)
    expect(res.removed).toBe(0)
    expect(res.accounting.balanced).toBe(true)
    expect(res.removals[0].outcome).toBe('unverifiable')
  })
})

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

describe('dedup collapses PROGRAM IDENTITY, not exact title strings', () => {
  for (const [a, b] of DUPLICATE_PAIRS) {
    it(`"${a}" and "${b}" are one program`, () => {
      expect(sameProgram({ title: a, grant_id: 'x' }, { title: b, grant_id: 'y' })).toBe(true)
    })
  }

  it('does NOT collapse two genuinely different programs', () => {
    const pairs = [
      ['Federal Pell Grant', 'Federal Work-Study'],
      ['Tennessee HOPE Scholarship', 'Tennessee Promise Scholarship'],
      ['Tennessee HOPE Scholarship', 'Tennessee Reconnect Grant'],
      // A shared SURNAME is a coincidence, not an identity — the lone-token
      // length floor is what stops this one.
      ['Gates Scholarship', 'Gates Millennium Scholars'],
      // A shared brand prefix before " - " is not identity — Heating vs Cooling
      // (and Rent vs Utilities) are different awards under one funder brand.
      ['HEAP - Heating Assistance', 'HEAP - Cooling Assistance'],
      ['Emergency Assistance - Rent', 'Emergency Assistance - Utilities'],
    ]
    for (const [a, b] of pairs) {
      expect(sameProgram({ title: a, grant_id: 'a' }, { title: b, grant_id: 'b' }), `${a} vs ${b}`).toBe(false)
    }
  })

  it('prefers the real funder URL over an aggregator mirror', () => {
    const funder = { title: 'Coca-Cola Scholars', application_url: 'https://www.coca-colascholarsfoundation.org/apply', funding_opportunity_id: 'fo1', sponsor: 'Coca-Cola Scholars Foundation' }
    const mirror = { title: 'Coca-Cola Scholars Program', application_url: 'https://bold.org/scholarships/coca-cola', funding_opportunity_id: 'fo2', sponsor: 'Bold.org' }
    expect(rankDuplicate(funder)[0]).toBeGreaterThan(rankDuplicate(mirror)[0])
  })

  it('keeps exactly ONE of a duplicated pair and removes the other with a DUPLICATE reason', async () => {
    const { db } = seed([
      { t: 'Federal Pell Grant', s: 'Federal Student Aid', ent: ['student'], cats: ['education'], url: 'https://studentaid.gov/pell' },
      { t: 'Pell Grant', s: 'U.S. Department of Education', ent: ['student'], cats: ['education'], url: 'https://www2.ed.gov/pell' },
    ])
    const res = await auditProfilePipeline(db, PROFILE_ID, { checkUrl: aliveCheckUrl })
    expect(res.kept).toBe(1)
    expect(res.deduped_away).toBe(1)
    expect(res.removals.find((r) => r.outcome === 'deduped').reason).toBe('duplicate')
    expect(res.accounting.balanced).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Protections
// ---------------------------------------------------------------------------

describe('protections that must never be overridden', () => {
  it('never touches the Sasquatch PromoPilot test profile', async () => {
    const { sqlite, db } = seed([{ t: 'Developmental Sciences', s: 'NSF', ent: ['nonprofit'] }])
    sqlite.prepare('UPDATE profiles SET display_name = ? WHERE id = ?').run('Sasquatch Conservancy', PROFILE_ID)
    const res = await auditProfilePipeline(db, PROFILE_ID, { checkUrl: aliveCheckUrl })
    expect(res.skipped).toBe('protected_profile_sasquatch')
    expect(res.removed).toBe(0)
  })

  it('never auto-removes a row a human has already progressed', async () => {
    const { sqlite, db } = seed([{ t: 'Developmental Sciences', s: 'NSF', ent: ['nonprofit', 'school'] }])
    sqlite.prepare("UPDATE grants SET status = 'submitted'").run()
    const res = await auditProfilePipeline(db, PROFILE_ID, { checkUrl: aliveCheckUrl })
    expect(res.protected).toBe(1)
    expect(res.removed).toBe(0)
    expect(res.accounting.balanced).toBe(true)
  })

  it('records a REVERSIBLE tombstone rather than hard-deleting the row', async () => {
    const { sqlite, db } = seed([{ t: 'Developmental Sciences', s: 'NSF', ent: ['nonprofit', 'school'] }])
    await auditProfilePipeline(db, PROFILE_ID, { checkUrl: aliveCheckUrl })
    const tombstones = sqlite.prepare("SELECT * FROM pipeline_dismissals").all()
    expect(tombstones.length).toBe(1)
    expect(String(tombstones[0].reason)).toContain('robert_pipeline_audit:qualifies')
  })
})

// ---------------------------------------------------------------------------
// The Amy handoff — and the autonomy boundary
// ---------------------------------------------------------------------------

describe('the Amy notation lands on the correct side of the autonomy boundary', () => {
  const facts = { profileId: PROFILE_ID, displayName: 'MTSU Forensic Science Undergraduate', needs: ['education', 'housing'] }
  const row = { grant_id: 'g1', title: 'Developmental Sciences', sponsor: 'NSF', source: 'grants_gov', source_url: 'https://grants.gov/x' }

  it('an ELIGIBILITY failure is a CODE BRIEF — never a lever Amy may auto-apply', () => {
    const note = buildAmyNotation({ facts, row, gate: GATES.QUALIFIES, verdict: { reason: 'profile_mismatch', evidence: { gate: 'applicant_type' } } })
    expect(note.channel).toBe('code_brief')
    expect(note.requires_code_change).toBe(true)
    expect(isAmyAutonomousLever(note.lever)).toBe(false)
    expect(note.code_brief.patch_authored_by_amy).toBe(false)
  })

  it('a GEO failure is a CODE BRIEF too — geo is matching logic', () => {
    const note = buildAmyNotation({ facts, row, gate: GATES.QUALIFIES, verdict: { reason: 'profile_mismatch', evidence: { gate: 'geo' } } })
    expect(note.lever).toBe('geo_scope')
    expect(note.channel).toBe('code_brief')
    expect(isAmyAutonomousLever('geo_scope')).toBe(false)
  })

  it('a COVERAGE gap IS Amy\'s to close — and carries the unmet need + the lane that produced the junk', () => {
    const note = buildAmyNotation({ facts, row, gate: GATES.COVERS_NEED, verdict: { reason: 'profile_mismatch', evidence: { gate: 'covers_need' } } })
    expect(note.channel).toBe('amy_lever')
    expect(isAmyAutonomousLever(note.lever)).toBe(true)
    expect(note.unmet_needs).toEqual(['education', 'housing'])
    expect(note.search_surface.source).toBe('grants_gov')
    expect(note.profile_id).toBe(PROFILE_ID)
  })

  it('NO removal ever hands Amy an autonomy-forbidden lever', async () => {
    const { db } = seed()
    const res = await auditProfilePipeline(db, PROFILE_ID, { checkUrl: aliveCheckUrl, now: new Date('2026-08-21T12:00:00Z') })
    const amyLane = res.notes.filter((n) => n.channel === 'amy_lever')
    expect(amyLane.length + res.notes.filter((n) => n.channel === 'code_brief').length).toBe(res.notes.length)
    for (const note of amyLane) {
      expect(isAmyAutonomousLever(note.lever), `${note.lever} reached Amy's autonomous lane`).toBe(true)
    }
  })

  it('persists the notation where Amy\'s approval queue reads it (not a write-only queue)', async () => {
    const { db } = seed()
    await auditProfilePipeline(db, PROFILE_ID, { checkUrl: aliveCheckUrl, runId: 'run-1', now: new Date('2026-08-21T12:00:00Z') })
    const gaps = await loadGapNotesForAmy(db)
    expect(gaps.total_open).toBeGreaterThan(0)
    expect(gaps.amy_levers.length + gaps.code_briefs.length).toBe(gaps.total_open)
  })
})
