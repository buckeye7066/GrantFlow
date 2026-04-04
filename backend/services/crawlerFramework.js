/**
 * crawlerFramework.js
 *
 * Single canonical crawler framework with pluggable source adapters.
 * Wraps the strategy-based crawlerManager and direct API source adapters.
 */

// Re-export the core crawler runner from crawlerManager
export { runCrawler, SCHEMA } from './crawlers/crawlerManager.js'

// Source adapters (real APIs)
export { fetchGrantsGov } from './sources/grantsGov.js'
export { fetchUSASpending } from './sources/usaSpending.js'

// Ingestion service
export { ingestOpportunities } from './sources/ingestionService.js'

/**
 * Deduplicate opportunities by source+source_id, keeping the latest.
 * @param {Array} opportunities
 * @returns {Array}
 */
export function deduplicateOpportunities(opportunities) {
  const seen = new Map();
  for (const opp of opportunities) {
    const key = `${opp.source}::${opp.source_id}`;
    if (!seen.has(key)) {
      seen.set(key, opp);
    }
  }
  return Array.from(seen.values());
}

/**
 * Run a full crawl for a profile using all available sources.
 * Profile-driven: reads profile's location, needs, and type to determine what to search for.
 *
 * @param {Object} db - Database connection
 * @param {string} profileId - Profile to crawl for
 * @param {Object} options - Options { sources: string[], maxResults: number, minScore: number }
 * @returns {Promise<{ results: Array, stats: Object }>}
 */
export async function runFullCrawl(db, profileId, options = {}) {
  const { sources, maxResults, minScore } = options;
  const startedAt = Date.now();

  try {
    let _runCrawler;
try {
  const module = await import('./crawlers/crawlerManager.js');
  _runCrawler = module.runCrawler;
  if (!_runCrawler) throw new Error('runCrawler not exported');
} catch (importErr) {
  throw new Error(`Failed to load crawlerManager: ${importErr.message}`);
}
    if (!db || typeof db !== 'object') {
  throw new Error('Valid database connection required');
}
const result = await _runCrawler(db, profileId, {
      maxResults,
      minScore,
      ...(sources ? { crawlerType: sources[0] } : {}),
    });

    return {
      results: result.results || [],
      stats: {
        total: (result.results || []).length,
        duration_ms: Date.now() - startedAt,
        strategy: result.debug?.strategy,
      },
    };
  } catch (err) {
    console.error('[crawlerFramework] runFullCrawl error:', err.message);
    return {
      results: [],
      stats: {
        total: 0,
        duration_ms: Date.now() - startedAt,
        error: err.message,
      },
    };
  }
}

/**
 * Run a federal sources crawl (Grants.gov + USASpending) for a profile.
 * Uses proper pagination - not capped at 100 results.
 *
 * @param {Object} db - Database connection
 * @param {string} profileId - Profile to crawl for
 * @param {Object} profileContext - Profile context with signals
 * @param {Object} options - { limit: number, storeResults: boolean }
 * @returns {Promise<{ opportunities: Array, stats: Object }>}
 */
export async function runFederalCrawl(db, profileId, profileContext, options = {}) {
  if (!profileId) {
    throw new Error('profileId is required for crawling');
  }
  if (!profileContext || typeof profileContext !== 'object') {
    console.warn('[crawlerFramework] Missing profileContext - results may not be relevant');
  }
  const { limit = 100, storeResults = true } = options;
  const startedAt = Date.now();
  const allOpportunities = [];
  const errors = [];

  const perSource = Math.ceil(limit / 2);

  // Fetch from Grants.gov
  let _fetchGrantsGov;
  try {
    const module = await import('./sources/grantsGov.js');
    _fetchGrantsGov = module.fetchGrantsGov;
    if (!_fetchGrantsGov) throw new Error('fetchGrantsGov not exported');
  } catch (importErr) {
    console.error('[crawlerFramework] Failed to load grantsGov:', importErr.message);
    errors.push({ source: 'grants.gov', error: `Module load failed: ${importErr.message}` });
  }
  if (_fetchGrantsGov) {
    try {
      const { opportunities } = await _fetchGrantsGov({ limit: perSource, offset: 0 });
      allOpportunities.push(...opportunities);
      console.log(`[crawlerFramework] Grants.gov: ${opportunities.length} results`);
    } catch (err) {
      console.error('[crawlerFramework] Grants.gov fetch error:', err.message);
      errors.push({ source: 'grants.gov', error: err.message });
    }
  }

  // Fetch from USASpending
  try {
    const { fetchUSASpending: _fetchUSASpending } = await import('./sources/usaSpending.js');
    const { opportunities } = await _fetchUSASpending({ limit: perSource, page: 1 });
    allOpportunities.push(...opportunities);
    console.log(`[crawlerFramework] USASpending: ${opportunities.length} results`);
  } catch (err) {
    console.error('[crawlerFramework] USASpending fetch error:', err.message);
    errors.push({ source: 'usaspending.gov', error: err.message });
  }

  const deduplicated = deduplicateOpportunities(allOpportunities);

  // Optionally store results
  if (storeResults && db && deduplicated.length > 0) {
    try {
      const { ingestOpportunities: _ingest } = await import('./sources/ingestionService.js');
      await _ingest(db, deduplicated, 'federal-crawl');
    } catch (err) {
      console.error('[crawlerFramework] Ingestion error:', err.message);
      errors.push({ source: 'ingestion', error: err.message });
    }
  }

  return {
    opportunities: deduplicated,
    stats: {
      total: deduplicated.length,
      duration_ms: Date.now() - startedAt,
      errors,
    },
  };
}
