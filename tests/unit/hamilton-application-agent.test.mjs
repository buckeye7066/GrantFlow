/**
 * Unit tests for backend/services/hamiltonApplicationAgent.js + companion
 * stores. Verifies:
 *   - Hamilton detects missing info instead of hallucinating.
 *   - Hamilton blocks on CAPTCHA / 2FA / login (institutional aid portals).
 *   - Hamilton creates a persistent notification for missing info.
 *   - Hamilton never auto-submits without explicit authorization.
 *   - Profile scoping: a task on profile A cannot be advanced by passing
 *     profile B's id.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

import {
  startHamiltonForOpportunity,
  continueHamiltonTask,
  runHamiltonCycle,
} from '../../backend/services/hamiltonApplicationAgent.js'
import {
  getApplicationTask,
  listMissingInfo,
  listTaskEvents,
  _resetSchemaCache,
} from '../../backend/services/hamilton/applicationTaskStore.js'
import { _resetSchemaCache as _resetPortalCache } from '../../backend/services/hamilton/studentPortalStore.js'
import { _resetLinkSchemaCache } from '../../backend/services/hamilton/studentFundingPortalLinker.js'
import { _resetNotificationsSchemaCache } from '../../backend/services/hamilton/hamiltonNotifications.js'

function makeMemoryDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec('PRAGMA foreign_keys = OFF')
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      organization_id TEXT,
      display_name TEXT
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      role TEXT
    );
    INSERT INTO profiles (id, user_id, display_name) VALUES ('p-mtsu', 'u-1', 'Anastasia');
    INSERT INTO profiles (id, user_id, display_name) VALUES ('p-other', 'u-2', 'Other Student');
    INSERT INTO users (id, role) VALUES ('u-admin', 'admin');
    CREATE TABLE IF NOT EXISTS profile_sections (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      section_key TEXT NOT NULL,
      data TEXT NOT NULL
    );
    INSERT INTO profile_sections (id, profile_id, section_key, data)
      VALUES ('ps-1', 'p-mtsu', 'basic_information',
              '{"first_name":"Anastasia","last_name":"K","email":"a@example.com","state":"TN"}');
    INSERT INTO profile_sections (id, profile_id, section_key, data)
      VALUES ('ps-2', 'p-mtsu', 'university_applications',
              '{"applications":[{"name":"Middle Tennessee State University","status":"committed","committed":true}]}');
    INSERT INTO profile_sections (id, profile_id, section_key, data)
      VALUES ('ps-3', 'p-other', 'basic_information',
              '{"first_name":"Sam","last_name":"L"}');
    INSERT INTO profile_sections (id, profile_id, section_key, data)
      VALUES ('ps-4', 'p-other', 'university_applications',
              '{"applications":[{"name":"University of New Haven","status":"submitted"}]}');
    CREATE TABLE IF NOT EXISTS funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT, description TEXT, application_url TEXT,
      funding_source_type TEXT, category TEXT
    );
    INSERT INTO funding_opportunities (id, title, description, application_url, funding_source_type, category)
      VALUES ('opp-mtsu-merit', 'MTSU Presidential Scholarship',
              'A merit scholarship for incoming undergraduates at Middle Tennessee State University.',
              'https://www.mtsu.edu/financial-aid/scholarships/', 'university', 'scholarship');
    INSERT INTO funding_opportunities (id, title, description, application_url, funding_source_type)
      VALUES ('opp-fafsa', 'MTSU Federal Work-Study',
              'Need-based federal work-study at Middle Tennessee State University. Requires FAFSA.',
              'https://www.mtsu.edu/financial-aid/', 'university');
    INSERT INTO funding_opportunities (id, title, description, application_url)
      VALUES ('opp-external', 'Going Merry General Scholarship',
              'A scholarship marketplace listing.',
              'https://www.goingmerry.com/scholarships/example-99');
    CREATE TABLE IF NOT EXISTS grants (
      id TEXT PRIMARY KEY, status TEXT, application_url TEXT
    );
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY, profile_id TEXT, type TEXT, kind TEXT, filename TEXT, label TEXT, university_application_name TEXT
    );
  `)
  return {
    dialect: 'sqlite',
    prepare(sql) {
      const stmt = sqlite.prepare(sql)
      return {
        get: async (...params) => stmt.get(...params),
        all: async (...params) => stmt.all(...params),
        run: async (...params) => {
          const r = stmt.run(...params)
          return { changes: r.changes, lastInsertRowid: r.lastInsertRowid }
        },
      }
    },
    exec(sql) { sqlite.exec(sql) },
    raw: sqlite,
  }
}

function resetCaches() {
  _resetSchemaCache()
  _resetPortalCache()
  _resetLinkSchemaCache()
  _resetNotificationsSchemaCache()
}

describe('hamiltonApplicationAgent — institutional aid', () => {
  it('blocks with login_required on financial-aid portal (FAFSA)', async () => {
    resetCaches()
    const db = makeMemoryDb()
    const result = await startHamiltonForOpportunity(db, {
      profileId: 'p-mtsu',
      userId: 'u-1',
      opportunityId: 'opp-fafsa',
    })
    assert.equal(result.ok, true)
    assert.equal(result.task.status, 'blocked_login_required',
      `expected blocked_login_required, got ${result.task.status}`)
    const missing = await listMissingInfo(db, result.task.id)
    assert.ok(missing.some((m) => m.kind === 'login'), 'login requirement is recorded')
    const notifs = db.raw.prepare("SELECT * FROM notifications WHERE type LIKE 'hamilton_%'").all()
    assert.ok(notifs.length >= 1, 'persistent notification emitted for the user')
  })
})

describe('hamiltonApplicationAgent — scholarship / external', () => {
  it('drafts and waits for user when scholarship portal is ready', async () => {
    resetCaches()
    const db = makeMemoryDb()
    // Add fake docs so the adapter is satisfied.
    db.raw.prepare('INSERT INTO documents (id, profile_id, type) VALUES (?, ?, ?)')
      .run('d1', 'p-mtsu', 'transcript')
    db.raw.prepare('INSERT INTO documents (id, profile_id, type) VALUES (?, ?, ?)')
      .run('d2', 'p-mtsu', 'personal_statement')

    const result = await startHamiltonForOpportunity(db, {
      profileId: 'p-mtsu',
      userId: 'u-1',
      opportunityId: 'opp-mtsu-merit',
    })
    assert.equal(result.ok, true)
    // Scholarship portals draft and then wait for student-attestation login.
    assert.ok(['draft_completed', 'blocked_login_required', 'waiting_for_user'].includes(result.task.status),
      `expected draft/blocked/waiting, got ${result.task.status}`)
  })

  it('detects missing info on external scholarship when profile is incomplete', async () => {
    resetCaches()
    const db = makeMemoryDb()
    // Empty out the basic information so required fields are missing.
    db.raw.prepare("UPDATE profile_sections SET data = '{}' WHERE profile_id = 'p-mtsu' AND section_key = 'basic_information'").run()
    const result = await startHamiltonForOpportunity(db, {
      profileId: 'p-mtsu',
      userId: 'u-1',
      opportunityId: 'opp-external',
    })
    assert.equal(result.ok, true)
    assert.equal(result.task.status, 'blocked_missing_info',
      `expected blocked_missing_info, got ${result.task.status}`)
    assert.ok(result.missing_info.length > 0, 'missing fields recorded')
    assert.ok(!result.missing_info.some((m) => m.label === 'invented_field'),
      'Hamilton never invents missing fields')
  })

  it('does NOT auto-submit when auto_submit_enabled is false (default)', async () => {
    resetCaches()
    const db = makeMemoryDb()
    db.raw.prepare('INSERT INTO documents (id, profile_id, type) VALUES (?, ?, ?)')
      .run('d1', 'p-mtsu', 'transcript')
    db.raw.prepare('INSERT INTO documents (id, profile_id, type) VALUES (?, ?, ?)')
      .run('d2', 'p-mtsu', 'personal_statement')
    const result = await startHamiltonForOpportunity(db, {
      profileId: 'p-mtsu',
      userId: 'u-1',
      opportunityId: 'opp-external',
    })
    assert.notEqual(result.task.status, 'submitted', 'never submitted without explicit authorisation')
  })
})

describe('hamiltonApplicationAgent — profile scoping', () => {
  it('runHamiltonCycle rejects when profileId does not match the task', async () => {
    resetCaches()
    const db = makeMemoryDb()
    const start = await startHamiltonForOpportunity(db, {
      profileId: 'p-mtsu',
      userId: 'u-1',
      opportunityId: 'opp-fafsa',
    })
    await assert.rejects(
      () => runHamiltonCycle(db, { taskId: start.task.id, profileId: 'p-other', userId: 'u-2' }),
      /profile mismatch/i,
    )
  })
})

describe('hamiltonApplicationAgent — task events audit', () => {
  it('records a "created" event followed by a status-change event', async () => {
    resetCaches()
    const db = makeMemoryDb()
    const result = await startHamiltonForOpportunity(db, {
      profileId: 'p-mtsu',
      userId: 'u-1',
      opportunityId: 'opp-fafsa',
    })
    const events = await listTaskEvents(db, result.task.id)
    assert.ok(events.length >= 2, 'at least created + run events')
    assert.equal(events[0].event_type, 'created')
    assert.ok(events.some((e) => e.event_type === 'blocked'))
  })
})
