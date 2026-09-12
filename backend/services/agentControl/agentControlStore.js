/**
 * agentControlStore.js
 *
 * Persistence layer for the Admin Agent Control Center. Wraps the five
 * `agent_control_*` tables introduced in migration 091 (SQLite) /
 * 0087 (Postgres):
 *
 *   - agent_control_runs            top-level orchestration runs
 *   - agent_control_steps           one row per agent step in a run
 *   - agent_control_events          full audit timeline
 *   - agent_control_locks           single-flight enforcement
 *   - agent_control_stop_requests   durable stop/pause/resume requests
 *
 * Every write is idempotent and tolerates "table missing" errors so
 * unit tests using ad-hoc SQLite stubs without the migration applied
 * still load. Read helpers always return arrays / null instead of
 * throwing on missing tables — the orchestrator catches errors anyway,
 * but keeping the store quiet keeps logs uncluttered.
 *
 * Stop requests are stored, not held in memory. The orchestrator polls
 * `latestUnfulfilledStop(...)` between atomic operations; this means
 * a stop survives process restarts and the UI can immediately show
 * "stopping" while the agent finishes its current unit of work.
 */

import crypto from 'node:crypto'
import os from 'node:os'
import {
  ALL_AGENTS,
  CANONICAL_ADMIN_EMAIL_DEFAULT,
  RUN_TYPES,
  RUN_STATUSES,
  STEP_STATUSES,
} from './agentControlTypes.js'

const ID = () => crypto.randomUUID()
const NOW = () => new Date().toISOString()

// A boot id unique to THIS process. Node caches ES modules per process, so
// every importer of this file within the same Railway container / test worker
// sees the identical value — it is the process's identity for lock-holder
// liveness tracking (see "Locks" section below).
const INSTANCE_ID = crypto.randomUUID()
export function getInstanceId() {
  return INSTANCE_ID
}

function safeHostname() {
  try {
    return os.hostname()
  } catch {
    return null
  }
}

let schemaCache = new WeakMap()

/**
 * Best-effort one-time schema bootstrap. Any error is swallowed because
 * production code paths run after migrations; tests pass an in-memory
 * SQLite that already has these tables. This is a defensive net only.
 */
export async function ensureSchema(db) {
  if (!db || typeof db.prepare !== 'function') return
  if (schemaCache.has(db)) return
  // Cache only after every required CREATE succeeds. A transient DDL failure
  // must remain retryable; marking the handle ready before the work ran made a
  // partially-created schema sticky for the lifetime of the process.
  let schemaComplete = true
  const isPostgres = db?.dialect === 'postgres'
  const tsType = isPostgres ? 'TIMESTAMPTZ' : 'DATETIME'
  const idDefault = isPostgres ? 'gen_random_uuid()::text' : "lower(hex(randomblob(16)))"
  const ddl = [
    `CREATE TABLE IF NOT EXISTS agent_control_runs (
      id TEXT PRIMARY KEY DEFAULT (${idDefault}),
      run_name TEXT,
      run_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      started_by_user_id TEXT,
      started_by_email TEXT,
      admin_email TEXT NOT NULL DEFAULT '${CANONICAL_ADMIN_EMAIL_DEFAULT}',
      requested_agents_json TEXT NOT NULL DEFAULT '[]',
      options_json TEXT NOT NULL DEFAULT '{}',
      cancellation_requested_at ${tsType},
      pause_requested_at ${tsType},
      resume_requested_at ${tsType},
      started_at ${tsType},
      completed_at ${tsType},
      error_message TEXT,
      summary_json TEXT,
      created_at ${tsType} DEFAULT ${isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'},
      updated_at ${tsType} DEFAULT ${isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'}
    )`,
    `CREATE TABLE IF NOT EXISTS agent_control_steps (
      id TEXT PRIMARY KEY DEFAULT (${idDefault}),
      control_run_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      step_name TEXT NOT NULL,
      step_order INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'queued',
      started_at ${tsType},
      completed_at ${tsType},
      heartbeat_at ${tsType},
      cancellation_checked_at ${tsType},
      progress_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT,
      error_message TEXT,
      created_at ${tsType} DEFAULT ${isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'},
      updated_at ${tsType} DEFAULT ${isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'}
    )`,
    `CREATE TABLE IF NOT EXISTS agent_control_events (
      id TEXT PRIMARY KEY DEFAULT (${idDefault}),
      control_run_id TEXT,
      step_id TEXT,
      agent_name TEXT,
      event_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      message TEXT,
      data_json TEXT NOT NULL DEFAULT '{}',
      created_at ${tsType} DEFAULT ${isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'}
    )`,
    `CREATE TABLE IF NOT EXISTS agent_control_locks (
      id TEXT PRIMARY KEY DEFAULT (${idDefault}),
      lock_name TEXT NOT NULL UNIQUE,
      control_run_id TEXT NOT NULL,
      owner_token TEXT,
      acquired_by TEXT,
      acquired_at ${tsType} DEFAULT ${isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'},
      expires_at ${tsType},
      holder_instance_id TEXT
    )`,
    // Lightweight per-process liveness ledger. A lock row records which
    // instance acquired it (holder_instance_id); this table is the ONLY
    // source of truth for whether that instance is still alive, independent
    // of the lock's own TTL — see acquireLock()'s stale-holder takeover.
    `CREATE TABLE IF NOT EXISTS agent_control_instances (
      instance_id TEXT PRIMARY KEY,
      pid INTEGER,
      hostname TEXT,
      started_at ${tsType} DEFAULT ${isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'},
      last_heartbeat_at ${tsType} DEFAULT ${isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'},
      updated_at ${tsType} DEFAULT ${isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'}
    )`,
    `CREATE TABLE IF NOT EXISTS agent_control_stop_requests (
      id TEXT PRIMARY KEY DEFAULT (${idDefault}),
      control_run_id TEXT NOT NULL,
      agent_name TEXT,
      requested_by_email TEXT,
      requested_by_user_id TEXT,
      request_type TEXT NOT NULL,
      reason TEXT,
      fulfilled_at ${tsType},
      created_at ${tsType} DEFAULT ${isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'}
    )`,
    // Persisted per-agent settings (KV). Holds owner-flipped Control-Center
    // toggles (e.g. 'anya.autonomous_enabled') so they survive restarts.
    `CREATE TABLE IF NOT EXISTS agent_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_by_email TEXT,
      updated_at ${tsType} DEFAULT ${isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'}
    )`,
  ]
  for (const sql of ddl) {
    try {
      if (typeof db.exec === 'function') {
        await db.exec(sql)
      } else {
        await db.prepare(sql).run()
      }
    } catch {
      // Keep the bootstrap best-effort for ad-hoc test handles, but do not
      // cache an incomplete attempt. The next real store operation retries.
      schemaComplete = false
    }
  }

  // Defensive column add for lock fencing. A lock table created by the
  // original migration (091 / 0087) has no `owner_token`; this self-heals
  // it so a process can release only the lock it actually owns. SQLite has
  // no `ADD COLUMN IF NOT EXISTS`, so we lean on try/catch for both dialects.
  const alterOwnerToken = isPostgres
    ? `ALTER TABLE agent_control_locks ADD COLUMN IF NOT EXISTS owner_token TEXT`
    : `ALTER TABLE agent_control_locks ADD COLUMN owner_token TEXT`
  try {
    if (typeof db.exec === 'function') {
      await db.exec(alterOwnerToken)
    } else {
      await db.prepare(alterOwnerToken).run()
    }
  } catch {
    // column already exists; ignore.
  }

  // Defensive column add for the stale-lock-reclaim holder identity. A lock
  // table created before this fix has no `holder_instance_id`; self-heal it
  // the same way owner_token was self-healed above.
  const alterHolderInstanceId = isPostgres
    ? `ALTER TABLE agent_control_locks ADD COLUMN IF NOT EXISTS holder_instance_id TEXT`
    : `ALTER TABLE agent_control_locks ADD COLUMN holder_instance_id TEXT`
  try {
    if (typeof db.exec === 'function') {
      await db.exec(alterHolderInstanceId)
    } else {
      await db.prepare(alterHolderInstanceId).run()
    }
  } catch {
    // column already exists; ignore.
  }

  // Self-heal the agent_control_runs status CHECK so newly-added statuses
  // (e.g. 'completed_noop' — the honest "ran but did no real work" outcome) are
  // accepted on a prod DB created by the original migration. Driven from
  // RUN_STATUSES so it can never drift. Postgres only — the CREATE TABLE IF NOT
  // EXISTS above carries no CHECK, so SQLite test DBs accept any status.
  if (isPostgres) {
    const statusList = RUN_STATUSES.map((s) => `'${String(s).replace(/'/g, "''")}'`).join(', ')
    try {
      await db.exec(`ALTER TABLE agent_control_runs DROP CONSTRAINT IF EXISTS agent_control_runs_status_check`)
      await db.exec(`ALTER TABLE agent_control_runs ADD CONSTRAINT agent_control_runs_status_check CHECK (status IN (${statusList}))`)
    } catch (err) {
      if (!/already exists|does not exist/i.test(String(err?.message || err))) throw err
    }
  }
  if (schemaComplete) schemaCache.set(db, true)
}

export function _resetSchemaCache() {
  schemaCache = new WeakMap()
}

// ---------------------------------------------------------------------------
// Persisted agent settings (KV) — owner-flipped Control-Center toggles.
// ---------------------------------------------------------------------------

/** Read a persisted agent setting. Returns the string value, or null if unset. */
export async function getAgentSetting(db, key) {
  if (!db || typeof db.prepare !== 'function' || !key) return null
  await ensureSchema(db)
  try {
    const row = await db.prepare('SELECT value FROM agent_settings WHERE key = ?').get(String(key))
    return row && row.value !== undefined ? (row.value ?? null) : null
  } catch {
    return null
  }
}

/** Upsert a persisted agent setting (value stored as text). Cross-dialect (no ON CONFLICT). */
export async function setAgentSetting(db, key, value, { updatedByEmail = null } = {}) {
  if (!db || typeof db.prepare !== 'function' || !key) return false
  await ensureSchema(db)
  const v = value === null || value === undefined ? null : String(value)
  const email = (updatedByEmail || '').toLowerCase() || null
  const now = NOW()
  const result = await db
    .prepare('UPDATE agent_settings SET value = ?, updated_by_email = ?, updated_at = ? WHERE key = ?')
    .run(v, email, now, String(key))
  const changed = Number(result?.changes ?? result?.rowCount ?? 0)
  if (!changed) {
    try {
      await db
        .prepare('INSERT INTO agent_settings (key, value, updated_by_email, updated_at) VALUES (?, ?, ?, ?)')
        .run(String(key), v, email, now)
    } catch {
      // Lost an insert race on the PK — the row now exists, so update it.
      await db
        .prepare('UPDATE agent_settings SET value = ?, updated_by_email = ?, updated_at = ? WHERE key = ?')
        .run(v, email, now, String(key))
    }
  }
  return true
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------
function safeStringify(value) {
  if (value === null || value === undefined) return null
  try {
    return typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    return null
  }
}

function safeParse(value, fallback = {}) {
  if (value === null || value === undefined) return fallback
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function row(rowObj) {
  if (!rowObj) return null
  const out = { ...rowObj }
  if (out.requested_agents_json !== undefined) {
    out.requested_agents = safeParse(out.requested_agents_json, [])
  }
  if (out.options_json !== undefined) {
    out.options = safeParse(out.options_json, {})
  }
  if (out.summary_json !== undefined) {
    out.summary = safeParse(out.summary_json, null)
  }
  if (out.progress_json !== undefined) {
    out.progress = safeParse(out.progress_json, {})
  }
  if (out.result_json !== undefined) {
    out.result = safeParse(out.result_json, null)
  }
  if (out.data_json !== undefined) {
    out.data = safeParse(out.data_json, {})
  }
  return out
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------
export async function createRun(db, {
  runType,
  runName = null,
  startedByUserId = null,
  startedByEmail = null,
  adminEmail = CANONICAL_ADMIN_EMAIL_DEFAULT,
  requestedAgents = [],
  options = {},
  status = 'queued',
} = {}) {
  if (!db) throw new Error('createRun: db required')
  if (!RUN_TYPES.includes(runType)) {
    throw new Error(`createRun: invalid runType "${runType}"`)
  }
  await ensureSchema(db)
  const id = ID()
  const now = NOW()
  const agents = Array.isArray(requestedAgents)
    ? requestedAgents.filter((a) => ALL_AGENTS.includes(String(a).toLowerCase()))
    : []
  await db
    .prepare(`
      INSERT INTO agent_control_runs (
        id, run_name, run_type, status,
        started_by_user_id, started_by_email, admin_email,
        requested_agents_json, options_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      id,
      runName || null,
      runType,
      status,
      startedByUserId || null,
      (startedByEmail || '').toLowerCase() || null,
      String(adminEmail || CANONICAL_ADMIN_EMAIL_DEFAULT).toLowerCase(),
      safeStringify(agents) || '[]',
      safeStringify(options) || '{}',
      now,
      now,
    )
  return id
}

export async function setRunStatus(db, runId, status, extra = {}) {
  if (!db || !runId) return
  if (!RUN_STATUSES.includes(status)) {
    throw new Error(`setRunStatus: invalid status "${status}"`)
  }

  // State-machine guard: refuse to transition OUT of a terminal state.
  // This is the safety net for the historical regression where
  // cancelRun() set 'cancelled' but executeRun() then overwrote it with
  // 'stopped', silently losing the user intent. After consulting
  // agentRunStateMachine.canDirectSet, an unsafe write becomes a no-op
  // and gets logged so the next person sees what happened.
  try {
    const { canDirectSet } = await import('./agentRunStateMachine.js')
    const currentRow = await db
      .prepare('SELECT status FROM agent_control_runs WHERE id = ? LIMIT 1')
      .get(runId)
    const current = currentRow?.status || null
    if (current) {
      const decision = canDirectSet(current, status)
      if (!decision.ok) {
        // No-op: keep the terminal state; emit a warn so it's visible.
        // Do NOT throw — legacy callers still rely on best-effort
        // semantics, and a thrown error here would crash the
        // orchestrator's fire-and-forget execute path.
        console.warn(
          `[agent-control] setRunStatus refused: runId=${runId} from='${current}' to='${status}' reason='${decision.reason}'`,
        )
        return
      }
    }
  } catch (smErr) {
    // State machine import or DB read failed — fall through to the
    // raw write so we don't block boot/legacy paths if the module
    // can't be loaded for any reason.
    console.warn(
      `[agent-control] setRunStatus state-machine check skipped (non-fatal): ${smErr?.message || smErr}`,
    )
  }

  const now = NOW()
  const fields = ['status = ?', 'updated_at = ?']
  const args = [status, now]

  if (status === 'running' && extra.startedAt !== false) {
    fields.push('started_at = COALESCE(started_at, ?)')
    args.push(now)
  }
  if (['completed', 'completed_noop', 'failed', 'cancelled', 'stopped', 'partial_stop', 'stop_failed'].includes(status)) {
    fields.push('completed_at = COALESCE(completed_at, ?)')
    args.push(now)
  }
  if (extra.errorMessage !== undefined) {
    fields.push('error_message = ?')
    args.push(extra.errorMessage || null)
  }
  if (extra.summary !== undefined) {
    fields.push('summary_json = ?')
    args.push(safeStringify(extra.summary))
  }
  if (extra.cancellationRequestedAt) {
    fields.push('cancellation_requested_at = COALESCE(cancellation_requested_at, ?)')
    args.push(extra.cancellationRequestedAt)
  }
  if (extra.pauseRequestedAt) {
    fields.push('pause_requested_at = ?')
    args.push(extra.pauseRequestedAt)
  }
  if (extra.resumeRequestedAt) {
    fields.push('resume_requested_at = ?')
    args.push(extra.resumeRequestedAt)
  }

  args.push(runId)
  await db
    .prepare(`UPDATE agent_control_runs SET ${fields.join(', ')} WHERE id = ?`)
    .run(...args)
}

export async function getRun(db, runId) {
  if (!db || !runId) return null
  try {
    const r = await db
      .prepare('SELECT * FROM agent_control_runs WHERE id = ? LIMIT 1')
      .get(runId)
    return row(r)
  } catch {
    return null
  }
}

export async function listRuns(db, { limit = 50, runType = null, status = null } = {}) {
  if (!db) return []
  const where = []
  const args = []
  if (runType) { where.push('run_type = ?'); args.push(runType) }
  if (status) { where.push('status = ?'); args.push(status) }
  const sql = `
    SELECT * FROM agent_control_runs
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY COALESCE(started_at, created_at) DESC
    LIMIT ?
  `
  args.push(Math.max(1, Math.min(200, Number(limit) || 50)))
  try {
    const rows = await db.prepare(sql).all(...args)
    return Array.isArray(rows) ? rows.map(row) : []
  } catch {
    return []
  }
}

/**
 * Returns the in-flight run (running / pausing / stopping / paused). Used
 * by the status endpoint and by lock-acquisition checks.
 */
export async function getActiveRun(db) {
  if (!db) return null
  try {
    const r = await db
      .prepare(`
        SELECT * FROM agent_control_runs
        WHERE status IN ('queued','running','pausing','paused','stopping')
        ORDER BY COALESCE(started_at, created_at) DESC
        LIMIT 1
      `)
      .get()
    return row(r)
  } catch {
    return null
  }
}

// A "Last failure" older than this, OR superseded by a more recent success, is
// stale: it must not be presented as the system's CURRENT/standing failure
// (the 6/18 "Could not acquire lock" still showing on a clean 6/22 run). It is
// still RETURNED (with stale flags) so history is auditable — the consumer
// decides whether to show it muted / hidden.
const STALE_FAILURE_TTL_MS = 24 * 60 * 60 * 1000 // 24h

function failureTimestamp(run) {
  return run?.completed_at || run?.started_at || run?.created_at || null
}

/**
 * Latest terminal run of each kind, used by Mission Control summary.
 *
 * The `last_failure` is annotated so the UI never presents a long-stale
 * failure as the standing one:
 *   - `last_failure_is_stale`  true when older than STALE_FAILURE_TTL_MS OR
 *                              when a success has occurred since it.
 *   - `last_failure_age_hours` age of the failure in whole hours.
 *   - `last_failure_superseded_by_success` true when last_success is newer.
 */
export async function getRunHighlights(db) {
  const empty = {
    last: null,
    last_full_cycle: null,
    last_success: null,
    last_failure: null,
    last_failure_is_stale: false,
    last_failure_age_hours: null,
    last_failure_superseded_by_success: false,
  }
  if (!db) return empty
  try {
    const last = await db
      .prepare(`SELECT * FROM agent_control_runs ORDER BY COALESCE(started_at, created_at) DESC LIMIT 1`)
      .get()
    const last_full_cycle = await db
      .prepare(`SELECT * FROM agent_control_runs WHERE run_type IN ('full_cycle','scheduled_cycle') ORDER BY COALESCE(started_at, created_at) DESC LIMIT 1`)
      .get()
    const last_success = await db
      .prepare(`SELECT * FROM agent_control_runs WHERE status IN ('completed','completed_noop') ORDER BY COALESCE(completed_at, started_at, created_at) DESC LIMIT 1`)
      .get()
    const last_failure = await db
      .prepare(`SELECT * FROM agent_control_runs WHERE status IN ('failed','stop_failed','partial_stop') ORDER BY COALESCE(completed_at, started_at, created_at) DESC LIMIT 1`)
      .get()

    const failureRow = row(last_failure)
    const successRow = row(last_success)

    let isStale = false
    let ageHours = null
    let supersededBySuccess = false
    if (failureRow) {
      const failTs = failureTimestamp(failureRow)
      const failMs = failTs ? new Date(failTs).getTime() : null
      if (Number.isFinite(failMs)) {
        ageHours = Math.max(0, Math.floor((Date.now() - failMs) / (60 * 60 * 1000)))
        if (Date.now() - failMs > STALE_FAILURE_TTL_MS) isStale = true
      }
      const succTs = successRow ? failureTimestamp(successRow) : null
      const succMs = succTs ? new Date(succTs).getTime() : null
      if (Number.isFinite(succMs) && Number.isFinite(failMs) && succMs >= failMs) {
        supersededBySuccess = true
        isStale = true
      }
    }

    return {
      last: row(last),
      last_full_cycle: row(last_full_cycle),
      last_success: successRow,
      last_failure: failureRow,
      last_failure_is_stale: isStale,
      last_failure_age_hours: ageHours,
      last_failure_superseded_by_success: supersededBySuccess,
    }
  } catch {
    return empty
  }
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------
export async function createSteps(db, runId, steps = []) {
  if (!db || !runId || !Array.isArray(steps) || steps.length === 0) return []
  await ensureSchema(db)
  const now = NOW()
  const ids = []
  for (let i = 0; i < steps.length; i += 1) {
    const s = steps[i]
    const id = ID()
    ids.push(id)
    await db
      .prepare(`
        INSERT INTO agent_control_steps (
          id, control_run_id, agent_name, step_name, step_order,
          status, progress_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        runId,
        String(s.agentName || s.agent_name || '').toLowerCase(),
        String(s.stepName || s.step_name || ''),
        Number.isFinite(s.stepOrder ?? s.step_order) ? Number(s.stepOrder ?? s.step_order) : i,
        s.status || 'queued',
        safeStringify(s.progress || {}) || '{}',
        now,
        now,
      )
  }
  return ids
}

export async function setStepStatus(db, stepId, status, extra = {}) {
  if (!db || !stepId) return
  if (!STEP_STATUSES.includes(status)) {
    throw new Error(`setStepStatus: invalid status "${status}"`)
  }
  const now = NOW()
  const fields = ['status = ?', 'updated_at = ?']
  const args = [status, now]
  if (status === 'running' && extra.startedAt !== false) {
    fields.push('started_at = COALESCE(started_at, ?)')
    args.push(now)
  }
  if (['completed', 'failed', 'stopped', 'skipped', 'blocked'].includes(status)) {
    fields.push('completed_at = COALESCE(completed_at, ?)')
    args.push(now)
  }
  if (extra.heartbeatAt !== undefined) {
    fields.push('heartbeat_at = ?')
    args.push(extra.heartbeatAt || now)
  }
  if (extra.checkedAt !== undefined) {
    fields.push('cancellation_checked_at = ?')
    args.push(extra.checkedAt || now)
  }
  if (extra.progress !== undefined) {
    fields.push('progress_json = ?')
    args.push(safeStringify(extra.progress) || '{}')
  }
  if (extra.result !== undefined) {
    fields.push('result_json = ?')
    args.push(safeStringify(extra.result))
  }
  if (extra.errorMessage !== undefined) {
    fields.push('error_message = ?')
    args.push(extra.errorMessage || null)
  }
  args.push(stepId)
  await db
    .prepare(`UPDATE agent_control_steps SET ${fields.join(', ')} WHERE id = ?`)
    .run(...args)
}

export async function listSteps(db, runId) {
  if (!db || !runId) return []
  try {
    const rows = await db
      .prepare('SELECT * FROM agent_control_steps WHERE control_run_id = ? ORDER BY step_order ASC, created_at ASC')
      .all(runId)
    return Array.isArray(rows) ? rows.map(row) : []
  } catch {
    return []
  }
}

export async function heartbeat(db, stepId, progress = null) {
  if (!db || !stepId) return
  const now = NOW()
  const fields = ['heartbeat_at = ?', 'updated_at = ?']
  const args = [now, now]
  if (progress !== null && progress !== undefined) {
    fields.push('progress_json = ?')
    args.push(safeStringify(progress) || '{}')
  }
  args.push(stepId)
  try {
    await db
      .prepare(`UPDATE agent_control_steps SET ${fields.join(', ')} WHERE id = ?`)
      .run(...args)
  } catch {
    // ignore — heartbeats are best-effort
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
export async function recordEvent(db, {
  controlRunId = null,
  stepId = null,
  agentName = null,
  eventType,
  severity = 'info',
  message = null,
  data = {},
} = {}) {
  if (!db || !eventType) return null
  await ensureSchema(db)
  const id = ID()
  try {
    await db
      .prepare(`
        INSERT INTO agent_control_events (
          id, control_run_id, step_id, agent_name,
          event_type, severity, message, data_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        controlRunId || null,
        stepId || null,
        agentName ? String(agentName).toLowerCase() : null,
        String(eventType),
        ['critical', 'high', 'medium', 'low', 'info'].includes(severity) ? severity : 'info',
        message ? String(message) : null,
        safeStringify(data) || '{}',
      )
    return id
  } catch {
    // best-effort
    return null
  }
}

export async function listEvents(db, runId, { limit = 200, severity = null, eventType = null } = {}) {
  if (!db || !runId) return []
  const where = ['control_run_id = ?']
  const args = [runId]
  if (severity) { where.push('severity = ?'); args.push(severity) }
  if (eventType) { where.push('event_type = ?'); args.push(eventType) }
  args.push(Math.max(1, Math.min(2000, Number(limit) || 200)))
  try {
    const rows = await db
      .prepare(`
        SELECT * FROM agent_control_events
        WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC
        LIMIT ?
      `)
      .all(...args)
    return Array.isArray(rows) ? rows.map(row) : []
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Locks (single-flight) — TTL'd, fenced, self-healing
// ---------------------------------------------------------------------------
//
// Every lock carries:
//   - an `expires_at` TTL so a crashed/restarted holder can never wedge the
//     system: the row self-heals once the deadline passes,
//   - a unique `owner_token` per acquisition so a process releases only the
//     lock it actually holds (a stale late-release can't free a successor's
//     lock),
//   - a `holder_instance_id` (this process's boot id) so a DIFFERENT holder
//     process's death can be detected and reclaimed WITHOUT waiting for the
//     lock's own TTL — see "Stale-holder reclaim" below,
//   - structured `[agent-control][lock]` logging on every acquire / takeover /
//     contention / release / sweep so contention is observable in prod logs.
//
// The acquire path is: sweep expired → INSERT (UNIQUE gives mutual exclusion)
// → on conflict, atomically take over IFF the existing row is expired OR its
// holder's instance is provably dead → else it's genuinely held, so log
// contention and (optionally) back off and retry.
//
// STALE-HOLDER RECLAIM (2026-09-12). A long-lived lock (e.g. Amy's 15-minute
// scheduler lease) is renewed by its live holder every ttlMs/3
// (schedulerLock.js heartbeat), which means a Railway redeploy/restart that
// kills the holder mid-run can leave `expires_at` pushed minutes into the
// future by the LAST renewal before death — the new process then reads
// `acquire.contended` / `lock_held` and cannot start Amy for up to the
// remaining TTL (measured in prod: up to ~40 minutes). The lock's TTL alone
// cannot tell "still running" apart from "died right after renewing".
//
// `agent_control_instances` is an independent liveness ledger: every process
// heartbeats its OWN row on a short interval (INSTANCE_HEARTBEAT_INTERVAL_MS),
// regardless of which locks (if any) it holds. `acquireLock()` may take over a
// contended lock — bypassing its TTL — the moment the recorded holder's
// instance heartbeat is older than INSTANCE_STALE_MS, or the instance row does
// not exist at all (pruned, or never registered). A LIVE holder's heartbeat is
// always fresh, so mutual exclusion across multiple concurrently-running
// instances is unaffected — this only shortens recovery after a holder is
// actually gone. A lock row with no `holder_instance_id` (written before this
// migration, or by a caller that opts out) falls back to the original
// TTL-only behavior.

// Hard ceiling fallback when a caller passes no TTL. Real callers pass a TTL
// derived from the run's max_runtime_minutes; this is just a backstop so a
// missing TTL can never mean "never expires".
const DEFAULT_LOCK_TTL_MS = 60 * 60 * 1000 // 1h
const MIN_LOCK_TTL_MS = 60_000             // 1m floor
const LOCK_TOKEN = () => crypto.randomUUID()

// A holder instance with no heartbeat newer than this is treated as dead for
// takeover purposes. Chosen well below every real lock TTL (Amy's is 15m) so
// a dead holder is reclaimed in roughly a minute instead of waiting out the
// TTL, while comfortably clearing the heartbeat interval below with margin
// for a slow tick or a transient DB hiccup.
const INSTANCE_STALE_MS = 90_000 // 90s
// How often a live process refreshes its own liveness row. Kept well under
// INSTANCE_STALE_MS (3-4 heartbeats of slack) so a single missed tick can
// never read as dead.
const INSTANCE_HEARTBEAT_INTERVAL_MS = 20_000 // 20s
// Liveness rows older than this are pruned (a boot/redeploy history's worth
// of dead instances must not accumulate forever). Deliberately much larger
// than INSTANCE_STALE_MS — anything this old is unambiguously gone, and any
// lock still pointing at it is already reclaimable via the NOT EXISTS branch.
const INSTANCE_DEAD_PRUNE_MS = 24 * 60 * 60 * 1000 // 24h

/**
 * Single-line, greppable structured log for lock events (acquire / takeover /
 * contention / release / sweep). Routed through console.warn because the lock
 * subsystem is low-frequency (agent runs are occasional) and these lines are
 * the breadcrumbs for diagnosing any future contention. Best-effort — logging
 * must never throw and never affect lock correctness.
 */
function lockLog(event, fields = {}) {
  try {
    const parts = Object.entries(fields)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')
    console.warn(`[agent-control][lock] ${event}${parts ? ` ${parts}` : ''}`)
  } catch { /* logging must never throw */ }
}

/**
 * Upsert this (or a given) instance's liveness row. Update-then-insert so it
 * works identically on SQLite and Postgres without relying on ON CONFLICT.
 * Best-effort: a failure here must never block lock acquisition, so callers
 * treat a `false` return as "heartbeat unavailable this tick", not fatal.
 */
export async function heartbeatInstance(db, instanceId = getInstanceId()) {
  if (!db || !instanceId) return false
  await ensureSchema(db)
  const now = NOW()
  try {
    const res = await db
      .prepare(`UPDATE agent_control_instances SET last_heartbeat_at = ?, updated_at = ? WHERE instance_id = ?`)
      .run(now, now, String(instanceId))
    if (Number(res?.changes || res?.rowCount || 0) > 0) return true
  } catch {
    // fall through and try to (re)create the row below
  }
  try {
    await db
      .prepare(`
        INSERT INTO agent_control_instances (instance_id, pid, hostname, started_at, last_heartbeat_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(String(instanceId), Number.isFinite(process.pid) ? process.pid : null, safeHostname(), now, now, now)
    return true
  } catch {
    // Lost an insert race (another tick/process created it first) — the row
    // now exists; update it so the heartbeat still lands this tick.
    try {
      const res = await db
        .prepare(`UPDATE agent_control_instances SET last_heartbeat_at = ?, updated_at = ? WHERE instance_id = ?`)
        .run(now, now, String(instanceId))
      return Number(res?.changes ?? res?.rowCount ?? 0) > 0
    } catch {
      return false
    }
  }
}

/** Read one instance's liveness row (diagnostic / test use). */
export async function getInstance(db, instanceId) {
  if (!db || !instanceId) return null
  try {
    const r = await db
      .prepare('SELECT * FROM agent_control_instances WHERE instance_id = ? LIMIT 1')
      .get(String(instanceId))
    return r || null
  } catch {
    return null
  }
}

/**
 * Delete liveness rows that have not heartbeated in a very long time (default
 * 24h) so the table cannot grow unbounded across years of redeploys. Anything
 * this old is unambiguously dead — any lock still referencing it is already
 * reclaimable through the "no instance row" branch of acquireLock's takeover
 * predicate, so pruning it changes no behavior, only table size.
 */
export async function pruneDeadInstances(db, { olderThanMs = INSTANCE_DEAD_PRUNE_MS, now = NOW() } = {}) {
  if (!db) return 0
  await ensureSchema(db)
  const nowMs = Date.parse(now)
  if (!Number.isFinite(nowMs)) return 0
  const cutoff = new Date(nowMs - Math.max(60_000, Number(olderThanMs) || INSTANCE_DEAD_PRUNE_MS)).toISOString()
  try {
    const res = await db
      .prepare(`DELETE FROM agent_control_instances WHERE last_heartbeat_at < ?`)
      .run(cutoff)
    const pruned = Number(res?.changes || 0)
    if (pruned > 0) lockLog('instance.pruned', { count: pruned })
    return pruned
  } catch {
    return 0
  }
}

// Autonomous per-process liveness heartbeat. Idempotent per process (never
// stacks timers), independent of whether/which lock this process currently
// holds — this is what lets a DIFFERENT process detect this one died even if
// it wasn't mid-renewal on any particular lock at the moment it was killed.
let instanceHeartbeatHandle = null

export function startInstanceHeartbeat(db, {
  intervalMs = INSTANCE_HEARTBEAT_INTERVAL_MS,
  instanceId = getInstanceId(),
  logger = console,
} = {}) {
  if (!db) return null
  if (instanceHeartbeatHandle) return instanceHeartbeatHandle // idempotent — never stack timers
  const period = Math.max(1_000, Number(intervalMs) || INSTANCE_HEARTBEAT_INTERVAL_MS)
  heartbeatInstance(db, instanceId).catch(() => {})
  instanceHeartbeatHandle = setInterval(() => {
    heartbeatInstance(db, instanceId).catch((err) =>
      logger?.warn?.('[agent-control] instance heartbeat failed:', err?.message || err),
    )
  }, period)
  if (typeof instanceHeartbeatHandle?.unref === 'function') instanceHeartbeatHandle.unref()
  lockLog('instance.heartbeat_started', { instance: instanceId, intervalMs: period })
  return instanceHeartbeatHandle
}

export function stopInstanceHeartbeat() {
  if (instanceHeartbeatHandle) {
    clearInterval(instanceHeartbeatHandle)
    instanceHeartbeatHandle = null
  }
}

/**
 * Delete every expired lock. Safe to call anytime (boot, before an acquire).
 * Returns the count swept so callers can meter orphaned-lock recovery.
 */
export async function sweepExpiredLocks(db, { now = NOW() } = {}) {
  if (!db) return 0
  await ensureSchema(db)
  try {
    const res = await db
      .prepare(`DELETE FROM agent_control_locks WHERE expires_at IS NOT NULL AND expires_at < ?`)
      .run(now)
    const swept = Number(res?.changes || 0)
    if (swept > 0) lockLog('sweep.reclaimed', { count: swept })
    return swept
  } catch {
    return 0
  }
}

// Autonomous orphaned-lock recovery.
//
// sweepExpiredLocks already runs before every acquireLock, so a lock left
// behind by a crashed/restarted worker is reclaimed the next time ANY run
// tries to acquire it. But if no run is attempted for a while (idle system),
// an expired lock lingers and the Control Center keeps reporting the agent as
// "locked". The periodic sweeper closes that gap: it reclaims expired locks on
// a timer regardless of acquire traffic, so locks self-heal even while idle.
const LOCK_SWEEP_INTERVAL_MS = 5 * 60 * 1000 // 5m
let lockSweeperHandle = null

export function startLockSweeper(db, { intervalMs = LOCK_SWEEP_INTERVAL_MS, logger = console } = {}) {
  if (!db) return null
  if (lockSweeperHandle) return lockSweeperHandle // idempotent — never stack timers
  const period = Math.max(MIN_LOCK_TTL_MS, Number(intervalMs) || LOCK_SWEEP_INTERVAL_MS)
  // Reclaim anything already orphaned at boot, then on a steady cadence. Dead
  // instance rows are pruned on the same tick — hygiene only, never behavior:
  // a lock still pointing at a pruned instance is already reclaimable via the
  // "no instance row" branch of acquireLock's takeover predicate.
  sweepExpiredLocks(db).catch(() => {})
  pruneDeadInstances(db).catch(() => {})
  lockSweeperHandle = setInterval(() => {
    sweepExpiredLocks(db).catch((err) =>
      logger?.warn?.('[agent-control] periodic lock sweep failed:', err?.message || err),
    )
    pruneDeadInstances(db).catch((err) =>
      logger?.warn?.('[agent-control] periodic instance prune failed:', err?.message || err),
    )
  }, period)
  // Never keep the process alive solely for the sweeper.
  if (typeof lockSweeperHandle?.unref === 'function') lockSweeperHandle.unref()
  lockLog('sweeper.started', { intervalMs: period })
  return lockSweeperHandle
}

export function stopLockSweeper() {
  if (lockSweeperHandle) {
    clearInterval(lockSweeperHandle)
    lockSweeperHandle = null
  }
}

/**
 * Acquire a lock with a TTL, an owner token, atomic takeover of an expired OR
 * dead-holder lock, and bounded retry-with-backoff. Returns a lease descriptor:
 *
 *   { acquired: true,  ownerToken, lockName, expiresAt, tookOver?, reclaimReason? }
 *   { acquired: false, reason: 'held'|'invalid_args', heldBy, expiresAt }
 *
 * `reclaimReason` (present only when `tookOver` is true) is `'ttl_expired'`
 * or `'dead_holder_instance'` — see the "STALE-HOLDER RECLAIM" note above.
 *
 * `retries` is the number of EXTRA attempts after the first (so retries=5 →
 * up to 6 attempts). Backoff is exponential off `backoffMs`, capped at 5s,
 * with a little jitter to de-correlate competing workers.
 *
 * `instanceId` (default: this process's boot id) is recorded as the lock's
 * holder; pass `null` to opt a call site out of instance-based reclaim
 * entirely (the lock then behaves exactly as before — TTL-only takeover).
 */
export async function acquireLock(db, {
  lockName,
  controlRunId,
  acquiredBy = null,
  ttlMs = DEFAULT_LOCK_TTL_MS,
  retries = 0,
  backoffMs = 250,
  instanceId = getInstanceId(),
  staleInstanceMs = INSTANCE_STALE_MS,
} = {}) {
  if (!db || !lockName || !controlRunId) {
    return { acquired: false, reason: 'invalid_args' }
  }
  await ensureSchema(db)

  let holderInstanceId = instanceId ? String(instanceId) : null
  // Keep THIS process's own liveness row fresh before contending for the
  // lock, so a concurrent acquirer (or our own takeover check below) always
  // sees an up-to-date heartbeat rather than whatever staleness happened to
  // exist since the last periodic tick. If registration fails, retain the
  // original TTL-only lease: a missing/stale heartbeat must not authorize a
  // second worker to reclaim a lease this live process just acquired.
  if (holderInstanceId && !await heartbeatInstance(db, holderInstanceId).catch(() => false)) {
    lockLog('instance.registration_unavailable', { instance: holderInstanceId, lock: lockName })
    holderInstanceId = null
  }

  const ownerToken = LOCK_TOKEN()
  const effTtl = Math.max(MIN_LOCK_TTL_MS, Number(ttlMs) || DEFAULT_LOCK_TTL_MS)
  const effStaleMs = Math.max(1_000, Number(staleInstanceMs) || INSTANCE_STALE_MS)
  const maxAttempts = Math.max(1, Number(retries) + 1)

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const now = NOW()
    const expiresAt = new Date(Date.now() + effTtl).toISOString()
    const staleCutoff = new Date(Date.now() - effStaleMs).toISOString()

    // 1. Reclaim any expired lock so a crashed/restarted holder never wedges us.
    await sweepExpiredLocks(db, { now })

    // 2. Fresh acquire. UNIQUE(lock_name) gives us mutual exclusion.
    try {
      await db
        .prepare(`
          INSERT INTO agent_control_locks
            (id, lock_name, control_run_id, owner_token, acquired_by, acquired_at, expires_at, holder_instance_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(ID(), String(lockName), String(controlRunId), ownerToken, acquiredBy || null, now, expiresAt, holderInstanceId)
      lockLog('acquire.ok', { lock: lockName, run: controlRunId, token: ownerToken, attempt, instance: holderInstanceId })
      return { acquired: true, ownerToken, lockName, expiresAt }
    } catch {
      // Row already exists — fall through to the takeover path.
    }

    // Read the current holder BEFORE attempting takeover, purely so a
    // successful takeover below can log WHY it was allowed (TTL expiry vs a
    // dead holder instance) without a second query.
    const existingHolder = await getLock(db, lockName)

    // 3. Atomic takeover IFF the existing row is expired BY TTL, OR its
    //    holder's instance is provably dead (no heartbeat newer than
    //    staleCutoff, or no instance row at all). This closes the race where
    //    the sweep above deleted nothing because another worker had just
    //    re-inserted, or the holder's deadline/liveness lapsed between sweep
    //    and insert. A NULL holder_instance_id (pre-migration/opted-out rows)
    //    can only be reclaimed via TTL, matching the original behavior.
    try {
      const res = await db
        .prepare(`
          UPDATE agent_control_locks
             SET control_run_id = ?, owner_token = ?, acquired_by = ?, acquired_at = ?, expires_at = ?, holder_instance_id = ?
           WHERE lock_name = ?
             AND (
               (expires_at IS NOT NULL AND expires_at < ?)
               OR (
                 holder_instance_id IS NOT NULL
                 AND NOT EXISTS (
                   SELECT 1 FROM agent_control_instances ai
                    WHERE ai.instance_id = agent_control_locks.holder_instance_id
                      AND ai.last_heartbeat_at >= ?
                 )
               )
             )
        `)
        .run(
          String(controlRunId), ownerToken, acquiredBy || null, now, expiresAt, holderInstanceId,
          String(lockName), now, staleCutoff,
        )
      if (Number(res?.changes || 0) > 0) {
        const ttlExpired = !!(existingHolder?.expires_at && existingHolder.expires_at < now)
        const reclaimReason = ttlExpired ? 'ttl_expired' : 'dead_holder_instance'
        lockLog('acquire.takeover', {
          lock: lockName,
          run: controlRunId,
          token: ownerToken,
          attempt,
          reason: reclaimReason,
          dead_instance: reclaimReason === 'dead_holder_instance' ? (existingHolder?.holder_instance_id || 'unknown') : undefined,
        })
        return { acquired: true, ownerToken, lockName, expiresAt, tookOver: true, reclaimReason }
      }
    } catch {
      // Treat any takeover failure as "still contended" and let retry/backoff handle it.
    }

    // 4. Genuinely held by a live owner. Log contention; back off and retry.
    const holder = await getLock(db, lockName)
    lockLog('acquire.contended', {
      lock: lockName,
      run: controlRunId,
      attempt,
      held_by: holder?.control_run_id || 'unknown',
      expires_at: holder?.expires_at || 'n/a',
    })

    if (attempt < maxAttempts) {
      const base = Math.min(5_000, backoffMs * 2 ** (attempt - 1))
      const delay = base + Math.floor(Math.random() * 100)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  const holder = await getLock(db, lockName)
  lockLog('acquire.failed', { lock: lockName, run: controlRunId, held_by: holder?.control_run_id || 'unknown' })
  return {
    acquired: false,
    reason: 'held',
    heldBy: holder?.control_run_id || null,
    expiresAt: holder?.expires_at || null,
  }
}

/**
 * Backwards-compatible boolean wrapper. Existing callers / tests that only
 * need a yes/no answer keep working; new callers should use `acquireLock`
 * (or `withLock`) so they get the owner token for fenced release.
 */
export async function tryAcquireLock(db, opts = {}) {
  const lease = await acquireLock(db, opts)
  return lease.acquired
}

/**
 * Release a lock. Scope it as tightly as the caller can:
 *   - `ownerToken` (preferred) fences the delete to the exact acquisition,
 *   - `controlRunId` scopes to a run (run IDs are unique, so this is also a
 *     safe fence and is what the orchestrator uses across process restarts),
 *   - `lockName` alone is a blunt release and should be avoided unless paired.
 * Returns the number of rows deleted.
 */
export async function releaseLock(db, { lockName = null, controlRunId = null, ownerToken = null } = {}) {
  if (!db) return 0
  if (!lockName && !controlRunId && !ownerToken) return 0
  const where = []
  const args = []
  if (ownerToken) { where.push('owner_token = ?'); args.push(String(ownerToken)) }
  if (lockName) { where.push('lock_name = ?'); args.push(String(lockName)) }
  if (controlRunId) { where.push('control_run_id = ?'); args.push(String(controlRunId)) }
  try {
    const res = await db
      .prepare(`DELETE FROM agent_control_locks WHERE ${where.join(' AND ')}`)
      .run(...args)
    const released = Number(res?.changes || 0)
    lockLog('release', { lock: lockName || 'n/a', run: controlRunId || 'n/a', token: ownerToken || 'n/a', released })
    return released
  } catch {
    return 0
  }
}

/**
 * Extend the TTL of a lock this process still owns (a heartbeat). Fenced by
 * `ownerToken` so it can only ever push out the deadline of the exact
 * acquisition it holds — never a successor's. Returns true when a row was
 * renewed. This is what lets a lock carry a SHORT TTL safely: a live holder
 * keeps renewing while it works, so a deploy-killed holder (which stops
 * renewing) frees the lock within one TTL instead of wedging the scheduler for
 * the whole fixed window.
 */
export async function renewLock(db, { lockName = null, ownerToken = null, ttlMs = DEFAULT_LOCK_TTL_MS } = {}) {
  if (!db || !lockName || !ownerToken) return false
  const effTtl = Math.max(MIN_LOCK_TTL_MS, Number(ttlMs) || DEFAULT_LOCK_TTL_MS)
  const expiresAt = new Date(Date.now() + effTtl).toISOString()
  try {
    const res = await db
      .prepare(`UPDATE agent_control_locks SET expires_at = ? WHERE lock_name = ? AND owner_token = ?`)
      .run(expiresAt, String(lockName), String(ownerToken))
    const renewed = Number(res?.changes || 0) > 0
    if (renewed) lockLog('renew', { lock: lockName, token: ownerToken, expires_at: expiresAt })
    return renewed
  } catch {
    return false
  }
}

/**
 * Context-manager / defer-style helper: acquire, run `fn(lease)`, and ALWAYS
 * release in a finally — including on exception or timeout. Throws a
 * `LOCK_NOT_ACQUIRED` error (with `.lease` attached) when the lock is held.
 * This is the safest way to use a lock for any new in-process critical section.
 */
export async function withLock(db, opts = {}, fn) {
  if (typeof fn !== 'function') throw new Error('withLock: fn required')
  const lease = await acquireLock(db, opts)
  if (!lease.acquired) {
    const e = new Error(`withLock: could not acquire "${opts?.lockName}" (held by ${lease.heldBy || 'unknown'})`)
    e.code = 'LOCK_NOT_ACQUIRED'
    e.lease = lease
    throw e
  }
  try {
    return await fn(lease)
  } finally {
    await releaseLock(db, {
      lockName: opts.lockName,
      controlRunId: opts.controlRunId,
      ownerToken: lease.ownerToken,
    })
  }
}

export async function getLock(db, lockName) {
  if (!db || !lockName) return null
  try {
    const r = await db
      .prepare('SELECT * FROM agent_control_locks WHERE lock_name = ? LIMIT 1')
      .get(String(lockName))
    return r || null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Stop / pause / resume requests (durable)
// ---------------------------------------------------------------------------
export async function recordStopRequest(db, {
  controlRunId,
  agentName = null,
  requestType,
  requestedByEmail = null,
  requestedByUserId = null,
  reason = null,
} = {}) {
  if (!db || !controlRunId || !requestType) return null
  if (!['pause', 'resume', 'graceful_stop', 'emergency_stop', 'cancel'].includes(requestType)) {
    throw new Error(`recordStopRequest: invalid requestType "${requestType}"`)
  }
  await ensureSchema(db)
  const id = ID()
  try {
    await db
      .prepare(`
        INSERT INTO agent_control_stop_requests (
          id, control_run_id, agent_name,
          requested_by_email, requested_by_user_id,
          request_type, reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        String(controlRunId),
        agentName ? String(agentName).toLowerCase() : null,
        requestedByEmail ? String(requestedByEmail).toLowerCase() : null,
        requestedByUserId || null,
        requestType,
        reason || null,
      )
    return id
  } catch {
    return null
  }
}

export async function listStopRequests(db, runId, { unfulfilledOnly = false } = {}) {
  if (!db || !runId) return []
  try {
    const sql = unfulfilledOnly
      ? `SELECT * FROM agent_control_stop_requests WHERE control_run_id = ? AND fulfilled_at IS NULL ORDER BY created_at ASC`
      : `SELECT * FROM agent_control_stop_requests WHERE control_run_id = ? ORDER BY created_at ASC`
    const rows = await db.prepare(sql).all(runId)
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

/**
 * Returns the latest unfulfilled stop request that an agent runner should
 * react to. Resume cancels any outstanding pause; cancel/emergency_stop
 * trumps pause/graceful_stop.
 */
export async function latestUnfulfilledStop(db, runId, { agentName = null, runWideOnly = false } = {}) {
  const reqs = await listStopRequests(db, runId, { unfulfilledOnly: true })
  if (!reqs.length) return null

  // An executor's between-step poll must ignore an agent-scoped stop so one
  // agent can halt without terminating the entire full cycle. During a step,
  // agentName includes both run-wide and that agent's requests.
  const relevant = runWideOnly
    ? reqs.filter((r) => !r.agent_name)
    : agentName
      ? reqs.filter((r) => !r.agent_name || r.agent_name === String(agentName).toLowerCase())
      : reqs

  if (!relevant.length) return null

  // Priority order: emergency_stop > cancel > graceful_stop > pause; resume cancels pause.
  const byType = (t) => relevant.filter((r) => r.request_type === t)
  if (byType('emergency_stop').length > 0) return byType('emergency_stop').slice(-1)[0]
  if (byType('cancel').length > 0) return byType('cancel').slice(-1)[0]
  if (byType('graceful_stop').length > 0) return byType('graceful_stop').slice(-1)[0]

  // pause vs resume — last write wins.
  const lastPauseOrResume = relevant
    .filter((r) => r.request_type === 'pause' || r.request_type === 'resume')
    .slice(-1)[0]
  if (lastPauseOrResume?.request_type === 'pause') return lastPauseOrResume

  return null
}

export async function fulfillStopRequest(db, requestId) {
  if (!db || !requestId) return
  try {
    await db
      .prepare(`UPDATE agent_control_stop_requests SET fulfilled_at = ? WHERE id = ? AND fulfilled_at IS NULL`)
      .run(NOW(), requestId)
  } catch { /* ignore */ }
}

export async function fulfillStopRequestsByType(db, runId, requestType) {
  if (!db || !runId || !requestType) return
  try {
    await db
      .prepare(`
        UPDATE agent_control_stop_requests
           SET fulfilled_at = ?
         WHERE control_run_id = ?
           AND request_type = ?
           AND fulfilled_at IS NULL
      `)
      .run(NOW(), runId, requestType)
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Step lookups used by the orchestrator
// ---------------------------------------------------------------------------
export async function findStep(db, runId, agentName) {
  if (!db || !runId || !agentName) return null
  try {
    const r = await db
      .prepare(`
        SELECT * FROM agent_control_steps
         WHERE control_run_id = ? AND agent_name = ?
         ORDER BY step_order ASC LIMIT 1
      `)
      .get(runId, String(agentName).toLowerCase())
    return row(r)
  } catch {
    return null
  }
}

export async function nextQueuedStep(db, runId) {
  if (!db || !runId) return null
  try {
    const r = await db
      .prepare(`
        SELECT * FROM agent_control_steps
         WHERE control_run_id = ? AND status = 'queued'
         ORDER BY step_order ASC LIMIT 1
      `)
      .get(runId)
    return row(r)
  } catch {
    return null
  }
}
