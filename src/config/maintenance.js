// Login maintenance mode (frontend).
//
// While active, the auth UI (Login page, session-expired re-auth dialog,
// set-password page, and OAuth callback) hides its sign-in controls and shows
// an upgrade banner, so no new sign-ins are attempted from the UI. This mirrors
// the backend twin (backend/config/maintenance.js), which returns 503 from every
// session-creating auth endpoint and is the real enforcement.
//
// Like the backend (LOGIN_MAINTENANCE=1), the guard arms ONLY via an
// environment variable: set VITE_LOGIN_MAINTENANCE=1 at build time for the
// upgrade window (pair it with LOGIN_MAINTENANCE=1 on the backend). The default
// is OFF so normal sign-in works with no code change and every CI/dev build
// exercises the real auth flows.
const RAW = import.meta.env.VITE_LOGIN_MAINTENANCE

export function isLoginMaintenanceActive() {
  return RAW === '1' || RAW === 'true'
}

export const LOGIN_MAINTENANCE = {
  active: isLoginMaintenanceActive(),
  title: 'GrantFlow is being upgraded',
  message:
    'We are performing a scheduled upgrade. Sign-in is temporarily disabled while we finish.',
  etaText: 'Sign-in will be restored as soon as the upgrade completes. Thanks for your patience.',
}
