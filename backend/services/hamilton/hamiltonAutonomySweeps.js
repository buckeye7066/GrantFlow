/**
 * hamiltonAutonomySweeps.js — two bounded, idempotent sweeps the scheduler
 * runs every tick so a full-automation profile's queue cannot silt up with
 * cards that no human was ever going to act on.
 *
 * 1. resolveContactFormVerifications — `submission_verification_required` is
 *    the honest quarantine for "Hamilton clicked submit and saw no receipt".
 *    Measured on prod 2026-08-31: all seven such cards on one profile were a
 *    MAILING-LIST / CONTACT form (first name + last name + email, one zip
 *    search) on a homepage — not an application. The engine now refuses those
 *    clicks (hamiltonAutopilotEngine.isContactOrNewsletterForm); this sweep
 *    settles the ones already parked: when the retained run shows the filled
 *    fields were contact-shaped and no application-shaped field existed, the
 *    task closes as "no application was submitted" instead of asking the owner
 *    to check a portal for a newsletter sign-up. A run whose evidence is not
 *    that unambiguous is left exactly as it is — the quarantine is correct.
 *
 * 2. releaseParkedReviewsUnderFullAutomation — under the profile's full-
 *    automation toggle "waiting for your review" is not a state Hamilton may
 *    park in for anything he can retry himself (owner doctrine 2026-08-22/31).
 *    The same classification the owner's "release needs-you" action uses
 *    (hamiltonNeedYouRelease.classifyNeedYouBlock) decides: a legitimate
 *    hand-off (physical copy, open missing-info ask, bot wall, external login,
 *    terms wall, maybe-submitted) stays; everything else goes back to
 *    ready_to_start. Bounded per task (at most MAX_AUTO_RELEASES lifetime, one
 *    per 24 h) so a source that keeps parking cannot loop.
 */
import { classifyNeedYouBlock } from './hamiltonNeedYouRelease.js'
import { isFullAutomationEnabled } from './hamiltonFullAutomationMode.js'
import { appendTaskEvent, updateApplicationTask, ensureApplicationTaskSchema } from './applicationTaskStore.js'
import { listAutopilotRuns } from './hamiltonAuthorizationStore.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('service:hamilton-autonomy-sweeps')

export const MAX_AUTO_RELEASES = 2
export const AUTO_RELEASE_COOLDOWN_MS = 24 * 60 * 60_000
export const AUTO_RELEASE_STEP = 'auto_release_full_automation'
export const CONTACT_FORM_RESOLVED_STEP = 'contact_form_verification_resolved'
// A TERMINAL `failed` task whose recorded failure is a race / network / click
// condition (the class the orchestrator now retries instead of failing) — the
// backlog that existed before that change. Nothing re-picks `failed`, so under
// full automation these are re-queued once through the same bounded release.
export const TRANSIENT_FAILURE_MESSAGE_RX = /could not reach|Execution context was destroyed|Target page, context or browser has been closed|Target closed|Download is starting|Submit button could not be clicked|Next button could not be clicked|net::ERR_|Timeout \d+ms exceeded|Navigation interrupted|frame got detached/i

// Keys a mailing-list / contact form asks for (mirrors the engine's
// CONTACT_FORM_KEYS; kept in step by the test).
export const CONTACT_SHAPED_KEYS = Object.freeze([
  'first_name', 'last_name', 'full_name', 'name', 'email', 'phone', 'zip', 'zip_code', 'postal_code',
  'city', 'state', 'country', 'school', 'organization', 'org_name', 'organization_name', 'message', 'comments',
])
const CONTACT_KEY_SET = new Set(CONTACT_SHAPED_KEYS)

/**
 * Was the retained run's submit a contact / newsletter form? Pure. TRUE only
 * when every filled key is contact identity, at most 4 distinct keys were
 * filled, nothing came from a narrative/LLM answer, and the run touched at
 * most 3 pages (a real multi-step application walks further).
 */
export function isContactShapedSubmission(runResult = {}) {
  const filled = Array.isArray(runResult?.filled_fields) ? runResult.filled_fields : []
  if (filled.length === 0) return false
  const keys = new Set()
  for (const f of filled) {
    const key = String(f?.key || '').toLowerCase()
    if (!key || key.startsWith('q:') || key.startsWith('id_')) return false
    if (f?.source && /narrative|llm|identity_vault|draft/i.test(String(f.source))) return false
    if (!CONTACT_KEY_SET.has(key)) return false
    keys.add(key)
  }
  if (keys.size > 4) return false
  const pages = Number(runResult?.pages_visited)
  if (Number.isFinite(pages) && pages > 3) return false
  return true
}

// A zone-less SQLite CURRENT_TIMESTAMP ("2026-08-31 14:02:11") must be read as
// UTC; Date.parse reads it as LOCAL time and shifts the cooldown by the box's
// offset (the samRateWindowRecency trap). Postgres returns a Date / ISO string.
function parseDbTime(value) {
  if (value instanceof Date) return value.getTime()
  const raw = String(value || '').trim()
  if (!raw) return NaN
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(raw)) return Date.parse(raw.replace(' ', 'T') + 'Z')
  return Date.parse(raw)
}

function parseResult(run) {
  const raw = run?.result ?? run?.result_json ?? null
  if (!raw) return {}
  if (typeof raw === 'object') return raw
  try { return JSON.parse(raw) } catch { return {} }
}

/**
 * Sweep 1. Returns counts; never throws.
 */
export async function resolveContactFormVerifications(db, { limit = 50, logger = log } = {}) {
  const out = { scanned: 0, resolved: 0, kept: 0, failed: 0, resolved_ids: [] }
  if (!db) return out
  let rows = []
  try {
    await ensureApplicationTaskSchema(db)
    rows = await db.prepare(
      `SELECT id, profile_id, user_id, application_url, portal_url, last_agent_message
         FROM application_tasks
        WHERE status = 'submission_verification_required'
        ORDER BY updated_at ASC
        LIMIT ?`,
    ).all(Math.max(1, Math.min(500, Number(limit) || 50)))
  } catch (err) {
    logger?.warn?.('contact_form_verification_scan_failed', { err: err?.message || String(err) })
    return out
  }
  for (const task of rows || []) {
    out.scanned += 1
    try {
      const runs = await listAutopilotRuns(db, { taskId: task.id, limit: 3 })
      const latest = (runs || []).find((r) => r?.status === 'submission_verification_required' || parseResult(r)?.submit_clicked === true) || (runs || [])[0]
      const result = parseResult(latest)
      if (!latest || !isContactShapedSubmission(result)) { out.kept += 1; continue }
      const url = task.application_url || task.portal_url || result?.url || 'the page'
      const keys = [...new Set((result.filled_fields || []).map((f) => String(f?.key || '')))].join(', ')
      const message = `The form Hamilton submitted on ${url} was a contact / newsletter sign-up (${keys}), not an application — no application was submitted, so there is nothing to verify on a portal. Closed as a research lead; Hamilton no longer clicks these forms.`
      await updateApplicationTask(db, task.id, {
        status: 'completed',
        nextRetryAt: null,
        lastAgentMessage: message,
      })
      await appendTaskEvent(db, {
        taskId: task.id, eventType: 'note', status: 'completed', step: CONTACT_FORM_RESOLVED_STEP,
        message, actorRole: 'agent',
        details: { autopilot_run_id: latest.id, filled_keys: keys, pages_visited: result?.pages_visited ?? null },
      })
      out.resolved += 1
      out.resolved_ids.push(task.id)
    } catch (err) {
      out.failed += 1
      logger?.warn?.('contact_form_verification_resolve_failed', { taskId: task.id, err: err?.message || String(err) })
    }
  }
  if (out.scanned > 0) logger?.info?.('contact_form_verification_sweep', out)
  return out
}

/**
 * Sweep 2. Returns counts; never throws. Only profiles whose full-automation
 * verdict (isFullAutomationEnabled) is ON are touched.
 */
export async function releaseParkedReviewsUnderFullAutomation(db, { limit = 100, now = Date.now(), logger = log } = {}) {
  const out = { scanned: 0, released: 0, kept: 0, cooled_down: 0, capped: 0, not_full_automation: 0, failed: 0, released_ids: [], kept_by_category: {} }
  if (!db) return out
  let rows = []
  try {
    await ensureApplicationTaskSchema(db)
    rows = await db.prepare(
      `SELECT id, profile_id, status, last_agent_message
         FROM application_tasks
        WHERE status IN ('waiting_for_review', 'failed')
        ORDER BY updated_at ASC
        LIMIT ?`,
    ).all(Math.max(1, Math.min(1000, Number(limit) || 100)))
  } catch (err) {
    logger?.warn?.('auto_release_scan_failed', { err: err?.message || String(err) })
    return out
  }
  if (!rows || rows.length === 0) return out

  // Open missing-info asks (category 2) — batched.
  const withOpenInfo = new Set()
  try {
    const ids = rows.map((t) => t.id)
    const ph = ids.map(() => '?').join(', ')
    const open = await db.prepare(
      `SELECT DISTINCT task_id FROM application_missing_info WHERE task_id IN (${ph}) AND resolved IS NOT TRUE`,
    ).all(...ids)
    for (const r of open || []) withOpenInfo.add(String(r.task_id))
  } catch { /* table may be absent on bare DBs */ }

  const fullAutomationByProfile = new Map()
  for (const task of rows) {
    out.scanned += 1
    try {
      const pid = String(task.profile_id || '')
      if (!fullAutomationByProfile.has(pid)) {
        let enabled = false
        try { enabled = Boolean((await isFullAutomationEnabled(db, pid))?.enabled) } catch { enabled = false }
        fullAutomationByProfile.set(pid, enabled)
      }
      if (!fullAutomationByProfile.get(pid)) { out.not_full_automation += 1; continue }

      // An OPEN missing-info ask is category 2 wherever the task is parked —
      // re-queuing it would only re-ask; the profile reconcile resumes it the
      // moment the answer lands.
      const verdict = withOpenInfo.has(String(task.id))
        ? { keep: true, category: 'missing_info', legitimate: true }
        : task.status === 'failed'
          ? (TRANSIENT_FAILURE_MESSAGE_RX.test(String(task.last_agent_message || ''))
            ? { keep: false, category: 'transient_failure', legitimate: false }
            : { keep: true, category: 'hard_failure', legitimate: false })
          : classifyNeedYouBlock(task, { hasUnresolvedInfo: false })
      if (verdict.keep) {
        out.kept += 1
        out.kept_by_category[verdict.category] = (out.kept_by_category[verdict.category] || 0) + 1
        continue
      }
      const prior = await db.prepare(
        `SELECT COUNT(*) AS n, MAX(created_at) AS last_at FROM application_task_events WHERE task_id = ? AND step = ?`,
      ).get(String(task.id), AUTO_RELEASE_STEP)
      const priorCount = Number(prior?.n) || 0
      if (priorCount >= MAX_AUTO_RELEASES) { out.capped += 1; continue }
      const lastMs = parseDbTime(prior?.last_at)
      if (Number.isFinite(lastMs) && now - lastMs < AUTO_RELEASE_COOLDOWN_MS) { out.cooled_down += 1; continue }

      const message = task.status === 'failed'
        ? `Full automation is on for this profile, and this task failed on a transient problem (${String(task.last_agent_message || '').slice(0, 140) || 'no reason recorded'}). Hamilton re-queued it to try again himself (release ${priorCount + 1} of ${MAX_AUTO_RELEASES}).`
        : `Full automation is on for this profile, and this card was parked for a review no one needed (${String(task.last_agent_message || '').slice(0, 140) || 'no reason recorded'}). Hamilton re-queued it to try again himself (release ${priorCount + 1} of ${MAX_AUTO_RELEASES}).`
      await updateApplicationTask(db, task.id, {
        status: 'ready_to_start',
        nextRetryAt: null,
        lastAgentMessage: message,
      })
      await appendTaskEvent(db, {
        taskId: task.id, eventType: 'note', status: 'ready_to_start', step: AUTO_RELEASE_STEP,
        message, actorRole: 'agent',
        details: { release_number: priorCount + 1, max_releases: MAX_AUTO_RELEASES, previous_message: String(task.last_agent_message || '').slice(0, 300) },
      })
      out.released += 1
      out.released_ids.push(task.id)
    } catch (err) {
      out.failed += 1
      logger?.warn?.('auto_release_failed', { taskId: task.id, err: err?.message || String(err) })
    }
  }
  if (out.scanned > 0) logger?.info?.('auto_release_sweep', { ...out, released_ids: out.released_ids.length })
  return out
}

export default {
  resolveContactFormVerifications,
  releaseParkedReviewsUnderFullAutomation,
  isContactShapedSubmission,
  MAX_AUTO_RELEASES,
  AUTO_RELEASE_COOLDOWN_MS,
}
