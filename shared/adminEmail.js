/**
 * shared/adminEmail.js
 *
 * Single canonical admin email for GrantFlow / Yana operator routing.
 * Used by:
 *   - backend (fallback when HAMILTON_ADMIN_EMAIL / ADMIN_EMAIL are unset)
 *   - frontend (Admin page tab gating, AdminHamiltonHardStops display)
 *
 * Keep this in sync with backend/config/constants.js DEFAULT_ADMIN_EMAIL.
 * Multi-admin lists are intentionally NOT primary behavior here — Yana
 * hard stops always go to this single account.
 */
export const HAMILTON_ADMIN_EMAIL = 'buckeye7066@gmail.com'

export function isHamiltonAdminEmail(email) {
  if (!email || typeof email !== 'string') return false
  return email.trim().toLowerCase() === HAMILTON_ADMIN_EMAIL
}

/**
 * Single canonical admin/operator for the Agent Control Center
 * (start/stop/pause/resume/emergency-stop the whole agent process).
 * Mirrors the backend AGENT_CONTROL_ADMIN_EMAIL constant — keep in
 * sync. Defaults to the Hamilton admin so a deployment with one env
 * lookup gets both behaviours right.
 */
export const AGENT_CONTROL_ADMIN_EMAIL = HAMILTON_ADMIN_EMAIL

export function isAgentControlAdminEmail(email) {
  if (!email || typeof email !== 'string') return false
  return email.trim().toLowerCase() === AGENT_CONTROL_ADMIN_EMAIL
}
