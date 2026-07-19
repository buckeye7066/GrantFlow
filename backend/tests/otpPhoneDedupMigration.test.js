/**
 * SECURITY REGRESSION (round 23): the phone de-dup migration must keep the phone on
 * the CREDENTIAL-OWNED user, not merely the oldest row.
 *
 * The round-22 age-based de-dup kept the OLDEST duplicate user and nulled the phone
 * on the rest — but the phone_otp CREDENTIAL may point at a NEWER row whose phone
 * just got nulled. /phone/start would then use that credential's user, and
 * /phone/verify would try to set the phone back on that nulled user and hit the new
 * unique index — AFTER consuming the code — giving PERSISTENT 500s on a correct code.
 *
 * This applies the ACTUAL migration SQL (137) to a seeded fixture. Red-able: the old
 * age-based migration keeps the oldest and strands the credential.
 */

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const Database = (await import('better-sqlite3')).default
const MIGRATION = fs.readFileSync(
  path.resolve('backend/db/migrations/137_users_primary_phone_unique.sql'),
  'utf8',
)

function seedDb() {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, primary_phone TEXT, created_at TEXT);
    CREATE TABLE user_credentials (id TEXT PRIMARY KEY, user_id TEXT, type TEXT, identifier TEXT);
  `)
  return raw
}

const phone = '+15551239999'
const phoneCountOn = (raw, p) => raw.prepare(`SELECT COUNT(*) c FROM users WHERE primary_phone = ?`).get(p).c
const phoneOf = (raw, id) => raw.prepare(`SELECT primary_phone FROM users WHERE id = ?`).get(id).primary_phone

describe('phone de-dup migration keeps the phone on the credential-owned user', () => {
  it('credential on the NON-oldest row → that (newer) user keeps the phone; oldest is nulled', () => {
    const raw = seedDb()
    raw.prepare(`INSERT INTO users (id, primary_phone, created_at) VALUES ('u-old', ?, '2026-01-01T00:00:00Z')`).run(phone)
    raw.prepare(`INSERT INTO users (id, primary_phone, created_at) VALUES ('u-new', ?, '2026-02-01T00:00:00Z')`).run(phone)
    raw.prepare(`INSERT INTO user_credentials (id, user_id, type, identifier) VALUES ('c1', 'u-new', 'phone_otp', ?)`).run(phone)

    raw.exec(MIGRATION)

    expect(phoneOf(raw, 'u-new')).toBe(phone) // credential-owned keeps it
    expect(phoneOf(raw, 'u-old')).toBeNull()
    expect(phoneCountOn(raw, phone)).toBe(1)
    // /phone/verify sets the phone on credential.user_id (u-new) — which already has
    // it, so no unique conflict / no 500.
    // The index is now enforced.
    expect(() => raw.prepare(`INSERT INTO users (id, primary_phone, created_at) VALUES ('u-x', ?, '2026-03-01')`).run(phone)).toThrow(/unique/i)
  })

  it('repairs an earlier age-based run: credential-owned user had its phone nulled → restored', () => {
    const raw = seedDb()
    // As if round-22 already ran: the oldest (non-credential) user kept the phone,
    // the credential-owned (newer) user was nulled.
    raw.prepare(`INSERT INTO users (id, primary_phone, created_at) VALUES ('u-old', ?, '2026-01-01T00:00:00Z')`).run(phone)
    raw.prepare(`INSERT INTO users (id, primary_phone, created_at) VALUES ('u-new', NULL, '2026-02-01T00:00:00Z')`).run()
    raw.prepare(`INSERT INTO user_credentials (id, user_id, type, identifier) VALUES ('c1', 'u-new', 'phone_otp', ?)`).run(phone)

    raw.exec(MIGRATION)

    expect(phoneOf(raw, 'u-new')).toBe(phone) // restored on credential-owned
    expect(phoneOf(raw, 'u-old')).toBeNull()
    expect(phoneCountOn(raw, phone)).toBe(1)
  })

  it('no credential → keeps the oldest (fallback), and is idempotent', () => {
    const raw = seedDb()
    raw.prepare(`INSERT INTO users (id, primary_phone, created_at) VALUES ('u-old', ?, '2026-01-01T00:00:00Z')`).run(phone)
    raw.prepare(`INSERT INTO users (id, primary_phone, created_at) VALUES ('u-new', ?, '2026-02-01T00:00:00Z')`).run(phone)

    raw.exec(MIGRATION)
    expect(phoneOf(raw, 'u-old')).toBe(phone)
    expect(phoneOf(raw, 'u-new')).toBeNull()
    expect(phoneCountOn(raw, phone)).toBe(1)

    // Idempotent: re-running changes nothing.
    raw.exec(MIGRATION)
    expect(phoneOf(raw, 'u-old')).toBe(phone)
    expect(phoneCountOn(raw, phone)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Round 24: the FORWARD repair migration 138 runs on an already-137-stamped DB
// (137 was edited in place and never re-runs) AND repoints stranded ownership.
// ---------------------------------------------------------------------------
const SCHEMA = fs.readFileSync(path.resolve('backend/db/schema.sql'), 'utf8')
const MIG138 = fs.readFileSync(path.resolve('backend/db/migrations/138_repair_phone_dedupe_repoint.sql'), 'utf8')
// The round-22 age-based 137 (what an already-stamped DB actually ran).
const AGE_BASED_137 = `
  UPDATE users SET primary_phone = NULL
  WHERE primary_phone IS NOT NULL AND EXISTS (
    SELECT 1 FROM users older WHERE older.primary_phone = users.primary_phone AND older.primary_phone IS NOT NULL
      AND (older.created_at < users.created_at OR (older.created_at = users.created_at AND older.id < users.id)));
  CREATE UNIQUE INDEX IF NOT EXISTS ux_users_primary_phone ON users (primary_phone) WHERE primary_phone IS NOT NULL;`

function fullDb() {
  const raw = new Database(':memory:')
  raw.exec(SCHEMA)
  raw.exec('DROP INDEX IF EXISTS ux_users_primary_phone') // allow seeding duplicate phones
  return raw
}

describe('forward repair migration 138 (already-137-stamped DBs) + ownership repoint', () => {
  it('the runner selects 138 even when 137 is already stamped (forward migration, not an in-place edit)', () => {
    // Mirrors migrate.js: `pending = files.filter(f => !applied.has(f))`.
    const dir = path.resolve('backend/db/migrations')
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    expect(files).toContain('137_users_primary_phone_unique.sql')
    expect(files).toContain('138_repair_phone_dedupe_repoint.sql')
    // A DB that already ran through 137 (age-based) has it stamped; the in-place
    // r23 edit to 137 would NEVER re-run — but 138 is a NEW filename, so:
    const applied = new Set(files.filter((f) => f <= '137_users_primary_phone_unique.sql'))
    const pending = files.filter((f) => !applied.has(f))
    expect(pending).toContain('138_repair_phone_dedupe_repoint.sql')
    // Postgres twin exists too.
    expect(fs.existsSync(path.resolve('backend/db/postgres/migrations/0142_repair_phone_dedupe_repoint.sql'))).toBe(true)
  })

  it('repairs an age-based-137 DB: credential-owned user regains the phone, oldest nulled, one holder', () => {
    const raw = fullDb()
    // Credential owned by the NEWER user (u-canonical); an older duplicate exists.
    raw.prepare(`INSERT INTO users (id, primary_phone, created_at) VALUES ('u-old', ?, '2026-01-01T00:00:00Z')`).run(phone)
    raw.prepare(`INSERT INTO users (id, primary_phone, created_at) VALUES ('u-canonical', ?, '2026-02-01T00:00:00Z')`).run(phone)
    raw.prepare(`INSERT INTO user_credentials (id, user_id, type, identifier) VALUES ('c1', 'u-canonical', 'phone_otp', ?)`).run(phone)

    // Simulate the r22-stamped state: the age-based 137 already ran (kept the OLDEST,
    // nulled the credential-owned u-canonical → stranded credential).
    raw.exec(AGE_BASED_137)
    expect(phoneOf(raw, 'u-old')).toBe(phone)
    expect(phoneOf(raw, 'u-canonical')).toBeNull() // credential stranded on a nulled-phone user

    // The FORWARD migration 138 repairs it.
    raw.exec(MIG138)
    expect(phoneOf(raw, 'u-canonical')).toBe(phone) // credential-owned user regains the phone
    expect(phoneOf(raw, 'u-old')).toBeNull()
    expect(phoneCountOn(raw, phone)).toBe(1)
    // /phone/verify sets the phone on credential.user_id (u-canonical), which already
    // has it → no unique conflict / no 500.
  })

  it('repoints a non-canonical duplicate\'s PROFILE and saved_grant to the canonical user (nothing stranded)', () => {
    const raw = fullDb()
    raw.prepare(`INSERT INTO users (id, primary_phone, created_at) VALUES ('u-dup', ?, '2026-01-01T00:00:00Z')`).run(phone)
    raw.prepare(`INSERT INTO users (id, primary_phone, created_at) VALUES ('u-canonical', ?, '2026-02-01T00:00:00Z')`).run(phone)
    raw.prepare(`INSERT INTO user_credentials (id, user_id, type, identifier) VALUES ('c1', 'u-canonical', 'phone_otp', ?)`).run(phone)
    // The non-canonical duplicate OWNS a profile + a saved_grant.
    raw.prepare(`INSERT INTO profiles (id, user_id, display_name) VALUES ('p-dup', 'u-dup', 'Dup Profile')`).run()
    raw.prepare(`INSERT INTO saved_grants (id, user_id, profile_id, opportunity_id) VALUES ('sg1', 'u-dup', 'p-dup', 'opp1')`).run()

    raw.exec(MIG138)

    // Phone resolves (via credential) to u-canonical — and its data is now attached there.
    expect(phoneOf(raw, 'u-canonical')).toBe(phone)
    expect(raw.prepare(`SELECT user_id FROM profiles WHERE id='p-dup'`).get().user_id).toBe('u-canonical')
    expect(raw.prepare(`SELECT user_id FROM saved_grants WHERE id='sg1'`).get().user_id).toBe('u-canonical')
    // Nothing left under the stranded duplicate.
    expect(raw.prepare(`SELECT COUNT(*) c FROM profiles WHERE user_id='u-dup'`).get().c).toBe(0)
  })

  it('is idempotent (re-run is a no-op) and a fresh install is a safe no-op', () => {
    const raw = fullDb()
    // Fresh install (corrected 137 already created the index; no dups).
    raw.prepare(`INSERT INTO users (id, primary_phone, created_at) VALUES ('u1', ?, '2026-01-01T00:00:00Z')`).run(phone)
    raw.prepare(`INSERT INTO user_credentials (id, user_id, type, identifier) VALUES ('c1', 'u1', 'phone_otp', ?)`).run(phone)
    raw.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_users_primary_phone ON users (primary_phone) WHERE primary_phone IS NOT NULL')

    raw.exec(MIG138)
    expect(phoneOf(raw, 'u1')).toBe(phone)
    expect(phoneCountOn(raw, phone)).toBe(1)
    // Re-run: still a no-op.
    raw.exec(MIG138)
    expect(phoneOf(raw, 'u1')).toBe(phone)
    expect(phoneCountOn(raw, phone)).toBe(1)
  })
})
