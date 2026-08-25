/**
 * Publish the running process's automation posture to `system_kv`.
 *
 * WHY: the production audit bridge runs in GitHub Actions, which deliberately
 * holds NO Railway credentials (a Railway token in CI would be a far larger
 * exposure than the audit is worth). So the auditor cannot ask Railway what
 * HAMILTON_ALLOW_AUTOSUBMIT is set to. It has exactly two channels into
 * production: the scoped read-only database role, and the public HTTP surface.
 * This writes the answer into the first one.
 *
 * WHAT IS AND IS NOT PUBLISHED: booleans only — whether each gate is armed.
 * No values, no secrets, no connection material. Knowing "auto-submit is off"
 * is precisely what an auditor must be able to prove before it is allowed to
 * touch an authenticated surface.
 *
 * THE STALENESS TRAP: a row saying `allow_auto_submit: false` is worthless on
 * its own — it may have been written by a deploy that has since been replaced
 * by one where the flag is armed. Environment changes only take effect on a
 * redeploy, so the honest question is not "is this row recent?" but "did the
 * process serving traffic right now write it?". BOOT_ID answers that: it is
 * minted per process, stored here, and echoed by GET /api/health/deployment.
 * The auditor compares the two and refuses to proceed unless they match.
 */

import { BOOT_ID } from '../config/bootId.js'
import {
  isAutoSubmitGloballyEnabled,
  isBrowserAutomationEnabled,
} from '../services/hamiltonApplicationAgent.js'

export const AUTOMATION_POSTURE_KV_KEY = 'automation_posture'

function changesOf(result) {
  if (!result) return 0
  if (typeof result.changes === 'number') return result.changes
  if (typeof result.rowCount === 'number') return result.rowCount
  return 0
}

/**
 * Resolve the posture WITHOUT re-implementing any gate.
 *
 * `isAutoSubmitGloballyEnabled` is the same function hamiltonApplicationAgent
 * consults before it will submit anything, so this record cannot drift from the
 * behavior it describes. Re-deriving it from process.env here would create a
 * second source of truth that reads green while the real gate says otherwise.
 */
export function buildAutomationPosture(env = process.env) {
  return {
    // The gate that matters: the audit aborts unless this is false.
    allow_auto_submit: isAutoSubmitGloballyEnabled(),
    browser_automation: isBrowserAutomationEnabled(),
    run_on_schedule: String(env.HAMILTON_RUN_ON_SCHEDULE || 'false').toLowerCase() === 'true',
    // Unset means the legacy tailored checkpoint is ON (tailoredNarrative.js), so absence is
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
    if (posture.allow_auto_submit) {
      logger?.warn?.('[automation-posture] HAMILTON_ALLOW_AUTOSUBMIT is ARMED in this process')
    }
    return posture
  } catch (err) {
    logger?.warn?.('[automation-posture] could not record posture (non-fatal):', err?.message || err)
    return null
  }
}
