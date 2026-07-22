// Login maintenance mode (server side).
//
// While active, every session-CREATING auth endpoint returns 503 so no new
// sign-ins (email link, password, phone, OAuth) can complete. `/refresh` and
// `/logout` stay open so users who were already signed in are not kicked out
// mid-session. The frontend twin (src/config/maintenance.js) holds fallback
// banner copy; the Login page asks GET /api/auth/maintenance at runtime, so
// this module is the single source of truth for whether the banner shows.
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
  'Expected back online by 8:00 PM Eastern tonight (Monday, July 21).'

// Banner copy served to the frontend by GET /api/auth/maintenance.
export const LOGIN_MAINTENANCE_COPY = {
  title: 'GrantFlow is being upgraded',
  message:
    'We are performing a scheduled upgrade. Sign-in is temporarily disabled while we finish.',
  etaText: 'Expected back online by 8:00 PM Eastern tonight (Monday, July 21).',
}
