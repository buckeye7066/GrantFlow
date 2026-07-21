// Login maintenance mode (server side).
//
// While active, every session-CREATING auth endpoint returns 503 so no new
// sign-ins (email link, password, phone, OAuth) can complete. `/refresh` and
// `/logout` stay open so users who were already signed in are not kicked out
// mid-session. The frontend twin (src/config/maintenance.js) shows the banner.
// Flip ACTIVE to false (one commit) when the upgrade is finished, or set
// LOGIN_MAINTENANCE=0 in the environment for an instant kill switch without
// a code change.
const LOGIN_MAINTENANCE_ACTIVE = true

export function isLoginMaintenanceActive() {
  if (process.env.LOGIN_MAINTENANCE === '0') return false
  // Tests exercise the normal auth flows; the maintenance posture is a
  // production stance, never an implicit test fixture.
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) return false
  return LOGIN_MAINTENANCE_ACTIVE
}

export const LOGIN_MAINTENANCE_MESSAGE =
  'GrantFlow is being upgraded and sign-in is temporarily disabled. ' +
  'Expected back online by 8:00 PM Eastern tonight (Monday, July 21).'
