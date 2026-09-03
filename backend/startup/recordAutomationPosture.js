/**
 * Publish the running process's automation posture to `system_kv`.
 *
 * WHY: the production audit bridge runs in GitHub Actions, which deliberately
 * holds NO Railway credentials (a Railway token in CI would be a far larger
 * exposure than the audit is worth). It has exactly two channels into
 * production: the scoped read-only database role, and the public HTTP surface.
 * This publishes the active submission authority through the first channel.
 *
 * WHAT IS AND IS NOT PUBLISHED: booleans and authority identifiers only — no
 * profile consent, values, secrets, or connection material. The audit proves
 * Hamilton requires profile-scoped authorization and that the posture came
 * from the process currently serving traffic.
 *
 * THE STALENESS TRAP: an authority row is worthless on its own — it may have
 * been written by a deploy that has since been replaced. BOOT_ID answers the
 * honest question, "did the process serving traffic right now write it?". It is
 * minted per process, stored here, and echoed by GET /api/health/deployment.
 * The auditor compares the two and refuses to proceed unless they match.
 */

import { BOOT_ID } from '../config/bootId.js'
import { isBrowserAutomationEnabled } from '../services/hamiltonApplicationAgent.js'

export const AUTOMATION_POSTURE_KV_KEY = 'automation_posture'

function changesOf(result) {
  if (!result) return 0
  if (typeof result.changes === 'number') return result.changes
  if (typeof result.rowCount === 'number') return result.rowCount
  return 0
}

/**
 * Resolve the posture without claiming that a retired process-wide feature
 * flag controls submission. The canonical orchestrator authorizes each
 * irreversible action from the profile owner's stored consent and re-reads it
 * immediately before the final click.
 */
export function buildAutomationPosture(env = process.env) {
  return {
    // There is intentionally no process-wide auto-submit veto. Audits that
    // require a non-mutating target must use a profile with no full-automation
    // authorization; old auditors looking for allow_auto_submit:false now fail
    // closed because this obsolete field is absent.
    submission_authority: 'profile_authorization',
    profile_authorization_required: true,
    external_submission_possible: true,
    browser_automation: isBrowserAutomationEnabled(),
    run_on_schedule: String(env.HAMILTON_RUN_ON_SCHEDULE || 'false').toLowerCase() === 'true',
    // Unset means the approval gate is ON (tailoredNarrative.js), so absence is
    // the SAFE reading here — do not "simplify" this to a plain truthy check.
    tailored_approval_gate: String(env.HAMILTON_TAILORED_APPROVAL_GATE ?? 'true').toLowerCase() !== 'false',
    boot_id: BOOT_ID,
    captured_at: new Date().toISOString(),
  }
}

/**
 * Write the posture. Best-effort and never throws: this is an observability
 * record, and a boot must not fail because a KV write failed. A MISSING row is
 * safe by construction — the auditor treats "cannot verify" as "abort", so the
 * failure mode of this function is a refused audit, never a permitted one.
 */
export async function recordAutomationPosture(db, { logger = console } = {}) {
  const posture = buildAutomationPosture()
  try {
    const value = JSON.stringify(posture)
    const now = new Date().toISOString()
    // UPDATE-then-INSERT: the shim-safe upsert this repo uses everywhere for
    // system_kv (see services/pipelinePromotion.js kvSet).
    const updated = await db
      .prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?')
      .run(value, now, AUTOMATION_POSTURE_KV_KEY)
    if (!changesOf(updated)) {
      await db
        .prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)')
        .run(AUTOMATION_POSTURE_KV_KEY, value, now)
    }
    logger?.info?.('[automation-posture] external submission requires current profile authorization')
    return posture
  } catch (err) {
    logger?.warn?.('[automation-posture] could not record posture (non-fatal):', err?.message || err)
    return null
  }
}
