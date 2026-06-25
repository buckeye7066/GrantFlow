import { createLogger } from '../utils/logger.js'
const log = createLogger('githubSyncVehicles')
/**
 * GitHub Sync Service — Vehicle Opportunities
 *
 * Fetches the last 100 vehicle_opportunities rows and writes them to
 * /data/vehicle_opportunities.json in the configured GitHub repo.
 *
 * Throttled to a maximum of one commit every 5 minutes.
 *
 * Required environment variables:
 *   GITHUB_TOKEN  — Personal access token with `repo` scope
 *   GITHUB_REPO   — Full repo slug, e.g. "buckeye7066/GrantFlow"
 */

const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DATA_FILE_PATH = 'data/vehicle_opportunities.json';
const FETCH_LIMIT = 100;

let lastSyncAt = 0;
let pendingSyncTimer = null;

/**
 * Fetch the last N vehicle opportunity rows from the database.
 *
 * @param {import('../db/index.js').Database} db
 * @returns {Promise<Array>}
 */
async function fetchVehicleOpportunities(db) {
  const rows = await db
    .prepare(
      `SELECT opportunity_type, title, amount, deadline, link, created_at
       FROM grant_opportunities
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(FETCH_LIMIT);
  return rows;
}

/**
 * Retrieve the current SHA of the target file from GitHub so we can update it
 * (GitHub requires the blob SHA when updating an existing file).
 *
 * @param {string} token
 * @param {string} repo  — "owner/repo"
 * @returns {Promise<string|null>}
 */
async function getFileSha(token, repo) {
  const url = `https://api.github.com/repos/${repo}/contents/${DATA_FILE_PATH}`;
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'GrantFlow-VehicleSync/1.0',
      },
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      log.error('[githubSyncVehicles] Failed to fetch file SHA', {
        status: response.status,
        body,
      });
      return null;
    }
    const data = await response.json();
    return data.sha || null;
  } catch (err) {
    log.error('[githubSyncVehicles] Error fetching file SHA:', err?.message || String(err));
    return null;
  }
}

/**
 * Push the vehicle opportunities JSON to GitHub via the Contents API.
 *
 * @param {import('../db/index.js').Database} db
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function syncVehicleOpportunitiesToGitHub(db) {
  const token = String(process.env.GITHUB_TOKEN || '').trim();
  const repo = String(process.env.GITHUB_REPO || '').trim();

  if (!token) {
    log.error('[githubSyncVehicles] GITHUB_TOKEN is not set; skipping sync.');
    return { ok: false, message: 'GITHUB_TOKEN not set' };
  }
  if (!repo) {
    log.error('[githubSyncVehicles] GITHUB_REPO is not set; skipping sync.');
    return { ok: false, message: 'GITHUB_REPO not set' };
  }

  let rows;
  try {
    rows = await fetchVehicleOpportunities(db);
  } catch (err) {
    log.error('[githubSyncVehicles] DB query failed:', err?.message || String(err));
    return { ok: false, message: `DB error: ${err?.message || String(err)}` };
  }

  const payload = rows.map((r) => ({
    opportunity_type: r.opportunity_type ?? '',
    title: r.title ?? '',
    amount: r.amount ?? 0,
    deadline: r.deadline ?? '',
    link: r.link ?? '',
    created_at: r.created_at ?? '',
  }));

  const content = Buffer.from(JSON.stringify(payload, null, 2)).toString('base64');
  const sha = await getFileSha(token, repo);

  const body = {
    message: `chore: update grant_opportunities snapshot (${payload.length} records)`,
    content,
    ...(sha ? { sha } : {}),
  };

  const url = `https://api.github.com/repos/${repo}/contents/${DATA_FILE_PATH}`;
  let response;
  try {
    response = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'GrantFlow-VehicleSync/1.0',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    log.error('[githubSyncVehicles] Network error during PUT:', err?.message || String(err));
    return { ok: false, message: `Network error: ${err?.message || String(err)}` };
  }

  if (!response.ok) {
    const responseBody = await response.text().catch(() => '');
    log.error('[githubSyncVehicles] GitHub PUT failed', {
      status: response.status,
      body: responseBody,
    });
    return {
      ok: false,
      message: `GitHub API error ${response.status}: ${responseBody}`,
    };
  }

  lastSyncAt = Date.now();
  log.info('[githubSyncVehicles] Successfully synced vehicle opportunities to GitHub', {
    count: payload.length,
    repo,
    path: DATA_FILE_PATH,
  });
  return { ok: true, message: `Synced ${payload.length} records` };
}

/**
 * Schedule a debounced GitHub sync.
 * At most one sync fires per SYNC_INTERVAL_MS window.
 *
 * @param {import('../db/index.js').Database} db
 */
export function scheduleDebouncedVehicleSync(db) {
  // If a timer is already pending, do nothing — it will fire soon.
  if (pendingSyncTimer !== null) return;

  const now = Date.now();
  const elapsed = now - lastSyncAt;
  const delay = elapsed >= SYNC_INTERVAL_MS ? 0 : SYNC_INTERVAL_MS - elapsed;

  pendingSyncTimer = setTimeout(async () => {
    pendingSyncTimer = null;
    try {
      await syncVehicleOpportunitiesToGitHub(db);
    } catch (err) {
      log.error('[githubSyncVehicles] Unexpected error during debounced sync:', err?.message || String(err));
    }
  }, delay);
}
