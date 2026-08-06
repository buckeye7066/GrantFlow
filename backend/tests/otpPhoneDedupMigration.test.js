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
 * This applies the ACTUAL migration SQL (147) to a seeded fixture. Red-able: the old
 * age-based migration keeps the oldest and strands the credential.
 */

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const Database = (await import('better-sqlite3')).default
// Single source of truth (Codex r28/r29): the harness shares the REAL migration
// runner's idempotent-error predicate, so it tolerates exactly what boot tolerates
// (and no more — an absent/renamed-table statement FAILS, as it does in prod).
const { isIdempotentAlreadyAppliedError, checkPhoneDedupeHealth, summarizeBootHealthLine } = await import('../db/migrate.js')
// A tiny db-shim over a raw better-sqlite3 connection so the runtime boot-health helpers
// (which speak the async db-shim API + .dialect) can run against a test fixture DB.
const asDbShim = (raw) => ({
  dialect: 'sqlite',
  prepare: (sql) => {
    const stmt = raw.prepare(sql)
    return { get: (...a) => stmt.get(...a), all: (...a) => stmt.all(...a), run: (...a) => stmt.run(...a) }
  },
})
const MIGRATION = fs.readFileSync(
  path.resolve('backend/db/migrations/147_users_primary_phone_unique.sql'),
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
// Round 24: the FORWARD repair migration 148 runs on an already-147-stamped DB
// (147 was edited in place and never re-runs) AND repoints stranded ownership.
// ---------------------------------------------------------------------------
const SCHEMA = fs.readFileSync(path.resolve('backend/db/schema.sql'), 'utf8')
const MIG148 = fs.readFileSync(path.resolve('backend/db/migrations/148_repair_phone_dedupe_repoint.sql'), 'utf8')
// The round-22 age-based 147 (what an already-stamped DB actually ran).
const AGE_BASED_147 = `
  UPDATE users SET primary_phone = NULL
  WHERE primary_phone IS NOT NULL AND EXISTS (
    SELECT 1 FROM users older WHERE older.primary_phone = users.primary_phone AND older.primary_phone IS NOT NULL
      AND (older.created_at < users.created_at OR (older.created_at = users.created_at AND older.id < users.id)));
  CREATE UNIQUE INDEX IF NOT EXISTS ux_users_primary_phone ON users (primary_phone) WHERE primary_phone IS NOT NULL;`

const MIG148_PG = fs.readFileSync(path.resolve('backend/db/postgres/migrations/0152_repair_phone_dedupe_repoint.sql'), 'utf8')
// Round 32: forward migrations that re-apply the broadened malformed-audit to already-stamped DBs.
const MIG149 = fs.readFileSync(path.resolve('backend/db/migrations/149_repair_malformed_profile_audit.sql'), 'utf8')
const MIG149_PG = fs.readFileSync(path.resolve('backend/db/postgres/migrations/0153_repair_malformed_profile_audit.sql'), 'utf8')

// Build the FULL migrated schema with the REAL migration-runner semantics (Codex r28):
// apply schema.sql then every migration, tolerating ONLY the "already applied / idempotent
// DDL" errors the runner tolerates (mirrors migrate.js isIdempotentAlreadyAppliedError +
// @sqlite-continue-on-idempotent-errors) — a genuine error surfaces instead of being
// swallowed, so the introspected schema is the ACTUAL migrated schema.
const ALL_MIGRATIONS = fs.readdirSync(path.resolve('backend/db/migrations'))
  .filter((f) => f.endsWith('.sql')).sort()
  .map((f) => ({ name: f, sql: fs.readFileSync(path.resolve('backend/db/migrations', f), 'utf8') }))
function applyLikeRunner(raw, name, sql) {
  // Mirrors migrate.js EXACTLY: marker migrations split + tolerate only the runner's
  // idempotent-already-applied errors; everything else execs whole with the same
  // predicate. 'no such table' is NOT idempotent -> it FAILS here (as in prod boot).
  if (sql.includes('@sqlite-continue-on-idempotent-errors')) {
    const statements = sql.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n').split(';').map((s) => s.trim()).filter(Boolean)
    for (const s of statements) { try { raw.exec(`${s};`) } catch (e) { if (!isIdempotentAlreadyAppliedError(e)) throw new Error(`${name}: ${e.message}`) } }
    return
  }
  try { raw.exec(sql) } catch (e) { if (!isIdempotentAlreadyAppliedError(e)) throw new Error(`${name}: ${e.message}`) }
}
function fullDb() {
  const raw = new Database(':memory:')
  raw.pragma('foreign_keys = OFF') // fixtures seed rows without full FK graphs
  raw.exec(SCHEMA)
  for (const { name, sql } of ALL_MIGRATIONS) applyLikeRunner(raw, name, sql)
  // Reset dedupe state applied by 147/148 above so each fixture starts clean.
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

const MIG147 = fs.readFileSync(path.resolve('backend/db/migrations/147_users_primary_phone_unique.sql'), 'utf8')
// The REAL prod order: 147 (capture map -> null non-canonical phones -> index) THEN 148 (repair).
const runRepair = (raw) => { raw.exec(MIG147); raw.exec(MIG148) }

// BY-CONSTRUCTION GUARD (Codex r27 #3): the two-owner inventory is INTROSPECTED from
// the live migrated schema, not a hardcoded list — so a two-owner table added by any
// future migration is automatically checked. The migration's classification is the
// single source of truth (generated alongside 148/0152).
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

describe('forward repair migration 148 (already-147-stamped DBs) + ownership repoint', () => {
  it('the SQLite (148) and Postgres (0152) shared complex logic (merge + collapse + phone-fix) is byte-identical', () => {
    // The two files differ ONLY in the documented dialect spots (the SAFE-JSON detect read
    // and the move/revoke exec: SQLite static vs PG existence-guarded DO block). The
    // complex, correctness-critical shared logic — the _members/_group/_merge build, the
    // group-wide collapse, and the phone-fix — must be byte-identical (no silent drift).
    const strip = (s) => s.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n')
    // Region from the _members build through the end of the collapse (before MOVE).
    const mergeCollapse = (s) => strip(s.split('DROP TABLE IF EXISTS _members;')[1].split('-- MOVE')[0]).trim()
    const phoneFix = (s) => strip(s.split('Keep the phone on the credential-owned user')[1]).trim()
    expect(mergeCollapse(MIG148_PG)).toBe(mergeCollapse(MIG148))
    expect(phoneFix(MIG148_PG)).toBe(phoneFix(MIG148))
    // And both derive move/revoke from the SAME generated classification (single source of truth).
    for (const t of [...CLASSIFICATION.moveProfile, ...CLASSIFICATION.moveAccount]) {
      expect(MIG148).toContain(`UPDATE ${t} SET user_id`)
      expect(MIG148_PG).toContain(`'${t}'`)
    }
  })

  it('[r28] the migration references NO renamed-away/absent table (no yana_* abort) and every referenced table EXISTS in the live schema', () => {
    // yana_* were renamed to hamilton_* (sqlite 090 / pg 0086); referencing them aborts PG.
    const yanaRef = /\byana_(authorizations|runs|autopilot_runs|blockers|resolved_fields|saved_sessions|payment_authorizations|attestation_authorizations)\b/
    expect(yanaRef.test(MIG148.replace(/--.*/g, ''))).toBe(false)
    expect(yanaRef.test(MIG148_PG.replace(/--.*/g, ''))).toBe(false)
    // Every table the SQLite migration MOVES/REVOKES must exist in the real migrated schema.
    const raw = fullDb()
    const existing = new Set(raw.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name))
    const referenced = [...CLASSIFICATION.moveProfile, ...CLASSIFICATION.moveAccount, ...CLASSIFICATION.revoke]
    const missing = referenced.filter((t) => !existing.has(t))
    expect(missing).toEqual([])
    // Postgres 0152 existence-guards each table (to_regclass) so an absent/renamed table is skipped.
    expect(MIG148_PG).toContain('to_regclass(t) IS NOT NULL')
  })

  it('[r27 #3 GUARD] every two-owner table in the live migrated schema is classified (move / revoke / post-repair invariant / exempt)', () => {
    const raw = fullDb()
    const { profile } = twoOwnerTables(raw)
    const classified = new Set([
      ...CLASSIFICATION.moveProfile,
      ...CLASSIFICATION.moveAccount,
      ...CLASSIFICATION.revoke,
      ...CLASSIFICATION.postRepairInvariant,
      ...CLASSIFICATION.exempt,
    ])
    // Every discovered two-owner (user_id+profile_id) table MUST be explicitly classified —
    // a new one added by a future migration fails here until a human classifies it.
    const unclassified = profile.filter((t) => !classified.has(t))
    expect(unclassified).toEqual([])
    // These consent/audit tables are created after the historical phone repair. They are
    // intentionally not rewritten or deleted by 148/0152: their immutable user/profile
    // ownership is enforced at creation/read time and remains covered by the live boot
    // split check (unlike actor-log exemptions).
    expect(CLASSIFICATION.postRepairInvariant).toEqual([
      'hamilton_submission_attempts',
      'hamilton_submission_audit_events',
    ])
    for (const table of CLASSIFICATION.postRepairInvariant) expect(EXEMPT.has(table)).toBe(false)
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

    raw.exec(MIG148)

    // NO cross-account merge: the stranger's profile + credential stay theirs.
    expect(profileOwner(raw, 'sp')).toBe('stranger')
    expect(raw.prepare(`SELECT user_id FROM user_credentials WHERE id='sc'`).get().user_id).toBe('stranger')
    // Never added to the (proven) map -> never moved.
    expect(raw.prepare(`SELECT COUNT(*) c FROM phone_dedupe_map WHERE dup_user_id='stranger'`).get().c).toBe(0)
    // Recorded ONLY as an operator-visible conflict (fail closed).
    expect(raw.prepare(`SELECT reason FROM phone_dedupe_conflicts WHERE dup_user_id='stranger'`).get()?.reason).toBe('pre-map-unverified, manual review')
    expect(userProfileSplits(raw)).toBe(0)
  })

  it('[r29 HIGH] a malformed profile_sections.data row does NOT abort the migration (SAFE JSON); repair still runs', () => {
    const raw = fullDb()
    const p = '+15558880000'
    // A normal mergeable dup.
    raw.prepare(`INSERT INTO users (id, primary_phone, created_at) VALUES ('d', ?, '2026-01-01')`).run(p)
    raw.prepare(`INSERT INTO users (id, primary_phone, created_at) VALUES ('c', ?, '2026-02-01')`).run(p)
    raw.prepare(`INSERT INTO user_credentials (id, user_id, type, identifier) VALUES ('cc', 'c', 'phone_otp', ?)`).run(p)
    raw.prepare(`INSERT INTO profiles (id, user_id, display_name) VALUES ('pd', 'd', 'D')`).run()
    // An UNRELATED profile with MALFORMED (non-JSON) basic_information — the detect read
    // would abort the whole migration without a json_valid guard.
    raw.prepare(`INSERT INTO users (id, created_at) VALUES ('x', '2026-01-01')`).run()
    raw.prepare(`INSERT INTO profiles (id, user_id, display_name) VALUES ('px', 'x', 'X')`).run()
    raw.prepare(`INSERT INTO profile_sections (profile_id, section_key, data) VALUES ('px', 'basic_information', 'not json at all {')`).run()

    expect(() => runRepair(raw)).not.toThrow() // COMPLETES, never aborts on the bad row

    // The repair still ran end-to-end.
    expect(profileOwner(raw, 'pd')).toBe('c')
    expect(phoneOf(raw, 'c')).toBe(p)
    // 'x' is a NULL-phone/no-map user with an unparseable profile → the r31 malformed-audit
    // SURFACES it for manual review (fail-open AND flagged), rather than silently skipping it.
    expect(raw.prepare(`SELECT reason FROM phone_dedupe_conflicts WHERE dup_user_id='x'`).get()?.reason).toBe('pre-map-malformed-profile, manual review')
  })

  it('[r31 HIGH] EVERY malformed basic_information on a NULL-phone/no-map user is flagged — no text heuristic (phone under any key / numeric-only / any case)', () => {
    const raw = fullDb()
    // Three already-147-stamped duplicates (primary_phone NULLED, NO proven map) whose ONLY
    // remaining phone evidence is a MALFORMED basic_information — but the phone does NOT sit
    // under a lowercase 'phone' key, so the r30 `LIKE '%phone%'` gate would SILENTLY DROP them.
    // The corrupt evidence itself must be surfaced regardless of its (unreadable) text.
    const malformed = {
      'm-contact': '{"contact": "+15557770000" broken json',   // phone under a different key
      'm-numeric': '{ 15557770001 ',                            // numeric-only, no 'phone' text
      'm-upper': '{"PHONE": "+15557770002" broken',             // UPPERCASE key (PG LIKE is case-sensitive)
    }
    for (const [uid, data] of Object.entries(malformed)) {
      raw.prepare(`INSERT INTO users (id, primary_phone, created_at) VALUES (?, NULL, '2026-01-01')`).run(uid)
      raw.prepare(`INSERT INTO profiles (id, user_id, display_name) VALUES (?, ?, 'MD')`).run(`p-${uid}`, uid)
      raw.prepare(`INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, 'basic_information', ?)`).run(`p-${uid}`, data)
    }

    expect(() => raw.exec(MIG148)).not.toThrow() // the flag INSERT itself must never abort on a malformed row

    // ALL THREE recorded for operator review — none silently skipped for lacking the word 'phone'.
    for (const uid of Object.keys(malformed)) {
      expect(raw.prepare(`SELECT reason FROM phone_dedupe_conflicts WHERE dup_user_id=?`).get(uid)?.reason).toBe('pre-map-malformed-profile, manual review')
      // Detect-only: nothing auto-moved, never added to the proven map.
      expect(profileOwner(raw, `p-${uid}`)).toBe(uid)
      expect(raw.prepare(`SELECT COUNT(*) c FROM phone_dedupe_map WHERE dup_user_id=?`).get(uid).c).toBe(0)
    }
    expect(userProfileSplits(raw)).toBe(0)

    // GUARD against over-flagging: a VALID (parseable) phoneless profile on a NULL-phone/no-map
    // user is NOT flagged — only genuinely UNREADABLE evidence is surfaced.
    raw.prepare(`INSERT INTO users (id, primary_phone, created_at) VALUES ('vdup', NULL, '2026-01-03')`).run()
    raw.prepare(`INSERT INTO profiles (id, user_id, display_name) VALUES ('vp', 'vdup', 'VD')`).run()
    raw.prepare(`INSERT INTO profile_sections (profile_id, section_key, data) VALUES ('vp', 'basic_information', ?)`).run(JSON.stringify({ email: 'v@x.com' }))
    raw.exec(MIG148)
    expect(raw.prepare(`SELECT COUNT(*) c FROM phone_dedupe_conflicts WHERE dup_user_id='vdup'`).get().c).toBe(0)
  })

  it('[r32 HIGH] forward 149 re-applies the broadened malformed-audit to an already-148-stamped DB (in-place 148 edit never re-runs by filename)', () => {
    // An already-148/0152-stamped DB that ran the r30 LIKE-gated behavior MISSED malformed rows
    // whose corrupt text lacked the literal 'phone'. Because the boot runner selects by filename
    // (files.filter(f => !applied.has(f))), the in-place r30/r31 edits to 148 never re-run there.
    // Forward 149 fixes exactly that DB. Simulate it: malformed rows present, 148 already ran and
    // left them UNFLAGGED (the r30 miss) — represented here by an empty conflicts table.
    const raw = fullDb() // fullDb runs all migrations incl. 149 then CLEARS the dedupe tables → clean slate
    const missed = {
      's-contact': '{"contact": "+15557770000" broken json',
      's-numeric': '{ 15557770001 ',
      's-upper': '{"PHONE": "+15557770002" broken',
    }
    for (const [uid, data] of Object.entries(missed)) {
      raw.prepare(`INSERT INTO users (id, primary_phone, created_at) VALUES (?, NULL, '2026-01-01')`).run(uid)
      raw.prepare(`INSERT INTO profiles (id, user_id, display_name) VALUES (?, ?, 'S')`).run(`p-${uid}`, uid)
      raw.prepare(`INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, 'basic_information', ?)`).run(`p-${uid}`, data)
    }
    // PRECONDITION (the r30 miss): with 148 already stamped and NOT re-run, these stay unflagged.
    for (const uid of Object.keys(missed)) {
      expect(raw.prepare(`SELECT COUNT(*) c FROM phone_dedupe_conflicts WHERE dup_user_id=?`).get(uid).c).toBe(0)
    }

    // The forward migration surfaces every previously-missed malformed row.
    expect(() => raw.exec(MIG149)).not.toThrow()
    for (const uid of Object.keys(missed)) {
      expect(raw.prepare(`SELECT reason FROM phone_dedupe_conflicts WHERE dup_user_id=?`).get(uid)?.reason).toBe('pre-map-malformed-profile, manual review')
      expect(profileOwner(raw, `p-${uid}`)).toBe(uid) // detect-only, nothing moved
    }
    expect(userProfileSplits(raw)).toBe(0)

    // IDEMPOTENT: re-running 149 is a no-op (no double-flag — sentinel canonical id + ON CONFLICT).
    raw.exec(MIG149)
    for (const uid of Object.keys(missed)) {
      expect(raw.prepare(`SELECT COUNT(*) c FROM phone_dedupe_conflicts WHERE dup_user_id=?`).get(uid).c).toBe(1)
    }

    // A VALID phoneless profile is still NOT flagged by the forward migration (no over-flagging).
    raw.prepare(`INSERT INTO users (id, primary_phone, created_at) VALUES ('svalid', NULL, '2026-01-05')`).run()
    raw.prepare(`INSERT INTO profiles (id, user_id, display_name) VALUES ('pvalid', 'svalid', 'V')`).run()
    raw.prepare(`INSERT INTO profile_sections (profile_id, section_key, data) VALUES ('pvalid', 'basic_information', ?)`).run(JSON.stringify({ email: 'v@x.com' }))
    raw.exec(MIG149)
    expect(raw.prepare(`SELECT COUNT(*) c FROM phone_dedupe_conflicts WHERE dup_user_id='svalid'`).get().c).toBe(0)
  })

  it('[r32 HIGH] fresh install (148 then 149) does not double-flag; 149 is a safe no-op after 148 already flagged', () => {
    const raw = fullDb()
    const p = '+15556660000'
    raw.prepare(`INSERT INTO users (id, primary_phone, created_at) VALUES ('fdup', NULL, '2026-01-01')`).run()
    raw.prepare(`INSERT INTO profiles (id, user_id, display_name) VALUES ('fp', 'fdup', 'F')`).run()
    raw.prepare(`INSERT INTO profile_sections (profile_id, section_key, data) VALUES ('fp', 'basic_information', ?)`).run('{"contact": "' + p + '" broken')

    // Fresh prod order: 148 (current r31 predicate) flags it, THEN 149 runs as a no-op.
    raw.exec(MIG148)
    expect(raw.prepare(`SELECT COUNT(*) c FROM phone_dedupe_conflicts WHERE dup_user_id='fdup'`).get().c).toBe(1)
    raw.exec(MIG149)
    expect(raw.prepare(`SELECT COUNT(*) c FROM phone_dedupe_conflicts WHERE dup_user_id='fdup'`).get().c).toBe(1) // no double-flag
  })

  it('[r32] forward 149 (SQLite) and 0153 (Postgres) share byte-identical audit logic (only json_valid vs pdedupe_is_json differs)', () => {
    // Normalize away comments, the PG-only pg_temp helper block, and the dialect validity check,
    // then the remaining INSERT logic must be byte-identical across the two forward migrations.
    const strip = (s) => s.split('\n').filter((l) => !l.trimStart().startsWith('--') && l.trim() !== '').join('\n')
    const core = (s) => strip(s.split('INSERT INTO phone_dedupe_conflicts')[1])
      .replace('AND pg_temp.pdedupe_is_json(ps.data) = false', 'AND <<validity>>')
      .replace('AND json_valid(ps.data) = 0', 'AND <<validity>>')
    expect(core(MIG149_PG)).toBe(core(MIG149))
    // Both use the sentinel canonical id + ON CONFLICT DO NOTHING (idempotent, no double-flag).
    for (const m of [MIG149, MIG149_PG]) {
      expect(m).toContain(`'(unknown-malformed-profile)'`)
      expect(m).toContain('ON CONFLICT (dup_user_id, canonical_user_id) DO NOTHING')
      expect(m).toContain('pre-map-malformed-profile, manual review')
    }
  })

  it('[r30 MED] boot post-condition HEALTH catches a failed/unstamped phone-dedup repair — it cannot hide behind schema-check OK', () => {
    // (a) A HEALTHY migrated DB (indexes present, no split) passes the post-condition check.
    const healthy = fullDb()
    healthy.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_users_primary_phone ON users (primary_phone) WHERE primary_phone IS NOT NULL')
    return Promise.resolve().then(async () => {
      const okHealth = await checkPhoneDedupeHealth(asDbShim(healthy))
      expect(okHealth.ok).toBe(true)
      expect(okHealth.problems).toEqual([])

      // (b) A DB where the repair FAILED/was unstamped: the primary_phone index is absent
      // (fullDb drops it) AND a two-owner split is present. Post-conditions must FAIL.
      const broken = fullDb() // ux_users_primary_phone already dropped by fullDb()
      broken.prepare(`INSERT INTO users (id, primary_phone, created_at) VALUES ('a', NULL, '2026-01-01')`).run()
      broken.prepare(`INSERT INTO users (id, primary_phone, created_at) VALUES ('b', NULL, '2026-01-02')`).run()
      broken.prepare(`INSERT INTO profiles (id, user_id, display_name) VALUES ('pb', 'b', 'B')`).run()
      broken.prepare(`INSERT INTO saved_grants (id, user_id, profile_id, opportunity_id) VALUES ('sgx', 'a', 'pb', 'o')`).run() // user a, profile owned by b → split
      const badHealth = await checkPhoneDedupeHealth(asDbShim(broken))
      expect(badHealth.ok).toBe(false)
      expect(badHealth.problems.join(' ')).toMatch(/ux_users_primary_phone/)
      expect(badHealth.problems.join(' ')).toMatch(/two-owner split/)

      // A missing one-active-code index is also caught.
      const noCodeIdx = fullDb()
      noCodeIdx.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_users_primary_phone ON users (primary_phone) WHERE primary_phone IS NOT NULL')
      noCodeIdx.exec('DROP INDEX IF EXISTS ux_uvc_one_active_per_credential')
      const codeHealth = await checkPhoneDedupeHealth(asDbShim(noCodeIdx))
      expect(codeHealth.ok).toBe(false)
      expect(codeHealth.problems.join(' ')).toMatch(/ux_uvc_one_active_per_credential/)

      // (c) The boot signal folds failed-migrations + phone-dedup health into ONE line.
      // KEY: even with ZERO missing columns/tables (schema check would say OK), a failed
      // repair OR a broken post-condition flips the line OFF OK — it can't hide.
      expect(summarizeBootHealthLine({ missingCols: [], missingTables: [], failed: [], dedupe: { ok: true, problems: [] } })).toBe('schema check: OK')
      const failedLine = summarizeBootHealthLine({ missingCols: [], missingTables: [], failed: ['148_repair_phone_dedupe_repoint.sql'], dedupe: badHealth })
      expect(failedLine).not.toBe('schema check: OK')
      expect(failedLine).toMatch(/failed_migrations=148_repair_phone_dedupe_repoint\.sql/)
      expect(failedLine).toMatch(/phone_dedupe=/)
      // Broken post-condition alone (no failed file) still flips it — the schema-OK path is closed.
      expect(summarizeBootHealthLine({ dedupe: badHealth })).not.toBe('schema check: OK')
    })
  }, 20000)  // heavy: runs the full migration chain + health check three times; 5s default flakes under parallel-file load

  it('[r29 MED] applyLikeRunner shares the REAL runner predicate — an absent/renamed-table statement FAILS the harness (no masked error)', () => {
    const raw = new Database(':memory:')
    // 'no such table' is NOT idempotent per the real migrate.js predicate -> must throw,
    // proving the guard would catch a yana_*-style abort instead of silently skipping it.
    expect(() => applyLikeRunner(raw, 'x.sql', `UPDATE definitely_absent_table SET user_id = 'z';`)).toThrow(/no such table/i)
    expect(isIdempotentAlreadyAppliedError({ message: 'no such table: yana_runs' })).toBe(false)
    // Sanity: a genuinely idempotent error (already exists) is still tolerated.
    raw.exec(`CREATE TABLE t (id TEXT)`)
    expect(() => applyLikeRunner(raw, 'x.sql', `CREATE TABLE t (id TEXT);`)).not.toThrow()
  })

  it('the runner selects 148 even when 147 is already stamped (forward migration, not an in-place edit)', () => {
    // Mirrors migrate.js: `pending = files.filter(f => !applied.has(f))`.
    const dir = path.resolve('backend/db/migrations')
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    expect(files).toContain('147_users_primary_phone_unique.sql')
    expect(files).toContain('148_repair_phone_dedupe_repoint.sql')
    // A DB that already ran through 147 (age-based) has it stamped; the in-place
    // r23 edit to 147 would NEVER re-run — but 148 is a NEW filename, so:
    const applied = new Set(files.filter((f) => f <= '147_users_primary_phone_unique.sql'))
    const pending = files.filter((f) => !applied.has(f))
    expect(pending).toContain('148_repair_phone_dedupe_repoint.sql')
    // Postgres twin exists too.
    expect(fs.existsSync(path.resolve('backend/db/postgres/migrations/0152_repair_phone_dedupe_repoint.sql'))).toBe(true)
  })

  it('repairs an age-based-147 DB: credential-owned user regains the phone, oldest nulled, one holder', () => {
    const raw = fullDb()
    // Credential owned by the NEWER user (u-canonical); an older duplicate exists.
    raw.prepare(`INSERT INTO users (id, primary_phone, created_at) VALUES ('u-old', ?, '2026-01-01T00:00:00Z')`).run(phone)
    raw.prepare(`INSERT INTO users (id, primary_phone, created_at) VALUES ('u-canonical', ?, '2026-02-01T00:00:00Z')`).run(phone)
    raw.prepare(`INSERT INTO user_credentials (id, user_id, type, identifier) VALUES ('c1', 'u-canonical', 'phone_otp', ?)`).run(phone)

    // Simulate the r22-stamped state: the age-based 147 already ran (kept the OLDEST,
    // nulled the credential-owned u-canonical → stranded credential).
    raw.exec(AGE_BASED_147)
    expect(phoneOf(raw, 'u-old')).toBe(phone)
    expect(phoneOf(raw, 'u-canonical')).toBeNull() // credential stranded on a nulled-phone user

    // The FORWARD migration 148 repairs it.
    raw.exec(MIG148)
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
    // Fresh install (corrected 147 already created the index; no dups).
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
  it('[r26 #1] 147 (which nulls the dup phone) THEN 148 still repairs — the durable map survives the null (no silent no-op)', () => {
    const raw = fullDb()
    seedPhoneDup(raw)
    raw.prepare(`INSERT INTO profiles (id, user_id, display_name) VALUES ('p-dup', 'u-dup', 'Dup Profile')`).run()

    raw.exec(MIG147) // captures phone_dedupe_map, THEN nulls u-dup's phone
    expect(phoneOf(raw, 'u-dup')).toBeNull() // phone gone — the old repair would no-op here
    expect(raw.prepare(`SELECT COUNT(*) c FROM phone_dedupe_map`).get().c).toBe(1) // but the map survives

    raw.exec(MIG148)
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

  it('[r28 #2] pre-map (old-52caf99-147) stamped DB: a nulled candidate is RECORDED for manual review, NEVER auto-merged (fail closed)', () => {
    const raw = fullDb()
    const p = '+15552220000'
    // r23-147-stamped state: a nulled user with a profile whose trace phone matches the canonical.
    // We CANNOT prove they were the phone's duplicate, so we must NOT auto-merge.
    raw.prepare(`INSERT INTO users (id, primary_phone, created_at) VALUES ('pre-dup', NULL, '2026-01-01')`).run()
    raw.prepare(`INSERT INTO users (id, primary_phone, created_at) VALUES ('pre-can', ?, '2026-02-01')`).run(p)
    raw.prepare(`INSERT INTO user_credentials (id, user_id, type, identifier) VALUES ('pc', 'pre-can', 'phone_otp', ?)`).run(p)
    raw.prepare(`INSERT INTO profiles (id, user_id, display_name) VALUES ('pre-p', 'pre-dup', 'PD')`).run()
    raw.prepare(`INSERT INTO profile_sections (profile_id, section_key, data) VALUES ('pre-p', 'basic_information', ?)`).run(JSON.stringify({ phone: p }))

    raw.exec(MIG148) // only 148 runs (old 147 stamped)

    // NOT merged (their profile stays theirs), NOT in the proven map — but RECORDED (not silent).
    expect(profileOwner(raw, 'pre-p')).toBe('pre-dup')
    expect(raw.prepare(`SELECT COUNT(*) c FROM phone_dedupe_map WHERE dup_user_id='pre-dup'`).get().c).toBe(0)
    expect(raw.prepare(`SELECT reason FROM phone_dedupe_conflicts WHERE dup_user_id='pre-dup'`).get()?.reason).toBe('pre-map-unverified, manual review')
    expect(userProfileSplits(raw)).toBe(0)
  })
})
