import { apiFetch } from './client';

/**
 * Fetch system diagnostics (admin only)
 * @returns {Promise<Object>} Diagnostics data
 */
export async function fetchDiagnostics() {
  return apiFetch('/api/admin/diagnostics');
}
