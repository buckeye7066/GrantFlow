// Login maintenance mode — FALLBACK copy + default.
//
// The Login page asks GET /api/auth/maintenance at runtime and follows the
// server's answer (toggled by the LOGIN_MAINTENANCE env var on the backend —
// '1' on, '0' off — no rebuild needed). This static object is only used
// (a) as the initial render state before the probe answers, and (b) when the
// API is unreachable — in which case showing the banner is honest, since
// sign-in couldn't succeed anyway. The backend twin is
// backend/config/maintenance.js.
export const LOGIN_MAINTENANCE = {
  active: true,
  title: 'GrantFlow is being upgraded',
  message:
    'We are performing a scheduled upgrade. Sign-in is temporarily disabled while we finish.',
  etaText: 'Expected back online by 8:00 PM Eastern tonight (Monday, July 21).',
}
