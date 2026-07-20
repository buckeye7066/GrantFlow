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

/**
 * Trigger a targeted, bounded re-crawl of ONE stale source (admin only).
 * Runs the same Crawler OS discovery path the nightly sweep uses, narrowed to
 * this single source_id and (when provided) this single profile — never a
 * full fleet re-crawl. See backend/routes/adminCrawlCoverageActions.js.
 * @param {{ sourceId: string, profileId?: string }} opts
 * @returns {Promise<Object>}
 */
export async function runCrawlCoverageSource({ sourceId, profileId } = {}) {
  return apiFetch('/api/admin/crawl-coverage-actions/run-source', {
    method: 'POST',
    body: JSON.stringify({ source_id: sourceId, profile_id: profileId || undefined }),
  });
}
