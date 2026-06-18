/**
 * Agent Mission Control — low-level store.
 *
 * Owns:
 *   - The `tableExists(db, name)` helper used by every aggregator function.
 *   - Insert/select against the unified `agent_activity_events` table.
 *   - Insert/upsert against `agent_daily_rollups`.
 *   - Parameterized timeline queries.
 *
 * Every function is dialect-aware (sqlite vs postgres) and never blows up
 * when a table is missing — it returns an empty result set instead.
 */

import { withProfileScope } from '../../middleware/profileContext.js'
import { AGENT_NAMES } from './agentTelemetryTypes.js'

const VALID_AGENTS = new Set(AGENT_NAMES)
const TABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Returns true if a table with `name` exists.
 *
 * sqlite: queries sqlite_master
 * postgres: queries information_schema.tables (current schema)
 *
 * Safe against arbitrary input — `name` is whitelisted to identifier chars.
 */
export async function tableExists(db, name) {
  if (!db || typeof name !== 'string' || !TABLE_NAME_RE.test(name)) return false
  try {
    return await withProfileScope({ bypass: true }, async () => {
      if (db.dialect === 'postgres') {
        const row = await db
          .prepare(
            "SELECT 1 AS ok FROM information_schema.tables WHERE table_schema = ANY (current_schemas(false)) AND table_name = ?",
          )
          .get(name)
        return Boolean(row && (row.ok === 1 || row.ok === true))
      }
      const row = db
        .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type IN ('table','view') AND name = ?")
        .get(name)
      return Boolean(row && (row.ok === 1 || row.ok === true))
    })
  } catch {
    return false
  }
}

export async function tablesExist(db, names = []) {
  const out = {}
  for (const n of names) out[n] = await tableExists(db, n)
  return out
}

/**
 * Returns the column names for `tableName` so aggregators can degrade
 * gracefully when an older deployment is missing a recently-added column.
 */
export async function columnsFor(db, tableName) {
  if (!db || typeof tableName !== 'string' || !TABLE_NAME_RE.test(tableName)) return []
  try {
    return await withProfileScope({ bypass: true }, async () => {
      if (db.dialect === 'postgres') {
        const rows = await db
          .prepare(
            "SELECT column_name FROM information_schema.columns WHERE table_schema = ANY (current_schemas(false)) AND table_name = ?",
          )
          .all(tableName)
        return rows.map((r) => r.column_name)
      }
      const rows = db.prepare(`PRAGMA table_info(${tableName})`).all()
      return rows.map((r) => r.name)
    })
  } catch {
    return []
  }
}

/**
 * Insert a single row into `agent_activity_events`.
 *
 * Keep this idempotent-ish: callers in agent code can fire-and-forget
 * without worrying about the table being missing — we silently no-op.
 *
 * Returns the inserted id (existing or generated).
 */
export async function insertActivityEvent(db, event = {}) {
  if (!db) return null
  const agent = String(event.agent_name || '').toLowerCase()
  if (!VALID_AGENTS.has(agent)) return null
  const exists = await tableExists(db, 'agent_activity_events')
  if (!exists) return null

  const isPg = db.dialect === 'postgres'
  const detailsJson = (() => {
    if (event.details_json === null || event.details_json === undefined) return null
    if (typeof event.details_json === 'string') return event.details_json
    try {
      return JSON.stringify(event.details_json)
    } catch {
      return null
    }
  })()

  return withProfileScope({ bypass: true }, async () => {
    if (isPg) {
      const sql = `
        INSERT INTO agent_activity_events
          (agent_name, event_type, status, severity, title, description,
           metric_key, metric_value, entity_type, entity_id,
           user_id, profile_id, organization_id,
           state, county, city, latitude, longitude, details_json, created_at)
        VALUES (?,?,?,?,?,?, ?,?,?,?, ?,?,?, ?,?,?,?,?, CAST(? AS JSONB), COALESCE(?, NOW()))
        RETURNING id
      `
      const row = await db
        .prepare(sql)
        .get(
          agent,
          event.event_type || 'event',
          event.status || null,
          event.severity || null,
          event.title || null,
          event.description || null,
          event.metric_key || null,
          numericOrNull(event.metric_value),
          event.entity_type || null,
          event.entity_id || null,
          event.user_id || null,
          event.profile_id || null,
          event.organization_id || null,
          event.state || null,
          event.county || null,
          event.city || null,
          numericOrNull(event.latitude),
          numericOrNull(event.longitude),
          detailsJson,
          event.created_at || null,
        )
      return row?.id || null
    }
    const sql = `
      INSERT INTO agent_activity_events
        (agent_name, event_type, status, severity, title, description,
         metric_key, metric_value, entity_type, entity_id,
         user_id, profile_id, organization_id,
         state, county, city, latitude, longitude, details_json, created_at)
      VALUES (?,?,?,?,?,?, ?,?,?,?, ?,?,?, ?,?,?,?,?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')))
    `
    db.prepare(sql).run(
      agent,
      event.event_type || 'event',
      event.status || null,
      event.severity || null,
      event.title || null,
      event.description || null,
      event.metric_key || null,
      numericOrNull(event.metric_value),
      event.entity_type || null,
      event.entity_id || null,
      event.user_id || null,
      event.profile_id || null,
      event.organization_id || null,
      event.state || null,
      event.county || null,
      event.city || null,
      numericOrNull(event.latitude),
      numericOrNull(event.longitude),
      detailsJson,
      event.created_at || null,
    )
    const row = db.prepare('SELECT id FROM agent_activity_events ORDER BY created_at DESC LIMIT 1').get()
    return row?.id || null
  })
}

/**
 * Increment a daily rollup counter (idempotent upsert).
 */
export async function incrementDailyRollup(db, { agent_name, rollup_date, metric_key, metric_value = 1, details_json = null } = {}) {
  if (!db) return false
  const agent = String(agent_name || '').toLowerCase()
  if (!VALID_AGENTS.has(agent)) return false
  if (!metric_key) return false
  const exists = await tableExists(db, 'agent_daily_rollups')
  if (!exists) return false

  const isPg = db.dialect === 'postgres'
  const date = rollup_date || new Date().toISOString().slice(0, 10)
  const detailsStr = details_json === null || details_json === undefined
    ? null
    : typeof details_json === 'string'
      ? details_json
      : (() => { try { return JSON.stringify(details_json) } catch { return null } })()

  return withProfileScope({ bypass: true }, async () => {
    if (isPg) {
      await db.prepare(`
        INSERT INTO agent_daily_rollups (agent_name, rollup_date, metric_key, metric_value, details_json)
        VALUES (?, ?::date, ?, ?, CAST(? AS JSONB))
        ON CONFLICT (agent_name, rollup_date, metric_key) DO UPDATE
          SET metric_value = agent_daily_rollups.metric_value + EXCLUDED.metric_value,
              updated_at = NOW(),
              details_json = COALESCE(EXCLUDED.details_json, agent_daily_rollups.details_json)
      `).run(agent, date, metric_key, numericOrNull(metric_value) || 0, detailsStr)
    } else {
      db.prepare(`
        INSERT INTO agent_daily_rollups (agent_name, rollup_date, metric_key, metric_value, details_json)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(agent_name, rollup_date, metric_key) DO UPDATE
          SET metric_value = metric_value + excluded.metric_value,
              updated_at = CURRENT_TIMESTAMP,
              details_json = COALESCE(excluded.details_json, details_json)
      `).run(agent, date, metric_key, numericOrNull(metric_value) || 0, detailsStr)
    }
    return true
  })
}

/**
 * Read events from `agent_activity_events`.
 * Filters: agent, status, startIso/endIso, profile_id, state, limit.
 * Returns rows in created_at DESC order.
 */
export async function readActivityEvents(db, opts = {}) {
  if (!db) return []
  const exists = await tableExists(db, 'agent_activity_events')
  if (!exists) return []

  const filters = []
  const args = []
  if (opts.agent && VALID_AGENTS.has(String(opts.agent).toLowerCase())) {
    filters.push('agent_name = ?'); args.push(String(opts.agent).toLowerCase())
  } else if (Array.isArray(opts.agents) && opts.agents.length) {
    const valid = opts.agents.filter((a) => VALID_AGENTS.has(String(a).toLowerCase()))
    if (valid.length) {
      filters.push(`agent_name IN (${valid.map(() => '?').join(',')})`)
      for (const v of valid) args.push(String(v).toLowerCase())
    }
  }
  if (opts.status) { filters.push('status = ?'); args.push(String(opts.status)) }
  if (opts.profile_id) { filters.push('profile_id = ?'); args.push(String(opts.profile_id)) }
  if (opts.state) { filters.push('state = ?'); args.push(String(opts.state).toUpperCase()) }
  if (opts.startIso) { filters.push('created_at >= ?'); args.push(opts.startIso) }
  if (opts.endIso) { filters.push('created_at <= ?'); args.push(opts.endIso) }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : ''
  const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 1000)

  const sql = `
    SELECT id, agent_name, event_type, status, severity, title, description,
           metric_key, metric_value, entity_type, entity_id,
           user_id, profile_id, organization_id,
           state, county, city, latitude, longitude, details_json, created_at
      FROM agent_activity_events
      ${where}
      ORDER BY created_at DESC
      LIMIT ?
  `
  args.push(limit)

  return withProfileScope({ bypass: true }, async () => {
    const rows = await db.prepare(sql).all(...args)
    return rows.map(decodeEventRow)
  })
}

/**
 * Count events grouped by agent + status (for overview cards).
 */
export async function countEventsByAgent(db, { startIso, endIso } = {}) {
  if (!db) return []
  const exists = await tableExists(db, 'agent_activity_events')
  if (!exists) return []

  const filters = []
  const args = []
  if (startIso) { filters.push('created_at >= ?'); args.push(startIso) }
  if (endIso) { filters.push('created_at <= ?'); args.push(endIso) }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : ''

  const sql = `
    SELECT agent_name,
           COUNT(*) AS total,
           SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) AS succeeded,
           SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN status='blocked' THEN 1 ELSE 0 END) AS blocked,
           SUM(CASE WHEN status='warning' THEN 1 ELSE 0 END) AS warnings,
           MAX(created_at) AS last_at,
           MAX(CASE WHEN status='succeeded' THEN created_at ELSE NULL END) AS last_success_at,
           MAX(CASE WHEN status='failed' THEN created_at ELSE NULL END) AS last_failure_at
      FROM agent_activity_events
      ${where}
      GROUP BY agent_name
  `
  return withProfileScope({ bypass: true }, async () => {
    return db.prepare(sql).all(...args)
  })
}

/**
 * Canonical "last run" timestamp for one agent: the most recent unified
 * activity event. This is the SAME source the telemetry summary cards read
 * (countEventsByAgent -> MAX(created_at)), so the Control Center per-agent
 * status cards can use it to stay in agreement with the telemetry timeline
 * instead of reading each agent's own run-table `started_at` (which differs
 * from the event time by the run's duration). Returns null when no unified
 * events exist yet (older DBs / first boot), letting callers fall back to
 * their per-agent run table.
 */
export async function getLastRunAtFromEvents(db, agentName) {
  if (!db || !agentName) return null
  const exists = await tableExists(db, 'agent_activity_events')
  if (!exists) return null
  return withProfileScope({ bypass: true }, async () => {
    try {
      const row = await db
        .prepare('SELECT MAX(created_at) AS last_at FROM agent_activity_events WHERE agent_name = ?')
        .get(String(agentName).toLowerCase())
      return row?.last_at || null
    } catch {
      return null
    }
  })
}

function numericOrNull(v) {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function decodeEventRow(row) {
  if (!row) return null
  let details = null
  if (row.details_json !== null && row.details_json !== undefined && row.details_json !== '') {
    if (typeof row.details_json === 'string') {
      try { details = JSON.parse(row.details_json) } catch { details = null }
    } else {
      details = row.details_json
    }
  }
  return { ...row, details_json: details }
}
