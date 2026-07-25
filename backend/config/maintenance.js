// Login maintenance mode (server side).
//
// While active, every session-CREATING auth endpoint returns 503 so no new
// sign-ins (email link, password, phone, OAuth) can complete. `/refresh` and
// `/logout` stay open so users who were already signed in are not kicked out
// mid-session. The frontend twin (src/config/maintenance.js) shows the banner.
// The guard arms ONLY via the LOGIN_MAINTENANCE=1 environment variable (set
// on Railway for the upgrade window; remove it or set 0 to reopen sign-in —
// no code change or deploy needed). The default is OFF so every CI lane —
// including the release-gate tests that deliberately run with
// NODE_ENV=production to assert real prod auth semantics — exercises the
// normal auth flows.
const LOGIN_MAINTENANCE_ACTIVE = false

export function isLoginMaintenanceActive() {
  if (process.env.LOGIN_MAINTENANCE === '1') return true
  if (process.env.LOGIN_MAINTENANCE === '0') return false
  return LOGIN_MAINTENANCE_ACTIVE
}

export const LOGIN_MAINTENANCE_MESSAGE =
  'GrantFlow is being upgraded and sign-in is temporarily disabled. ' +
  'Sign-in will be restored as soon as the upgrade completes.'
