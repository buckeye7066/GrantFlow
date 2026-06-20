import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { seedBaselineFromRepo } from '../../backend/utils/seedBaselineFromRepo.js'

// Regression guard for the avatar-churn bug: the boot/admin baseline re-seed
// upserts EVERY profile and historically did `avatar_url = excluded.avatar_url`.
// The repo seed snapshot carries no live avatars (avatar_url is null, avatar_data
// is never exported), so that wiped uploaded avatars across many profiles at once.
// The fix preserves any existing live avatar via COALESCE on conflict.

async function createDbWrapper(dbFilePath) {
  const Database = (await import('better-sqlite3')).default
  const raw = new Database(dbFilePath)
  raw.pragma('foreign_keys = ON')

  const makePrepared = (sql) => {
    const stmt = raw.prepare(sql)
    return {
      get: (...args) => stmt.get(...args),
      all: (...args) => stmt.all(...args),
      run: (...args) => stmt.run(...args),
    }
  }

  return {
    dialect: 'sqlite',
    prepare: makePrepared,
    exec: (sql) => raw.exec(sql),
    async withTransaction(fn) {
      raw.exec('BEGIN')
      try {
        const result = await fn({ dialect: 'sqlite', prepare: makePrepared, exec: (sql) => raw.exec(sql) })
        raw.exec('COMMIT')
        return result
      } catch (error) {
        try {
          raw.exec('ROLLBACK')
        } catch {
          // ignore
        }
        throw error
      }
    },
    close: () => raw.close(),
  }
}

test('baseline seed (force) preserves an existing uploaded avatar_url/avatar_data', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'grantflow-baseline-avatar-'))
  const dbPath = path.join(tmp, 'test.db')

  const db = await createDbWrapper(dbPath)
  try {
    const schema = readFileSync(path.resolve('backend/db/schema.sql'), 'utf8')
    db.exec(schema)

    // Use a real seed profile id whose snapshot avatar_url is null (the bug condition).
    const seed = JSON.parse(readFileSync(path.resolve('seed/baseline-profiles.json'), 'utf8'))
    const seedProfile = (seed.profiles || []).find((p) => p?.id && (p.avatar_url === null || p.avatar_url === undefined))
    assert.ok(seedProfile, 'expected at least one seed profile with a null avatar_url')

    const liveAvatarUrl = '/uploads/live-avatar-123.png'
    const liveAvatarBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03])

    // Simulate an existing profile that has uploaded an avatar (durable bytes + url).
    db.prepare(
      `
        INSERT INTO profiles (id, display_name, status, tags, avatar_url, avatar_data, avatar_content_type, updated_at)
        VALUES (?, ?, 'active', '[]', ?, ?, 'image/png', CURRENT_TIMESTAMP)
      `,
    ).run(seedProfile.id, seedProfile.display_name || 'Seeded Profile', liveAvatarUrl, liveAvatarBytes)

    // Force re-seed: re-upserts every profile, including this one.
    const result = await seedBaselineFromRepo(db, {
      mode: 'force',
      seedOpportunitiesIfEmpty: false,
      seedGrantsIfEmpty: false,
      seedDocumentsIfEmpty: false,
    })
    assert.equal(result.ok, true)

    const after = db
      .prepare('SELECT avatar_url, avatar_data FROM profiles WHERE id = ?')
      .get(seedProfile.id)

    assert.equal(after.avatar_url, liveAvatarUrl, 'avatar_url must survive the baseline re-seed')
    assert.ok(after.avatar_data, 'avatar_data must survive the baseline re-seed')
    assert.deepEqual(Buffer.from(after.avatar_data), liveAvatarBytes, 'avatar bytes must be unchanged')
  } finally {
    db.close()
  }
})

test('baseline seed still sets avatar_url for a brand-new profile that has none', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'grantflow-baseline-avatar-new-'))
  const dbPath = path.join(tmp, 'test.db')

  const db = await createDbWrapper(dbPath)
  try {
    const schema = readFileSync(path.resolve('backend/db/schema.sql'), 'utf8')
    db.exec(schema)

    // Empty DB: seeding inserts profiles fresh. Their avatar should match the snapshot
    // (null here), confirming the COALESCE guard does not break the INSERT path.
    const result = await seedBaselineFromRepo(db, {
      mode: 'force',
      seedOpportunitiesIfEmpty: false,
      seedGrantsIfEmpty: false,
      seedDocumentsIfEmpty: false,
    })
    assert.equal(result.ok, true)

    const count = Number((db.prepare('SELECT COUNT(*) as count FROM profiles').get())?.count || 0)
    assert.ok(count > 0, 'expected baseline seeding to insert profiles')
  } finally {
    db.close()
  }
})
