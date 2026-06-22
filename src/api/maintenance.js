import { apiFetch } from './client'

/** PUBLIC current maintenance status (works signed-out). */
export async function getMaintenanceStatus() {
  return apiFetch('/api/maintenance/status')
}

/** ADMIN: schedule a maintenance window (warning -> down). */
export async function scheduleMaintenance({ graceMinutes = 5, estimatedMinutes = 15, reason = 'deploy', message = null } = {}) {
  return apiFetch('/api/maintenance/schedule', {
    method: 'POST',
    body: JSON.stringify({ graceMinutes, estimatedMinutes, reason, message }),
  })
}

/** ADMIN: reopen the app. */
export async function endMaintenance() {
  return apiFetch('/api/maintenance/end', { method: 'POST', body: JSON.stringify({}) })
}

/** ADMIN: run Sam's nightly maintenance sweep now. */
export async function runNightlySweep() {
  return apiFetch('/api/maintenance/run-nightly-sweep', { method: 'POST', body: JSON.stringify({}) })
}
