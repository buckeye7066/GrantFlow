/**
 * shared/adminEmail.js
 *
 * Source-safe local fixture retained for compatibility with legacy imports.
 * Production authorization is DB-backed on the client and environment-backed
 * on the server; this value must never confer authority.
 */
export const HAMILTON_ADMIN_EMAIL = 'admin@grantflow.local'

export function isHamiltonAdminEmail(email) {
  if (!email || typeof email !== 'string') return false
  return email.trim().toLowerCase() === HAMILTON_ADMIN_EMAIL
}

/**
 * Single canonical admin/operator for the Agent Control Center
 * (start/stop/pause/resume/emergency-stop the whole agent process).
 * Legacy presentation helper only. Server authorization never reads it.
 */
export const AGENT_CONTROL_ADMIN_EMAIL = HAMILTON_ADMIN_EMAIL

export function isAgentControlAdminEmail(email) {
  if (!email || typeof email !== 'string') return false
  return email.trim().toLowerCase() === AGENT_CONTROL_ADMIN_EMAIL
}
