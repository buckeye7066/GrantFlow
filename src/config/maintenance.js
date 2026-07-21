// Login maintenance mode.
//
// While `active` is true the Login page replaces the sign-in form with an
// upgrade banner and no new sign-ins are possible from the UI. The backend
// twin (backend/config/maintenance.js) enforces the same block server-side.
// Flip BOTH to false (one commit) when the upgrade is finished.
export const LOGIN_MAINTENANCE = {
  active: true,
  title: 'GrantFlow is being upgraded',
  message:
    'We are performing a scheduled upgrade. Sign-in is temporarily disabled while we finish.',
  etaText: 'Expected back online by 8:00 PM Eastern tonight (Monday, July 21).',
}
