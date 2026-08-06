/**
 * agentControlNotifications.js
 *
 * Lifecycle notifications for the Admin Agent Control Center. Every
 * start / stop / pause / resume / fail / complete event creates ONE
 * persistent notification on the `notifications` table addressed to
 * the canonical admin/operator (configured-admin@example.invalid).
 *
 * If the admin is logged in, the existing NotificationBell + toast
 * bridge picks the row up on its next poll. The notification persists
 * so a quick action that finishes between polls is not lost.
 *
 * Notification types (every one validated below):
 *   agent_control_started
 *   agent_control_completed
 *   agent_control_failed
 *   agent_control_paused
 *   agent_control_resumed
 *   agent_control_stopped
 *   agent_control_emergency_stopped
 *   agent_control_agent_failed
 *   agent_control_agent_blocked
 */

import crypto from 'node:crypto'
import { resolveAdminUserId } from '../hamilton/hamiltonAdminAccount.js'
import { CONTROL_NOTIFICATION_TYPES } from './agentControlTypes.js'

let notificationsSchemaCache = new WeakMap()
export function _resetNotificationsSchemaCache() { notificationsSchemaCache = new WeakMap() }

async function ensureNotificationsSchema(db) {
  if (!db || typeof db.prepare !== 'function') return
  if (notificationsSchemaCache.has(db)) return
  notificationsSchemaCache.set(db, true)
  const isPostgres = db?.dialect === 'postgres'
  const tsType = isPostgres ? 'TIMESTAMPTZ' : 'DATETIME'
  const ddl = `
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      data TEXT,
      read INTEGER NOT NULL DEFAULT 0,
      created_at ${tsType} DEFAULT ${isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'},
      expires_at ${tsType}
    )
  `
  try {
    if (typeof db.exec === 'function') await db.exec(ddl)
    else await db.prepare(ddl).run()
  } catch { /* migration 049 already created it; ignore */ }
}

function severityFromType(type) {
  switch (type) {
    case 'agent_control_sam_critical':
      return 'critical'
    case 'agent_control_failed':
    case 'agent_control_emergency_stopped':
    case 'agent_control_agent_failed':
      return 'high'
    case 'agent_control_agent_blocked':
    case 'agent_control_stopped':
      return 'medium'
    default:
      return 'info'
  }
}

/**
 * Insert one persistent notification for the canonical admin. Returns
 * the new notification id (or null on best-effort failure).
 */
export async function emitControlNotification(db, {
  type,
  title,
  message,
  data = {},
  expiresInDays = 30,
} = {}) {
  if (!db || !type) return null
  if (!CONTROL_NOTIFICATION_TYPES.includes(type)) {
    throw new Error(`emitControlNotification: invalid type "${type}"`)
  }
  if (!title || !message) throw new Error('emitControlNotification: title and message required')

  await ensureNotificationsSchema(db)
  const adminUserId = await resolveAdminUserId(db)
  const id = crypto.randomUUID()
  const isPostgres = db?.dialect === 'postgres'
  const days = Math.max(1, Math.min(365, Number(expiresInDays) || 30))
  const expires = isPostgres
    ? `NOW() + INTERVAL '${days} days'`
    : `datetime('now', '+${days} days')`

  let dataJson
  try {
    dataJson = JSON.stringify({ ...data, severity: severityFromType(type) })
  } catch {
    dataJson = JSON.stringify({ severity: severityFromType(type) })
  }

  try {
    await db
      .prepare(`
        INSERT INTO notifications (id, user_id, type, title, message, data, read, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, ${expires})
      `)
      .run(id, adminUserId, type, String(title), String(message), dataJson)
    return id
  } catch (err) {
    if (process?.env?.NODE_ENV !== 'test') {
      console.warn('[agentControlNotifications] insert failed:', err?.message || err)
    }
    return null
  }
}

/**
 * Convenience helpers for each lifecycle event. Every helper accepts
 * the run row + extra fields and produces the canonical title/message.
 */
function runLabel(run) {
  if (!run) return 'control run'
  const t = run.run_type === 'full_cycle' ? 'full agent cycle'
    : run.run_type === 'selected_agents' ? `selected agents (${(run.requested_agents || []).join(', ')})`
    : run.run_type?.replace('_only', ' only').replace('_', ' ')
  return `${t} #${String(run.id || '').slice(0, 8)}`
}

export async function notifyStarted(db, run) {
  return emitControlNotification(db, {
    type: 'agent_control_started',
    title: 'Agent Control Center: run started',
    message: `${runLabel(run)} started by ${run?.started_by_email || run?.admin_email || 'admin'}.`,
    data: { run_id: run?.id, run_type: run?.run_type, agents: run?.requested_agents || [] },
  })
}

export async function notifyCompleted(db, run, summary = {}) {
  return emitControlNotification(db, {
    type: 'agent_control_completed',
    title: 'Agent Control Center: run completed',
    message: `${runLabel(run)} completed.`,
    data: { run_id: run?.id, run_type: run?.run_type, summary },
  })
}

export async function notifyFailed(db, run, errorMessage = 'unknown error') {
  return emitControlNotification(db, {
    type: 'agent_control_failed',
    title: 'Agent Control Center: run failed',
    message: `${runLabel(run)} failed — ${errorMessage}`,
    data: { run_id: run?.id, run_type: run?.run_type, error: errorMessage },
  })
}

export async function notifyPaused(db, run, reason = null) {
  return emitControlNotification(db, {
    type: 'agent_control_paused',
    title: 'Agent Control Center: run paused',
    message: `${runLabel(run)} paused${reason ? ` — ${reason}` : ''}.`,
    data: { run_id: run?.id, run_type: run?.run_type, reason },
  })
}

export async function notifyResumed(db, run) {
  return emitControlNotification(db, {
    type: 'agent_control_resumed',
    title: 'Agent Control Center: run resumed',
    message: `${runLabel(run)} resumed.`,
    data: { run_id: run?.id, run_type: run?.run_type },
  })
}

export async function notifyStopped(db, run, { partial = false, reason = null } = {}) {
  return emitControlNotification(db, {
    type: 'agent_control_stopped',
    title: partial ? 'Agent Control Center: partial stop' : 'Agent Control Center: run stopped',
    message: `${runLabel(run)} ${partial ? 'partially ' : ''}stopped${reason ? ` — ${reason}` : ''}.`,
    data: { run_id: run?.id, run_type: run?.run_type, partial, reason },
  })
}

export async function notifyEmergencyStopped(db, run, reason = null) {
  return emitControlNotification(db, {
    type: 'agent_control_emergency_stopped',
    title: 'Agent Control Center: EMERGENCY STOP',
    message: `Emergency stop on ${runLabel(run)}${reason ? ` — ${reason}` : ''}. Some operations may have been aborted mid-flight; review the timeline for unfinished steps.`,
    data: { run_id: run?.id, run_type: run?.run_type, reason },
    expiresInDays: 90,
  })
}

export async function notifyAgentFailed(db, run, agentName, errorMessage = 'unknown error') {
  return emitControlNotification(db, {
    type: 'agent_control_agent_failed',
    title: `Agent Control Center: ${agentName} failed`,
    message: `Agent "${agentName}" failed inside ${runLabel(run)} — ${errorMessage}`,
    data: { run_id: run?.id, run_type: run?.run_type, agent: agentName, error: errorMessage },
  })
}

export async function notifyAgentBlocked(db, run, agentName, reason = 'unknown blocker') {
  return emitControlNotification(db, {
    type: 'agent_control_agent_blocked',
    title: `Agent Control Center: ${agentName} blocked`,
    message: `Agent "${agentName}" blocked inside ${runLabel(run)} — ${reason}`,
    data: { run_id: run?.id, run_type: run?.run_type, agent: agentName, reason },
  })
}

/**
 * Sam (code supervisor) escalation: emit ONE persistent critical notification
 * to the canonical admin when a Sam run finds critical issues (charter §3/§6 —
 * "report critical issues to the single admin"). Kept here so Sam reuses the
 * canonical notification path instead of inventing its own.
 */
export async function notifySamCritical(db, {
  runId = null,
  criticalCount = 0,
  totalFindings = 0,
  healthScore = null,
  productionReady = null,
} = {}) {
  const score = (healthScore === null || healthScore === undefined) ? '' : ` Health score ${healthScore}.`
  return emitControlNotification(db, {
    type: 'agent_control_sam_critical',
    title: `Sam: ${criticalCount} critical issue${criticalCount === 1 ? '' : 's'} need review`,
    message: `Sam's supervision run found ${criticalCount} critical issue${criticalCount === 1 ? '' : 's'} (of ${totalFindings} findings).${score}${productionReady === false ? ' GrantFlow is NOT production-ready until these are resolved.' : ''}`,
    data: { run_id: runId, agent: 'sam', critical_count: criticalCount, total_findings: totalFindings, health_score: healthScore, production_ready: productionReady },
    expiresInDays: 90,
  })
}
