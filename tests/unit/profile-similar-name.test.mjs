import test from 'node:test'
import assert from 'node:assert/strict'
import {
  profilesHaveSimilarNames,
  tokenizeProfileDisplayName,
  findDuplicateProfileGroups,
} from '../../backend/services/profileDedupeService.js'

test('tokenizeProfileDisplayName normalizes punctuation and case', () => {
  assert.deepEqual(tokenizeProfileDisplayName('Maria L. Sample'), ['maria', 'l', 'sample'])
  assert.deepEqual(tokenizeProfileDisplayName('  Maria  '), ['maria'])
})

test('profilesHaveSimilarNames groups short and full person names', () => {
  assert.equal(profilesHaveSimilarNames('Maria', 'Maria L. Sample'), true)
  assert.equal(profilesHaveSimilarNames('Maria L Sample', 'Maria Sample'), true)
  assert.equal(profilesHaveSimilarNames('John', 'John Smith'), true)
})

test('profilesHaveSimilarNames rejects unrelated names', () => {
  assert.equal(profilesHaveSimilarNames('John Smith', 'John Jones'), false)
  assert.equal(profilesHaveSimilarNames('Sample', 'Maria L Sample'), false)
  assert.equal(profilesHaveSimilarNames('Cleveland Blue Raiders', 'William'), false)
})

test('findDuplicateProfileGroups similar_name strategy groups partial names', async () => {
  const Database = (await import('better-sqlite3')).default
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const path = (await import('node:path')).default

  const tmp = mkdtempSync(path.join(tmpdir(), 'grantflow-similar-name-'))
  const dbPath = path.join(tmp, 'test.db')
  const db = new Database(dbPath)

  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      primary_type TEXT,
      status TEXT,
      user_id TEXT,
      organization_id TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE profile_sections (
      id TEXT PRIMARY KEY,
      profile_id TEXT,
      section_key TEXT,
      data TEXT
    );
    CREATE TABLE documents (id TEXT PRIMARY KEY, profile_id TEXT);
    CREATE TABLE crawler_jobs (id TEXT PRIMARY KEY, profile_id TEXT);
    CREATE TABLE anya_sessions (id TEXT PRIMARY KEY, profile_id TEXT);
    CREATE TABLE billing_accounts (id TEXT PRIMARY KEY, profile_id TEXT);
  `)

  const shortId = '00000000-0000-0000-0000-00000000a101'
  const fullId = '00000000-0000-0000-0000-00000000a102'
  const otherId = '00000000-0000-0000-0000-00000000a103'

  db.exec(`
    INSERT INTO profiles (id, display_name, status, created_at, updated_at)
    VALUES
      ('${shortId}', 'Maria', 'active', '2026-01-01', '2026-01-01'),
      ('${fullId}', 'Maria L. Sample', 'active', '2026-01-02', '2026-01-02'),
      ('${otherId}', 'William', 'active', '2026-01-01', '2026-01-01');

    INSERT INTO profile_sections (id, profile_id, section_key, data)
    VALUES
      ('00000000-0000-0000-0000-00000000a201', '${fullId}', 'basic_information', '{"email":"maria.sample@example.invalid","state":"OH"}');
  `)

  const sqliteDb = {
    dialect: 'sqlite',
    prepare(sql) {
      const stmt = db.prepare(sql)
      return {
        all(...args) {
          return stmt.all(...args)
        },
        get(...args) {
          return stmt.get(...args)
        },
        run(...args) {
          return stmt.run(...args)
        },
      }
    },
  }

  const report = await findDuplicateProfileGroups(sqliteDb, {
    strategy: 'similar_name',
    limitGroups: 10,
    minGroupSize: 2,
  })

  assert.equal(report.groups.length, 1)
  assert.equal(report.groups[0].count, 2)
  assert.equal(report.groups[0].winner.id, fullId)
  assert.ok(report.groups[0].losers.some((profile) => profile.id === shortId))

  db.close()
})
