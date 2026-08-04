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
