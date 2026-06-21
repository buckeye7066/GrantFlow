import { apiFetch } from './client';

/**
 * Fetch system diagnostics (admin only)
 * @returns {Promise<Object>} Diagnostics data
 */
export async function fetchDiagnostics() {
  return apiFetch('/api/admin/diagnostics');
}

/**
 * Fetch the read-only crawl coverage & health report (admin only).
 * @param {{ profileId?: string, limit?: number }} [opts]
 * @returns {Promise<Object>} Crawl coverage data
 */
export async function fetchCrawlCoverage({ profileId, limit } = {}) {
  const params = new URLSearchParams();
  if (profileId) params.set('profileId', profileId);
  if (limit) params.set('limit', String(limit));
  const qs = params.toString();
  return apiFetch(`/api/admin/crawl-coverage${qs ? `?${qs}` : ''}`);
}
