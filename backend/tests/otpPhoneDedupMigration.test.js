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

const MIG138_PG = fs.readFileSync(path.resolve('backend/db/postgres/migrations/0142_repair_phone_dedupe_repoint.sql'), 'utf8')

// Build the FULL migrated schema with the REAL migration-runner semantics (Codex r28):
// apply schema.sql then every migration, tolerating ONLY the "already applied / idempotent
// DDL" errors the runner tolerates (mirrors migrate.js isIdempotentAlreadyAppliedError +
// @sqlite-continue-on-idempotent-errors) — a genuine error surfaces instead of being
// swallowed, so the introspected schema is the ACTUAL migrated schema.
const ALL_MIGRATIONS = fs.readdirSync(path.resolve('backend/db/migrations'))
  .filter((f) => f.endsWith('.sql')).sort()
  .map((f) => ({ name: f, sql: fs.readFileSync(path.resolve('backend/db/migrations', f), 'utf8') }))
function isIdempotentError(err) {
  const m = String(err?.message || err || '').toLowerCase()
  return m.includes('duplicate column name') || m.includes('already exists') || m.includes('duplicate index') ||
    m.includes('there is already another table or index with this name') ||
    (m.includes('near "exists"') && m.includes('syntax error')) ||
    m.includes('no such table') // an ALTER/CREATE-dependent statement whose base was renamed/absent
}
function applyLikeRunner(raw, name, sql) {
  if (sql.includes('@sqlite-continue-on-idempotent-errors')) {
    const statements = sql.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n').split(';').map((s) => s.trim()).filter(Boolean)
    for (const s of statements) { try { raw.exec(`${s};`) } catch (e) { if (!isIdempotentError(e)) throw new Error(`${name}: ${e.message}`) } }
    return
  }
  try { raw.exec(sql) } catch (e) { if (!isIdempotentError(e)) throw new Error(`${name}: ${e.message}`) }
}
function fullDb() {
  const raw = new Database(':memory:')
  raw.pragma('foreign_keys = OFF') // fixtures seed rows without full FK graphs
  raw.exec(SCHEMA)
  for (const { name, sql } of ALL_MIGRATIONS) applyLikeRunner(raw, name, sql)
  // Reset dedupe state applied by 137/138 above so each fixture starts clean.
  raw.exec('DROP INDEX IF EXISTS ux_users_primary_phone; DELETE FROM phone_dedupe_map; DELETE FROM phone_dedupe_conflicts;')
  return raw
}
const seedPhoneDup = (raw, { dupCreated = '2026-01-01T00:00:00Z', canCreated = '2026-02-01T00:00:00Z' } = {}) => {
  raw.prepare(`INSERT INTO users (id, primary_phone, created_at) VALUES ('u-dup', ?, ?)`).run(phone, dupCreated)
  raw.prepare(`INSERT INTO users (id, primary_phone, created_at) VALUES ('u-canonical', ?, ?)`).run(phone, canCreated)
  raw.prepare(`INSERT INTO user_credentials (id, user_id, type, identifier) VALUES ('c1', 'u-canonical', 'phone_otp', ?)`).run(phone)
}
// The account an ownership FK ultimately resolves to (via the parent resource).
const profileOwner = (raw, profileId) => raw.prepare(`SELECT user_id FROM profiles WHERE id = ?`).get(profileId)?.user_id
const stripeOwner = (raw, custId) => raw.prepare(`SELECT user_id FROM stripe_customers WHERE stripe_customer_id = ?`).get(custId)?.user_id
const conflicts = (raw) => raw.prepare(`SELECT COUNT(*) c FROM phone_dedupe_conflicts`).get().c

const MIG137 = fs.readFileSync(path.resolve('backend/db/migrations/137_users_primary_phone_unique.sql'), 'utf8')
// The REAL prod order: 137 (capture map -> null non-canonical phones -> index) THEN 138 (repair).
const runRepair = (raw) => { raw.exec(MIG137); raw.exec(MIG138) }

// BY-CONSTRUCTION GUARD (Codex r27 #3): the two-owner inventory is INTROSPECTED from
// the live migrated schema, not a hardcoded list — so a two-owner table added by any
// future migration is automatically checked. The migration's classification is the
// single source of truth (generated alongside 138/0142).
const CLASSIFICATION = JSON.parse(fs.readFileSync(path.resolve('backend/tests/fixtures/phoneDedupeClassification.json'), 'utf8'))
const EXEMPT = new Set(CLASSIFICATION.exempt)
function twoOwnerTables(raw) {
  const tbls = raw.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all().map((r) => r.name)
  const profile = [], stripe = []
  for (const t of tbls) {
    const cols = raw.prepare(`PRAGMA table_info(${JSON.stringify(t)})`).all().map((c) => c.name)
    if (cols.includes('user_id') && cols.includes('profile_id')) profile.push(t)
    if (cols.includes('user_id') && cols.includes('stripe_customer_id')) stripe.push(t)
  }
  return { profile, stripe }
}
// Sweep EVERY (non-exempt) two-owner table in the LIVE schema for a user_id/owner mismatch.
function userProfileSplits(raw) {
  let n = 0
  for (const t of twoOwnerTables(raw).profile) {
    if (EXEMPT.has(t)) continue
    n += raw.prepare(`SELECT COUNT(*) c FROM ${t} x JOIN profiles p ON p.id = x.profile_id
      WHERE x.user_id IS NOT NULL AND p.user_id IS NOT NULL AND x.user_id <> p.user_id`).get().c
  }
  return n
}
function userStripeSplits(raw) {
  let n = 0
  for (const t of twoOwnerTables(raw).stripe) {
    if (t === 'stripe_customers' || EXEMPT.has(t)) continue
    n += raw.prepare(`SELECT COUNT(*) c FROM ${t} x JOIN stripe_customers s ON s.stripe_customer_id = x.stripe_customer_id
      WHERE x.user_id IS NOT NULL AND s.user_id IS NOT NULL AND x.user_id <> s.user_id`).get().c
  }
  return n
}

describe('forward repair migration 138 (already-137-stamped DBs) + ownership repoint', () => {
  it('the SQLite (138) and Postgres (0142) shared preamble/collapse/phone-fix match (dialect diffs only in move/revoke exec + JSON)', () => {
    // 138 = static move/revoke; 0142 = existence-guarded DO block. Everything BEFORE the
    // move/revoke section (tables, capture, detect [modulo JSON], merge, collapse) is byte-identical.
    const preamble = (s) => s.split('-- GROUP-WIDE COLLISION-COLLAPSE')[0]
      .split('\n').filter((l) => !l.trimStart().startsWith('--'))
      .map((l) => l.replace(/json_extract\(ps\.data, '\$\.phone'\)/, 'JSONPHONE').replace(/\(ps\.data::jsonb->>'phone'\)/, 'JSONPHONE'))
      .join('\n').trim()
    expect(preamble(MIG138_PG)).toBe(preamble(MIG138))
  })

  it('[r28] the migration references NO renamed-away/absent table (no yana_* abort) and every referenced table EXISTS in the live schema', () => {
    // yana_* were renamed to hamilton_* (sqlite 090 / pg 0086); referencing them aborts PG.
    const yanaRef = /\byana_(authorizations|runs|autopilot_runs|blockers|resolved_fields|saved_sessions|payment_authorizations|attestation_authorizations)\b/
    expect(yanaRef.test(MIG138.replace(/--.*/g, ''))).toBe(false)
    expect(yanaRef.test(MIG138_PG.replace(/--.*/g, ''))).toBe(false)
    // Every table the SQLite migration MOVES/REVOKES must exist in the real migrated schema.
    const raw = fullDb()
    const existing = new Set(raw.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name))
    const referenced = [...CLASSIFICATION.moveProfile, ...CLASSIFICATION.moveAccount, ...CLASSIFICATION.revoke]
    const missing = referenced.filter((t) => !existing.has(t))
    expect(missing).toEqual([])
    // Postgres 0142 existence-guards each table (to_regclass) so an absent/renamed table is skipped.
    expect(MIG138_PG).toContain('to_regclass(t) IS NOT NULL')
  })

  it('[r27 #3 GUARD] every two-owner table in the live migrated schema is classified (move / revoke / exempt)', () => {
    const raw = fullDb()
    const { profile } = twoOwnerTables(raw)
    const classified = new Set([...CLASSIFICATION.moveProfile, ...CLASSIFICATION.moveAccount, ...CLASSIFICATION.revoke, ...CLASSIFICATION.exempt])
    // Every discovered two-owner (user_id+profile_id) table MUST be explicitly classified —
    // a new one added by a future migration fails here until a human classifies it.
    const unclassified = profile.filter((t) => !classified.has(t))
    expect(unclassified).toEqual([])
    // Sanity: the discovery found the known later-migration tables (not just schema.sql's).
    expect(profile).toContain('grant_applications')
    expect(profile).toContain('anya_match_suggestions')
    expect(profile).toContain('hamilton_portal_credentials')
  })

  it('[r28 CRITICAL] a coincidental profile-phone match is NEVER auto-merged — data stays with its owner, only an operator conflict is recorded', () => {
    const raw = fullDb()
    const p = '+15559990000'
    // A phone OWNER (canonical) and an UNRELATED email-only user who merely typed the owner's phone into their profile.
    raw.prepare(`INSERT INTO users (id, primary_phone, created_at) VALUES ('owner', ?, '2026-01-01')`).run(p)
    raw.prepare(`INSERT INTO user_credentials (id, user_id, type, identifier) VALUES ('oc', 'owner', 'phone_otp', ?)`).run(p)
    raw.prepare(`INSERT INTO users (id, primary_email, primary_phone, created_at) VALUES ('stranger', 's@x.com', NULL, '2026-01-02')`).run()
    raw.prepare(`INSERT INTO user_credentials (id, user_id, type, identifier) VALUES ('sc', 'stranger', 'email_otp', 's@x.com')`).run()
    raw.prepare(`INSERT INTO profiles (id, user_id, display_name) VALUES ('sp', 'stranger', 'Stranger')`).run()
    raw.prepare(`INSERT INTO profile_sections (profile_id, section_key, data) VALUES ('sp', 'basic_information', ?)`).run(JSON.stringify({ phone: p }))

    raw.exec(MIG138)

    // NO cross-account merge: the stranger's profile + credential stay theirs.
    expect(profileOwner(raw, 'sp')).toBe('stranger')
    expect(raw.prepare(`SELECT user_id FROM user_credentials WHERE id='sc'`).get().user_id).toBe('stranger')
    // Never added to the (proven) map -> never moved.
    expect(raw.prepare(`SELECT COUNT(*) c FROM phone_dedupe_map WHERE dup_user_id='stranger'`).get().c).toBe(0)
    // Recorded ONLY as an operator-visible conflict (fail closed).
    expect(raw.prepare(`SELECT reason FROM phone_dedupe_conflicts WHERE dup_user_id='stranger'`).get()?.reason).toBe('pre-map-unverified, manual review')
    expect(userProfileSplits(raw)).toBe(0)
  })

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

  it('MERGEABLE (canonical owns nothing): fully merges the dup — profile + grant move together to canonical, no split', () => {
    const raw = fullDb()
    seedPhoneDup(raw)
    raw.prepare(`INSERT INTO profiles (id, user_id, display_name) VALUES ('p-dup', 'u-dup', 'Dup Profile')`).run()
    raw.prepare(`INSERT INTO saved_grants (id, user_id, profile_id, opportunity_id) VALUES ('sg1', 'u-dup', 'p-dup', 'opp1')`).run()

    runRepair(raw)

    expect(phoneOf(raw, 'u-canonical')).toBe(phone)
    // Profile AND its saved_grant moved to canonical — the grant's user_id matches its profile's owner.
    expect(profileOwner(raw, 'p-dup')).toBe('u-canonical')
    expect(raw.prepare(`SELECT user_id FROM saved_grants WHERE id='sg1'`).get().user_id).toBe('u-canonical')
    expect(raw.prepare(`SELECT user_id FROM saved_grants WHERE id='sg1'`).get().user_id).toBe(profileOwner(raw, 'p-dup'))
    expect(conflicts(raw)).toBe(0) // cleanly merged, no unresolved conflict
  })

  it('UNMERGEABLE (both own a PROFILE): NO split — dup profile + its grant stay TOGETHER on the dup; conflict recorded', () => {
    const raw = fullDb()
    seedPhoneDup(raw)
    raw.prepare(`INSERT INTO profiles (id, user_id, display_name) VALUES ('p-can', 'u-canonical', 'Canon Profile')`).run()
    raw.prepare(`INSERT INTO profiles (id, user_id, display_name) VALUES ('p-dup', 'u-dup', 'Dup Profile')`).run()
    raw.prepare(`INSERT INTO saved_grants (id, user_id, profile_id, opportunity_id) VALUES ('sg1', 'u-dup', 'p-dup', 'opp1')`).run()

    runRepair(raw)

    // CORE INVARIANT: the grant's user_id must equal the owner of its profile_id — never split.
    const sgUser = raw.prepare(`SELECT user_id FROM saved_grants WHERE id='sg1'`).get().user_id
    expect(sgUser).toBe(profileOwner(raw, 'p-dup'))
    // Left fully self-consistent on the dup (not half-moved to canonical).
    expect(profileOwner(raw, 'p-dup')).toBe('u-dup')
    expect(sgUser).toBe('u-dup')
    // Only the canonical keeps the phone; the conflict is recorded for the owner.
    expect(phoneOf(raw, 'u-canonical')).toBe(phone)
    expect(phoneOf(raw, 'u-dup')).toBeNull()
    expect(conflicts(raw)).toBe(1)
  })

  it('UNMERGEABLE (both have a STRIPE customer): service_purchases are NOT left referencing a customer under a different user', () => {
    const raw = fullDb()
    seedPhoneDup(raw)
    raw.prepare(`INSERT INTO stripe_customers (user_id, stripe_customer_id) VALUES ('u-canonical', 'cus_can')`).run()
    raw.prepare(`INSERT INTO stripe_customers (user_id, stripe_customer_id) VALUES ('u-dup', 'cus_dup')`).run()
    raw.prepare(`INSERT INTO service_purchases (id, user_id, service_id, client_category, pricing_model, status, stripe_customer_id) VALUES ('sp', 'u-dup', 'svc1', 'cat', 'flat', 'paid', 'cus_dup')`).run()

    runRepair(raw)

    // CORE INVARIANT: the purchase's user_id must equal the owner of its stripe_customer_id.
    const sp = raw.prepare(`SELECT user_id, stripe_customer_id FROM service_purchases WHERE id='sp'`).get()
    expect(sp.user_id).toBe(stripeOwner(raw, sp.stripe_customer_id))
    // Both left on the dup (consistent), never split onto the canonical's customer.
    expect(sp.user_id).toBe('u-dup')
    expect(stripeOwner(raw, 'cus_dup')).toBe('u-dup')
    expect(conflicts(raw)).toBe(1)
  })

  it('UNMERGEABLE (both have user_preferences): consistent, no split, dup left intact', () => {
    const raw = fullDb()
    seedPhoneDup(raw)
    raw.prepare(`INSERT INTO user_preferences (user_id) VALUES ('u-canonical')`).run()
    raw.prepare(`INSERT INTO user_preferences (user_id) VALUES ('u-dup')`).run()
    raw.prepare(`INSERT INTO profiles (id, user_id, display_name) VALUES ('p-dup', 'u-dup', 'Dup Profile')`).run()

    runRepair(raw)

    // both-prefs → unmergeable → nothing moves; dup keeps its profile + prefs together.
    expect(profileOwner(raw, 'p-dup')).toBe('u-dup')
    expect(raw.prepare(`SELECT COUNT(*) c FROM user_preferences WHERE user_id='u-dup'`).get().c).toBe(1)
    expect(conflicts(raw)).toBe(1)
    expect(phoneOf(raw, 'u-canonical')).toBe(phone)
  })

  it('is idempotent (re-run is a no-op) and a fresh install is a safe no-op', () => {
    const raw = fullDb()
    // Fresh install (corrected 137 already created the index; no dups).
    raw.prepare(`INSERT INTO users (id, primary_phone, created_at) VALUES ('u1', ?, '2026-01-01T00:00:00Z')`).run(phone)
    raw.prepare(`INSERT INTO user_credentials (id, user_id, type, identifier) VALUES ('c1', 'u1', 'phone_otp', ?)`).run(phone)
    raw.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_users_primary_phone ON users (primary_phone) WHERE primary_phone IS NOT NULL')

    runRepair(raw)
    expect(phoneOf(raw, 'u1')).toBe(phone)
    expect(phoneCountOn(raw, phone)).toBe(1)
    // Re-run: still a no-op.
    runRepair(raw)
    expect(phoneOf(raw, 'u1')).toBe(phone)
    expect(phoneCountOn(raw, phone)).toBe(1)
  })

  // ---- Round 26 ----
  it('[r26 #1] 137 (which nulls the dup phone) THEN 138 still repairs — the durable map survives the null (no silent no-op)', () => {
    const raw = fullDb()
    seedPhoneDup(raw)
    raw.prepare(`INSERT INTO profiles (id, user_id, display_name) VALUES ('p-dup', 'u-dup', 'Dup Profile')`).run()

    raw.exec(MIG137) // captures phone_dedupe_map, THEN nulls u-dup's phone
    expect(phoneOf(raw, 'u-dup')).toBeNull() // phone gone — the old repair would no-op here
    expect(raw.prepare(`SELECT COUNT(*) c FROM phone_dedupe_map`).get().c).toBe(1) // but the map survives

    raw.exec(MIG138)
    // Repair still ran: the mergeable dup's profile moved to the canonical.
    expect(profileOwner(raw, 'p-dup')).toBe('u-canonical')
    expect(userProfileSplits(raw)).toBe(0)
  })

  it('[r26 #2] a legacy saved_grants unique collision (NULL-profile AND non-NULL) does NOT abort the migration', () => {
    const raw = fullDb()
    seedPhoneDup(raw) // no profiles -> mergeable
    // Canonical + dup BOTH have a NULL-profile grant for the same opportunity (legacy unique
    // (user_id, opportunity_id) WHERE profile_id IS NULL), and a non-NULL collision too.
    raw.prepare(`INSERT INTO saved_grants (id, user_id, profile_id, opportunity_id) VALUES ('c-null', 'u-canonical', NULL, 'oX')`).run()
    raw.prepare(`INSERT INTO saved_grants (id, user_id, profile_id, opportunity_id) VALUES ('d-null', 'u-dup', NULL, 'oX')`).run()
    raw.prepare(`INSERT INTO profiles (id, user_id, display_name) VALUES ('pp', 'u-canonical', 'shared')`).run()
    raw.prepare(`INSERT INTO saved_grants (id, user_id, profile_id, opportunity_id) VALUES ('c-p', 'u-canonical', 'pp', 'oY')`).run()
    raw.prepare(`INSERT INTO saved_grants (id, user_id, profile_id, opportunity_id) VALUES ('d-p', 'u-dup', 'pp', 'oY')`).run()

    expect(() => runRepair(raw)).not.toThrow() // must NEVER abort on real data
    // Redundant dup rows collapsed; canonical keeps exactly one per unique key.
    expect(raw.prepare(`SELECT COUNT(*) c FROM saved_grants WHERE user_id='u-canonical' AND profile_id IS NULL AND opportunity_id='oX'`).get().c).toBe(1)
    expect(raw.prepare(`SELECT COUNT(*) c FROM saved_grants WHERE user_id='u-canonical' AND profile_id='pp' AND opportunity_id='oY'`).get().c).toBe(1)
    expect(userProfileSplits(raw)).toBe(0)
  })

  it('[r26 #3] mergeable dup: two-owner session/authorization rows are REVOKED (not transferred); activity rows are MOVED — no split', () => {
    const raw = fullDb()
    seedPhoneDup(raw) // u-canonical owns nothing -> mergeable
    raw.prepare(`INSERT INTO profiles (id, user_id, display_name) VALUES ('p-dup', 'u-dup', 'D')`).run()
    // Security-sensitive session/auth/payment state (must be revoked, never transferred).
    raw.prepare(`INSERT INTO user_sessions (id, user_id, profile_id, refresh_token_hash) VALUES ('us', 'u-dup', 'p-dup', 'h')`).run()
    raw.prepare(`INSERT INTO hamilton_saved_sessions (id, user_id, profile_id, portal_host) VALUES ('hs', 'u-dup', 'p-dup', 'x.com')`).run()
    raw.prepare(`INSERT INTO hamilton_authorizations (id, user_id, profile_id, scope, authorization_type, authorization_text, authorization_version, options_json, metadata_json) VALUES ('ha', 'u-dup', 'p-dup', 'profile', 'payment', 't', '1', '{}', '{}')`).run()
    // Non-security activity (moved with the profile).
    raw.prepare(`INSERT INTO hamilton_runs (id, user_id, profile_id) VALUES ('hr', 'u-dup', 'p-dup')`).run()
    raw.prepare(`INSERT INTO anya_sessions (id, user_id, profile_id) VALUES ('an', 'u-dup', 'p-dup')`).run()

    runRepair(raw)

    // Revoked, not transferred to the canonical.
    expect(raw.prepare(`SELECT COUNT(*) c FROM user_sessions`).get().c).toBe(0)
    expect(raw.prepare(`SELECT COUNT(*) c FROM hamilton_saved_sessions`).get().c).toBe(0)
    expect(raw.prepare(`SELECT COUNT(*) c FROM hamilton_authorizations`).get().c).toBe(0)
    // Activity moved to the canonical (with the profile) — no split.
    expect(raw.prepare(`SELECT user_id FROM hamilton_runs WHERE id='hr'`).get().user_id).toBe('u-canonical')
    expect(raw.prepare(`SELECT user_id FROM anya_sessions WHERE id='an'`).get().user_id).toBe('u-canonical')
    expect(userProfileSplits(raw)).toBe(0)
  })

  it('[r26 GUARD] post-migration invariant holds across ALL two-owner-FK tables on a multi-duplicate DB (red-able)', () => {
    const raw = fullDb()
    // Two independent phone groups: one mergeable, one unmergeable.
    raw.prepare(`INSERT INTO users (id, primary_phone, created_at) VALUES ('m-dup', '+15550000001', '2026-01-01')`).run()
    raw.prepare(`INSERT INTO users (id, primary_phone, created_at) VALUES ('m-can', '+15550000001', '2026-02-01')`).run()
    raw.prepare(`INSERT INTO user_credentials (id, user_id, type, identifier) VALUES ('mc', 'm-can', 'phone_otp', '+15550000001')`).run()
    raw.prepare(`INSERT INTO profiles (id, user_id, display_name) VALUES ('pm', 'm-dup', 'M')`).run() // canonical empty -> mergeable
    raw.prepare(`INSERT INTO saved_grants (id, user_id, profile_id, opportunity_id) VALUES ('smg', 'm-dup', 'pm', 'o1')`).run()
    raw.prepare(`INSERT INTO application_tasks (id, user_id, profile_id) VALUES ('at', 'm-dup', 'pm')`).run()

    raw.prepare(`INSERT INTO users (id, primary_phone, created_at) VALUES ('u-dup', '+15550000002', '2026-01-01')`).run()
    raw.prepare(`INSERT INTO users (id, primary_phone, created_at) VALUES ('u-can', '+15550000002', '2026-02-01')`).run()
    raw.prepare(`INSERT INTO user_credentials (id, user_id, type, identifier) VALUES ('uc', 'u-can', 'phone_otp', '+15550000002')`).run()
    raw.prepare(`INSERT INTO profiles (id, user_id, display_name) VALUES ('pu-can', 'u-can', 'C')`).run()
    raw.prepare(`INSERT INTO profiles (id, user_id, display_name) VALUES ('pu-dup', 'u-dup', 'D')`).run() // both own -> unmergeable
    raw.prepare(`INSERT INTO saved_grants (id, user_id, profile_id, opportunity_id) VALUES ('sud', 'u-dup', 'pu-dup', 'o2')`).run()

    runRepair(raw)

    // The by-construction guard: NO row in ANY two-owner table is split.
    expect(userProfileSplits(raw)).toBe(0)
    expect(userStripeSplits(raw)).toBe(0)
    // Sanity: the mergeable group moved, the unmergeable stayed + was recorded.
    expect(profileOwner(raw, 'pm')).toBe('m-can')
    expect(profileOwner(raw, 'pu-dup')).toBe('u-dup')
    expect(conflicts(raw)).toBe(1)

    // RED-ABLE: introduce a split and the guard catches it.
    raw.prepare(`UPDATE saved_grants SET user_id='u-can' WHERE id='sud'`).run() // user_id=u-can but profile_id=pu-dup(u-dup)
    expect(userProfileSplits(raw)).toBeGreaterThan(0)
  })

  it('[r27 #1] a MULTI-DUP group (2 dups -> 1 canonical) with dup-vs-dup collisions does NOT abort; one survivor; no split', () => {
    const raw = fullDb()
    const p = '+15551110000'
    raw.prepare(`INSERT INTO users (id, primary_phone, created_at) VALUES ('d1', ?, '2026-01-01')`).run(p)
    raw.prepare(`INSERT INTO users (id, primary_phone, created_at) VALUES ('d2', ?, '2026-01-02')`).run(p)
    raw.prepare(`INSERT INTO users (id, primary_phone, created_at) VALUES ('cann', ?, '2026-02-01')`).run(p)
    raw.prepare(`INSERT INTO user_credentials (id, user_id, type, identifier) VALUES ('cc', 'cann', 'phone_otp', ?)`).run(p)
    // Only ONE member owns a profile -> group mergeable.
    raw.prepare(`INSERT INTO profiles (id, user_id, display_name) VALUES ('pd1', 'd1', 'D1')`).run()
    // dup-vs-dup collision on the NULL-profile legacy unique (both dups saved the same opp).
    raw.prepare(`INSERT INTO saved_grants (id, user_id, profile_id, opportunity_id) VALUES ('g1', 'd1', NULL, 'oX')`).run()
    raw.prepare(`INSERT INTO saved_grants (id, user_id, profile_id, opportunity_id) VALUES ('g2', 'd2', NULL, 'oX')`).run()
    // dup-vs-dup collision on user_organizations PK.
    raw.prepare(`INSERT INTO organizations (id, name) VALUES ('org1', 'Org1')`).run()
    raw.prepare(`INSERT INTO user_organizations (user_id, organization_id) VALUES ('d1', 'org1')`).run()
    raw.prepare(`INSERT INTO user_organizations (user_id, organization_id) VALUES ('d2', 'org1')`).run()

    expect(() => runRepair(raw)).not.toThrow() // must NEVER abort on a dup-vs-dup collision

    // Exactly one survivor per unique key, all under the canonical.
    expect(raw.prepare(`SELECT COUNT(*) c FROM saved_grants WHERE user_id='cann' AND profile_id IS NULL AND opportunity_id='oX'`).get().c).toBe(1)
    expect(raw.prepare(`SELECT COUNT(*) c FROM user_organizations WHERE user_id='cann' AND organization_id='org1'`).get().c).toBe(1)
    expect(profileOwner(raw, 'pd1')).toBe('cann')
    expect(conflicts(raw)).toBe(0) // clean group merge
    expect(userProfileSplits(raw)).toBe(0)
  })

  it('[r27 #1b] a MULTI-DUP group where TWO members own a profile is UNMERGEABLE as a whole (nothing moved, all recorded)', () => {
    const raw = fullDb()
    const p = '+15551119999'
    raw.prepare(`INSERT INTO users (id, primary_phone, created_at) VALUES ('e1', ?, '2026-01-01')`).run(p)
    raw.prepare(`INSERT INTO users (id, primary_phone, created_at) VALUES ('e2', ?, '2026-01-02')`).run(p)
    raw.prepare(`INSERT INTO users (id, primary_phone, created_at) VALUES ('ecan', ?, '2026-02-01')`).run(p)
    raw.prepare(`INSERT INTO user_credentials (id, user_id, type, identifier) VALUES ('ec', 'ecan', 'phone_otp', ?)`).run(p)
    // TWO dups own profiles -> group over-owns a 1-per-user resource -> UNMERGEABLE.
    raw.prepare(`INSERT INTO profiles (id, user_id, display_name) VALUES ('pe1', 'e1', 'E1')`).run()
    raw.prepare(`INSERT INTO profiles (id, user_id, display_name) VALUES ('pe2', 'e2', 'E2')`).run()
    raw.prepare(`INSERT INTO saved_grants (id, user_id, profile_id, opportunity_id) VALUES ('eg', 'e1', 'pe1', 'oY')`).run()

    expect(() => runRepair(raw)).not.toThrow()
    // Nothing moved (consistent), every dup recorded for manual reconciliation.
    expect(profileOwner(raw, 'pe1')).toBe('e1')
    expect(profileOwner(raw, 'pe2')).toBe('e2')
    expect(conflicts(raw)).toBe(2) // both dups recorded
    expect(userProfileSplits(raw)).toBe(0)
  })

  it('[r28 #2] pre-map (old-52caf99-137) stamped DB: a nulled candidate is RECORDED for manual review, NEVER auto-merged (fail closed)', () => {
    const raw = fullDb()
    const p = '+15552220000'
    // r23-137-stamped state: a nulled user with a profile whose trace phone matches the canonical.
    // We CANNOT prove they were the phone's duplicate, so we must NOT auto-merge.
    raw.prepare(`INSERT INTO users (id, primary_phone, created_at) VALUES ('pre-dup', NULL, '2026-01-01')`).run()
    raw.prepare(`INSERT INTO users (id, primary_phone, created_at) VALUES ('pre-can', ?, '2026-02-01')`).run(p)
    raw.prepare(`INSERT INTO user_credentials (id, user_id, type, identifier) VALUES ('pc', 'pre-can', 'phone_otp', ?)`).run(p)
    raw.prepare(`INSERT INTO profiles (id, user_id, display_name) VALUES ('pre-p', 'pre-dup', 'PD')`).run()
    raw.prepare(`INSERT INTO profile_sections (profile_id, section_key, data) VALUES ('pre-p', 'basic_information', ?)`).run(JSON.stringify({ phone: p }))

    raw.exec(MIG138) // only 138 runs (old 137 stamped)

    // NOT merged (their profile stays theirs), NOT in the proven map — but RECORDED (not silent).
    expect(profileOwner(raw, 'pre-p')).toBe('pre-dup')
    expect(raw.prepare(`SELECT COUNT(*) c FROM phone_dedupe_map WHERE dup_user_id='pre-dup'`).get().c).toBe(0)
    expect(raw.prepare(`SELECT reason FROM phone_dedupe_conflicts WHERE dup_user_id='pre-dup'`).get()?.reason).toBe('pre-map-unverified, manual review')
    expect(userProfileSplits(raw)).toBe(0)
  })
})
