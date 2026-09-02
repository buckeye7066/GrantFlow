/**
 * hamiltonStopRecheck.js — re-check SYSTEM-side task stops against current
 * state, so a stop that no longer reproduces cannot pile up forever.
 *
 * The class (owner report 2026-07-27, Demo College Student Persona's 41 stops): Hamilton's
 * preflight files hard stops as application_missing_info rows —
 *   • key 'crawler_profile_rules' ("Funding source does not meet GrantFlow
 *     crawler/profile rules", e.g. missing_profile_crawler_match)
 *   • key 'application_url' ("Portal URL is missing")
 * — but NOTHING ever re-ran the check. The blocked-task self-heal
 * deliberately skips tasks with non-profile-field items (conservative class
 * gate), so these stops were permanent BY CONSTRUCTION: a later crawl that
 * endorses the (profile, opportunity) pair, or a URL-rescue that finds the
 * portal page, changed nothing for the task that was already stopped. Worse,
 * 18 of Robert's 33 stops sat on tasks whose GRANT ROW HAD BEEN PURGED —
 * unfulfillable zombies announcing themselves as "needs your input" forever.
 *
 * THE RULE: every stop is re-checked with the SAME code that wrote it (no
 * drift — assessHamiltonFundingSource for policy stops; the same usable-URL
 * bar the URL hygiene rules use), with three honest outcomes:
 *   1. The check now PASSES → resolve the stop; a task with nothing else
 *      outstanding resumes automatically (Hamilton continues on his own).
 *   2. The funding source NO LONGER EXISTS (grant and catalog row both gone —
 *      purged upstream as junk/dismissed) → CANCEL the task. A task for a
 *      deleted source can never be fulfilled; leaving it blocked is a lie.
 *   3. The canonical policy still refuses the source → CANCEL the task. A
 *      policy-refused source is discovery/history, never unfinished work that
 *      asks the owner to unblock an application Hamilton must not pursue.
 */

import {
  ensureApplicationTaskSchema,
  listMissingInfo,
  resolveMissingInfoItem,
  resumeTaskAfterMissingInfo,
  appendTaskEvent,
  updateApplicationTask,
  cancelApplicationTask,
} from './applicationTaskStore.js'
import { assessHamiltonFundingSource } from './hamiltonFundingSourcePolicy.js'
import { isSearchEngineUrl } from '../../config/urlRules.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('service:hamiltonStopRecheck')

// 'school_name' (2026-08-30): preflight used to HARD-BLOCK any source whose
// copy merely said "grant"/"aid" on "Profile is missing school / university".
// That bar is retired — a missing school is a preflight WARNING now, and the
// engine asks for the exact field only when a real form requires it — so every
// unresolved school_name stop is a stop whose writer no longer exists. The
// recheck clears them so those tasks resume instead of sitting blocked forever.
const RECHECKABLE_KEYS = ['crawler_profile_rules', 'application_url', 'school_name']
const SKIP_STATUSES = ['submitted', 'draft_completed', 'completed_draft', 'failed', 'cancelled', 'completed']

function usableUrl(...candidates) {
  for (const raw of candidates) {
    const u = String(raw || '').trim()
    if (!/^https?:\/\//i.test(u)) continue
    if (isSearchEngineUrl(u)) continue
    return u
  }
  return null
}

async function loadRow(db, table, id) {
  if (!id) return null
  try {
    return await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(String(id))
  } catch {
    return null
  }
}

// Trust reasons that mean "the ONLY problem is a link marked broken" — the
// class where re-probing the URL right now can clear the whole stop. An
// insert-time HEAD probe that failed once (bot-block/timeout) stamps
// link_status='broken' WITH last_verified_at, so the recurring verifier will
// not revisit for its re-verify window while every task on the row stays
// blocked (the MTSU off-campus-housing-portal chain, 2026-07-27).
const LINK_ONLY_TRUST_REASONS = new Set([
  'link_marked_broken', 'hidden_broken_direct_link', 'link_unverified',
])

function blockedOnlyByLink(assessment) {
  const reasons = Array.isArray(assessment?.reasons) ? assessment.reasons : []
  return (
    assessment?.code === 'funding_source_disallowed' &&
    reasons.length > 0 &&
    reasons.every((r) => LINK_ONLY_TRUST_REASONS.has(String(r)))
  )
}

async function resolveCancelledStops(db, taskId, items, reason) {
  for (const item of items || []) {
    try {
      await resolveMissingInfoItem(db, taskId, {
        kind: item.kind,
        key: item.key,
        value: `task_cancelled:${reason}`,
        resolvedBy: 'stop_recheck',
      })
    } catch {
      // Cancellation is authoritative. A later precision cleanup removes any
      // legacy blocker row whose schema could not be updated here.
    }
  }
}

/**
 * Re-check unresolved system stops on live tasks.
 * @param {object} deps.verifyLink — test seam; defaults to the canonical
 *   verifyOpportunityLinkNow (same prober + write path as the recurring sweep).
 * @returns {Promise<{scannedTasks:number, itemsResolved:number, tasksResumed:number, tasksCancelled:number, leftHonest:number, linksReverified:number}>}
 */
export async function recheckHamiltonPolicyStops(db, { limit = 200, enforce = true, verifyLink = null } = {}) {
  const out = { scannedTasks: 0, itemsResolved: 0, tasksResumed: 0, tasksCancelled: 0, leftHonest: 0, linksReverified: 0 }
  if (!db || typeof db.prepare !== 'function') return out
  await ensureApplicationTaskSchema(db)

  const keyPh = RECHECKABLE_KEYS.map(() => '?').join(',')
  const skipPh = SKIP_STATUSES.map(() => '?').join(',')
  let taskRows = []
  try {
    // `resolved IS NOT TRUE` on purpose: INTEGER on SQLite, BOOLEAN on prod
    // Postgres (the #944-family dialect trap).
    taskRows = await db.prepare(`
      SELECT DISTINCT at.id
        FROM application_missing_info mi
        JOIN application_tasks at ON at.id = mi.task_id
       WHERE mi.resolved IS NOT TRUE
         AND mi.key IN (${keyPh})
         AND at.status NOT IN (${skipPh})
       LIMIT ${Number.isFinite(Number(limit)) ? Math.max(1, Number(limit)) : 200}
    `).all(...RECHECKABLE_KEYS, ...SKIP_STATUSES)
    if (!Array.isArray(taskRows)) taskRows = []
  } catch {
    return out
  }

  for (const { id: taskId } of taskRows) {
    out.scannedTasks += 1
    const task = await loadRow(db, 'application_tasks', taskId)
    if (!task) continue
    const items = (await listMissingInfo(db, taskId, { includeResolved: false }))
      .filter((m) => RECHECKABLE_KEYS.includes(String(m.key)))
    if (items.length === 0) continue

    const grant = await loadRow(db, 'grants', task.grant_id)
    const opportunity = await loadRow(
      db, 'funding_opportunities', task.opportunity_id || grant?.funding_opportunity_id,
    )

    let resolvedHere = 0
    let cancelled = false
    for (const item of items) {
      if (String(item.key) === 'school_name') {
        // The preflight rule that wrote this stop is retired (missing school is
        // a warning; the engine asks per-form when a form really requires it).
        // Resolve unconditionally so the task resumes.
        if (!enforce) continue
        const ok = await resolveMissingInfoItem(db, taskId, {
          kind: item.kind, key: item.key,
          value: 'preflight_school_bar_retired', resolvedBy: 'stop_recheck',
        })
        if (ok) { resolvedHere += 1; out.itemsResolved += 1 }
        continue
      }
      if (String(item.key) === 'application_url') {
        const url = usableUrl(
          task.application_url, task.portal_url,
          grant?.application_url, grant?.url,
          opportunity?.application_url, opportunity?.source_url,
        )
        if (!url) { out.leftHonest += 1; continue }
        if (!enforce) continue
        // Record the found URL ON THE TASK so Hamilton can actually drive it,
        // then clear the stop.
        if (!usableUrl(task.application_url, task.portal_url)) {
          try { await updateApplicationTask(db, taskId, { applicationUrl: url }) } catch { /* keep resolving */ }
        }
        const ok = await resolveMissingInfoItem(db, taskId, {
          kind: item.kind, key: item.key, value: url, resolvedBy: 'stop_recheck',
        })
        if (ok) { resolvedHere += 1; out.itemsResolved += 1 }
        continue
      }

      // crawler_profile_rules — re-run the SAME policy that wrote the stop.
      let assessment = await assessHamiltonFundingSource(db, {
        profileId: task.profile_id, opportunity, grant,
      })
      // Blocked ONLY by a broken-link mark? Probe the URL right now (the mark
      // may be an insert-time transient the recurring verifier won't revisit
      // for weeks) and re-assess on a fresh row. Enforce-gated: count-only
      // runs must not write verification columns either.
      if (!assessment.ok && enforce && opportunity && blockedOnlyByLink(assessment)) {
        try {
          const doVerify = verifyLink ?? (await import('../linkVerificationService.js')).verifyOpportunityLinkNow
          const probe = await doVerify(db, opportunity, { verifiedBy: 'hamilton-stop-recheck' })
          if (probe?.updated) {
            out.linksReverified += 1
            const fresh = await loadRow(db, 'funding_opportunities', opportunity.id)
            if (fresh) {
              assessment = await assessHamiltonFundingSource(db, {
                profileId: task.profile_id, opportunity: fresh, grant,
              })
            }
          }
        } catch { /* probe is best-effort; the honest stop stays */ }
      }
      if (assessment.ok) {
        if (!enforce) continue
        const ok = await resolveMissingInfoItem(db, taskId, {
          kind: item.kind, key: item.key,
          value: 'policy_recheck_passed', resolvedBy: 'stop_recheck',
        })
        if (ok) { resolvedHere += 1; out.itemsResolved += 1 }
      } else if (assessment.unavailable) {
        // An engine/database outage is our problem, not proof the source is
        // invalid. Leave the durable task untouched; the live queue refuses to
        // display unverified work until a later audit succeeds.
        out.leftHonest += 1
        continue
      } else if (assessment.code === 'missing_funding_source') {
        // The grant AND catalog row are gone — purged upstream (relevance
        // floor, sticky delete, dedup). The task can never be fulfilled.
        if (!enforce) continue
        try {
          await cancelApplicationTask(db, taskId, {
            actorRole: 'system',
            reason: 'funding source no longer exists (purged upstream) — unfulfillable task closed by stop recheck',
          })
          cancelled = true
          out.tasksCancelled += 1
          await resolveCancelledStops(db, taskId, items, 'missing_funding_source')
          await appendTaskEvent(db, {
            taskId,
            eventType: 'cancelled',
            status: 'cancelled',
            step: 'stop_recheck',
            message: 'The funding source behind this task was removed from the catalog (junk/dismissed upstream), so the task can never proceed — closed automatically.',
            actorRole: 'agent',
            details: { via: 'stop_recheck', reason: 'missing_funding_source' },
          })
        } catch { /* best-effort; next sweep retries */ }
        break // no point rechecking the task's other items
      } else {
        if (!enforce) { out.leftHonest += 1; continue }
        try {
          const reason = `funding source failed current Hamilton policy (${assessment.gate || assessment.code || 'unknown'}) — invalid application task closed by stop recheck`
          await cancelApplicationTask(db, taskId, { actorRole: 'system', reason })
          cancelled = true
          out.tasksCancelled += 1
          await resolveCancelledStops(db, taskId, items, assessment.gate || assessment.code || 'policy')
          await appendTaskEvent(db, {
            taskId,
            eventType: 'cancelled',
            status: 'cancelled',
            step: 'stop_recheck',
            message: 'This source no longer passes the live application policy, so it was removed from unfinished work.',
            actorRole: 'agent',
            details: {
              via: 'stop_recheck',
              gate: assessment.gate || null,
              code: assessment.code || null,
              reasons: assessment.reasons || [],
            },
          })
        } catch { out.leftHonest += 1 }
        break
      }
    }

    if (cancelled || resolvedHere === 0) continue
    const remaining = await listMissingInfo(db, taskId, { includeResolved: false })
    const resume = await resumeTaskAfterMissingInfo(db, taskId, {
      resolvedCount: resolvedHere, remainingCount: remaining.length,
    })
    if (resume.resumed) {
      out.tasksResumed += 1
      await appendTaskEvent(db, {
        taskId,
        eventType: 'unblocked',
        status: 'ready',
        step: 'stop_recheck',
        message: 'The condition this task was stopped on no longer holds (source now endorsed / portal URL found) — task re-queued; Hamilton will resume automatically.',
        actorRole: 'agent',
        details: { auto_resumed: true, via: 'stop_recheck', items_resolved: resolvedHere },
      })
    }
  }

  if (out.itemsResolved > 0 || out.tasksCancelled > 0) {
    log.info('recheck cleared stops that no longer reproduce', out)
  }
  return out
}

export default { recheckHamiltonPolicyStops }
