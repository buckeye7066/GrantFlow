/**
 * discoveryAutoAddGate.js
 *
 * Per-profile enforcement of the `discovery_auto_add` automation toggle:
 * "Allow scheduled crawlers / discovery to add newly-matched funding
 * opportunities to this profile's pipeline automatically."
 *
 * Scheduled/automatic crawlers call this before auto-adding to a profile's
 * pipeline. When the toggle is OFF, the crawler skips the auto-add (the
 * opportunity still lands in the catalog and surfaces in Discovery for manual
 * add) — it just won't enter the pipeline unattended. Absent preference
 * defaults ON, preserving current behaviour. Mirrors the read used by
 * pipelineAutomation.js so behaviour is identical across enforcement points.
 *
 * This is the AUTOMATIC path only. Deliberate, user-initiated adds (the
 * /from-opportunity route, admin "Process All") are NOT gated here.
 */

import { isAutomationEnabled } from '../../shared/automationPreferences.js'

export async function discoveryAutoAddAllowedForProfile(db, profileId) {
  if (!db || !profileId) return true
  try {
    const row = await db
      .prepare(`SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = 'automation_preferences' LIMIT 1`)
      .get(String(profileId))
    const prefs = row?.data
      ? (typeof row.data === 'string' ? JSON.parse(row.data) : row.data)
      : {}
    return isAutomationEnabled(prefs, 'discovery_auto_add')
  } catch {
    // Never let a read failure silently disable a user's automation.
    return true
  }
}

export default { discoveryAutoAddAllowedForProfile }
