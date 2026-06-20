/**
 * portalSyncHealth.js
 *
 * Read-only health surface for Hamilton's two-way portal sync, built to the
 * same graceful-degradation contract as agentTelemetry.getHealth: it NEVER
 * throws. When the `portal_sync_runs` table doesn't exist yet (the backend
 * framework hasn't been migrated in), it reports `installed: false` /
 * status `not_installed` instead of blowing up — exactly mirroring how the
 * agent-telemetry aggregators handle a missing table.
 *
 * Consumed by:
 *   - Sam diagnostics — via the admin route GET /api/admin/portal-sync/health,
 *     probed by the `hamilton.portalSync.health` HTTP check in samRegistry.
 *   - Anya — the `owner.get_portal_sync_status` tool reuses getPortalSyncRuns().
 *
 * Honesty contract: every status/timestamp/error reported here is read straight
 * from `portal_sync_runs`. Nothing is faked — a profile/host with no run yet
 * simply has no entry, and a failed run surfaces its real error string.
 */

import { tableExists, columnsFor } from '../../agentTelemetry/agentTelemetryStore.js'
import { withProfileScope } from '../../../middleware/profileContext.js'

const PORTAL_SYNC_RUNS_TABLE = 'portal_sync_runs'

/**
 * Best-effort load of the connector catalogue from the (parallel-built)
 * portalSync framework. If the module isn't present yet, return [] — the
 * health surface still works, it just reports zero connectors.
 *
 * @returns {Promise<Array<{ id: string, label: string }>>}
 */
async function loadConnectors() {
  try {
    const mod = await import('./index.js')
    if (typeof mod?.listConnectors === 'function') {
      const list = mod.listConnectors()
      return Array.isArray(list) ? list : []
    }
  } catch {
    // Framework module not merged yet — degrade to empty list, never throw.
  }
  return []
}

/**
 * Pick the best available "finished/started" timestamp column the deployed
 * table actually has, so we degrade gracefully across schema drift.
 */
function pickTimeCol(cols) {
  const set = new Set(cols)
  for (const c of ['finished_at', 'started_at', 'created_at', 'updated_at']) {
    if (set.has(c)) return c
  }
  return null
}

/**
 * Return the most recent portal_sync_runs rows, newest first, optionally
 * filtered by profileId and/or portalHost. Never throws — returns [] when the
 * table is missing or anything goes wrong.
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {string|null} [opts.profileId]
 * @param {string|null} [opts.portalHost]
 * @param {number} [opts.limit]
 * @returns {Promise<Array<object>>}
 */
export async function getPortalSyncRuns(db, { profileId = null, portalHost = null, limit = 50 } = {}) {
  if (!db) return []
  if (!(await tableExists(db, PORTAL_SYNC_RUNS_TABLE))) return []
  const cols = new Set(await columnsFor(db, PORTAL_SYNC_RUNS_TABLE))
  const orderCol = pickTimeCol(cols) || 'id'
  const cap = Math.max(1, Math.min(500, Number(limit) || 50))

  return withProfileScope({ bypass: true }, async () => {
    try {
      const where = []
      const args = []
      if (profileId && cols.has('profile_id')) {
        where.push('profile_id = ?')
        args.push(String(profileId))
      }
      if (portalHost && cols.has('portal_host')) {
        where.push('portal_host = ?')
        args.push(String(portalHost))
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
      const rows = await db
        .prepare(`SELECT * FROM ${PORTAL_SYNC_RUNS_TABLE} ${whereSql} ORDER BY ${orderCol} DESC LIMIT ${cap}`)
        .all(...args)
      return Array.isArray(rows) ? rows : []
    } catch {
      return []
    }
  })
}

/**
 * Full health report for Sam / Mission Control.
 *
 * Shape (always returns this skeleton, even when not installed):
 *   {
 *     ok: boolean,                 // false only when the table is missing
 *     installed: boolean,          // portal_sync_runs table present?
 *     status: 'ok'|'degraded'|'not_installed',
 *     connectors: [{ id, label }], // from listConnectors()
 *     connector_count: number,
 *     latest_by_host: [            // newest run per profile+host
 *       { profile_id, portal_host, connector_id, direction, status, error, at }
 *     ],
 *     failing: number,             // how many host rows are in a failed state
 *     generated_at: ISO string,
 *     notes: string[],
 *   }
 */
export async function getPortalSyncHealth(db) {
  const connectors = await loadConnectors()
  const out = {
    ok: true,
    installed: false,
    status: 'not_installed',
    connectors,
    connector_count: connectors.length,
    latest_by_host: [],
    failing: 0,
    generated_at: new Date().toISOString(),
    notes: [],
  }

  const installed = db ? await tableExists(db, PORTAL_SYNC_RUNS_TABLE) : false
  if (!installed) {
    // Mirror agentTelemetry: a missing table is "not installed", not an error.
    out.ok = false
    out.notes.push(
      `${PORTAL_SYNC_RUNS_TABLE} table not found — portal sync backend not installed yet.`,
    )
    return out
  }

  out.installed = true
  out.status = 'ok'

  const runs = await getPortalSyncRuns(db, { limit: 500 })
  // Collapse to the latest run per (profile_id, portal_host).
  const latest = new Map()
  for (const r of runs) {
    const key = `${r.profile_id ?? ''}::${r.portal_host ?? ''}`
    if (!latest.has(key)) {
      latest.set(key, {
        profile_id: r.profile_id ?? null,
        portal_host: r.portal_host ?? null,
        connector_id: r.connector_id ?? null,
        direction: r.direction ?? null,
        status: r.status ?? null,
        error: r.error ?? null,
        at: r.finished_at ?? r.started_at ?? null,
      })
    }
  }
  out.latest_by_host = [...latest.values()]
  out.failing = out.latest_by_host.filter((h) => {
    const s = String(h.status || '').toLowerCase()
    return s === 'error' || s === 'failed' || Boolean(h.error)
  }).length
  if (out.failing > 0) {
    out.status = 'degraded'
    out.notes.push(`${out.failing} portal/host pair(s) have a failing latest sync.`)
  }
  return out
}

export default getPortalSyncHealth
