import client from './client';

/**
 * Fetch system diagnostics (admin only)
 * @returns {Promise<Object>} Diagnostics data
 */
export async function fetchDiagnostics() {
  const response = await client.get('/api/admin/diagnostics');
  return response.data;
}
