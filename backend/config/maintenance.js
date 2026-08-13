// Login maintenance is permanently disabled.
// Production configuration cannot re-arm a login shutdown or banner.

export function isLoginMaintenanceActive() {
  return false
}

export function resolveLoginMaintenanceEta() {
  return ''
}

export const LOGIN_MAINTENANCE_MESSAGE = ''

export const LOGIN_MAINTENANCE_COPY = {
  title: '',
  message: '',
  etaText: '',
}
