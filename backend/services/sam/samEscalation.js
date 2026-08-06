/**
 * samEscalation.js
 *
 * Active admin escalation for Sam (charter §3/§6: "report critical issues to the
 * single admin — configured-admin@example.invalid"). Sam already persists every run to an
 * append-only audit trail; this adds a PUSH so a critical finding actually
 * reaches the admin (persistent notification + toast bridge) instead of waiting
 * to be discovered.
 *
 * Escalation fires only when a run produces critical findings — never on clean
 * or merely-degraded runs — so the scheduler can't spam the admin. Opt out with
 * SAM_ESCALATE_ADMIN=false. Best-effort: a notification failure never affects
 * the run result.
 */

function escalationEnabled(env) {
  const raw = env?.SAM_ESCALATE_ADMIN
  if (raw === null || raw === undefined || raw === '') return true // default ON
  return !/^(0|false|no|off)$/i.test(String(raw).trim())
}

/**
 * Escalate a completed Sam run to the canonical admin if it has critical
 * findings. `notify` is injectable for tests; in production it lazily loads the
 * canonical agent-control notifier so Sam stays decoupled at module load.
 *
 * @returns {Promise<{escalated:boolean, reason?:string, notification_id?:string|null, critical_count?:number, error?:string}>}
 */
export async function escalateSamCritical(db, {
  runId = null,
  findingSummary = {},
  healthScore = null,
  productionReady = null,
  env = process.env,
  notify = null,
} = {}) {
  if (!escalationEnabled(env)) return { escalated: false, reason: 'disabled' }
  const criticalCount = Number(findingSummary?.critical || 0)
  if (criticalCount <= 0) return { escalated: false, reason: 'no_critical_findings' }
  if (!db) return { escalated: false, reason: 'no_db' }

  const emit = notify
    || (async (...args) => {
      const mod = await import('../agentControl/agentControlNotifications.js')
      return mod.notifySamCritical(...args)
    })

  try {
    const notificationId = await emit(db, {
      runId,
      criticalCount,
      totalFindings: Number(findingSummary?.total || 0),
      healthScore,
      productionReady,
    })
    return { escalated: true, notification_id: notificationId ?? null, critical_count: criticalCount }
  } catch (err) {
    return { escalated: false, reason: 'notify_failed', error: String(err?.message || err) }
  }
}

export const __testing__ = { escalationEnabled }
