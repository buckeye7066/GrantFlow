// backend/services/opportunityIdentityStore.js
//
// Phase 2.1 of the web-lane de-contamination program: pure accessors over the
// opportunity identity tables (opportunity_identity_aliases /
// opportunity_identity_conflicts — see the opportunity_identity_tables
// migration twins + schema.sql).
//
// ADDITIVE: the alias/conflict tables remain default-off for general identity
// claiming, while crawler persistence reuses `withIdentityTxn` as a keyed
// serializer for rolling Grants.gov identity migration. That lock-only use
// does not read or write either identity table. The remaining exports are
// injectable-DB accessors (the repo's dialect-agnostic shim OR a raw
// better-sqlite3 handle in tests; `?` placeholders and
// `ON CONFLICT ... DO UPDATE` work on both SQLite and Postgres).
//
// Identity model:
//   - An ALIAS maps a (scheme, identity_key) — e.g. a normalized URL or an
//     external id under a named scheme — to the ONE opportunity it has been
//     observed to denote. UNIQUE(scheme, identity_key) is the invariant.
//   - A CONFLICT records the times the world DISAGREED: the same
//     (scheme, identity_key) observed on two different opportunities. The
//     PARTIAL unique index (WHERE status = 'open') keeps at most ONE open
//     conflict per key: re-observing a known conflict UPDATES the open row
//     (evidence + participants + last_seen_at), never inserts a second, while
//     a RESOLVED conflict leaves room for a genuinely new open one.
//     opportunity_id_a/b stay the FIRST-observed pair; `participants` (JSON
//     array) accumulates EVERY distinct opportunity id ever observed on the
//     row, so an A/C observation folding into an open A/B row never loses C.
//
// Concurrency: two logical writers can race to claim the same identity key.
// `withIdentityTxn` serializes them — Postgres via pg_advisory_xact_lock on the
// key (taken INSIDE the transaction, before any dual-read), SQLite via a
// BEGIN IMMEDIATE transaction (the write lock is taken up front) — and on a
// unique-constraint violation OF THE ALIAS CONSTRAINT SPECIFICALLY (never an
// unrelated table's) retries an alias-claim callback ONCE: the loser's re-read
// (`getAlias` first, per the callback contract below) then sees the winner's
// row instead of colliding again. Keyed-lock-only callbacks cannot enter that
// alias-specific retry path.

import { randomUUID } from 'crypto'

/** Every legal conflict status, in one place. */
export const CONFLICT_STATUSES = Object.freeze([
  'open',
  'resolved_merged',
  'resolved_distinct',
  'dismissed',
])

/** The statuses `resolveConflict` may move a conflict TO (never back to open). */
export const RESOLVED_CONFLICT_STATUSES = Object.freeze([
  'resolved_merged',
  'resolved_distinct',
  'dismissed',
])

/**
 * The NAMED unique constraint on opportunity_identity_aliases(scheme,
 * identity_key) — declared with this exact name in both migration twins and
 * schema.sql. It is API surface: `withIdentityTxn` retries ONLY a violation of
 * this constraint (Postgres reports it as error.constraint), never an
 * unrelated table's.
 */
export const ALIAS_UNIQUE_CONSTRAINT = 'ux_opportunity_identity_aliases_key'

const ALIAS_TABLE = 'opportunity_identity_aliases'

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    const got = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
    throw new TypeError(`opportunityIdentityStore: ${name} must be a non-empty string (received ${got})`)
  }
  return value
}

/**
 * Serialize conflict evidence for the TEXT column: a string is stored as-is, a
 * JSON-serializable value is stored as JSON, nullish stores NULL. Never throws
 * on exotic values (falls back to String()) — evidence is debug context, not a
 * decision input.
 */
function serializeEvidence(evidence) {
  if (evidence === null || evidence === undefined) return null
  if (typeof evidence === 'string') return evidence
  try {
    return JSON.stringify(evidence)
  } catch {
    return String(evidence)
  }
}

/**
 * True when an error is a unique-constraint violation in EITHER dialect:
 * Postgres unique_violation (code 23505) or better-sqlite3's
 * SQLITE_CONSTRAINT_UNIQUE / SQLITE_CONSTRAINT_PRIMARYKEY.
 */
export function isUniqueViolation(error) {
  if (!error) return false
  const code = String(error.code || '')
  if (code === '23505') return true
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return true
  // Some sqlite wrappers surface the generic constraint code; disambiguate on
  // the message, which better-sqlite3 always includes.
  if (code.startsWith('SQLITE_CONSTRAINT') && /UNIQUE constraint failed/i.test(String(error.message || ''))) {
    return true
  }
  return false
}

/**
 * True ONLY for a unique violation of the ALIAS table's (scheme, identity_key)
 * constraint — the one race `withIdentityTxn` is licensed to absorb. An
 * unrelated unique violation (any other table, any other constraint) must
 * surface to the caller, NOT trigger a callback re-run: retrying the whole
 * callback would double-apply any effect that escaped the rolled-back
 * transaction.
 *
 * Postgres names the violated constraint (error.constraint) and table
 * (error.table); SQLite better-sqlite3 reports the columns in the message
 * ("UNIQUE constraint failed: opportunity_identity_aliases.scheme, ...").
 */
export function isAliasUniqueViolation(error) {
  if (!isUniqueViolation(error)) return false
  const constraint = String(error?.constraint || '')
  if (constraint) {
    return constraint === ALIAS_UNIQUE_CONSTRAINT || constraint.includes(ALIAS_TABLE)
  }
  if (error?.table) return String(error.table) === ALIAS_TABLE
  return new RegExp(`UNIQUE constraint failed:\\s*${ALIAS_TABLE}\\.`, 'i').test(String(error?.message || ''))
}

/**
 * Look up the alias row for an identity key.
 *
 * @param {*} db injectable DB handle (shim or transaction handle).
 * @param {string} scheme
 * @param {string} identityKey
 * @returns {Promise<object|null>} the alias row, or null when unclaimed.
 */
export async function getAlias(db, scheme, identityKey) {
  requireNonEmptyString(scheme, 'scheme')
  requireNonEmptyString(identityKey, 'identityKey')
  const row = await db
    .prepare(
      `SELECT scheme, identity_key, opportunity_id, first_seen_at, last_seen_at
         FROM opportunity_identity_aliases
        WHERE scheme = ? AND identity_key = ?
        LIMIT 1`,
    )
    .get(scheme, identityKey)
  return row || null
}

/**
 * Claim an identity key for an opportunity (sets first_seen_at AND
 * last_seen_at). A plain INSERT by design: claiming an already-claimed key
 * raises the dialect's unique-constraint violation, which `withIdentityTxn`
 * turns into a retry so the caller's re-read sees the winner.
 *
 * @param {*} db injectable DB handle.
 * @param {{scheme:string, identityKey:string, opportunityId:string}} alias
 * @returns {Promise<object>} the inserted alias row.
 */
export async function insertAlias(db, { scheme, identityKey, opportunityId } = {}) {
  requireNonEmptyString(scheme, 'scheme')
  requireNonEmptyString(identityKey, 'identityKey')
  requireNonEmptyString(opportunityId, 'opportunityId')
  await db
    .prepare(
      `INSERT INTO opportunity_identity_aliases
         (scheme, identity_key, opportunity_id, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    )
    .run(scheme, identityKey, opportunityId)
  return getAlias(db, scheme, identityKey)
}

/**
 * Record a fresh observation of an existing alias: bumps last_seen_at ONLY
 * (first_seen_at and opportunity_id are never touched).
 *
 * @param {*} db injectable DB handle.
 * @param {string} scheme
 * @param {string} identityKey
 * @returns {Promise<boolean>} true when an alias row was updated.
 */
export async function touchAlias(db, scheme, identityKey) {
  requireNonEmptyString(scheme, 'scheme')
  requireNonEmptyString(identityKey, 'identityKey')
  const result = await db
    .prepare(
      `UPDATE opportunity_identity_aliases
          SET last_seen_at = CURRENT_TIMESTAMP
        WHERE scheme = ? AND identity_key = ?`,
    )
    .run(scheme, identityKey)
  return Number(result?.changes || 0) > 0
}

/**
 * Read the ONE open conflict row for an identity key, or null.
 */
async function getOpenConflict(db, scheme, identityKey) {
  const row = await db
    .prepare(
      `SELECT id, scheme, identity_key, opportunity_id_a, opportunity_id_b,
              participants, evidence, status, first_seen_at, last_seen_at
         FROM opportunity_identity_conflicts
        WHERE scheme = ? AND identity_key = ? AND status = 'open'
        LIMIT 1`,
    )
    .get(scheme, identityKey)
  return row || null
}

/**
 * Union of the row's known participants and a new observation's pair, as a
 * deterministic (sorted, de-duplicated) JSON array. A legacy/NULL participants
 * column is seeded from the row's own a/b pair, so no id is ever lost.
 */
function mergeParticipants(existingRow, aId, bId) {
  const known = []
  if (existingRow) {
    let parsed = null
    try {
      parsed = JSON.parse(existingRow.participants)
    } catch {
      parsed = null
    }
    if (Array.isArray(parsed)) known.push(...parsed.map((v) => String(v)))
    else known.push(String(existingRow.opportunity_id_a), String(existingRow.opportunity_id_b))
  }
  return JSON.stringify([...new Set([...known, aId, bId])].sort())
}

/**
 * Record (or re-observe) an identity conflict. At most ONE open conflict
 * exists per (scheme, identity_key) — enforced by the partial unique index —
 * so re-observing an existing open conflict UPDATES its evidence, participants
 * and last_seen_at on the SAME row (same id), never inserts a second open row.
 * The single `ON CONFLICT ... WHERE status = 'open' DO UPDATE` statement
 * targets that partial index identically on SQLite and Postgres, so the
 * no-second-open-row guarantee holds even for a caller racing outside
 * `withIdentityTxn`. A RESOLVED conflict does not collide: a later
 * re-observation inserts a genuinely NEW open row.
 *
 * PARTICIPANT AGGREGATION: opportunity_id_a/b keep the FIRST-observed pair;
 * `participants` is the union of every distinct opportunity id observed on
 * the row (seeded from a/b), so an A/C observation folding into an open A/B
 * row retains C STRUCTURALLY — not merely inside unstructured evidence — and
 * resolving the row later never erases that knowledge. The union is computed
 * from a pre-read; callers wanting it race-proof run inside `withIdentityTxn`
 * (the same serialization every identity write already requires).
 *
 * @param {*} db injectable DB handle.
 * @param {{scheme:string, identityKey:string, aId:string, bId:string, evidence?:*}} conflict
 * @returns {Promise<object>} the open conflict row (existing id on re-observation).
 */
export async function upsertOpenConflict(db, { scheme, identityKey, aId, bId, evidence } = {}) {
  requireNonEmptyString(scheme, 'scheme')
  requireNonEmptyString(identityKey, 'identityKey')
  requireNonEmptyString(aId, 'aId')
  requireNonEmptyString(bId, 'bId')
  const existing = await getOpenConflict(db, scheme, identityKey)
  const participants = mergeParticipants(existing, aId, bId)
  await db
    .prepare(
      `INSERT INTO opportunity_identity_conflicts
         (id, scheme, identity_key, opportunity_id_a, opportunity_id_b,
          participants, evidence, status, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (scheme, identity_key) WHERE status = 'open'
       DO UPDATE SET
         participants = excluded.participants,
         evidence = excluded.evidence,
         last_seen_at = CURRENT_TIMESTAMP`,
    )
    .run(randomUUID(), scheme, identityKey, aId, bId, participants, serializeEvidence(evidence))
  return getOpenConflict(db, scheme, identityKey)
}

/**
 * Move a conflict OUT of the open state. Only the three resolved states are
 * legal targets — re-opening ('open') or any unknown status THROWS. Resolving
 * frees the partial unique slot, so a genuinely new open conflict for the same
 * key can be recorded later. Participants are left intact on the resolved row
 * (resolution finalizes a decision; it never erases what was observed).
 *
 * COMPARE-AND-SET: the UPDATE is guarded by `AND status = 'open'`, so of two
 * concurrent resolvers exactly ONE wins — the loser gets false and the first
 * final decision is never silently rewritten.
 *
 * @param {*} db injectable DB handle.
 * @param {string} id the conflict row id.
 * @param {string} status one of RESOLVED_CONFLICT_STATUSES.
 * @returns {Promise<boolean>} true when THIS call performed the open→resolved
 *   transition; false when the row was already finalized (or unknown).
 */
export async function resolveConflict(db, id, status) {
  requireNonEmptyString(id, 'id')
  if (!RESOLVED_CONFLICT_STATUSES.includes(status)) {
    throw new TypeError(
      `opportunityIdentityStore: resolveConflict status must be one of ${RESOLVED_CONFLICT_STATUSES.join(', ')} (received ${JSON.stringify(status)})`,
    )
  }
  const result = await db
    .prepare(
      `UPDATE opportunity_identity_conflicts
          SET status = ?, last_seen_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'open'`,
    )
    .run(status, id)
  return Number(result?.changes || 0) > 0
}

/**
 * Run one attempt of the identity transaction in the right dialect.
 *
 * Postgres: the pg shim's withTransaction (BEGIN/COMMIT with a tx handle);
 * the TWO-INT advisory lock pg_advisory_xact_lock(hashtext(scheme),
 * hashtext(identity_key)) is taken INSIDE the transaction, before the
 * callback's dual-reads, and releases automatically at COMMIT/ROLLBACK. The
 * two-int form keys each component separately, so there is no concatenation
 * ambiguity (("a:b","c") vs ("a","b:c")) and the combined key space is 64-bit
 * — collisions only over-serialize, never under-serialize, but a 32-bit
 * single hash made that needlessly likely.
 *
 * SQLite: the shim's withTransaction already opens BEGIN IMMEDIATE (the write
 * lock up front — the equivalent serialization); a raw better-sqlite3 handle
 * (tests) gets a manual BEGIN IMMEDIATE / COMMIT / ROLLBACK.
 */
async function runIdentityTxnOnce(db, scheme, identityKey, fn) {
  if (db?.dialect === 'postgres') {
    return db.withTransaction(async (tx) => {
      await tx
        .prepare(`SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?)) AS locked`)
        .get(scheme, identityKey)
      return fn(tx)
    })
  }
  if (typeof db?.withTransaction === 'function') {
    // The sqlite shim's withTransaction is BEGIN IMMEDIATE already.
    return db.withTransaction((tx) => fn(tx || db))
  }
  // Raw better-sqlite3 handle (tests): manual BEGIN IMMEDIATE.
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = await fn(db)
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // ignore rollback errors — the original error is the story
    }
    throw error
  }
}

/**
 * Serialize identity work on ONE (scheme, identityKey) and absorb the
 * lost-race case.
 *
 * CALLBACK CONTRACT: `fn(tx)` receives the transaction handle and MUST perform
 * all database reads and writes through it. Alias-claim callbacks MUST start
 * with `getAlias`: their retry semantics depend on the second attempt
 * re-reading the alias and seeing the winner's row. Keyed-lock-only callbacks
 * that never touch the alias table do not need that pre-read because they
 * cannot trigger the alias-specific retry below. Every callback must do
 * TRANSACTION-LOCAL, IDEMPOTENT work ONLY: no writes through other connections,
 * no telemetry emission, no external service calls. A retried alias callback
 * runs in FULL a second time, and anything that escaped the rolled-back
 * transaction would be double-applied.
 *
 * On a unique violation OF THE ALIAS CONSTRAINT (two logical writers claimed
 * the same key; the serialization window was missed — e.g. a caller outside
 * any lock) the FIRST attempt's transaction rolls back and the callback is
 * retried exactly ONCE in a fresh transaction. Any OTHER unique violation —
 * an unrelated table or constraint — is NOT the race this retry exists to
 * absorb and propagates immediately, as does any other error and an alias
 * violation on the retry itself.
 *
 * @param {*} db the dialect-agnostic shim (or a raw sqlite handle in tests).
 * @param {string} scheme
 * @param {string} identityKey
 * @param {(tx:*) => Promise<*>} fn
 * @returns {Promise<*>} the callback's result.
 */
export async function withIdentityTxn(db, scheme, identityKey, fn) {
  requireNonEmptyString(scheme, 'scheme')
  requireNonEmptyString(identityKey, 'identityKey')
  if (typeof fn !== 'function') {
    throw new TypeError('opportunityIdentityStore: withIdentityTxn fn must be a function')
  }
  try {
    return await runIdentityTxnOnce(db, scheme, identityKey, fn)
  } catch (error) {
    if (!isAliasUniqueViolation(error)) throw error
    // Lost the ALIAS race: retry ONCE — the re-read (getAlias) now sees the winner.
    return runIdentityTxnOnce(db, scheme, identityKey, fn)
  }
}
