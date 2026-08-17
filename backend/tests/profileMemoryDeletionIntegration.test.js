import fs from 'fs'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { wrapSqlite } from '../../tests/helpers/sqliteTestDb.mjs'
import {
  createProfileMemory,
  redactProfileMemoryForProfile,
} from '../services/profileMemoryRepository.js'

const migrationSql = fs.readFileSync(
  new URL('../db/migrations/170_profile_memory_and_funder_intelligence.sql', import.meta.url),
  'utf8',
)
const baseSchemaSql = fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8')
const databases = []

function makeMemoryDb() {
  const raw = new Database(':memory:')
  databases.push(raw)
  raw.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
      status TEXT DEFAULT 'active'
    );
    CREATE TABLE grant_transactions (
      id TEXT PRIMARY KEY, funder_ein TEXT, tax_year INTEGER,
      amount NUMERIC, recipient_name TEXT
    );
    INSERT INTO organizations (id, name) VALUES ('org-1', 'Housing Network');
    INSERT INTO profiles (id, user_id, organization_id) VALUES ('profile-1', 'owner-1', 'org-1');
  `)
  raw.exec(migrationSql)
  return { raw, db: wrapSqlite(raw) }
}

afterEach(() => {
  while (databases.length) databases.pop().close()
})

describe('canonical profile-delete memory choke point', () => {
  it('is wired before both designated tombstoning and hard deletion', () => {
    const source = fs.readFileSync(new URL('../routes/profiles.js', import.meta.url), 'utf8')
    const guard = source.indexOf('await redactProfileMemoryForProfile(req.db')
    const designated = source.indexOf('if (isDesignatedProfileId(id))', guard)
    const hardDelete = source.indexOf("req.db.prepare('DELETE FROM profiles WHERE id = ?')", guard)
    expect(guard).toBeGreaterThan(0)
    expect(designated).toBeGreaterThan(guard)
    expect(hardDelete).toBeGreaterThan(guard)
    expect(source).toContain("memoryError?.code === 'MEMORY_RETENTION_HOLD'")
    expect(source).toContain('return res.status(409)')
  })

  it('wires admin hard-delete through the same atomic memory-erasure contract', () => {
    const source = fs.readFileSync(new URL('../routes/admin.js', import.meta.url), 'utf8')
    const transaction = source.indexOf('await db.withTransaction(async (tx) =>')
    const memoryErase = source.indexOf('await redactProfileMemoryForProfile(memoryTx', transaction)
    const profileDelete = source.indexOf("tx.prepare('DELETE FROM profiles WHERE id = ?')", memoryErase)
    expect(transaction).toBeGreaterThan(0)
    expect(memoryErase).toBeGreaterThan(transaction)
    expect(profileDelete).toBeGreaterThan(memoryErase)
    expect(source).toContain("error?.code === 'MEMORY_RETENTION_HOLD'")
  })

  it('keeps fresh-schema lifecycle foreign keys valid during profile cascades', () => {
    const raw = new Database(':memory:')
    databases.push(raw)
    raw.pragma('foreign_keys = ON')
    raw.exec(baseSchemaSql)

    expect(raw.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'grant_applications'",
    ).get()?.name).toBe('grant_applications')

    raw.prepare('INSERT INTO profiles (id, display_name) VALUES (?, ?)')
      .run('profile-fresh', 'Fresh Schema Applicant')
    raw.prepare(
      `INSERT INTO grant_applications (id, profile_id, user_id, grant_name)
       VALUES (?, ?, ?, ?)`,
    ).run('application-fresh', 'profile-fresh', 'user-fresh', 'Fresh Schema Grant')
    raw.prepare(
      `INSERT INTO application_lifecycle_subjects (application_id, profile_id)
       VALUES (?, ?)`,
    ).run('application-fresh', 'profile-fresh')

    expect(() => raw.prepare('DELETE FROM profiles WHERE id = ?').run('profile-fresh')).not.toThrow()
    expect(raw.prepare('SELECT COUNT(*) AS count FROM grant_applications').get().count).toBe(0)
    expect(raw.prepare('SELECT COUNT(*) AS count FROM application_lifecycle_subjects').get().count).toBe(0)
  })

  it('redacts eligible payloads before the profile row is removed', async () => {
    const { raw, db } = makeMemoryDb()
    await createProfileMemory(db, {
      profileId: 'profile-1',
      memoryKey: 'private-note',
      title: 'Private note',
      value: { text: 'Sensitive applicant fact' },
      actorUserId: 'owner-1',
    })
    const result = await redactProfileMemoryForProfile(db, {
      profileId: 'profile-1',
      actorUserId: 'owner-1',
      actorIsOwner: true,
    })
    expect(result.redacted).toBe(1)
    const revision = raw.prepare('SELECT value_json, payload_redacted FROM profile_memory_revisions').get()
    expect(revision.value_json).toBe('{}')
    expect(revision.payload_redacted).toBe(1)

    raw.prepare('DELETE FROM profiles WHERE id = ?').run('profile-1')
    expect(raw.prepare('SELECT COUNT(*) AS count FROM profile_memory_entries').get().count).toBe(0)
  })

  it('blocks deletion on a legal hold and tolerates only the exact old-schema state', async () => {
    const { db } = makeMemoryDb()
    await createProfileMemory(db, {
      profileId: 'profile-1',
      memoryKey: 'held-note',
      title: 'Held note',
      value: { text: 'Preserve' },
      retentionPolicy: 'legal_hold',
      legalHoldReason: 'Preservation request 24-17',
      actorIsAdmin: true,
    })
    await expect(redactProfileMemoryForProfile(db, {
      profileId: 'profile-1',
      actorUserId: 'owner-1',
      actorIsOwner: true,
    })).rejects.toMatchObject({ code: 'MEMORY_RETENTION_HOLD' })

    const oldRaw = new Database(':memory:')
    databases.push(oldRaw)
    const oldDb = wrapSqlite(oldRaw)
    const rolling = await redactProfileMemoryForProfile(oldDb, {
      profileId: 'profile-before-migration',
      actorIsOwner: true,
    })
    expect(rolling).toMatchObject({ redacted: 0, skipped: 'schema_unavailable' })
  })
})
