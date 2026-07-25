// Login maintenance mode — frontend.
//
// The backend (backend/config/maintenance.js) is the single source of truth:
// LOGIN_MAINTENANCE=1 makes every session-creating auth endpoint return 503.
// The frontend reflects that in two ways, both defaults OFF so normal CI/dev
// builds exercise the real auth flows:
//   • isLoginMaintenanceActive() is the BUILD-TIME opt-in
//     (VITE_LOGIN_MAINTENANCE === '1' | 'true'). It seeds the Login page's
//     INITIAL paint via LOGIN_MAINTENANCE.active so a maintenance build never
//     flashes the normal login form, and gates the secondary auth surfaces
//     that render synchronously without a probe — AuthCallback, SetPassword,
//     and SessionExpiredDialog.
//   • The Login page then probes GET /api/auth/maintenance at runtime and
//     follows the server's answer, so flipping the backend env var needs no
//     frontend rebuild — the build-time flag only avoids the initial flash
//     and stays consistent with the runtime truth in normal builds.
// LOGIN_MAINTENANCE (below) is the runtime fallback (and the probe's shape);
// when the API is unreachable the fallback stands — sign-in couldn't succeed
// anyway, so showing the banner is the safe default.
export function isLoginMaintenanceActive() {
  return (
    import.meta.env.VITE_LOGIN_MAINTENANCE === '1' ||
    import.meta.env.VITE_LOGIN_MAINTENANCE === 'true'
  )
}

export const LOGIN_MAINTENANCE = {
  active: isLoginMaintenanceActive(),
  title: 'GrantFlow is being upgraded',
  message:
    'We are performing a scheduled upgrade. Sign-in is temporarily disabled while we finish.',
  etaText: 'Expected back online by 8:00 PM Eastern tonight (Monday, July 21).',
}
