/**
 * Task-identity + pointer-research-lead guards (2026-08-04).
 *
 * 1. A GRANT-backed task's identity is (profile, grant): the 2026-07-21 batch
 *    minted DUPLICATE tasks for grants whose earlier task predated opportunity
 *    linking, because the exact key treated (grant, NULL-opp) and (grant, opp)
 *    as different tasks. ensureApplicationTask now ADOPTS a live same-grant
 *    task (backfilling its opportunity_id) instead of duplicating; a TERMINAL
 *    same-grant task still allows recreate.
 *
 * 2. A pointer-kind row decomposition cannot reach is a RESEARCH LEAD, never
 *    an application task — refused by assessHamiltonFundingSource with
 *    generated handoff instructions (the manual-handoff directive), BEFORE the
 *    trust gate so a URL-less pointer surfaces the actionable handoff instead
 *    of a generic no_real_url refusal.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../../tests/helpers/sqliteTestDb.mjs'
import {
  ensureApplicationTask,
  _resetSchemaCache,
} from '../services/hamilton/applicationTaskStore.js'
import {
  assessHamiltonFundingSource,
  assessPointerResearchLead,
} from '../services/hamilton/hamiltonFundingSourcePolicy.js'

const PROFILE = 'profile-task-identity'

function makeDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY, user_id TEXT, display_name TEXT);
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, profile_id TEXT, title TEXT, description TEXT,
      opportunity_kind TEXT, application_url TEXT, apply_url TEXT,
      source_url TEXT, url TEXT, evidence_url TEXT, record_origin TEXT,
      source TEXT, source_trust_tier TEXT, reality_status TEXT, is_active INTEGER
    );
    CREATE TABLE profile_opportunity_matches (
      id TEXT PRIMARY KEY, profile_id TEXT, opportunity_id TEXT,
      match_score REAL, match_decision TEXT, match_explanation TEXT,
      matcher_version TEXT, updated_at TEXT, computed_at TEXT
    );
  `)
  sqlite.prepare('INSERT INTO profiles (id, display_name) VALUES (?, ?)').run(PROFILE, 'Task Identity Test')
  return wrapSqlite(sqlite)
}

let db
beforeEach(() => {
  _resetSchemaCache()
  db = makeDb()
})

describe('ensureApplicationTask grant-identity adoption', () => {
  it('adopts a live (grant, NULL-opp) task when a later call carries the opportunity — and backfills it', async () => {
    const first = await ensureApplicationTask(db, { profileId: PROFILE, grantId: 'g-1' })
    const second = await ensureApplicationTask(db, { profileId: PROFILE, grantId: 'g-1', opportunityId: 'opp-1' })
    expect(second.id).toBe(first.id)
    expect(second.opportunity_id).toBe('opp-1')
    const count = await db.prepare('SELECT COUNT(*) AS n FROM application_tasks WHERE profile_id = ? AND grant_id = ?').get(PROFILE, 'g-1')
    expect(Number(count.n)).toBe(1)
  })

  it('the exact-key lookup stays idempotent (same grant + same opportunity)', async () => {
    const a = await ensureApplicationTask(db, { profileId: PROFILE, grantId: 'g-2', opportunityId: 'opp-2' })
    const b = await ensureApplicationTask(db, { profileId: PROFILE, grantId: 'g-2', opportunityId: 'opp-2' })
    expect(b.id).toBe(a.id)
  })

  it('a TERMINAL same-grant task is NOT adopted — cancel-then-recreate stays possible', async () => {
    const first = await ensureApplicationTask(db, { profileId: PROFILE, grantId: 'g-3' })
    await db.prepare("UPDATE application_tasks SET status = 'cancelled' WHERE id = ?").run(first.id)
    const second = await ensureApplicationTask(db, { profileId: PROFILE, grantId: 'g-3', opportunityId: 'opp-3' })
    expect(second.id).not.toBe(first.id)
  })

  it('grantless (portal/university) identity is untouched: different opportunities stay different tasks', async () => {
    const a = await ensureApplicationTask(db, { profileId: PROFILE, opportunityId: 'opp-A' })
    const b = await ensureApplicationTask(db, { profileId: PROFILE, opportunityId: 'opp-B' })
    expect(b.id).not.toBe(a.id)
  })
})

describe('pointer rows become research leads, never application tasks', () => {
  const savedEnv = process.env.HAMILTON_DECOMPOSE_POINTER_LISTINGS
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.HAMILTON_DECOMPOSE_POINTER_LISTINGS
    else process.env.HAMILTON_DECOMPOSE_POINTER_LISTINGS = savedEnv
  })

  it('assessPointerResearchLead: a URL-less directory row yields handoff instructions', () => {
    const lead = assessPointerResearchLead({ opportunity_kind: 'directory', title: 'GrantWatch — Van & Vehicle Grants' })
    expect(lead).toBeTruthy()
    expect(lead.instructions).toMatch(/directory/i)
    expect(lead.instructions).toMatch(/Discovery/)
  })

  it('assessPointerResearchLead: a pointer WITH a usable URL stays allowed (decomposition owns it)', () => {
    delete process.env.HAMILTON_DECOMPOSE_POINTER_LISTINGS
    const lead = assessPointerResearchLead({ opportunity_kind: 'directory', title: 'X', application_url: 'https://example.org/list' })
    expect(lead).toBeNull()
  })

  it('assessPointerResearchLead: decomposition disabled makes even a URL-carrying pointer a research lead', () => {
    process.env.HAMILTON_DECOMPOSE_POINTER_LISTINGS = 'false'
    const lead = assessPointerResearchLead({ opportunity_kind: 'directory', title: 'X', application_url: 'https://example.org/list' })
    expect(lead).toBeTruthy()
  })

  it('assessPointerResearchLead: a non-pointer kind is never a research lead', () => {
    expect(assessPointerResearchLead({ opportunity_kind: 'direct_grant', title: 'Real Grant' })).toBeNull()
    expect(assessPointerResearchLead({ opportunity_kind: null, title: 'Kindless' })).toBeNull()
  })

  it('a SEARCH/FINDER/DIRECTORY title is a research lead even with a stale non-pointer kind', () => {
    delete process.env.HAMILTON_DECOMPOSE_POINTER_LISTINGS
    // Real rows that sat at "waiting for review" (2026-08-22) with a non-pointer
    // stored kind — title-classified so the stale kind can't hide them. URL-less
    // here so they resolve to a research-lead handoff rather than decomposition.
    for (const title of [
      'Scholarships.com — Free Scholarship Search',
      'Music & Performing Arts Scholarship Finder',
      'Criminal Justice & Forensics Scholarship Directory',
      'Bold.org — No-Essay & Traditional Scholarships',
      'Fastweb — Room & Board / Housing Scholarships',
    ]) {
      const lead = assessPointerResearchLead({ opportunity_kind: 'direct_grant', title })
      expect(lead, title).toBeTruthy()
    }
  })

  it('a REAL award hosted on an aggregator is NOT a research lead (funder is the sponsor, title is the award)', () => {
    for (const opp of [
      { opportunity_kind: 'direct_grant', title: 'Coca-Cola Scholars Program', sponsor: 'National Program' },
      { opportunity_kind: 'direct_grant', title: 'Bound Tree Medical Legacy Scholarship', sponsor: 'Bound Tree Medical' },
      { opportunity_kind: 'direct_grant', title: 'Dr. Richard Detmer Scholarship', sponsor: 'Middle Tennessee State University' },
    ]) {
      expect(assessPointerResearchLead(opp), opp.title).toBeNull()
    }
  })

  it('assessHamiltonFundingSource refuses a URL-less pointer catalog row as pointer_research_lead WITH handoff', async () => {
    await db.prepare(
      `INSERT INTO funding_opportunities (id, title, opportunity_kind, is_active) VALUES (?, ?, ?, 1)`,
    ).run('opp-pointer', 'Ohio 211 — Connect to Help', 'referral')
    const assessment = await assessHamiltonFundingSource(db, {
      profileId: PROFILE,
      opportunity: await db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get('opp-pointer'),
    })
    expect(assessment.ok).toBe(false)
    expect(assessment.code).toBe('pointer_research_lead')
    expect(assessment.handoff?.instructions).toMatch(/referral/i)
  })
})

/**
 * 3. THE SECOND DOOR (owner report 2026-08-21).
 *
 * `assessHamiltonFundingSource` reaches its match checks only when a stored
 * `profile_opportunity_matches` row exists OR `requiresProfileMatch(subject)`
 * is true — and that predicate is keyed on
 * `PROFILE_MATCH_REQUIRED_ORIGINS = {live_crawl, geo_crawl, discovered}`.
 * A row with any OTHER `record_origin` — `curated_verified`, `manual`, and
 * `scholarship_crawler`, which is exactly what listing decomposition mints —
 * fell through to `ok: true` with NO eligibility evaluation of any kind, and
 * Hamilton opened an application for it.
 *
 * Fixing only the match engine would have left this door open for every
 * curated and decomposition-minted row.
 */
describe('the applicant-type gate runs for EVERY record_origin, not just the crawled ones', () => {
  // A real-looking host: `example-*.org` trips the trust gate's placeholder
  // detector, which would refuse before the applicant-type gate is reached and
  // make this test pass for the wrong reason.
  function seedOpp(database, { id, title, entityTypes, origin, url }) {
    return database.prepare(`
      INSERT INTO funding_opportunities
        (id, title, opportunity_kind, application_url, source_url, record_origin, source,
         source_trust_tier, reality_status, is_active, entity_types_allowed)
      VALUES (?, ?, 'direct', ?, ?, ?, 'curated', 'official', 'real', 1, ?)
    `).run(id, title, url, url, origin, JSON.stringify(entityTypes))
  }

  let policyDb
  beforeEach(async () => {
    policyDb = makeDb()
    // The gate needs the column the crawler actually writes.
    await policyDb.prepare('ALTER TABLE funding_opportunities ADD COLUMN entity_types_allowed TEXT').run()
    await policyDb.prepare('UPDATE profiles SET display_name = ? WHERE id = ?').run('MTSU Forensic Science Undergraduate', PROFILE)
    await policyDb.prepare('ALTER TABLE profiles ADD COLUMN primary_type TEXT').run()
    await policyDb.prepare("UPDATE profiles SET primary_type = 'college_student' WHERE id = ?").run(PROFILE)
    await policyDb.prepare('CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT)').run()
  })

  // NOTE: the assessment is driven through a GRANT, not a bare `{id}` stub —
  // `loadOpportunityForPolicy` short-circuits on `opportunity?.id` and would
  // hand the trust gate a row with no URL, refusing for the wrong reason.
  it('REFUSES an institutional NOFO for an individual even with a curated origin and no stored match', async () => {
    await seedOpp(policyDb, {
      id: 'opp-onr',
      title: 'FY25 Long Range Broad Agency Announcement (BAA) for Navy and Marine Corps Science and Technology',
      entityTypes: ['nonprofit', 'school', 'government', 'business'],
      origin: 'curated_verified',
      url: 'https://www.onr.navy.mil/work-with-us/funding-opportunities/baa',
    })
    const verdict = await assessHamiltonFundingSource(policyDb, { profileId: PROFILE, grant: { id: 'g-opp-onr', funding_opportunity_id: 'opp-onr' } })
    expect(verdict.ok).toBe(false)
    expect(verdict.code).toBe('funding_source_profile_rejected')
    expect(verdict.reasons.join(' ')).toMatch(/applicant_type/)
  })

  it('ALLOWS a real student award through the same door (the gate is not a blanket refusal)', async () => {
    await seedOpp(policyDb, {
      id: 'opp-pell',
      title: 'Federal Pell Grant',
      entityTypes: ['student', 'family'],
      origin: 'curated_verified',
      url: 'https://studentaid.gov/understand-aid/types/grants/pell',
    })
    const verdict = await assessHamiltonFundingSource(policyDb, { profileId: PROFILE, grant: { id: 'g-opp-pell', funding_opportunity_id: 'opp-pell' } })
    expect(verdict.ok).toBe(true)
  })

  it('refuses automation when applicant type cannot be positively verified', async () => {
    await policyDb.prepare("UPDATE profiles SET primary_type = NULL, display_name = NULL WHERE id = ?").run(PROFILE)
    await seedOpp(policyDb, {
      id: 'opp-unknown',
      title: 'Developmental Sciences',
      entityTypes: ['nonprofit', 'school'],
      origin: 'curated_verified',
      url: 'https://www.nsf.gov/funding/opportunities/developmental-sciences',
    })
    const verdict = await assessHamiltonFundingSource(policyDb, { profileId: PROFILE, grant: { id: 'g-opp-unknown', funding_opportunity_id: 'opp-unknown' } })
    expect(verdict.ok).toBe(false)
    expect(verdict.code).toBe('funding_source_profile_not_accepted')
    expect(verdict.reasons.join(' ')).toMatch(/applicant_type:not_positively_verified/)
  })
})
