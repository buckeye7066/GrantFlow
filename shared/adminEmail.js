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
