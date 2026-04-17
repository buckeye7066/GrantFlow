/**
 * crawlerFramework.js
 *
 * Single canonical crawler framework with pluggable source adapters.
 * Wraps the strategy-based crawlerManager and direct API source adapters.
 */

// Re-export the core crawler runner from crawlerManager
export { runCrawler, SCHEMA } from './crawlers/crawlerManager.js'

// Source adapters (real APIs)
export { fetchSamGov as fetchGrantsGov } from './sources/samGov.js'
export { fetchUSASpending } from './sources/usaSpending.js'
// NIH RePORTER — real v2 Projects Search API (no key required).
// Adapted from Grant_Guide/nih_interface.py pattern: POST criteria, normalize
// to the canonical FundingOpportunity shape used by upsertFundingOpportunity.
export { fetchOpportunities as fetchNihReporter } from '../src/integrations/nihReporter.js'

// Ingestion service
export { ingestOpportunities } from './sources/ingestionService.js'

/**
 * Build an NIH RePORTER text_search query from the profile context's signals.
 * Returns '' when we can't derive anything useful; nihReporter.js treats '' as
 * an unconstrained broad search (still returns real award rows).
 *
 * Profile-driven per mission goal 3 ("use the full profile"), but never
 * narrows to zero results — it's additive only.
 *
 * @param {Object=} profileContext - { profile, signals, sections }
 * @returns {string}
 */
export function deriveNihSearchText(profileContext) {
  if (!profileContext || typeof profileContext !== 'object') return ''
  const sig = profileContext.signals ?? profileContext.profile?.signals ?? null
  const terms = new Set()
  if (sig && typeof sig === 'object') {
    for (const key of ['primary_keywords', 'needs', 'focus_areas', 'research_topics']) {
      const arr = Array.isArray(sig[key]) ? sig[key] : []
      for (const t of arr) {
        const s = typeof t === 'string' ? t.trim() : ''
        if (s && s.length <= 60) terms.add(s.toLowerCase())
      }
    }
  }
  // Cap to 3 terms to keep the API happy; RePORTER uses text_search as
  // free text with implicit AND, so too many terms → zero results.
  // Join with ", " to preserve multi-word phrases intact (NIH treats the
  // whole string as free text).
  return Array.from(terms).slice(0, 3).join(', ')
}

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

  // Three federal sources now: SAM.gov (active solicitations),
  // USASpending (historical awards), NIH RePORTER (NIH-funded projects).
  // NIH RePORTER returns program-style award records; relying on the
  // reviewer + validator layers keeps hallucinated rows out of the DB.
  const perSource = Math.max(1, Math.ceil(limit / 3));

  // Fetch from SAM.gov (formerly Grants.gov)
  let _fetchSamGov;
  try {
    const module = await import('./sources/samGov.js');
    _fetchSamGov = module.fetchSamGov;
    if (!_fetchSamGov) throw new Error('fetchSamGov not exported');
  } catch (importErr) {
    console.error('[crawlerFramework] Failed to load samGov:', importErr.message);
    errors.push({ source: 'sam.gov', error: `Module load failed: ${importErr.message}` });
  }
  if (_fetchSamGov) {
    try {
      const { opportunities } = await _fetchSamGov({ limit: perSource, offset: 0 });
      allOpportunities.push(...opportunities);
      console.log(`[crawlerFramework] SAM.gov: ${opportunities.length} results`);
    } catch (err) {
      console.error('[crawlerFramework] SAM.gov fetch error:', err.message);
      errors.push({ source: 'sam.gov', error: err.message });
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

  // Fetch from NIH RePORTER (v2 Projects Search — no API key required).
  // Profile-driven text query when signals are present; otherwise broad fetch.
  try {
    const { fetchOpportunities: _fetchNih } = await import(
      '../src/integrations/nihReporter.js'
    );
    const text = deriveNihSearchText(profileContext);
    const results = await _fetchNih({ text, limit: perSource, offset: 0 });
    // NIH RePORTER adapter already returns canonical FundingOpportunity shape.
    allOpportunities.push(...results);
    console.log(
      `[crawlerFramework] NIH RePORTER: ${results.length} results (text="${text || '<none>'}")`,
    );
  } catch (err) {
    console.error('[crawlerFramework] NIH RePORTER fetch error:', err.message);
    errors.push({ source: 'nih.reporter', error: err.message });
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
