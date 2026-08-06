/**
 * profile-resolver.test.mjs
 *
 * Regression for: scholarship/curated_benefits jobs failing with
 *   "Snapshot creation failed: Profile profile-demo-tennessee-stem-student not found"
 *   Result payload: { non_retryable: true }
 *
 * Mission goals:
 *   - Zero results is a failure state (must self-heal when possible).
 *   - null / undefined / missing profile fields default to neutral, not exclusionary.
 *   - Profile attributes increase score, not eliminate results.
 *
 * The resolver must convert a stale designated-profile slug into a live
 * `profiles` row when the live row exists under a different id (e.g. UUID
 * keyed) but the same display_name as the configured designated profile.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../helpers/sqliteTestDb.mjs'

import { resolveProfileForId, isDesignatedProfileSlug } from '../../backend/utils/profileResolver.js'

function makeDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      primary_type TEXT,
      status TEXT DEFAULT 'active',
      tags TEXT DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE profile_sections (
      id TEXT PRIMARY KEY,
      profile_id TEXT,
      section_key TEXT,
      data TEXT,
      updated_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(profile_id, section_key)
    );
    CREATE TABLE profile_tombstones (
      profile_id TEXT PRIMARY KEY,
      deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      deleted_by TEXT,
      reason TEXT
    );
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      primary_email TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE profile_users (
      profile_id TEXT,
      user_id TEXT,
      role TEXT DEFAULT 'owner',
      PRIMARY KEY(profile_id, user_id)
    );
  `)
  return { ...wrapSqlite(sqlite), withTransaction(fn) { return fn(this) } }
}

describe('isDesignatedProfileSlug', () => {
  it('recognizes demo_stem_student-white as a designated slug', () => {
    assert.equal(isDesignatedProfileSlug('profile-demo-tennessee-stem-student'), true)
  })

  it('rejects unrelated ids', () => {
    assert.equal(isDesignatedProfileSlug('00000000-0000-4000-8000-000000000001'), false)
    assert.equal(isDesignatedProfileSlug(''), false)
    assert.equal(isDesignatedProfileSlug(null), false)
  })
})

describe('resolveProfileForId — direct lookup', () => {
  it('returns the profile by exact id without repair', async () => {
    const db = makeDb()
    db.raw.prepare(
      `INSERT INTO profiles (id, display_name, primary_type, status) VALUES (?, ?, ?, 'active')`,
    ).run('uuid-1', 'Test Person', 'individual')

    const result = await resolveProfileForId(db, 'uuid-1', { allowReseed: false })
    assert.ok(result, 'expected resolution')
    assert.equal(result.repaired, false)
    assert.equal(result.strategy, 'direct')
    assert.equal(result.resolvedId, 'uuid-1')
    assert.equal(result.originalId, 'uuid-1')
  })

  it('returns null for an unknown id with no designated alias', async () => {
    const db = makeDb()
    const result = await resolveProfileForId(db, 'random-orphan-id', { allowReseed: false })
    assert.equal(result, null)
  })
})

describe('resolveProfileForId — designated slug → live UUID self-heal', () => {
  it('repairs profile-demo-tennessee-stem-student to a live UUID-keyed profile via display_name', async () => {
    const db = makeDb()
    // Live profile keyed by UUID, with the same display_name as the
    // designated config entry for `profile-demo-tennessee-stem-student`.
    db.raw.prepare(
      `INSERT INTO profiles (id, display_name, primary_type, status) VALUES (?, ?, ?, 'active')`,
    ).run(
      '00000000-0000-4000-8000-000000000001',
      'Demo Tennessee STEM Student',
      'high_school_student',
    )

    const result = await resolveProfileForId(db, 'profile-demo-tennessee-stem-student', {
      allowReseed: false,
    })

    assert.ok(result, 'expected resolution')
    assert.equal(result.repaired, true)
    assert.equal(result.strategy, 'designated_display_name')
    assert.equal(result.originalId, 'profile-demo-tennessee-stem-student')
    assert.equal(result.resolvedId, '00000000-0000-4000-8000-000000000001')
    assert.equal(result.profile.id, '00000000-0000-4000-8000-000000000001')
  })

  it('does NOT match deleted profiles when re-keying', async () => {
    const db = makeDb()
    db.raw.prepare(
      `INSERT INTO profiles (id, display_name, primary_type, status) VALUES (?, ?, ?, 'deleted')`,
    ).run(
      '00000000-0000-4000-8000-000000000001',
      'Demo Tennessee STEM Student',
      'high_school_student',
    )

    const result = await resolveProfileForId(db, 'profile-demo-tennessee-stem-student', {
      allowReseed: false,
    })

    assert.equal(result, null, 'must not heal toward a soft-deleted profile')
  })

  it('seeds the designated profile when nothing matches and allowReseed=true', async () => {
    const db = makeDb()
    // No matching profile in DB at all.
    const result = await resolveProfileForId(db, 'profile-demo-tennessee-stem-student', {
      allowReseed: true,
    })

    assert.ok(result, 'expected reseed to materialize the profile')
    assert.equal(result.profile.display_name, 'Demo Tennessee STEM Student')
    // Strategy can be 'reseed' (slug seeded back) or 'designated_display_name'
    // if the seed routed through display_name during the second pass.
    assert.match(result.strategy, /^(reseed|designated_display_name)$/)
  })
})
