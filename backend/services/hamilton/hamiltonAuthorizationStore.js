/**
 * hamiltonAuthorizationStore.js
 *
 * Persistence layer for Hamilton Autopilot's standing authorizations.
 *
 * The user grants Hamilton authority once per (profile, selected funding
 * sources) and we persist:
 *   - the exact text shown on the authorization screen
 *   - which authorization options the user ticked
 *   - the authorization version
 *   - timestamp + IP + user-agent
 *
 * Lookups never delete — revocation is a status transition
 * (`revoked_at IS NOT NULL`) so the audit trail is complete.
 */

import crypto from 'node:crypto'

export const HAMILTON_AUTHORIZATION_TYPES = Object.freeze([
  'complete_forms',
  'upload_documents',
  'generate_narratives',
  'save_drafts',
  'submit_applications',
  'use_saved_session',
  'use_saved_credentials_reference',
  'use_standing_attestation',
])

export const HAMILTON_AUTHORIZATION_SCOPES = Object.freeze(['profile', 'task', 'funding_source'])

let ensuredAuthSchema = false

export function _resetAuthSchemaCache() {
  ensuredAuthSchema = false
}

function isMissingRelationError(err) {
  // Postgres 42P01 "relation ... does not exist" / SQLite "no such table".
  const msg = String(err?.message || err || '').toLowerCase()
  return msg.includes('does not exist') || msg.includes('no such table')
}

export async function ensureHamiltonAuthorizationSchema(db) {
  if (!db || typeof db.prepare !== 'function') return
  if (ensuredAuthSchema) return
  const isPostgres = db?.dialect === 'postgres'
  // gen_random_uuid() is core in Postgres 13+, but pgcrypto provides it on
  // older servers; create the extension defensively so the DEFAULT below never
  // fails at CREATE TABLE time.
  if (isPostgres) {
    try { await db.exec('CREATE EXTENSION IF NOT EXISTS pgcrypto') } catch { /* may lack superuser; core gen_random_uuid still works on PG13+ */ }
  }
  const idDefault = isPostgres ? '(gen_random_uuid()::text)' : '(lower(hex(randomblob(16))))'
  const tsType = isPostgres ? 'TIMESTAMPTZ' : 'DATETIME'
  const nowFn = isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'
  const jsonbType = isPostgres ? 'JSONB' : 'TEXT'
  const emptyObj = isPostgres ? `'{}'::jsonb` : `'{}'`
  await db.exec(`
    CREATE TABLE IF NOT EXISTS hamilton_authorizations (
      id TEXT PRIMARY KEY DEFAULT ${idDefault},
      user_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      authorization_type TEXT NOT NULL,
      funding_source_id TEXT,
      task_id TEXT,
      authorization_text TEXT NOT NULL,
      authorization_version TEXT NOT NULL DEFAULT 'hamilton-autopilot-v1',
      options_json ${jsonbType} NOT NULL DEFAULT ${emptyObj},
      metadata_json ${jsonbType} NOT NULL DEFAULT ${emptyObj},
      accepted_at ${tsType} DEFAULT ${nowFn},
      revoked_at ${tsType},
      revoked_reason TEXT,
      created_at ${tsType} DEFAULT ${nowFn},
      updated_at ${tsType} DEFAULT ${nowFn}
    );
    CREATE INDEX IF NOT EXISTS idx_hamilton_auth_user    ON hamilton_authorizations(user_id);
    CREATE INDEX IF NOT EXISTS idx_hamilton_auth_profile ON hamilton_authorizations(profile_id);
    CREATE INDEX IF NOT EXISTS idx_hamilton_auth_type    ON hamilton_authorizations(authorization_type);
    CREATE INDEX IF NOT EXISTS idx_hamilton_auth_funding ON hamilton_authorizations(funding_source_id);

    CREATE TABLE IF NOT EXISTS hamilton_autopilot_runs (
      id TEXT PRIMARY KEY DEFAULT ${idDefault},
      task_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      user_id TEXT,
      authorization_id TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      blocker_kind TEXT,
      blocker_detail TEXT,
      preflight_json ${jsonbType} NOT NULL DEFAULT ${emptyObj},
      result_json ${jsonbType} NOT NULL DEFAULT ${emptyObj},
      confirmation_reference TEXT,
      confirmation_screenshot_path TEXT,
      started_at ${tsType},
      finished_at ${tsType},
      created_at ${tsType} DEFAULT ${nowFn},
      updated_at ${tsType} DEFAULT ${nowFn}
    );
    CREATE INDEX IF NOT EXISTS idx_hamilton_autopilot_task     ON hamilton_autopilot_runs(task_id);
    CREATE INDEX IF NOT EXISTS idx_hamilton_autopilot_profile  ON hamilton_autopilot_runs(profile_id);
    CREATE INDEX IF NOT EXISTS idx_hamilton_autopilot_status   ON hamilton_autopilot_runs(status);
  `)
  ensuredAuthSchema = true
}

function safeJson(val, fallback) {
  if (val === null || val === undefined) return fallback
  if (typeof val === 'object') return val
  try { return JSON.parse(val) } catch { return fallback }
}

function rowToAuth(row) {
  if (!row) return null
  return {
    id: row.id,
    user_id: row.user_id,
    profile_id: row.profile_id,
    scope: row.scope,
    authorization_type: row.authorization_type,
    funding_source_id: row.funding_source_id ?? null,
    task_id: row.task_id ?? null,
    authorization_text: row.authorization_text,
    authorization_version: row.authorization_version,
    options: safeJson(row.options_json, {}),
    metadata: safeJson(row.metadata_json, {}),
    accepted_at: row.accepted_at,
    revoked_at: row.revoked_at ?? null,
    revoked_reason: row.revoked_reason ?? null,
  }
}

function rowToRun(row) {
  if (!row) return null
  return {
    id: row.id,
    task_id: row.task_id,
    profile_id: row.profile_id,
    user_id: row.user_id ?? null,
    authorization_id: row.authorization_id ?? null,
    status: row.status,
    blocker_kind: row.blocker_kind ?? null,
    blocker_detail: row.blocker_detail ?? null,
    preflight: safeJson(row.preflight_json, {}),
    result: safeJson(row.result_json, {}),
    confirmation_reference: row.confirmation_reference ?? null,
    confirmation_screenshot_path: row.confirmation_screenshot_path ?? null,
    started_at: row.started_at ?? null,
    finished_at: row.finished_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

/**
 * Record one or more authorization rows in a single batch. Returns the
 * inserted authorization ids. Idempotency: if an active (non-revoked)
 * authorization for the same (user_id, profile_id, scope, type, target)
 * already exists, we re-stamp `accepted_at`/`options`/`metadata`
 * instead of inserting a duplicate.
 */
export async function recordAuthorizations(db, {
  userId,
  profileId,
  scope = 'task',
  fundingSourceIds = [],
  taskIds = [],
  authorizationTypes = [],
  authorizationText,
  authorizationVersion = 'hamilton-autopilot-v1',
  options = {},
  metadata = {},
  replaceOmittedTypes = false,
} = {}) {
  if (!db) throw new Error('db required')
  if (!userId) throw new Error('userId required')
  if (!profileId) throw new Error('profileId required')
  if (!authorizationText) throw new Error('authorizationText required')
  if (!Array.isArray(authorizationTypes) || authorizationTypes.length === 0) {
    throw new Error('authorizationTypes required')
  }
  for (const t of authorizationTypes) {
    if (!HAMILTON_AUTHORIZATION_TYPES.includes(t)) throw new Error(`invalid authorization_type: ${t}`)
  }
  if (!HAMILTON_AUTHORIZATION_SCOPES.includes(scope)) throw new Error(`invalid scope: ${scope}`)
  await ensureHamiltonAuthorizationSchema(db)

  const targets = scope === 'funding_source' && fundingSourceIds.length > 0
    ? fundingSourceIds.map((id) => ({ funding_source_id: id, task_id: null }))
    : scope === 'task' && taskIds.length > 0
      ? taskIds.map((id) => ({ funding_source_id: null, task_id: id }))
      : [{ funding_source_id: null, task_id: null }]

  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'

  // Self-heal: if the hamilton_authorizations table is missing (prod schema
  // drift — the same class of failure that produced the 500s on this endpoint
  // and `relation "robert_runs" does not exist`), force a fresh schema-ensure
  // and retry once before giving up. ensuredAuthSchema is reset so the cache
  // can't keep masking a table that was never actually created.
  try {
    return await writeAuthorizations()
  } catch (err) {
    if (!isMissingRelationError(err)) throw err
    ensuredAuthSchema = false
    await ensureHamiltonAuthorizationSchema(db)
    return await writeAuthorizations()
  }

  async function writeAuthorizations() {
   const ids = []
   // Who actually performed this write. The row's `user_id` records who accepted
   // the authorization text; when an ADMIN changes an owner's consent the row is
   // updated in place (see the comment below), so the acting principal has to be
   // recorded somewhere or the audit trail loses it entirely.
   const writeMetadata = {
     ...(metadata || {}),
     last_modified_by: String(userId),
     last_modified_at: new Date().toISOString(),
   }
   for (const target of targets) {
    // The authorization screen represents the caller's complete selection for
    // this exact scope/target. When requested by that screen, revoke active
    // capabilities that were omitted instead of leaving a stale grant alive
    // behind an unchecked box. Revocation is fail-closed and preserves the
    // audit row; a later insert failure can remove authority, never widen it.
    // THE WRITE KEY MUST MATCH THE READ KEY. Every reader of this table -
    // listActiveAuthorizations, isAuthorizationActive, readAuthorizations,
    // resolveSubmissionDecision and therefore hasFullAutomation - selects on
    // (profile_id, scope, target) and NEVER on user_id: a profile-scoped consent
    // is a property of the PROFILE, not of whoever happened to click. These two
    // statements used to add `user_id = ?`, so a second principal - an ADMIN
    // operating a profile they do not own, or the owner returning under a
    // different user id - matched nothing: the omitted-type revoke silently
    // updated ZERO rows while the profile-scoped read still returned the
    // original grant, so the toggle snapped straight back on, and the insert
    // below then added a DUPLICATE active row under the new user id. Keying the
    // write the way the read is keyed is what makes "an admin can operate all
    // three toggles" true rather than merely unblocked at the route.
    //
    // `user_id` stays on the row as the record of who ACCEPTED the authorization
    // text; the principal who last changed it is recorded in metadata below.
    if (replaceOmittedTypes) {
      const omitted = HAMILTON_AUTHORIZATION_TYPES.filter((type) => !authorizationTypes.includes(type))
      for (const type of omitted) {
        await db.prepare(
          `UPDATE hamilton_authorizations SET
              revoked_at = ${nowFn}, revoked_reason = ?, updated_at = ${nowFn}
            WHERE profile_id = ? AND scope = ? AND authorization_type = ?
              AND COALESCE(funding_source_id,'') = COALESCE(?, '')
              AND COALESCE(task_id,'') = COALESCE(?, '')
              AND revoked_at IS NULL`,
        ).run(
          'replaced_by_authorization_selection',
          String(profileId), scope, type,
          target.funding_source_id, target.task_id,
        )
      }
    }
    for (const type of authorizationTypes) {
      const existing = await db.prepare(
        `SELECT id FROM hamilton_authorizations
          WHERE profile_id = ? AND scope = ? AND authorization_type = ?
            AND COALESCE(funding_source_id,'') = COALESCE(?, '')
            AND COALESCE(task_id,'') = COALESCE(?, '')
            AND revoked_at IS NULL
          ORDER BY accepted_at DESC
          LIMIT 1`,
      ).get(
        String(profileId), scope, type,
        target.funding_source_id, target.task_id,
      )
      if (existing) {
        await db.prepare(
          `UPDATE hamilton_authorizations SET
              authorization_text = ?, authorization_version = ?,
              options_json = ?, metadata_json = ?,
              accepted_at = ${nowFn}, updated_at = ${nowFn}
            WHERE id = ?`,
        ).run(
          authorizationText, authorizationVersion,
          JSON.stringify(options || {}), JSON.stringify(writeMetadata),
          existing.id,
        )
        ids.push(existing.id)
        continue
      }
      const id = crypto.randomUUID()
      await db.prepare(
        `INSERT INTO hamilton_authorizations
            (id, user_id, profile_id, scope, authorization_type, funding_source_id, task_id,
             authorization_text, authorization_version, options_json, metadata_json,
             accepted_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${nowFn}, ${nowFn}, ${nowFn})`,
      ).run(
        id, String(userId), String(profileId), scope, type,
        target.funding_source_id, target.task_id,
        authorizationText, authorizationVersion,
        JSON.stringify(options || {}), JSON.stringify(metadata || {}),
      )
      ids.push(id)
    }
   }
   return ids
  }
}

/**
 * Check whether a given (profile, type) authorization is active. Looks
 * for any non-revoked row at scope=profile OR scope=funding_source
 * matching `fundingSourceId` OR scope=task matching `taskId`.
 */
export async function isAuthorizationActive(db, {
  profileId,
  authorizationType,
  fundingSourceId = null,
  taskId = null,
} = {}) {
  if (!db || !profileId || !authorizationType) return false
  await ensureHamiltonAuthorizationSchema(db)
  const row = await db.prepare(
    `SELECT id FROM hamilton_authorizations
      WHERE profile_id = ? AND authorization_type = ? AND revoked_at IS NULL
        AND (
          scope = 'profile'
          OR (scope = 'funding_source' AND funding_source_id = ?)
          OR (scope = 'task' AND task_id = ?)
        )
      ORDER BY accepted_at DESC LIMIT 1`,
  ).get(String(profileId), authorizationType, fundingSourceId, taskId)
  return Boolean(row)
}

export async function listActiveAuthorizations(db, { profileId, fundingSourceId = null, taskId = null } = {}) {
  if (!db || !profileId) return []
  await ensureHamiltonAuthorizationSchema(db)
  const rows = await db.prepare(
    `SELECT * FROM hamilton_authorizations
      WHERE profile_id = ? AND revoked_at IS NULL
        AND (
          scope = 'profile'
          OR (scope = 'funding_source' AND funding_source_id = ?)
          OR (scope = 'task' AND task_id = ?)
        )
      ORDER BY accepted_at DESC`,
  ).all(String(profileId), fundingSourceId, taskId)
  return (rows || []).map(rowToAuth)
}

/**
 * Revoke submit authority attached to an exact task or funding source. Profile-
 * wide grants are deliberately left alone; task intent is still cleared by the
 * caller, so a broader grant cannot submit until the user explicitly opts in
 * again. This helper exists for the task-level "Disable auto-submit" action.
 */
export async function revokeTargetAuthorizations(db, {
  profileId,
  authorizationType,
  fundingSourceId = null,
  taskId = null,
  reason = 'target_authorization_revoked',
} = {}) {
  if (!db || !profileId || !authorizationType) return 0
  if (!HAMILTON_AUTHORIZATION_TYPES.includes(authorizationType)) {
    throw new Error(`invalid authorization_type: ${authorizationType}`)
  }
  if (!fundingSourceId && !taskId) return 0
  await ensureHamiltonAuthorizationSchema(db)
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  const result = await db.prepare(
    `UPDATE hamilton_authorizations
        SET revoked_at = ${nowFn}, revoked_reason = ?, updated_at = ${nowFn}
      WHERE profile_id = ? AND authorization_type = ? AND revoked_at IS NULL
        AND (
          (scope = 'funding_source' AND funding_source_id = ?)
          OR (scope = 'task' AND task_id = ?)
        )`,
  ).run(
    reason,
    String(profileId),
    authorizationType,
    fundingSourceId ? String(fundingSourceId) : null,
    taskId ? String(taskId) : null,
  )
  return Number(result?.changes ?? result?.rowCount ?? 0)
}

/**
 * Canonical submission decision. The live task's `allow_auto_submit` field is
 * the sole intent flag; request payloads and the retired
 * `auto_submit_enabled` field are never consulted at the irreversible
 * boundary. The request may set the live task field when a run is enqueued,
 * but clearing that field is then a durable veto even when a broader profile
 * authorization remains active. Authority itself still comes only from a
 * currently-active, persisted `submit_applications` authorization. A stored
 * human-review preference is an unconditional veto. Call this again
 * immediately before the portal click so revocation or disable actions made
 * during a long browser run take effect.
 */
export async function resolveSubmissionDecision(db, {
  profileId,
  fundingSourceId = null,
  taskId = null,
  taskAllowAutoSubmit = false,
} = {}) {
  const active = await listActiveAuthorizations(db, { profileId, fundingSourceId, taskId })
  const submitAuthorization = active.find((row) => row.authorization_type === 'submit_applications') || null
  const requireHumanReview = active.some((row) => row.options?.require_human_review === true)
  // Auto-submit INTENT has two sources, and the toggle is the authoritative one.
  // The per-task `allow_auto_submit` column is a mirror the #1312 full-automation
  // sweep maintains; a task the sweep never reached — a stale backlog row, or one
  // created after the profile toggle flipped on — would otherwise draft forever
  // while the readiness card (`isFullAutomationEnabled`, which reads the
  // authorization's own `allow_auto_submit` option) reports "full automation is
  // on". That contradiction is exactly what stranded 100+ tasks at
  // `waiting_for_review` under an enabled toggle (2026-08-21). Reading intent from
  // the active authorization here makes the gate and the readiness card agree by
  // construction. Every veto still holds below: a `require_human_review` option at
  // any scope, the missing-submit-grant check, the global env kill switch
  // (applied by the caller), and the browser-executable check all still refuse.
  const authorizationAutoSubmit = active.some((row) => row.options?.allow_auto_submit === true)
  const requested = Boolean(taskAllowAutoSubmit) || authorizationAutoSubmit

  let reason = 'authorized'
  if (!requested) reason = 'not_requested'
  else if (!submitAuthorization) reason = 'missing_submit_authorization'
  else if (requireHumanReview) reason = 'human_review_required'

  return {
    allow_auto_submit: requested && Boolean(submitAuthorization) && !requireHumanReview,
    requested,
    authorized: Boolean(submitAuthorization),
    require_human_review: requireHumanReview,
    reason,
    authorization_id: submitAuthorization?.id || null,
    authorization_version: submitAuthorization?.authorization_version || null,
  }
}

// Fetch one authorization by id (includes profile_id for ownership checks
// before revoke). Null when not found.
export async function getAuthorizationById(db, id) {
  if (!db || !id) return null
  await ensureHamiltonAuthorizationSchema(db)
  const row = await db.prepare('SELECT * FROM hamilton_authorizations WHERE id = ?').get(String(id))
  return row ? rowToAuth(row) : null
}

export async function revokeAuthorization(db, { id, reason = null } = {}) {
  if (!db || !id) return null
  await ensureHamiltonAuthorizationSchema(db)
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  await db.prepare(
    `UPDATE hamilton_authorizations
        SET revoked_at = ${nowFn}, revoked_reason = ?, updated_at = ${nowFn}
      WHERE id = ?`,
  ).run(reason ?? null, String(id))
  const row = await db.prepare('SELECT * FROM hamilton_authorizations WHERE id = ?').get(String(id))
  return rowToAuth(row)
}

// ── Autopilot run ledger ────────────────────────────────────────────

/**
 * Every status the autopilot run ledger may hold. This is the SINGLE list the
 * Postgres CHECK constraint (`0185_hamilton_autopilot_run_statuses.sql`) and
 * `schema.sql` mirror — a static test (`hamiltonAutopilotRunStatusLockstep`)
 * fails when any of the three drift.
 *
 * WHY THIS EXISTS (2026-08-22, prod): the orchestrator wrote
 * `submit_attempt_started` at the irreversible click boundary, the table's
 * CHECK only knew the original eight statuses, Postgres rejected the row, and
 * Hamilton fail-closed into `submission_verification_required` on EVERY live
 * submit (4 real tasks that night). The SQLite test schema in `ensure…Schema`
 * below carries no CHECK, so no test could see it. Validating here makes the
 * failure a named error in every dialect instead of a prod-only constraint.
 */
export const AUTOPILOT_RUN_STATUSES = Object.freeze([
  'queued', 'preflight', 'running', 'blocked', 'completed', 'submitted',
  'failed', 'cancelled',
  // Scheduling / retry.
  'deferred',
  // Irreversible-submission boundary ledger.
  'submit_attempt_started', 'submit_evidence_pending', 'submission_verification_required',
])

function assertRunStatus(status) {
  if (!AUTOPILOT_RUN_STATUSES.includes(status)) {
    throw new Error(`invalid autopilot run status: ${String(status)} (allowed: ${AUTOPILOT_RUN_STATUSES.join(', ')})`)
  }
}

/**
 * JSON for a Postgres TEXT column. Postgres rejects a NUL byte anywhere in a
 * text value ("invalid byte sequence for encoding UTF8: 0x00") and a page
 * snapshot scraped from a portal can carry one; a circular reference or a
 * BigInt from a library object would throw in JSON.stringify. Either failure
 * used to be an uncaught rejection that left the run `running` forever with no
 * trace. The ledger must always be writable: drop what cannot be serialised,
 * never the row.
 */
export function serializeRunJson(value, fallback = '{}') {
  const seen = new WeakSet()
  let out
  try {
    out = JSON.stringify(value ?? {}, (_k, v) => {
      if (typeof v === 'bigint') return v.toString()
      if (typeof v === 'string') return v.includes(' ') ? v.split(' ').join('') : v
      if (v && typeof v === 'object') {
        if (seen.has(v)) return '[circular]'
        seen.add(v)
      }
      return v
    })
  } catch (err) {
    out = JSON.stringify({ serialization_error: String(err?.message || err).slice(0, 200) })
  }
  return out === undefined ? fallback : out
}

export async function createAutopilotRun(db, {
  taskId, profileId, userId = null, authorizationId = null,
  preflight = {}, status = 'queued',
} = {}) {
  if (!db || !taskId || !profileId) throw new Error('taskId and profileId required')
  assertRunStatus(status)
  await ensureHamiltonAuthorizationSchema(db)
  const id = crypto.randomUUID()
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  await db.prepare(
    `INSERT INTO hamilton_autopilot_runs
        (id, task_id, profile_id, user_id, authorization_id, status, preflight_json, started_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ${nowFn}, ${nowFn}, ${nowFn})`,
  ).run(
    id, String(taskId), String(profileId), userId, authorizationId, status,
    serializeRunJson(preflight || {}),
  )
  const row = await db.prepare('SELECT * FROM hamilton_autopilot_runs WHERE id = ?').get(id)
  return rowToRun(row)
}

export async function updateAutopilotRun(db, runId, patch = {}) {
  if (!db || !runId) return null
  await ensureHamiltonAuthorizationSchema(db)
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  const sets = [`updated_at = ${nowFn}`]
  const params = []
  if (patch.status !== undefined) { assertRunStatus(patch.status); sets.push('status = ?'); params.push(patch.status) }
  if (patch.authorizationId !== undefined) { sets.push('authorization_id = ?'); params.push(patch.authorizationId ?? null) }
  if (patch.blockerKind !== undefined) { sets.push('blocker_kind = ?'); params.push(patch.blockerKind ?? null) }
  if (patch.blockerDetail !== undefined) { sets.push('blocker_detail = ?'); params.push(patch.blockerDetail ?? null) }
  if (patch.preflight !== undefined) { sets.push('preflight_json = ?'); params.push(serializeRunJson(patch.preflight ?? {})) }
  if (patch.result !== undefined) { sets.push('result_json = ?'); params.push(serializeRunJson(patch.result ?? {})) }
  if (patch.confirmationReference !== undefined) { sets.push('confirmation_reference = ?'); params.push(patch.confirmationReference ?? null) }
  if (patch.confirmationScreenshotPath !== undefined) { sets.push('confirmation_screenshot_path = ?'); params.push(patch.confirmationScreenshotPath ?? null) }
  if (patch.finishedAt !== undefined) { sets.push('finished_at = ?'); params.push(patch.finishedAt ?? null) }
  if (sets.length === 1) return await getAutopilotRun(db, runId)
  params.push(String(runId))
  await db.prepare(`UPDATE hamilton_autopilot_runs SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  return await getAutopilotRun(db, runId)
}

export async function getAutopilotRun(db, runId) {
  if (!db || !runId) return null
  const row = await db.prepare('SELECT * FROM hamilton_autopilot_runs WHERE id = ?').get(String(runId))
  return rowToRun(row)
}

export async function listAutopilotRuns(db, { profileId = null, taskId = null, limit = 100 } = {}) {
  await ensureHamiltonAuthorizationSchema(db)
  let sql = 'SELECT * FROM hamilton_autopilot_runs WHERE 1=1'
  const params = []
  if (profileId) { sql += ' AND profile_id = ?'; params.push(String(profileId)) }
  if (taskId) { sql += ' AND task_id = ?'; params.push(String(taskId)) }
  sql += ' ORDER BY created_at DESC LIMIT ?'
  params.push(Math.max(1, Math.min(500, Number(limit) || 100)))
  const rows = await db.prepare(sql).all(...params)
  return (rows || []).map(rowToRun)
}
