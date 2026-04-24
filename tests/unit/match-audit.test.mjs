import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

import { auditMatchQuality } from '../../backend/services/codeGuardService.js'

function makeDb() {
  const raw = new Database(':memory:')
  // Minimum schema needed by auditMatchQuality + gradeProfile.
  raw.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      primary_type TEXT,
      tags TEXT
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY,
      profile_id TEXT,
      title TEXT,
      funder TEXT,
      match_score INTEGER,
      match_decision TEXT,
      match_explanation TEXT,
      matched_needs TEXT,
      application_url TEXT
    );
    CREATE TABLE anya_brain_memory (
      id TEXT PRIMARY KEY,
      scope TEXT,
      memory_key TEXT,
      memory_type TEXT,
      content TEXT,
      source TEXT,
      ttl_seconds INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)
  // Minimal interface that matches backend/db/index.js prepare() surface.
  const stub = {
    dialect: 'sqlite',
    prepare(sql) {
      const s = raw.prepare(sql)
      return {
        get: (...args) => s.get(...args.flat()),
        all: (...args) => s.all(...args.flat()),
        run: (...args) => s.run(...args.flat()),
      }
    },
  }
  return { raw, db: stub }
}

test('auditMatchQuality grades ≥80% of profiles B-or-better after backfill', async () => {
  const { raw, db } = makeDb()
  const pIns = raw.prepare('INSERT INTO profiles (id, display_name, primary_type, tags) VALUES (?, ?, ?, ?)')
  const gIns = raw.prepare(
    'INSERT INTO grants (id, profile_id, title, funder, match_score, match_decision, match_explanation, matched_needs, application_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )

  const profileCount = 10
  for (let i = 0; i < profileCount; i++) {
    const pid = `p${i}`
    pIns.run(pid, `Profile ${i}`, 'nonprofit', '[]')
    for (let j = 0; j < 10; j++) {
      gIns.run(
        `g-${i}-${j}`,
        pid,
        `Grant ${j} for Profile ${i}`,
        'Some Funder',
        55,
        'review',
        `Backfilled: Grant ${j} for Profile ${i} from Some Funder — review recommended`,
        '["backfill"]',
        `https://example.com/grant/${i}/${j}`,
      )
    }
  }

  const result = await auditMatchQuality(db)
  const gradesAtOrAboveB = result.grades.A + result.grades.B
  const ratio = gradesAtOrAboveB / Math.max(1, result.totalProfiles)
  assert.ok(
    ratio >= 0.8,
    `expected ≥80% B-or-better, got ${gradesAtOrAboveB}/${result.totalProfiles} (grades=${JSON.stringify(result.grades)})`,
  )
})

test('auditMatchQuality: F when decision+explanation+needs all missing', async () => {
  const { raw, db } = makeDb()
  raw.prepare('INSERT INTO profiles (id, display_name, primary_type, tags) VALUES (?, ?, ?, ?)').run('p1', 'P1', 'org', '[]')
  const gIns = raw.prepare(
    'INSERT INTO grants (id, profile_id, title, funder, match_score, match_decision, match_explanation, matched_needs, application_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
  for (let j = 0; j < 5; j++) {
    gIns.run(`g-${j}`, 'p1', `T${j}`, 'F', 20, null, null, '[]', null)
  }
  const result = await auditMatchQuality(db)
  const p1 = result.profiles.find((p) => p.profileId === 'p1')
  assert.equal(p1.grade, 'F', `expected F, got ${p1.grade}`)
})
