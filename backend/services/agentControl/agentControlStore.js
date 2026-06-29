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
import { ALL_AGENTS, RUN_TYPES, RUN_STATUSES, STEP_STATUSES } from './agentControlTypes.js'

const ID = () => crypto.randomUUID()
const NOW = () => new Date().toISOString()

let schemaCache = new WeakMap()

/**
 * Best-effort one-time schema bootstrap. Any error is swallowed because
 * production code paths run after migrations; tests pass an in-memory
 * SQLite that already has these tables. This is a defensive net only.
 */
export async function ensureSchema(db) {
  if (!db || typeof db.prepare !== 'function') return
  if (schemaCache.has(db)) return
  schemaCache.set(db, true)
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
      admin_email TEXT NOT NULL DEFAULT 'buckeye7066@gmail.com',
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
      expires_at ${tsType}
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
      // table may already exist via migrations; ignore.
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
  adminEmail = 'buckeye7066@gmail.com',
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
      String(adminEmail || 'buckeye7066@gmail.com').toLowerCase(),
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
  if (['completed', 'failed', 'cancelled', 'stopped', 'partial_stop', 'stop_failed'].includes(status)) {
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
      .prepare(`SELECT * FROM agent_control_runs WHERE run_type = 'full_cycle' ORDER BY COALESCE(started_at, created_at) DESC LIMIT 1`)
      .get()
    const last_success = await db
      .prepare(`SELECT * FROM agent_control_runs WHERE status = 'completed' ORDER BY COALESCE(completed_at, started_at, created_at) DESC LIMIT 1`)
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
//   - structured `[agent-control][lock]` logging on every acquire / takeover /
//     contention / release / sweep so contention is observable in prod logs.
//
// The acquire path is: sweep expired → INSERT (UNIQUE gives mutual exclusion)
// → on conflict, atomically take over IFF the existing row is expired → else
// it's genuinely held, so log contention and (optionally) back off and retry.

// Hard ceiling fallback when a caller passes no TTL. Real callers pass a TTL
// derived from the run's max_runtime_minutes; this is just a backstop so a
// missing TTL can never mean "never expires".
const DEFAULT_LOCK_TTL_MS = 60 * 60 * 1000 // 1h
const MIN_LOCK_TTL_MS = 60_000             // 1m floor
const LOCK_TOKEN = () => crypto.randomUUID()

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
  // Reclaim anything already orphaned at boot, then on a steady cadence.
  sweepExpiredLocks(db).catch(() => {})
  lockSweeperHandle = setInterval(() => {
    sweepExpiredLocks(db).catch((err) =>
      logger?.warn?.('[agent-control] periodic lock sweep failed:', err?.message || err),
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
 * Acquire a lock with a TTL, an owner token, atomic takeover of an expired
 * holder, and bounded retry-with-backoff. Returns a lease descriptor:
 *
 *   { acquired: true,  ownerToken, lockName, expiresAt, tookOver? }
 *   { acquired: false, reason: 'held'|'invalid_args', heldBy, expiresAt }
 *
 * `retries` is the number of EXTRA attempts after the first (so retries=5 →
 * up to 6 attempts). Backoff is exponential off `backoffMs`, capped at 5s,
 * with a little jitter to de-correlate competing workers.
 */
export async function acquireLock(db, {
  lockName,
  controlRunId,
  acquiredBy = null,
  ttlMs = DEFAULT_LOCK_TTL_MS,
  retries = 0,
  backoffMs = 250,
} = {}) {
  if (!db || !lockName || !controlRunId) {
    return { acquired: false, reason: 'invalid_args' }
  }
  await ensureSchema(db)

  const ownerToken = LOCK_TOKEN()
  const effTtl = Math.max(MIN_LOCK_TTL_MS, Number(ttlMs) || DEFAULT_LOCK_TTL_MS)
  const maxAttempts = Math.max(1, Number(retries) + 1)

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const now = NOW()
    const expiresAt = new Date(Date.now() + effTtl).toISOString()

    // 1. Reclaim any expired lock so a crashed/restarted holder never wedges us.
    await sweepExpiredLocks(db, { now })

    // 2. Fresh acquire. UNIQUE(lock_name) gives us mutual exclusion.
    try {
      await db
        .prepare(`
          INSERT INTO agent_control_locks
            (id, lock_name, control_run_id, owner_token, acquired_by, acquired_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(ID(), String(lockName), String(controlRunId), ownerToken, acquiredBy || null, now, expiresAt)
      lockLog('acquire.ok', { lock: lockName, run: controlRunId, token: ownerToken, attempt })
      return { acquired: true, ownerToken, lockName, expiresAt }
    } catch {
      // Row already exists — fall through to the expired-takeover path.
    }

    // 3. Atomic takeover IFF the existing row is expired. This closes the race
    //    where the sweep above deleted nothing because another worker had just
    //    re-inserted, or the holder's deadline lapsed between sweep and insert.
    try {
      const res = await db
        .prepare(`
          UPDATE agent_control_locks
             SET control_run_id = ?, owner_token = ?, acquired_by = ?, acquired_at = ?, expires_at = ?
           WHERE lock_name = ? AND expires_at IS NOT NULL AND expires_at < ?
        `)
        .run(String(controlRunId), ownerToken, acquiredBy || null, now, expiresAt, String(lockName), now)
      if (Number(res?.changes || 0) > 0) {
        lockLog('acquire.takeover', { lock: lockName, run: controlRunId, token: ownerToken, attempt })
        return { acquired: true, ownerToken, lockName, expiresAt, tookOver: true }
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
export async function latestUnfulfilledStop(db, runId, { agentName = null } = {}) {
  const reqs = await listStopRequests(db, runId, { unfulfilledOnly: true })
  if (!reqs.length) return null

  // Filter by agent (null = run-wide)
  const relevant = agentName
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
