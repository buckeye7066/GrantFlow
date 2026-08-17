import fs from 'fs'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { wrapSqlite } from '../../tests/helpers/sqliteTestDb.mjs'
import {
  ProfileMemoryError,
  createProfileMemory,
  deleteProfileMemoryEntry,
  expireDueProfileMemory,
  getProfileMemoryDeletionReadiness,
  listProfileMemory,
  listProfileMemoryRevisions,
  reviseProfileMemory,
  setProfileMemoryRetention,
} from '../services/profileMemoryRepository.js'

const migrationSql = fs.readFileSync(
  new URL('../db/migrations/170_profile_memory_and_funder_intelligence.sql', import.meta.url),
  'utf8',
)

const databases = []

function makeDb() {
  const raw = new Database(':memory:')
  databases.push(raw)
  raw.pragma('foreign_keys = ON')
  raw.exec(`
    CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
      status TEXT DEFAULT 'active'
    );
    CREATE TABLE grant_transactions (
      id TEXT PRIMARY KEY,
      funder_ein TEXT,
      tax_year INTEGER,
      amount NUMERIC,
      recipient_name TEXT
    );
    INSERT INTO organizations (id, name) VALUES ('org-1', 'Community Housing Network');
    INSERT INTO profiles (id, organization_id, status) VALUES ('profile-1', 'org-1', 'active');
  `)
  raw.exec(migrationSql)
  const db = wrapSqlite(raw)
  return { raw, db }
}

afterEach(() => {
  while (databases.length) databases.pop().close()
})

function createFact(db, overrides = {}) {
  return createProfileMemory(db, {
    profileId: 'profile-1',
    memoryKey: 'preferred-contact',
    title: 'Preferred contact',
    kind: 'preference',
    value: { text: 'Email the program director first.' },
    sourceKind: 'user',
    provenance: { captured_from: 'profile' },
    actorUserId: 'user-1',
    ...overrides,
  })
}

describe('profile memory revision and deletion contract', () => {
  it('appends revisions and binds organization memory from the profile', async () => {
    const { db } = makeDb()
    const created = await createFact(db)
    expect(created.organization_id).toBe('org-1')
    expect(created.current_revision).toBe(1)
    expect(created.value).toEqual({ text: 'Email the program director first.' })

    const revised = await reviseProfileMemory(db, {
      profileId: 'profile-1',
      entryId: created.id,
      title: 'Preferred contact sequence',
      kind: 'preference',
      value: { text: 'Email, then call after five business days.' },
      sourceKind: 'user',
      provenance: { reason: 'owner correction' },
      actorUserId: 'user-1',
    })
    expect(revised.current_revision).toBe(2)
    expect(revised.value.text).toContain('five business days')

    const revisions = await listProfileMemoryRevisions(db, {
      profileId: 'profile-1',
      entryId: created.id,
    })
    expect(revisions.map((revision) => revision.revision_number)).toEqual([2, 1])
    expect(revisions[0].change_kind).toBe('update')
    expect(revisions[1].change_kind).toBe('create')
  })

  it('redacts every historical payload and appends a tombstone on deletion', async () => {
    const { db } = makeDb()
    const created = await createFact(db, {
      memoryKey: 'private-jane-doe-contact',
      title: 'Jane Doe private phone 555-0104',
    })
    await reviseProfileMemory(db, {
      profileId: 'profile-1',
      entryId: created.id,
      value: { text: 'Corrected private value' },
      sourceKind: 'document',
      sourceRef: 'document-secret-id',
      provenance: { page: 4 },
    })

    const deleted = await deleteProfileMemoryEntry(db, {
      profileId: 'profile-1',
      entryId: created.id,
      actorUserId: 'user-1',
      actorIsOwner: true,
      reason: 'owner_requested',
    })
    expect(deleted.status).toBe('deleted')
    expect(deleted.value).toBeNull()
    expect(await listProfileMemory(db, { profileId: 'profile-1' })).toEqual([])

    const revisions = await listProfileMemoryRevisions(db, {
      profileId: 'profile-1',
      entryId: created.id,
    })
    expect(revisions).toHaveLength(3)
    expect(revisions[0].change_kind).toBe('delete')
    expect(revisions.every((revision) => revision.payload_redacted && revision.value === null)).toBe(true)
    expect(revisions.every((revision) => revision.source_ref === null)).toBe(true)
    expect(revisions.every((revision) => revision.title === 'Deleted memory' && revision.kind === 'fact')).toBe(true)
    const tombstone = await db.prepare(
      'SELECT memory_key, title, kind, deletion_reason, legal_hold_reason FROM profile_memory_entries WHERE id = ?',
    ).get(created.id)
    expect(tombstone).toMatchObject({
      title: 'Deleted memory',
      kind: 'fact',
      deletion_reason: 'user_requested',
      legal_hold_reason: null,
    })
    expect(tombstone.memory_key).not.toContain('jane')
    const retainedText = JSON.stringify({
      entry: tombstone,
      revisions: await db.prepare('SELECT * FROM profile_memory_revisions WHERE entry_id = ?').all(created.id),
    })
    expect(retainedText).not.toContain('Jane Doe')
    expect(retainedText).not.toContain('555-0104')
  })

  it('enforces until-date and legal-hold retention before erasure', async () => {
    const { db } = makeDb()
    const until = new Date(Date.now() + 86_400_000).toISOString()
    await expect(createFact(db, {
      memoryKey: 'owner-retained-outcome',
      retentionPolicy: 'until_date',
      retentionUntil: until,
      actorIsOwner: true,
    })).rejects.toMatchObject({ code: 'MEMORY_ADMIN_REQUIRED' })
    const dated = await createFact(db, {
      memoryKey: 'retained-outcome',
      retentionPolicy: 'until_date',
      retentionUntil: until,
      actorIsAdmin: true,
    })
    await expect(createFact(db, {
      memoryKey: 'collaborator-legal-hold',
      retentionPolicy: 'legal_hold',
      legalHoldReason: 'Unverified collaborator request',
      actorIsOwner: true,
    })).rejects.toMatchObject({ code: 'MEMORY_ADMIN_REQUIRED' })
    const held = await createFact(db, {
      memoryKey: 'legal-hold-note',
      retentionPolicy: 'legal_hold',
      legalHoldReason: 'Preservation request 24-17',
      actorIsAdmin: true,
    })

    await expect(deleteProfileMemoryEntry(db, {
      profileId: 'profile-1',
      entryId: dated.id,
      actorIsOwner: true,
      reason: 'owner_requested',
    })).rejects.toMatchObject({ code: 'MEMORY_RETENTION_HOLD' })
    await expect(deleteProfileMemoryEntry(db, {
      profileId: 'profile-1',
      entryId: held.id,
      actorIsOwner: true,
      reason: 'owner_requested',
    })).rejects.toBeInstanceOf(ProfileMemoryError)

    const readiness = await getProfileMemoryDeletionReadiness(db, { profileId: 'profile-1' })
    expect(readiness.can_delete).toBe(false)
    expect(readiness.blocks.map((block) => block.reason).sort()).toEqual(['legal_hold', 'until_date'])

    await expect(setProfileMemoryRetention(db, {
      profileId: 'profile-1',
      entryId: held.id,
      retentionPolicy: 'profile_lifetime',
      actorUserId: 'user-1',
      actorIsOwner: true,
    })).rejects.toMatchObject({ code: 'MEMORY_ADMIN_REQUIRED' })
    const released = await setProfileMemoryRetention(db, {
      profileId: 'profile-1',
      entryId: held.id,
      retentionPolicy: 'profile_lifetime',
      actorUserId: 'admin-1',
      actorIsAdmin: true,
    })
    expect(released.retention_policy).toBe('profile_lifetime')
    const revisions = await listProfileMemoryRevisions(db, {
      profileId: 'profile-1',
      entryId: held.id,
    })
    expect(revisions[0].change_kind).toBe('retention')
  })

  it('expires due entries and cascades memory when a profile is hard-deleted', async () => {
    const { raw, db } = makeDb()
    const due = await createFact(db, {
      memoryKey: 'temporary-note',
      retentionPolicy: 'until_date',
      retentionUntil: '2025-01-01T00:00:00.000Z',
      actorIsAdmin: true,
    })
    const expired = await expireDueProfileMemory(db, { at: '2026-01-01T00:00:00.000Z' })
    expect(expired.expired).toEqual([due.id])
    expect((await listProfileMemory(db, { profileId: 'profile-1', includeDeleted: true }))[0].status).toBe('expired')

    raw.prepare('DELETE FROM profiles WHERE id = ?').run('profile-1')
    expect(raw.prepare('SELECT COUNT(*) AS count FROM profile_memory_entries').get().count).toBe(0)
    expect(raw.prepare('SELECT COUNT(*) AS count FROM profile_memory_revisions').get().count).toBe(0)
  })
})
