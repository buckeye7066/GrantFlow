// Login maintenance mode (server side).
//
// While active, every session-CREATING auth endpoint returns 503 so no new
// sign-ins (email link, password, phone, OAuth) can complete. `/refresh` and
// `/logout` stay open so users who were already signed in are not kicked out
// mid-session. The frontend twin (src/config/maintenance.js) holds fallback
// banner copy; the Login page asks GET /api/auth/maintenance at runtime, so
// this module is the single source of truth for whether the banner shows.
//
// TOGGLE (no code change, no rebuild): set the LOGIN_MAINTENANCE env var on
// the backend (Railway) — '0' forces it OFF, '1' forces it ON; the service
// restarts on a variable change and the frontend follows within one page
// load. Unset, it falls back to the code default below.
const LOGIN_MAINTENANCE_ACTIVE = true

export function isLoginMaintenanceActive() {
  // Explicit env override wins in both directions.
  if (process.env.LOGIN_MAINTENANCE === '0') return false
  if (process.env.LOGIN_MAINTENANCE === '1') return true
  // Tests exercise the normal auth flows; the maintenance posture is a
  // production stance, never an implicit test fixture.
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) return false
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
