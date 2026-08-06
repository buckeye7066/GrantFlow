import test from 'node:test'
import assert from 'node:assert/strict'

import Database from 'better-sqlite3'
import { findDuplicateProfileGroups, mergeProfiles, normalizeProfileNameKey } from '../../backend/services/profileDedupeService.js'

function makeTestDb() {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      primary_type TEXT,
      status TEXT DEFAULT 'active',
      user_id TEXT,
      organization_id TEXT,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE profile_sections (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      section_key TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_by TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(profile_id, section_key)
    );

    CREATE TABLE profile_documents (profile_id TEXT NOT NULL, document_id TEXT NOT NULL, PRIMARY KEY (profile_id, document_id));

    CREATE TABLE documents (id TEXT PRIMARY KEY, profile_id TEXT, name TEXT);
    CREATE TABLE crawler_jobs (id TEXT PRIMARY KEY, profile_id TEXT);
    CREATE TABLE crawler_schedules (id TEXT PRIMARY KEY, profile_id TEXT);
    CREATE TABLE anya_sessions (id TEXT PRIMARY KEY, profile_id TEXT);
    CREATE TABLE anya_tasks (id TEXT PRIMARY KEY, profile_id TEXT);
    CREATE TABLE anya_tool_usage (id TEXT PRIMARY KEY, profile_id TEXT);
    CREATE TABLE service_applications (id TEXT PRIMARY KEY, profile_id TEXT);
    CREATE TABLE funding_opportunities (id TEXT PRIMARY KEY, profile_id TEXT);

    CREATE TABLE billing_accounts (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, metadata TEXT);
    CREATE TABLE billing_account_events (id TEXT PRIMARY KEY, account_id TEXT NOT NULL);

    CREATE TABLE anya_brain_memory (id TEXT PRIMARY KEY, scope TEXT, scope_id TEXT, memory_key TEXT, content TEXT);
  `)

  const db = {
    dialect: 'sqlite',
    prepare(sql) {
      const stmt = raw.prepare(sql)
      return {
        get: (...args) => stmt.get(...args),
        all: (...args) => stmt.all(...args),
        run: (...args) => stmt.run(...args),
      }
    },
    async withTransaction(fn) {
      raw.exec('BEGIN')
      try {
        const res = await fn(db)
        raw.exec('COMMIT')
        return res
      } catch (e) {
        raw.exec('ROLLBACK')
        throw e
      }
    },
  }

  return db
}

test('normalizeProfileNameKey: lowercases, strips punctuation, collapses spaces', () => {
  assert.equal(normalizeProfileNameKey('  Démó  Applicant.  '), 'demo applicant')
  assert.equal(normalizeProfileNameKey('Robert!!!'), 'robert')
})

test('findDuplicateProfileGroups picks the most complete profile as winner', async () => {
  const db = makeTestDb()

  db.prepare('INSERT INTO profiles (id, display_name, status, updated_at) VALUES (?, ?, ?, ?)').run('p1', 'Robert', 'active', '2026-01-01')
  db.prepare('INSERT INTO profiles (id, display_name, status, updated_at) VALUES (?, ?, ?, ?)').run('p2', 'Robert', 'active', '2026-01-02')

  db.prepare('INSERT INTO profile_sections (id, profile_id, section_key, data) VALUES (?, ?, ?, ?)').run(
    's1',
    'p1',
    'basic_information',
    JSON.stringify({ email: 'robert@example.com', city: 'Columbus' }),
  )
  db.prepare('INSERT INTO profile_sections (id, profile_id, section_key, data) VALUES (?, ?, ?, ?)').run(
    's2',
    'p1',
    'needs_assessment',
    JSON.stringify({ needs: ['rent assistance'] }),
  )

  const report = await findDuplicateProfileGroups(db, { strategy: 'exact_name', limitGroups: 10 })
  assert.equal(report.groups.length, 1)
  assert.equal(report.groups[0].winner.id, 'p1')
  assert.equal(report.groups[0].losers.length, 1)
  assert.equal(report.groups[0].losers[0].id, 'p2')
})

test('mergeProfiles repoints references and deletes loser', async () => {
  const db = makeTestDb()

  db.prepare('INSERT INTO profiles (id, display_name, status, updated_at) VALUES (?, ?, ?, ?)').run('winner', 'demo_senior_family', 'active', '2026-01-01')
  db.prepare('INSERT INTO profiles (id, display_name, status, updated_at) VALUES (?, ?, ?, ?)').run('loser', 'demo_senior_family', 'active', '2026-01-02')

  db.prepare('INSERT INTO profile_sections (id, profile_id, section_key, data) VALUES (?, ?, ?, ?)').run(
    'ws1',
    'winner',
    'basic_information',
    JSON.stringify({ city: 'Cleveland' }),
  )
  db.prepare('INSERT INTO profile_sections (id, profile_id, section_key, data) VALUES (?, ?, ?, ?)').run(
    'ls1',
    'loser',
    'basic_information',
    JSON.stringify({ email: 'demo_senior_family@example.com' }),
  )

  db.prepare('INSERT INTO documents (id, profile_id, name) VALUES (?, ?, ?)').run('d1', 'loser', 'doc')
  db.prepare('INSERT INTO profile_documents (profile_id, document_id) VALUES (?, ?)').run('loser', 'd1')
  db.prepare('INSERT INTO crawler_jobs (id, profile_id) VALUES (?, ?)').run('j1', 'loser')
  db.prepare('INSERT INTO anya_sessions (id, profile_id) VALUES (?, ?)').run('a1', 'loser')
  db.prepare("INSERT INTO anya_brain_memory (id, scope, scope_id, memory_key, content) VALUES (?, 'profile', ?, ?, ?)").run(
    'm1',
    'loser',
    'k',
    '{}',
  )

  const res = await mergeProfiles(db, { winnerId: 'winner', loserIds: ['loser'], dryRun: false, actorUserId: 'admin' })
  assert.equal(res.dry_run, false)

  const loserRow = db.prepare('SELECT id FROM profiles WHERE id = ?').get('loser')
  assert.equal(loserRow, undefined)

  const doc = db.prepare('SELECT profile_id FROM documents WHERE id = ?').get('d1')
  assert.equal(doc.profile_id, 'winner')

  const join = db.prepare('SELECT profile_id FROM profile_documents WHERE document_id = ?').get('d1')
  assert.equal(join.profile_id, 'winner')

  const job = db.prepare('SELECT profile_id FROM crawler_jobs WHERE id = ?').get('j1')
  assert.equal(job.profile_id, 'winner')

  const session = db.prepare('SELECT profile_id FROM anya_sessions WHERE id = ?').get('a1')
  assert.equal(session.profile_id, 'winner')

  const mem = db.prepare('SELECT scope_id FROM anya_brain_memory WHERE id = ?').get('m1')
  assert.equal(mem.scope_id, 'winner')

  const mergedSection = db
    .prepare('SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = ?')
    .get('winner', 'basic_information')
  const parsed = JSON.parse(mergedSection.data)
  assert.equal(parsed.city, 'Cleveland')
  assert.equal(parsed.email, 'demo_senior_family@example.com')
})

test('mergeProfiles tolerates missing optional tables/columns (production schema drift safety)', async () => {
  const db = makeTestDb()

  // Simulate a partial schema (e.g. a drifted Postgres instance) by dropping a few tables.
  db.prepare('DROP TABLE crawler_schedules').run()
  db.prepare('DROP TABLE anya_tool_usage').run()

  db.prepare('INSERT INTO profiles (id, display_name, status, updated_at) VALUES (?, ?, ?, ?)').run('winner2', 'GrantFlow Smoke', 'active', '2026-01-01')
  db.prepare('INSERT INTO profiles (id, display_name, status, updated_at) VALUES (?, ?, ?, ?)').run('loser2', 'GrantFlow Smoke', 'active', '2026-01-02')

  db.prepare('INSERT INTO documents (id, profile_id, name) VALUES (?, ?, ?)').run('d2', 'loser2', 'doc')

  const res = await mergeProfiles(db, { winnerId: 'winner2', loserIds: ['loser2'], dryRun: false, actorUserId: 'admin' })
  assert.equal(res.dry_run, false)

  const doc = db.prepare('SELECT profile_id FROM documents WHERE id = ?').get('d2')
  assert.equal(doc.profile_id, 'winner2')
})
