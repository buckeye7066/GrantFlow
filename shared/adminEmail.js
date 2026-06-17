/**
 * shared/adminEmail.js
 *
 * Single canonical admin email for GrantFlow / Yana operator routing.
 * Used by:
 *   - backend (fallback when YANA_ADMIN_EMAIL / ADMIN_EMAIL are unset)
 *   - frontend (Admin page tab gating, AdminYanaHardStops display)
 *
 * Keep this in sync with backend/config/constants.js DEFAULT_ADMIN_EMAIL.
 * Multi-admin lists are intentionally NOT primary behavior here — Yana
 * hard stops always go to this single account.
 */
export const YANA_ADMIN_EMAIL = 'buckeye7066@gmail.com'

export function isYanaAdminEmail(email) {
  if (!email || typeof email !== 'string') return false
  return email.trim().toLowerCase() === YANA_ADMIN_EMAIL
}
