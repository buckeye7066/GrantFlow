// Login maintenance is permanently disabled.
// This static fallback cannot hide or replace the normal sign-in experience.

export function isLoginMaintenanceActive() {
  return false
}

export const LOGIN_MAINTENANCE = {
  active: false,
  title: '',
  message: '',
  etaText: '',
}
