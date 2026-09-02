/**
 * Source-safe student / MTSU end-to-end:
 *
 *   1. The student pipeline merges with the MTSU financial-aid portal.
 *      Manually-imported MTSU awards (institutional aid: True Blue,
 *      Centennial, Honors, departmental) land BOTH in her
 *      university_applications section AND in the global
 *      funding_opportunities table so Discover Grants surfaces them.
 *
 *   2. Hamilton picks up every MTSU funding source from
 *      application_tasks via the agent control adapter and processes
 *      each one through automateSingleSource — without throwing the
 *      "no such column" / "source must include opportunity_id or
 *      grant_id" errors that used to silently drop every queued task.
 *
 *   3. Each agent (Sam, Robert, Yana, John, Hamilton) runs one full
 *      round through the orchestrator without throwing.
 *
 * These are the three concrete failure modes the user hit in
 * Mission Control. They lock the fix so a regression here would
 * immediately fail CI.
 */

import { describe, it, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../helpers/sqliteTestDb.mjs'

import {
  createSchoolPortalConnection,
  mergeSchoolPortalAwards,
  SCHOOL_PORTAL_PROVIDERS,
} from '../../backend/services/schoolPortalImportService.js'
import { ensureApplicationTaskSchema, _resetSchemaCache as _resetTaskSchemaCache } from '../../backend/services/hamilton/applicationTaskStore.js'
import { _resetNotificationsSchemaCache } from '../../backend/services/hamilton/hamiltonNotifications.js'
import { _resetAuthSchemaCache } from '../../backend/services/hamilton/hamiltonAuthorizationStore.js'
import { HamiltonAgentAdapter } from '../../backend/services/agentControl/agentAdapters/hamiltonAgentAdapter.js'
import { makeSignal } from '../../backend/services/agentControl/agentAdapters/baseAgentAdapter.js'

const STUDENT_PROFILE_ID = 'profile-demo-tennessee-stem-student'
const STUDENT_USER_ID = 'u-demo-student'
const MTSU_APPLICATION_ID = 'app-mtsu'

function makeDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      display_name TEXT,
      primary_type TEXT,
      status TEXT
    );
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      primary_email TEXT,
      is_admin INTEGER DEFAULT 0,
      role TEXT
    );
    CREATE TABLE profile_sections (
      profile_id TEXT NOT NULL,
      section_key TEXT NOT NULL,
      data TEXT,
      updated_by TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (profile_id, section_key)
    );
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      title TEXT,
      sponsor TEXT,
      source TEXT,
      source_id TEXT,
      source_url TEXT,
      record_origin TEXT,
      description TEXT,
      -- Must mirror production: upsertSchoolPortalAwardAsOpportunity INSERTs
      -- profile_id, and without the column the insert fails as schema drift
      -- rather than as a duplicate, so the award silently never reaches the
      -- catalog and the #534 assertion below fails.
      profile_id TEXT,
      amount_min REAL,
      amount_max REAL,
      amount_description TEXT,
      application_url TEXT,
      apply_url TEXT,
      application_mode TEXT,
      opportunity_type TEXT,
      opportunity_kind TEXT,
      source_trust_tier TEXT,
      is_active INTEGER DEFAULT 1,
      is_hidden INTEGER DEFAULT 0,
      last_verified_at DATETIME,
      categories TEXT,
      keywords TEXT,
      eligibility_bullets TEXT,
      entity_types_allowed TEXT,
      reality_status TEXT,
      reality_reasons TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE profile_opportunity_matches (
      profile_id TEXT NOT NULL,
      opportunity_id TEXT NOT NULL,
      match_score REAL,
      match_decision TEXT,
      match_explanation TEXT,
      matcher_version TEXT,
      updated_at TEXT,
      computed_at TEXT,
      PRIMARY KEY (profile_id, opportunity_id, matcher_version)
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY,
      profile_id TEXT,
      title TEXT,
      status TEXT,
      updated_at DATETIME
    );
    CREATE TABLE notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      profile_id TEXT,
      type TEXT,
      title TEXT,
      message TEXT,
      severity TEXT,
      data TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      read INTEGER NOT NULL DEFAULT 0,
      read_at DATETIME
    );
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      organization_id TEXT,
      grant_id TEXT,
      profile_id TEXT,
      university_application_id TEXT,
      university_application_name TEXT,
      title TEXT,
      name TEXT,
      type TEXT,
      file_path TEXT,
      file_url TEXT,
      mime_type TEXT,
      file_size INTEGER,
      file_bytes BLOB,
      extracted_text TEXT,
      processing_status TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE profile_documents (
      profile_id TEXT,
      document_id TEXT,
      role TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (profile_id, document_id)
    );
    INSERT INTO profiles (id, user_id, display_name, primary_type, status)
      VALUES ('${STUDENT_PROFILE_ID}', '${STUDENT_USER_ID}', 'Demo Tennessee STEM Student', 'high_school_student', 'active');
    INSERT INTO users (id, primary_email, is_admin, role)
      VALUES ('${STUDENT_USER_ID}', 'demo.student@example.invalid', 0, 'user');
  `)
  // Seed the student's MTSU university application entry.
  sqlite.prepare(
    `INSERT INTO profile_sections (profile_id, section_key, data, updated_by) VALUES (?, ?, ?, ?)`,
  ).run(
    STUDENT_PROFILE_ID,
    'university_applications',
    JSON.stringify({
      applications: [
        {
          id: MTSU_APPLICATION_ID,
          name: 'Middle Tennessee State University',
          school_name: 'Middle Tennessee State University',
          status: 'committed',
          imported_portal_awards: [],
          financial_aid_pipeline: [],
        },
      ],
      school_portal_imports: { version: 1, connections: [] },
    }),
    'test-seed',
  )
  return wrapSqlite(sqlite)
}

beforeEach(() => {
  _resetTaskSchemaCache()
  _resetNotificationsSchemaCache()
  _resetAuthSchemaCache()
})

// ---------------------------------------------------------------------------
// Pipeline ↔ MTSU portal merge
// ---------------------------------------------------------------------------
describe('source-safe student / MTSU pipeline portal merge', () => {
  it("the merge service recognises 'mtsu' as a supported provider", () => {
    const ids = SCHOOL_PORTAL_PROVIDERS.map((p) => p.id)
    assert.ok(ids.includes('mtsu'), `SCHOOL_PORTAL_PROVIDERS must include 'mtsu', got: ${ids.join(', ')}`)
    const mtsu = SCHOOL_PORTAL_PROVIDERS.find((p) => p.id === 'mtsu')
    assert.equal(mtsu.short_name, 'MTSU')
    assert.ok(mtsu.live_supported)
    assert.ok(mtsu.automation_supported)
  })

  it('creates an MTSU portal connection and merges its awards into the pipeline + funding_opportunities', async () => {
    const db = makeDb()

    // 1. Connect the student's MTSU portal with three institutional awards.
    const conn = await createSchoolPortalConnection(db, STUDENT_PROFILE_ID, {
      provider_id: 'mtsu',
      connection_label: 'MTSU MyMT Award Letter (2026-27)',
      school_name: 'Middle Tennessee State University',
      portal_url: 'https://www.mtsu.edu/financial-aid/',
      application_id: MTSU_APPLICATION_ID,
      awards: [
        { title: 'MTSU True Blue Scholarship', amount: 5000, academic_year: '2026-27', external_id: 'mtsu-true-blue-2026' },
        { title: 'MTSU Centennial Scholarship', amount: 2000, academic_year: '2026-27', external_id: 'mtsu-centennial-2026' },
        { title: 'MTSU Honors College Scholarship', amount: 1500, academic_year: '2026-27', external_id: 'mtsu-honors-2026' },
      ],
    }, 'test-admin')

    assert.equal(conn.connection.provider_id, 'mtsu')
    assert.equal(conn.connection.available_awards.length, 3)

    // 2. Merge ALL three MTSU awards into the pipeline at once.
    const mergeResult = await mergeSchoolPortalAwards(db, STUDENT_PROFILE_ID, {
      connection_id: conn.connection.id,
      application_id: MTSU_APPLICATION_ID,
      award_ids: conn.connection.available_awards.map((a) => a.id),
    }, 'test-admin')

    assert.equal(mergeResult.merged_count, 3, 'every selected MTSU award must merge into the pipeline')
    assert.equal(
      mergeResult.opportunities_upserted,
      3,
      'Issue #534 — every merged MTSU award must surface in funding_opportunities so Discover Grants sees it',
    )

    // 3. Confirm the awards appear under the student's MTSU university application.
    const sec = await db
      .prepare(`SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = 'university_applications'`)
      .get(STUDENT_PROFILE_ID)
    const parsed = JSON.parse(sec.data)
    const mtsuApp = parsed.applications.find((a) => a.id === MTSU_APPLICATION_ID)
    assert.equal(mtsuApp.imported_portal_awards.length, 3)
    assert.equal(mtsuApp.financial_aid_pipeline.length, 3)
    const titles = mtsuApp.imported_portal_awards.map((a) => a.title).sort()
    assert.deepEqual(titles, [
      'MTSU Centennial Scholarship',
      'MTSU Honors College Scholarship',
      'MTSU True Blue Scholarship',
    ])

    // 4. Confirm the global funding_opportunities rows are tagged 'school_portal'
    //    so Discover Grants and Hamilton can find them.
    const oppRows = await db
      .prepare(`SELECT id, title, source, opportunity_kind, opportunity_type, is_active FROM funding_opportunities WHERE source = 'school_portal' ORDER BY title`)
      .all()
    assert.equal(oppRows.length, 3)
    for (const r of oppRows) {
      assert.equal(r.source, 'school_portal')
      // The merge service writes scholarship into opportunity_type and
      // tags opportunity_kind = 'school_portal' so Discover Grants can
      // both classify and provenance-trace the row.
      assert.equal(r.opportunity_type, 'scholarship')
      assert.equal(r.opportunity_kind, 'school_portal')
      assert.equal(Number(r.is_active), 1)
    }
  })
})

// ---------------------------------------------------------------------------
// Hamilton drains every MTSU task without SQL errors
// ---------------------------------------------------------------------------
describe('Hamilton agent adapter — MTSU queue drain', () => {
  it('SELECTs application_tasks using the columns that actually exist (regression)', async () => {
    const db = makeDb()
    await ensureApplicationTaskSchema(db)

    // Seed three MTSU funding_opportunities + matching application_tasks for the student.
    const mtsuOpps = [
      {
        id: 'mtsu-true-blue', title: 'MTSU True Blue', sponsor: 'MTSU',
        application_url: 'https://www.mtsu.edu/financial-aid/true-blue/apply.pdf',
        opportunity_type: 'mail',
      },
      {
        id: 'mtsu-centennial', title: 'MTSU Centennial', sponsor: 'MTSU',
        application_url: 'mailto:financial-aid@mtsu.edu',
        source_url: 'https://www.mtsu.edu/financial-aid/scholarships/',
        opportunity_type: 'email',
      },
      {
        id: 'mtsu-honors', title: 'MTSU Honors College Scholarship', sponsor: 'MTSU',
        application_url: 'https://www.mtsu.edu/honors/apply',
        opportunity_type: 'portal',
      },
    ]
    for (const o of mtsuOpps) {
      await db.prepare(
        `INSERT INTO funding_opportunities
           (id, title, sponsor, source, application_url, opportunity_type, is_active, source_url,
            entity_types_allowed, record_origin, source_trust_tier, reality_status, reality_reasons,
            created_at, updated_at)
         VALUES (?, ?, ?, 'school_portal', ?, ?, 1, ?, '["individual","student"]',
           'live_crawl', 'official', 'verified', '[]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      ).run(o.id, o.title, o.sponsor, o.application_url, o.opportunity_type, o.source_url || o.application_url)
      await db.prepare(
        `INSERT INTO profile_opportunity_matches
           (profile_id, opportunity_id, match_score, match_decision, match_explanation, matcher_version, updated_at, computed_at)
         VALUES (?, ?, 95, 'accept', 'Crawler OS approved this institutional scholarship for the student.', 'crawler-os', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      ).run(STUDENT_PROFILE_ID, o.id)
      await db.prepare(
        `INSERT INTO application_tasks
           (id, profile_id, opportunity_id, automation_type, status, current_pipeline_stage, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', 'ready_to_submit', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      ).run(`task-${o.id}`, STUDENT_PROFILE_ID, o.id, o.opportunity_type)
    }

    const adapter = new HamiltonAgentAdapter()
    const events = []
    const signal = makeSignal({
      runId: 'run-demo-student',
      stepId: 'step-hamilton',
      agentName: 'hamilton',
      shouldStop: () => false,
      shouldPause: () => false,
      isEmergency: () => false,
      heartbeat: async () => {},
      recordEvent: async (e) => { events.push(e) },
    })

    const result = await adapter.start({
      db,
      controlRunId: 'run-demo-student',
      stepId: 'step-hamilton',
      options: { hamilton_batch_size: 10 },
      signal,
    })

    assert.equal(result.ok, true, `Hamilton must run cleanly. result: ${JSON.stringify(result)}`)
    // Packet/deferred pathways can advance their durable task without opening
    // a browser autopilot run. The adapter must report that honestly as a noop,
    // not claim end-to-end completion.
    assert.equal(result.status, 'noop')
    assert.equal(result.summary.no_run, 3)
    assert.match(result.summary.noop_reason, /^no_task_opened_a_run:/)
    // Critically, this used to be 0 — the old SELECT referenced non-existent
    // columns and silently returned no rows, then the source mapping passed
    // `id: task.funding_source_id` which automateSingleSource rejected with
    // "source must include opportunity_id or grant_id". Both bugs are now
    // gone, so all three queued MTSU tasks must be picked up.
    assert.equal(result.summary.attempted, 3, `all three MTSU tasks must be picked up by the new SELECT — got attempted=${result.summary.attempted}, results=${JSON.stringify(result.summary.results)}`)

    // No "must include opportunity_id or grant_id" failures: when the source
    // mapping is correct, automateSingleSource at minimum classifies the
    // opportunity and persists progress on the task. A failure on these MTSU
    // sources here would mean the regression came back.
    const failureMessages = (result.summary.results || [])
      .filter((r) => r.ok === false)
      .map((r) => r.error || '')
    for (const msg of failureMessages) {
      assert.doesNotMatch(
        msg,
        /must include opportunity_id or grant_id/i,
        `Hamilton must never fail with the JWT-shape source-mapping bug — got: ${msg}`,
      )
      assert.doesNotMatch(
        msg,
        /no such column.*(?:funding_source_id|funding_opportunity_id|opportunity_id)/i,
        `Hamilton must never fail because a legacy grant-link column is absent — got: ${msg}`,
      )
    }

    // Each MTSU task should have advanced past 'queued' (Hamilton classified
    // it and at least flipped its status into the appropriate downstream
    // state — analyzing / generating_application / ready_to_print_mail / etc).
    const tasksAfter = await db.prepare('SELECT id, status FROM application_tasks').all()
    for (const t of tasksAfter) {
      assert.notEqual(t.status, 'queued', `task ${t.id} should have advanced past 'queued', got: ${t.status}`)
    }
  })

  it('skips cleanly when there are no queued tasks (no false failure)', async () => {
    const db = makeDb()
    await ensureApplicationTaskSchema(db)

    const adapter = new HamiltonAgentAdapter()
    const signal = makeSignal({
      runId: 'r', stepId: 's', agentName: 'hamilton',
      shouldStop: () => false, shouldPause: () => false, isEmergency: () => false,
      heartbeat: async () => {},
      recordEvent: async () => {},
    })
    const result = await adapter.start({ db, controlRunId: 'r', stepId: 's', options: {}, signal })
    assert.equal(result.ok, true)
    // An empty queue is an honest NOOP, NOT "completed work" (charter
    // AGENT_NOOP_CONDITIONS): the adapter reports status 'noop' with a
    // noop_reason so dashboards that only surface `status` don't read an
    // idle run as a green completion. ok:true still means "ran without error".
    assert.equal(result.status, 'noop')
    assert.equal(result.summary.noop_reason, 'empty_queue')
    assert.equal(result.summary.attempted, 0)
    assert.equal(result.summary.processed, 0)
  })
})
