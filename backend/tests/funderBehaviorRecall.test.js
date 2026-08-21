/**
 * enforceFunderBehaviorRecall — a funder whose OWN filed grant list shows
 * in-state giving for a need the profile DECLARES is put in front of the
 * canonical engine; only the engine's ACCEPT or REVIEW is written (a funder
 * row structurally lacks an apply_url — the 990 lane never invents one — so
 * the engine downgrades an otherwise-ACCEPT pair to REVIEW for exactly that
 * missing URL; measured live 2026-08-05: REVIEW 11, "Downgraded from ACCEPT
 * — missing application URL"). A REJECT is never written.
 *
 * The engine here is the REAL `computeMatchDecision` (the crisisNeedRecall
 * posture): fixtures are shaped like the real rows the 990 lane + ingest
 * produce — a `propublica_990` PROGRAM row whose description carries the
 * ingest's giving line and whose categories carry the purposes' evidenced
 * needs — so an ACCEPT in this file is the engine's real verdict on the real
 * shape, not a mock's.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { SURFACED_MATCHER_VERSIONS } from '../config/matchSurfacing.js'
import { REVIEW_SCORE } from '../config/matchThresholds.js'
import { enforceFunderBehaviorRecall } from '../startup/enforceInvariants.js'
import { normalizePersistedMatchDecisionIntegrity } from '../services/matching/matchDecisionIntegrity.js'

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
      state TEXT, is_national INTEGER, opportunity_kind TEXT, source TEXT, source_id TEXT,
      source_url TEXT, application_url TEXT, amount_min NUMERIC, amount_max NUMERIC,
      eligibility_text TEXT, eligibility_bullets TEXT, entity_types_allowed TEXT,
      need_types_supported TEXT, categories TEXT, keywords TEXT,
      profile_id TEXT, is_active INTEGER DEFAULT 1, is_loan INTEGER DEFAULT 0,
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
    CREATE TABLE grant_transactions (
      id TEXT PRIMARY KEY, funder_ein TEXT NOT NULL, funder_name TEXT,
      recipient_name TEXT NOT NULL, recipient_ein TEXT, recipient_city TEXT,
      recipient_state TEXT, recipient_country TEXT, amount NUMERIC, purpose TEXT,
      tax_year INTEGER, form_type TEXT, source_object_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)
  return db
}

const wrap = (db) => ({ dialect: 'sqlite', prepare: (sql) => db.prepare(sql) })

const EIN = '621234567'

/** A TN nonprofit that DECLARES a housing need (structured, never prose). */
function seedProfile(db, { id = 'p-shelter', needs = ['housing'], state = 'TN' } = {}) {
  db.prepare(
    `INSERT INTO profiles (id, display_name, primary_type, status, state, city)
     VALUES (?, 'Bradley Housing Coalition', 'nonprofit', 'active', ?, 'Cleveland')`,
  ).run(id, state)
  db.prepare(`INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, 'basic_information', ?)`)
    .run(id, JSON.stringify({ organization_name: 'Bradley Housing Coalition', city: 'Cleveland', state }))
  db.prepare(`INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, 'organization_details', ?)`)
    .run(id, JSON.stringify({ organization_type: 'nonprofit', mission_focus: 'housing' }))
  if (needs) {
    db.prepare(`INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, 'financial_information', ?)`)
      .run(id, JSON.stringify({ funding_needs: needs }))
  }
  return id
}

/** The row shape the 990 lane + ingest actually produce for this funder. */
function seedFunderRow(db, {
  id = 'fo-smith',
  ein = EIN,
  state = 'TN',
  // The live 990 lane stamps `opportunity_kind` on some funder rows (measured
  // 2026-08-21 in the local catalog: "Michael & Susan Dell Foundation —
  // Foundation/Grantmaker", kind `directory`), and a thin row carries no
  // categories at all. Both are parameters so the resource-kind convergence
  // case below can reproduce the real shape.
  kind = null,
  categories = ['housing', 'programs'],
} = {}) {
  db.prepare(
    `INSERT INTO funding_opportunities
       (id, title, sponsor, description, source, source_id, state, is_national, categories, source_url, opportunity_kind)
     VALUES (?, ?, ?, ?, 'propublica_990', ?, ?, 0, ?, ?, ?)`,
  ).run(
    id,
    'Smith Family Foundation — Foundation/Grantmaker',
    'Smith Family Foundation',
    'Location: Nashville, TN | NTEE: T20 | IRS 990-listed grantmaking organization (approach the funder directly; no open deadline is implied).\n' +
      'IRS 990 grants filed (tax year 2024): 12 grants totaling $340,000, individual awards $5,000–$60,000. Top recipient states: TN (11), GA (1).',
    ein,
    state,
    categories ? JSON.stringify(categories) : null,
    `https://projects.propublica.org/nonprofits/organizations/${ein}`,
    kind,
  )
  return id
}

function seedTransactions(db, { ein = EIN, state = 'TN', purpose = 'EMERGENCY RENT ASSISTANCE AND HOMELESS SHELTER SUPPORT', n = 3 } = {}) {
  for (let i = 0; i < n; i += 1) {
    db.prepare(
      `INSERT INTO grant_transactions
         (id, funder_ein, funder_name, recipient_name, recipient_state, amount, purpose, tax_year, form_type, source_object_id)
       VALUES (?, ?, 'Smith Family Foundation', ?, ?, ?, ?, 2024, '990PF', 'obj-1')`,
    ).run(`tx-${ein}-${state}-${i}`, ein, `Recipient ${i}`, state, 20000 + i, purpose)
  }
}

const linkRows = (db) =>
  db.prepare("SELECT * FROM profile_opportunity_matches WHERE matcher_version = 'funder-behavior-link'").all()

let ENV_SNAPSHOT
beforeEach(() => { ENV_SNAPSHOT = { ...process.env } })
afterEach(() => { process.env = ENV_SNAPSHOT })

describe('the version is registered — persisting and not reading back is the web-llm regression', () => {
  it('funder-behavior-link is in SURFACED_MATCHER_VERSIONS', () => {
    expect(SURFACED_MATCHER_VERSIONS).toContain('funder-behavior-link')
  })
})

describe('enforceFunderBehaviorRecall — links on demonstrated behavior + engine ACCEPT', () => {
  it('links the TN housing nonprofit to the funder whose filed grants show TN housing giving', async () => {
    const db = makeDb()
    seedProfile(db)
    seedFunderRow(db)
    seedTransactions(db)
    const res = await enforceFunderBehaviorRecall(wrap(db))
    expect(res.error).toBeUndefined()
    expect(res.profilesEligible).toBe(1)
    const links = linkRows(db)
    expect(links).toHaveLength(1)
    // The engine's own verdict on this pair: topical ACCEPT downgraded to
    // REVIEW solely for the structurally-absent apply URL.
    expect(['accept', 'review']).toContain(links[0].match_decision)
    const explain = JSON.parse(links[0].match_explain_json)
    expect(explain.gate).toBe('funder_behavior')
    expect(explain.state).toBe('TN')
    // The evidence IS the claim: the funder's own filed grants ride the row.
    expect(explain.evidence.length).toBeGreaterThan(0)
    expect(explain.evidence[0].purpose).toContain('RENT ASSISTANCE')
  })

  it('a 990 funder row REVIEW carries the direct-approach explanation, never the defect-shaped "missing URL" text', async () => {
    const db = makeDb()
    seedProfile(db)
    seedFunderRow(db)
    seedTransactions(db)
    await enforceFunderBehaviorRecall(wrap(db))
    const links = linkRows(db)
    expect(links).toHaveLength(1)
    if (String(links[0].match_decision).toLowerCase() === 'review') {
      // The funder-behavior ceiling (structurally-absent apply URL) must read
      // as a DIRECT-APPROACH funder, not a broken listing (epic slice 5).
      expect(links[0].match_explanation).toMatch(/approach this funder directly/i)
      expect(links[0].match_explanation).not.toMatch(/missing application URL/i)
    }
  })

  it('is idempotent: a second boot links nothing new and deletes nothing', async () => {
    const db = makeDb()
    seedProfile(db)
    seedFunderRow(db)
    seedTransactions(db)
    await enforceFunderBehaviorRecall(wrap(db))
    const after1 = linkRows(db).length
    const res2 = await enforceFunderBehaviorRecall(wrap(db))
    expect(res2.repaired).toBe(0)
    expect(res2.stale ?? 0).toBe(0)
    expect(linkRows(db).length).toBe(after1)
  })
})

describe('the flood guards — every conjunct is REQUIRED', () => {
  it('NO structured declared need (prose only) → no key, no link', async () => {
    const db = makeDb()
    seedProfile(db, { needs: null })
    // Prose that MENTIONS housing — including denying it — declares nothing.
    db.prepare(`INSERT INTO profile_sections (profile_id, section_key, data) VALUES ('p-shelter', 'narrative', ?)`)
      .run(JSON.stringify({ primary_goal: 'We handle housing questions but do not need housing funding' }))
    seedFunderRow(db)
    seedTransactions(db)
    const res = await enforceFunderBehaviorRecall(wrap(db))
    expect(res.profilesEligible).toBe(0)
    expect(linkRows(db)).toHaveLength(0)
  })

  it('the funder gave in ANOTHER state only → not a candidate', async () => {
    const db = makeDb()
    seedProfile(db) // TN
    seedFunderRow(db)
    seedTransactions(db, { state: 'GA' })
    await enforceFunderBehaviorRecall(wrap(db))
    expect(linkRows(db)).toHaveLength(0)
  })

  it('in-state giving for an UNRELATED purpose → adjudicated out (the LIKE superset is not the rule)', async () => {
    const db = makeDb()
    seedProfile(db)
    seedFunderRow(db)
    // "shelter" appears mid-word — the LIKE superset catches it, the
    // whole-word adjudication must refuse it.
    seedTransactions(db, { purpose: 'SHELTERWOOD TIMBER RESEARCH PROGRAM' })
    const res = await enforceFunderBehaviorRecall(wrap(db))
    expect(linkRows(db)).toHaveLength(0)
    expect(res.repaired).toBe(0)
  })

  it('an engine non-ACCEPT is never written (a loan-flagged funder row hard-fails)', async () => {
    const db = makeDb()
    seedProfile(db)
    seedFunderRow(db)
    db.prepare('UPDATE funding_opportunities SET is_loan = 1').run()
    seedTransactions(db)
    const res = await enforceFunderBehaviorRecall(wrap(db))
    expect(linkRows(db)).toHaveLength(0)
    expect(res.rejectedByEngine).toBeGreaterThan(0)
  })

  it('a profile with NO resolvable state gains no key (MISSING = NEUTRAL)', async () => {
    const db = makeDb()
    seedProfile(db, { state: null })
    db.prepare("UPDATE profiles SET state = NULL").run()
    db.prepare("UPDATE profile_sections SET data = ? WHERE section_key = 'basic_information'")
      .run(JSON.stringify({ organization_name: 'Bradley Housing Coalition' }))
    seedFunderRow(db)
    seedTransactions(db)
    const res = await enforceFunderBehaviorRecall(wrap(db))
    expect(res.profilesEligible).toBe(0)
    expect(linkRows(db)).toHaveLength(0)
  })
})

describe('count-only, convergence, and survival', () => {
  it('ENFORCE_FUNDER_BEHAVIOR_RECALL=0 → wouldRepair counted, nothing written', async () => {
    const db = makeDb()
    seedProfile(db)
    seedFunderRow(db)
    seedTransactions(db)
    process.env.ENFORCE_FUNDER_BEHAVIOR_RECALL = '0'
    const res = await enforceFunderBehaviorRecall(wrap(db))
    expect(res.enforced).toBe(false)
    expect(res.wouldRepair).toBeGreaterThan(0)
    expect(linkRows(db)).toHaveLength(0)
  })

  it('CONVERGENCE: a withdrawn need removes the link on the next boot', async () => {
    const db = makeDb()
    seedProfile(db)
    seedFunderRow(db)
    seedTransactions(db)
    await enforceFunderBehaviorRecall(wrap(db))
    expect(linkRows(db)).toHaveLength(1)
    // The org re-focuses: housing need withdrawn.
    db.prepare("UPDATE profile_sections SET data = ? WHERE section_key = 'financial_information'")
      .run(JSON.stringify({ funding_needs: [] }))
    const res = await enforceFunderBehaviorRecall(wrap(db))
    expect(res.stale).toBe(1)
    expect(linkRows(db)).toHaveLength(0)
  })

  it('CONVERGENCE: a deactivated funder row removes the link', async () => {
    const db = makeDb()
    seedProfile(db)
    seedFunderRow(db)
    seedTransactions(db)
    await enforceFunderBehaviorRecall(wrap(db))
    db.prepare('UPDATE funding_opportunities SET is_active = 0').run()
    const res = await enforceFunderBehaviorRecall(wrap(db))
    expect(res.stale).toBe(1)
    expect(linkRows(db)).toHaveLength(0)
  })

  it('a link written by ANOTHER lane is never deleted by this net\'s convergence', async () => {
    const db = makeDb()
    seedProfile(db)
    seedFunderRow(db)
    seedTransactions(db)
    db.prepare(
      `INSERT INTO profile_opportunity_matches (id, profile_id, opportunity_id, match_score, match_decision, matcher_version)
       VALUES ('other-lane', 'p-shelter', 'fo-other', 50, 'accept', 'crawler-os')`,
    ).run()
    await enforceFunderBehaviorRecall(wrap(db))
    // Withdraw everything — only the funder-behavior link may converge away.
    db.prepare("UPDATE profile_sections SET data = ? WHERE section_key = 'financial_information'")
      .run(JSON.stringify({ funding_needs: [] }))
    await enforceFunderBehaviorRecall(wrap(db))
    const survivors = db.prepare('SELECT id, matcher_version FROM profile_opportunity_matches').all()
    expect(survivors.map((r) => r.id)).toContain('other-lane')
  })

  it('missing grant_transactions table → skipped:"schema", never a throw', async () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE profile_opportunity_matches (
        id TEXT PRIMARY KEY, profile_id TEXT, opportunity_id TEXT, matcher_version TEXT
      );
    `)
    const res = await enforceFunderBehaviorRecall(wrap(db))
    expect(res.skipped).toBe('schema')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// LADDER CONVERGENCE: a sweep must never write a row a LATER sweep in the same
// boot deletes (2026-08-21, measured).
//
// `enforceFunderBehaviorRecall` is step 33 of the boot ladder;
// `enforcePersistedMatchDecisionIntegrity` is step 39. Rule 3 of the decision
// contract deletes any RESOURCE-kind match (DIRECTORY / REFERRAL /
// SCHOOL_PORTAL / PAST_AWARD_INTEL) whose explicit score is below REVIEW_SCORE.
// The recall net writes on the engine's REVIEW verdict alone — and the engine
// can return REVIEW at a score under that bar.
//
// Measured on a real local catalog (480 crawled opportunities, 8 crawled Amy
// profiles) on 2026-08-21: `enforceFunderBehaviorRecall` inserted
// profile 80953e8d… ↔ "Michael & Susan Dell Foundation — Foundation/Grantmaker"
// (opportunity_kind `directory`, match_score **2**, decision `review`) and
// `enforcePersistedMatchDecisionIntegrity` deleted that exact same pair, on
// EVERY boot. Four consecutive full ladder runs reported
// totalRepaired 15 → 7 → 7 → 7, with `funder_behavior_recall repaired:1` and
// `persisted_match_decision_integrity repaired:1` in every single pass. That is
// the documented tug-of-war signature: a repair count that never trends to zero.
//
// The fix narrows the WRITER (a row the contract forbids is simply never
// minted). It cannot surface anything new — the row was being deleted the same
// boot anyway — so no gate is weakened by making the ladder converge.
// ─────────────────────────────────────────────────────────────────────────────
describe('ladder convergence — never mint a row the decision contract deletes', () => {
  it('does not link a resource-kind funder row scored below the resource bar', async () => {
    const db = makeDb()
    seedProfile(db)
    // The real shape: a DIRECTORY-kind 990 funder row with no categories, which
    // the engine scores at 4 — REVIEW by verdict, below REVIEW_SCORE (7).
    seedFunderRow(db, { kind: 'DIRECTORY', categories: null })
    seedTransactions(db)

    const res = await enforceFunderBehaviorRecall(wrap(db))
    expect(res.error).toBeUndefined()
    expect(res.profilesEligible).toBe(1)
    // Nothing is written, and the sweep SAYS so rather than reporting a repair
    // that another sweep silently undoes.
    expect(linkRows(db)).toHaveLength(0)
    expect(res.repaired).toBe(0)
    expect(res.contractRejected).toBe(1)
  })

  it('the decision-contract net finds nothing to delete after the recall net ran', async () => {
    const db = makeDb()
    seedProfile(db)
    seedFunderRow(db, { kind: 'DIRECTORY', categories: null })
    seedTransactions(db)

    await enforceFunderBehaviorRecall(wrap(db))
    const integrity = await normalizePersistedMatchDecisionIntegrity(wrap(db))
    // The whole point: step 39 must have no work created by step 33.
    expect(integrity.removed_below_review_resources).toBe(0)
  })

  it('a resource-kind row AT OR ABOVE the bar is still linked (the fix narrows nothing else)', async () => {
    const db = makeDb()
    seedProfile(db)
    // Same DIRECTORY kind, but the categorised row scores 10 — above the bar.
    seedFunderRow(db, { kind: 'directory' })
    seedTransactions(db)

    const res = await enforceFunderBehaviorRecall(wrap(db))
    expect(res.repaired).toBe(1)
    expect(res.contractRejected ?? 0).toBe(0)
    const links = linkRows(db)
    expect(links).toHaveLength(1)
    expect(links[0].match_score).toBeGreaterThanOrEqual(REVIEW_SCORE)
    // …and the contract net leaves it alone.
    const integrity = await normalizePersistedMatchDecisionIntegrity(wrap(db))
    expect(integrity.removed_below_review_resources).toBe(0)
    expect(linkRows(db)).toHaveLength(1)
  })

  it('a NON-resource kind below the bar is untouched by this narrowing (rule 3 does not govern it)', async () => {
    const db = makeDb()
    seedProfile(db)
    // No opportunity_kind at all — rule 3 never applies, so the engine's REVIEW
    // stands even at a low score. Guards against over-narrowing the writer.
    seedFunderRow(db, { kind: null, categories: null })
    seedTransactions(db)

    const res = await enforceFunderBehaviorRecall(wrap(db))
    expect(res.repaired).toBe(1)
    expect(res.contractRejected ?? 0).toBe(0)
    expect(linkRows(db)).toHaveLength(1)
  })
})
