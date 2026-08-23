/**
 * hamiltonFullAutomationMode.js
 *
 * ONE authority for "is this profile in full automation, and does every
 * downstream gate agree with that answer".
 *
 * WHY THIS EXISTS
 * ---------------
 * Owner report 2026-08-21: Hamilton can navigate and fill supported portals but
 * cannot work the portal queue unattended, because switching the profile toggle
 * ON did not actually reach the three places that decide whether he may finish:
 *
 *   1. LEGACY VETOES. `resolveSubmissionDecision` treats ANY active
 *      authorization row carrying `options.require_human_review === true` as an
 *      unconditional veto, and it reads rows at EVERY scope (profile, funding
 *      source, task). The authorization writer only ever rewrites the row for
 *      the exact (scope, target) it was called with. So a
 *      `require_human_review: true` grant recorded months ago against one task
 *      or one funding source kept vetoing forever, no matter how many times the
 *      profile-wide toggle was switched on. The UI default is already `false`;
 *      the DATA was the blocker.
 *
 *   2. PER-TASK INTENT. Submission requires the live task's
 *      `allow_auto_submit` column, which defaults to FALSE and was only ever
 *      set by passing `options.allow_auto_submit` on a specific launch. A
 *      profile-wide consent never reached the 900-odd tasks already sitting in
 *      the queue, so the standing authorization was true and every task still
 *      said "not_requested".
 *
 *   3. RUNTIME CAPABILITY. The run path passes `attemptVerification` to the
 *      engine (Hamilton reading a one-time code from HIS OWN mailbox/SMS, which
 *      is what HAMILTON_IDENTITY exists for) only when `allowAutoSubmit` is
 *      true — that flag is the runtime spelling of "full automation". With
 *      (1) and (2) unfixed it was false, so the 2FA-clearing path that already
 *      shipped could never run on a real portal login.
 *
 * So this module does not invent a second consent model. It makes the ONE
 * authority — `resolveSubmissionDecision` — receive true inputs when the owner
 * of the profile has said yes, and it reports exactly what it changed.
 *
 * NO SILENT NO-OPS. Every sweep returns `candidates`, what it acted on, and
 * what it skipped and why. A sweep that changes nothing says so with numbers;
 * it never returns a bare `ok: true`.
 *
 * WHAT THIS MODULE DOES NOT DO
 * ----------------------------
 * It does not lower the irreversible-submit boundary. `resolveSubmissionDecision`
 * is still called immediately before the portal click, a revocation mid-run
 * still wins, and submission still requires a persisted, currently-active
 * `submit_applications` grant. This module changes which inputs that decision
 * sees — never whether it is consulted.
 */

import { normalizeAutomationToggles, isAutomationEnabled } from '../../../shared/automationPreferences.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('service:hamilton-full-automation')

/**
 * Every capability a full-automation profile grants. Mirrors the frontend's
 * AUTOMATION_TYPES so the two cannot drift; the backend validates against
 * HAMILTON_AUTHORIZATION_TYPES either way.
 */
export const FULL_AUTOMATION_AUTHORIZATION_TYPES = Object.freeze([
  'complete_forms',
  'upload_documents',
  'generate_narratives',
  'save_drafts',
  'submit_applications',
  'use_saved_session',
  'use_saved_credentials_reference',
  'use_standing_attestation',
])

/**
 * The option block a full-automation grant carries.
 *
 * `allow_auto_submit` and `require_human_review` are OPTIONS on the grant row,
 * not authorization TYPES — see hamiltonIdentity.hasFullAutomation, which reads
 * exactly this shape.
 */
export const FULL_AUTOMATION_OPTIONS = Object.freeze({
  complete_forms: true,
  upload_documents: true,
  generate_narratives: true,
  save_drafts: true,
  submit_applications: true,
  allow_auto_submit: true,
  use_saved_session: true,
  use_saved_credentials_reference: true,
  use_standing_attestation: true,
  require_human_review: false,
})

/**
 * Statuses a sweep must NOT touch.
 *
 * Terminal states are finished. The submission-uncertain states are the
 * irreversible-boundary quarantine: a task that may already have been submitted
 * without captured evidence is never re-armed by a bulk toggle — the one person
 * who can settle whether it went through has to look at it.
 */
export const SWEEP_EXCLUDED_STATUSES = Object.freeze([
  'submitted',
  'failed',
  'cancelled',
  'submit_attempt_started',
  'submit_evidence_pending',
  'submission_verification_required',
])

function parseOptions(raw) {
  if (raw === null || raw === undefined) return {}
  if (typeof raw === 'object') return raw
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Does this authorize request describe full automation? Used by the route to
 * decide whether to run the sweep after recording the grant.
 */
export function isFullAutomationGrant(authorizationTypes = [], options = {}) {
  const types = Array.isArray(authorizationTypes) ? authorizationTypes : []
  if (!types.includes('submit_applications')) return false
  if (options?.require_human_review === true) return false
  return options?.allow_auto_submit === true
}

/**
 * May Hamilton CREATE a portal account for this profile right now?
 *
 * Full automation (submit_applications + allow_auto_submit + no human-review
 * veto) is the irreversible consent for registration. Credential-use is also
 * required because signup writes into the same vault the credential grant
 * covers. `readAuthorizations` does NOT surface `allow_auto_submit`, so callers
 * must pass the live `isFullAutomationEnabled` verdict — never reconstruct
 * "full automation" from submit+credentials alone.
 */
export function isPortalAccountCreationAuthorized({
  fullAutomationActive = false,
  useSavedCredentialsReference = false,
} = {}) {
  return fullAutomationActive === true && useSavedCredentialsReference === true
}

/**
 * Every non-revoked authorization row for a profile, at any scope. The shared
 * candidate set for the status predicate and the veto sweep, so the two can
 * never disagree about which rows exist.
 */
async function listAllActiveAuthorizations(db, profileId) {
  const rows = await db.prepare(
    `SELECT id, scope, authorization_type, funding_source_id, task_id, options_json
       FROM hamilton_authorizations
      WHERE profile_id = ? AND revoked_at IS NULL`,
  ).all(String(profileId))
  return (rows || []).map((row) => ({
    id: row.id,
    scope: row.scope,
    authorization_type: row.authorization_type,
    funding_source_id: row.funding_source_id ?? null,
    task_id: row.task_id ?? null,
    options: parseOptions(row.options_json),
  }))
}

/**
 * Read-side predicate: is full automation currently in force for this profile?
 *
 * Deliberately mirrors `resolveSubmissionDecision`'s own rules (a
 * `submit_applications` grant, `allow_auto_submit` on an active row, and NO
 * `require_human_review` veto at any scope) so the two can't disagree. Returns
 * the reason as well as the verdict, because "why is Hamilton not submitting"
 * is the question this whole module exists to answer.
 */
export async function isFullAutomationEnabled(db, profileId) {
  if (!db || !profileId) return { enabled: false, reason: 'missing_profile', vetoes: [] }
  // EVERY active row for the profile, at EVERY scope — NOT
  // `listActiveAuthorizations`, which filters targets against the
  // fundingSourceId/taskId it was given and therefore returns only
  // profile-scoped rows when both are null (`funding_source_id = NULL` is never
  // true in SQL). A veto recorded against ONE task is invisible to that read
  // while `resolveSubmissionDecision(db, { taskId })` sees it and refuses — the
  // exact read/write asymmetry this module exists to close, so the status
  // predicate has to use the WIDER set or it reports "ready" for a profile that
  // will still refuse on the tasks that carry the legacy row.
  const active = await listAllActiveAuthorizations(db, profileId)
  const vetoes = active.filter((row) => parseOptions(row.options)?.require_human_review === true)
  const submit = active.find((row) => row.authorization_type === 'submit_applications') || null
  const autoSubmit = active.some((row) => parseOptions(row.options)?.allow_auto_submit === true)

  let reason = 'full_automation'
  if (!submit) reason = 'missing_submit_authorization'
  else if (!autoSubmit) reason = 'auto_submit_not_authorized'
  else if (vetoes.length > 0) reason = 'human_review_required'

  return {
    enabled: Boolean(submit) && autoSubmit && vetoes.length === 0,
    reason,
    authorization_id: submit?.id || null,
    vetoes: vetoes.map((row) => ({
      id: row.id,
      scope: row.scope,
      funding_source_id: row.funding_source_id,
      task_id: row.task_id,
      authorization_type: row.authorization_type,
    })),
  }
}

/**
 * Blocker (2): clear `require_human_review` from every ACTIVE authorization row
 * for this profile, at every scope.
 *
 * The row itself is kept (revoking it would drop the capability it grants); only
 * the veto option is rewritten, and the previous value is recorded in metadata
 * so the audit trail still shows a human-review preference existed and when it
 * was lifted, by whom.
 *
 * Returns counts, never a bare boolean — a sweep that finds nothing to clear
 * must be distinguishable from a sweep that never ran.
 */
export async function clearHumanReviewVetoes(db, { profileId, userId = null } = {}) {
  const result = { candidates: 0, cleared: 0, cleared_ids: [], skipped: 0, failed: 0 }
  if (!db || !profileId) return result

  const rows = await db.prepare(
    `SELECT id, options_json, metadata_json FROM hamilton_authorizations
      WHERE profile_id = ? AND revoked_at IS NULL`,
  ).all(String(profileId))

  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  for (const row of rows || []) {
    const options = parseOptions(row.options_json)
    if (options.require_human_review !== true) { result.skipped += 1; continue }
    result.candidates += 1
    const metadata = parseOptions(row.metadata_json)
    const nextOptions = { ...options, require_human_review: false }
    const nextMetadata = {
      ...metadata,
      human_review_veto_cleared_at: new Date().toISOString(),
      human_review_veto_cleared_by: userId ? String(userId) : 'full_automation_sweep',
      human_review_veto_previous_value: true,
    }
    try {
      await db.prepare(
        `UPDATE hamilton_authorizations
            SET options_json = ?, metadata_json = ?, updated_at = ${nowFn}
          WHERE id = ?`,
      ).run(JSON.stringify(nextOptions), JSON.stringify(nextMetadata), row.id)
      result.cleared += 1
      result.cleared_ids.push(row.id)
    } catch (err) {
      result.failed += 1
      log.error('clear_human_review_veto_failed', { authorization_id: row.id, err: err?.message })
    }
  }
  return result
}

/**
 * Blocker (3): carry the profile-wide decision down to the live tasks.
 *
 * `allow_auto_submit` is the per-task intent flag the submission boundary
 * reads; `auto_submit_enabled` is its retired twin, kept in step because a
 * stale value there has already caused one class of wrong-looking task
 * (applicationTaskStore's own note). Excluded statuses are never touched.
 */
export async function propagateAutoSubmitToTasks(db, { profileId, enable = true } = {}) {
  const result = {
    candidates: 0,
    updated: 0,
    already_correct: 0,
    skipped_by_reason: {},
    excluded_statuses: [...SWEEP_EXCLUDED_STATUSES],
  }
  if (!db || !profileId) {
    result.skipped_by_reason.missing_profile = 1
    return result
  }

  const rows = await db.prepare(
    `SELECT id, status, allow_auto_submit, cancelled_at FROM application_tasks WHERE profile_id = ?`,
  ).all(String(profileId))

  const target = enable ? 1 : 0
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  const boolValue = db?.dialect === 'postgres' ? Boolean(target) : target

  for (const row of rows || []) {
    const status = String(row.status || '')
    if (row.cancelled_at) {
      result.skipped_by_reason.cancelled = (result.skipped_by_reason.cancelled || 0) + 1
      continue
    }
    if (SWEEP_EXCLUDED_STATUSES.includes(status)) {
      const key = `status:${status}`
      result.skipped_by_reason[key] = (result.skipped_by_reason[key] || 0) + 1
      continue
    }
    result.candidates += 1
    if (Boolean(row.allow_auto_submit) === Boolean(target)) {
      result.already_correct += 1
      continue
    }
    const updateResult = await db.prepare(
      `UPDATE application_tasks
          SET allow_auto_submit = ?, auto_submit_enabled = ?, updated_at = ${nowFn}
        WHERE id = ?`,
    ).run(boolValue, boolValue, row.id)
    result.updated += Number(updateResult?.changes ?? updateResult?.rowCount ?? 0)
  }
  return result
}

/**
 * The FIFTH gate, and the one the owner's blocker list did not name.
 *
 * `automation_preferences.automations.hamilton_auto_submit` is a SECOND consent
 * store, held on the profile_sections row rather than in hamilton_authorizations,
 * and it defaults to FALSE. The orchestrator re-reads it at the irreversible
 * boundary (`profile_auto_submit_disabled`) and the tailored gate refuses on it
 * again (`automation_off`). `hamilton_autopilot` gates the unattended RUN itself,
 * so a queue can't even start without it.
 *
 * Granting the Hamilton authorization while leaving these false is precisely the
 * "authorized but still never submits" state the owner is reporting, so the
 * toggle has to move both stores or it has not really been switched on.
 *
 * Read/write are inlined here (the profiles route keeps its own copies
 * module-private) and deliberately touch ONLY the two Hamilton keys —
 * discovery and pipeline preferences are not this toggle's business.
 */
export async function alignAutomationPreferences(db, { profileId, userId = null, enable = true } = {}) {
  const result = { before: null, after: null, changed: [], failed: null }
  if (!db || !profileId) { result.failed = 'missing_profile'; return result }

  let prefs = {}
  try {
    const row = await db.prepare(
      `SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = 'automation_preferences' LIMIT 1`,
    ).get(String(profileId))
    if (row?.data) prefs = typeof row.data === 'string' ? JSON.parse(row.data) : row.data
  } catch (err) {
    result.failed = `read_failed:${err?.message || err}`
    return result
  }
  if (!prefs || typeof prefs !== 'object') prefs = {}

  const before = normalizeAutomationToggles(prefs.automations)
  result.before = before
  const after = { ...before, hamilton_autopilot: enable, hamilton_auto_submit: enable }
  result.after = after
  for (const key of ['hamilton_autopilot', 'hamilton_auto_submit']) {
    if (before[key] !== after[key]) result.changed.push(key)
  }
  if (result.changed.length === 0) return result

  const next = { ...prefs, automations: after }
  const data = JSON.stringify(next)
  try {
    const existing = await db.prepare(
      `SELECT 1 AS x FROM profile_sections WHERE profile_id = ? AND section_key = 'automation_preferences'`,
    ).get(String(profileId))
    if (existing) {
      await db.prepare(
        `UPDATE profile_sections SET data = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
          WHERE profile_id = ? AND section_key = 'automation_preferences'`,
      ).run(data, userId ?? null, String(profileId))
    } else {
      await db.prepare(
        `INSERT INTO profile_sections (profile_id, section_key, data, updated_by, updated_at)
          VALUES (?, 'automation_preferences', ?, ?, CURRENT_TIMESTAMP)`,
      ).run(String(profileId), data, userId ?? null)
    }
  } catch (err) {
    result.failed = `write_failed:${err?.message || err}`
    result.changed = []
  }
  return result
}

/**
 * Are the profile preference toggles in the position full automation needs?
 * Reported alongside the authorization verdict so "why is Hamilton not
 * submitting" has one answer, not two half-answers in different stores.
 */
export async function readAutomationPreferenceState(db, profileId) {
  if (!db || !profileId) return { hamilton_autopilot: false, hamilton_auto_submit: false, readable: false }
  try {
    const row = await db.prepare(
      `SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = 'automation_preferences' LIMIT 1`,
    ).get(String(profileId))
    const prefs = row?.data ? (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) : {}
    return {
      hamilton_autopilot: isAutomationEnabled(prefs, 'hamilton_autopilot'),
      hamilton_auto_submit: isAutomationEnabled(prefs, 'hamilton_auto_submit'),
      readable: true,
    }
  } catch {
    return { hamilton_autopilot: false, hamilton_auto_submit: false, readable: false }
  }
}

/**
 * The whole sweep, run whenever a profile turns full automation ON (or OFF).
 *
 * On ENABLE it clears the legacy human-review vetoes and arms the queue. On
 * DISABLE it does NOT re-add vetoes (that would forge a preference nobody
 * expressed) — it only disarms the per-task intent flag, which is the honest
 * inverse: the standing authorization is what the caller revokes separately.
 */
export async function applyFullAutomationSweep(db, { profileId, userId = null, enable = true } = {}) {
  const startedAt = new Date().toISOString()
  const vetoes = enable
    ? await clearHumanReviewVetoes(db, { profileId, userId })
    : { candidates: 0, cleared: 0, cleared_ids: [], skipped: 0, failed: 0, not_run: 'disable_does_not_restore_vetoes' }
  const preferences = await alignAutomationPreferences(db, { profileId, userId, enable })
  const tasks = await propagateAutoSubmitToTasks(db, { profileId, enable })
  const status = await isFullAutomationEnabled(db, profileId)
  const preferenceState = await readAutomationPreferenceState(db, profileId)

  const summary = {
    profile_id: String(profileId),
    enable,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    human_review_vetoes: vetoes,
    automation_preferences: preferences,
    tasks,
    full_automation: status,
    preference_state: preferenceState,
    // The honest end-state: authorization AND both preference toggles have to
    // agree before an unattended submit can happen. Reporting only the
    // authorization verdict is how "authorized but never submits" stayed
    // invisible.
    unattended_submit_ready: Boolean(
      status.enabled && preferenceState.hamilton_autopilot && preferenceState.hamilton_auto_submit,
    ),
  }
  log.info('full_automation_sweep', {
    profile_id: String(profileId),
    enable,
    vetoes_cleared: vetoes.cleared,
    task_candidates: tasks.candidates,
    tasks_updated: tasks.updated,
    enabled_after: status.enabled,
    reason_after: status.reason,
    preferences_changed: preferences.changed,
    unattended_submit_ready: summary.unattended_submit_ready,
  })
  return summary
}

export default {
  FULL_AUTOMATION_AUTHORIZATION_TYPES,
  FULL_AUTOMATION_OPTIONS,
  SWEEP_EXCLUDED_STATUSES,
  isFullAutomationGrant,
  isFullAutomationEnabled,
  clearHumanReviewVetoes,
  propagateAutoSubmitToTasks,
  alignAutomationPreferences,
  readAutomationPreferenceState,
  applyFullAutomationSweep,
}
