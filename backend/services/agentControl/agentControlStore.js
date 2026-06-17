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
}

export function _resetSchemaCache() {
  schemaCache = new WeakMap()
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

/**
 * Latest terminal run of each kind, used by Mission Control summary.
 */
export async function getRunHighlights(db) {
  if (!db) return { last: null, last_full_cycle: null, last_success: null, last_failure: null }
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
    return {
      last: row(last),
      last_full_cycle: row(last_full_cycle),
      last_success: row(last_success),
      last_failure: row(last_failure),
    }
  } catch {
    return { last: null, last_full_cycle: null, last_success: null, last_failure: null }
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
// Locks (single-flight)
// ---------------------------------------------------------------------------
export async function tryAcquireLock(db, { lockName, controlRunId, acquiredBy = null, ttlMs = 6 * 60 * 60 * 1000 } = {}) {
  if (!db || !lockName || !controlRunId) return false
  await ensureSchema(db)
  const id = ID()
  const expiresAt = new Date(Date.now() + Math.max(60_000, Number(ttlMs) || 0)).toISOString()

  // First sweep expired locks so a crashed run never wedges the system.
  try {
    await db
      .prepare(`DELETE FROM agent_control_locks WHERE expires_at IS NOT NULL AND expires_at < ?`)
      .run(NOW())
  } catch { /* ignore */ }

  // Try insert; UNIQUE(lock_name) means a second writer fails.
  try {
    await db
      .prepare(`
        INSERT INTO agent_control_locks (id, lock_name, control_run_id, acquired_by, acquired_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(id, String(lockName), String(controlRunId), acquiredBy || null, NOW(), expiresAt)
    return true
  } catch {
    return false
  }
}

export async function releaseLock(db, { lockName = null, controlRunId = null } = {}) {
  if (!db) return
  if (!lockName && !controlRunId) return
  const where = []
  const args = []
  if (lockName) { where.push('lock_name = ?'); args.push(String(lockName)) }
  if (controlRunId) { where.push('control_run_id = ?'); args.push(String(controlRunId)) }
  try {
    await db
      .prepare(`DELETE FROM agent_control_locks WHERE ${where.join(' AND ')}`)
      .run(...args)
  } catch {
    // ignore
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
