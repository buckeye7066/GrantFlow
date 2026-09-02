import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../../tests/helpers/sqliteTestDb.mjs'
import { enforcePipelinePrecision } from '../startup/enforceInvariants.js'

function makeDb() {
  const sqlite = new Database(':memory:')
  sqlite.dialect = 'sqlite'
  sqlite.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY, display_name TEXT, applicant_type TEXT, primary_type TEXT, status TEXT);
    CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT);
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT, sponsor TEXT, entity_types_allowed TEXT,
      categories TEXT, source TEXT, source_url TEXT, application_url TEXT,
      state TEXT, is_national INTEGER
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY, profile_id TEXT, funding_opportunity_id TEXT, title TEXT,
      funder TEXT, status TEXT, match_decision TEXT, eligibility_status TEXT, ineligibility_reasons TEXT
    );
    CREATE TABLE application_tasks (
      id TEXT PRIMARY KEY, profile_id TEXT, opportunity_id TEXT, grant_id TEXT, status TEXT, last_agent_message TEXT, updated_at TEXT
    );
    CREATE TABLE profile_opportunity_matches (id TEXT PRIMARY KEY, profile_id TEXT, opportunity_id TEXT);
    CREATE TABLE pipeline_dismissals (id TEXT PRIMARY KEY, profile_id TEXT, title TEXT, reason TEXT);
    CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
  `)
  return wrapSqlite(sqlite)
}

function seedScenario(db) {
  // Profile: Tennessee student with declared education need.
  db.raw.prepare(`INSERT INTO profiles (id, display_name, primary_type, status) VALUES ('p1','TN Student','college_student','active')`).run()
  db.raw.prepare(`INSERT INTO profile_sections (profile_id, section_key, data) VALUES ('p1','basic_information',?)`).run(JSON.stringify({ state: 'TN', profile_category: 'college_student' }))
  db.raw.prepare(`INSERT INTO profile_sections (profile_id, section_key, data) VALUES ('p1','education',?)`).run(JSON.stringify({ current_institution: 'Middle Tennessee State University' }))
  db.raw.prepare(`INSERT INTO profile_sections (profile_id, section_key, data) VALUES ('p1','financial_information',?)`).run(JSON.stringify({ needs: ['education'] }))

  // Bad: Alaska housing (out-of-state) — appears in saved; should be removed and tasks cancelled.
  db.raw.prepare(`INSERT INTO funding_opportunities (id,title,sponsor,entity_types_allowed,categories,source,source_url,application_url,state,is_national)
                  VALUES ('fo-ak','Alaska Housing Aid','AK Housing',
                          '["individual"]','["housing"]','test','https://ak.example.org','https://ak.example.org/apply','AK',0)`).run()
  db.raw.prepare(`INSERT INTO grants (id,profile_id,funding_opportunity_id,title,funder,status) VALUES ('g-ak','p1','fo-ak','Alaska Housing Aid','AK Housing','saved')`).run()
  db.raw.prepare(`INSERT INTO application_tasks (id,profile_id,opportunity_id,grant_id,status) VALUES ('t1','p1','fo-ak','g-ak','waiting_for_review')`).run()
  db.raw.prepare(`INSERT INTO profile_opportunity_matches (id,profile_id,opportunity_id) VALUES ('m1','p1','fo-ak')`).run()

  // Bad: Portal MTSU info page (relatable=false) — appears in portal stage; should be removed and tasks cancelled.
  db.raw.prepare(`INSERT INTO funding_opportunities (id,title,sponsor,entity_types_allowed,categories,source,source_url,application_url,state,is_national)
                  VALUES ('fo-mtsu','Middle Tennessee State University — Info','Middle Tennessee State University',
                          '["school"]','[]','test','https://mtsu.edu/info','https://mtsu.edu/info',NULL,1)`).run()
  db.raw.prepare(`INSERT INTO grants (id,profile_id,funding_opportunity_id,title,funder,status) VALUES ('g-mtsu','p1','fo-mtsu','MTSU Info','MTSU','portal')`).run()
  db.raw.prepare(`INSERT INTO application_tasks (id,profile_id,opportunity_id,grant_id,status) VALUES ('t2','p1','fo-mtsu','g-mtsu','filling_portal')`).run()
  db.raw.prepare(`INSERT INTO profile_opportunity_matches (id,profile_id,opportunity_id) VALUES ('m2','p1','fo-mtsu')`).run()

  // Protected failed: submitted institutional HUD row — should be relabeled ineligible and match_decision REJECT, tasks (if any) cancelled.
  db.raw.prepare(`INSERT INTO funding_opportunities (id,title,sponsor,entity_types_allowed,categories,source,source_url,application_url,state,is_national)
                  VALUES ('fo-hud','HUD Institutional Award','HUD',
                          '["government","school","nonprofit"]','["housing"]','test','https://hud.gov','https://hud.gov/apply',NULL,1)`).run()
  db.raw.prepare(`INSERT INTO grants (id,profile_id,funding_opportunity_id,title,funder,status,match_decision) VALUES ('g-hud','p1','fo-hud','HUD Institutional Award','HUD','submitted','ACCEPT')`).run()

  // Good: TN Pell-like (education) — keep.
  db.raw.prepare(`INSERT INTO funding_opportunities (id,title,sponsor,entity_types_allowed,categories,source,source_url,application_url,state,is_national)
                  VALUES ('fo-pell','Federal Pell Grant','Federal Student Aid',
                          '["student","family"]','["education"]','test','https://studentaid.gov/pell','https://studentaid.gov/pell','TN',1)`).run()
  db.raw.prepare(`INSERT INTO grants (id,profile_id,funding_opportunity_id,title,funder,status) VALUES ('g-pell','p1','fo-pell','Federal Pell Grant','Federal Student Aid','discovered')`).run()
}

describe('Four-gate reconciliation — cancels live tasks, removes matches, deletes early, relabels protected', () => {
  it('converges pipeline and Hamilton traces for refused sources', async () => {
    const db = makeDb()
    seedScenario(db)
    const res = await enforcePipelinePrecision(db)
    expect(res.ok).toBe(true)
    // Tasks for refused sources cancelled (waiting_for_review, filling_portal).
    const t1 = await db.prepare(`SELECT status FROM application_tasks WHERE id = 't1'`).get()
    const t2 = await db.prepare(`SELECT status FROM application_tasks WHERE id = 't2'`).get()
    expect(t1.status).toBe('cancelled')
    expect(t2.status).toBe('cancelled')
    // Early/discovery and portal rows removed; good + submitted remain.
    const remaining = await db.prepare(`SELECT id FROM grants ORDER BY id`).all()
    const ids = remaining.map((r) => r.id)
    expect(ids).toContain('g-pell')
    expect(ids).toContain('g-hud')
    expect(ids).not.toContain('g-ak')
    expect(ids).not.toContain('g-mtsu')
    // Matches deleted for refused sources.
    const matches = await db.prepare(`SELECT id FROM profile_opportunity_matches`).all()
    const mids = matches.map((r) => r.id)
    expect(mids).not.toContain('m1')
    expect(mids).not.toContain('m2')
    // Protected failed history relabeled and canonically rejected.
    const hud = await db.prepare(`SELECT eligibility_status, match_decision FROM grants WHERE id = 'g-hud'`).get()
    expect(hud.eligibility_status).toBe('ineligible')
    expect((hud.match_decision || '').toUpperCase()).toBe('REJECT')
    // Last-run summary persisted.
    const kv = await db.prepare(`SELECT value FROM system_kv WHERE key = 'pipeline_precision_last_run'`).get()
    expect(kv?.value).toBeTruthy()
  })
})

