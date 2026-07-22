// Login maintenance mode — FALLBACK copy + default.
//
// The Login page asks GET /api/auth/maintenance at runtime and follows the
// server's answer (toggled by the LOGIN_MAINTENANCE env var on the backend —
// '1' on, '0' off, default OFF — no rebuild needed). This static object is
// only the initial render state before the probe answers and the fallback
// when the API is unreachable; `active: false` matches the backend's default
// so a normal page load never flashes the upgrade banner. The backend twin
// is backend/config/maintenance.js.
export const LOGIN_MAINTENANCE = {
  active: false,
  title: 'GrantFlow is being upgraded',
  message:
    'We are performing a scheduled upgrade. Sign-in is temporarily disabled while we finish.',
  etaText: 'Expected back online by 8:00 PM Eastern tonight (Monday, July 21).',
}
