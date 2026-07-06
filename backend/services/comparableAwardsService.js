/**
 * comparableAwardsService.js — real comparable funded awards as drafting
 * grounding (COMPARABLE_AWARDS flag, default OFF).
 *
 * Single choke point for turning a pipeline grant into a small set of REAL
 * historical awards (NIH RePORTER) that a proposal draft can mirror for
 * structure/scope/framing. G0 contract:
 *   - Rows come only from the live RePORTER API (no invention, no padding).
 *   - Every row is labeled reference_only and presented as OTHER applicants'
 *     awards — the proposal generator injects them as reference context, NOT
 *     into the applicant evidence pack, so the fabrication guard still treats
 *     the profile as the only source of applicant truth.
 *   - Zero results is reported as zero (empty list + the query we used), never
 *     backfilled with fabricated entries.
 */

import { fetchComparableAwards } from '../src/integrations/nihReporter.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('comparableAwards')

export const COMPARABLE_AWARDS_LABEL = 'Comparable funded awards (reference only)'

/** Flag gate — default OFF until proven in prod. */
export function isComparableAwardsEnabled() {
  const v = String(process.env.COMPARABLE_AWARDS || '').trim().toLowerCase()
  return v === '1' || v === 'true'
}

const QUERY_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'your', 'their',
  'grant', 'grants', 'program', 'programs', 'fund', 'funds', 'funding',
  'award', 'awards', 'application', 'opportunity', 'assistance', 'support',
  'project', 'projects', 'initiative', 'foundation', 'annual', 'fiscal',
])

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 3 && !QUERY_STOPWORDS.has(t))
}

function asList(v) {
  if (Array.isArray(v)) return v
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

/**
 * Build the free-text RePORTER query from the grant + its linked catalog
 * opportunity. Prefers curated category/keyword signals over raw title
 * tokens; bounded so a verbose description can't produce a junk query.
 */
export function buildComparableAwardsQuery(grant, opportunity = null) {
  const terms = []
  const push = (t) => {
    const v = String(t || '').trim().toLowerCase()
    if (v && !terms.includes(v)) terms.push(v)
  }

  for (const k of asList(opportunity?.keywords).slice(0, 4)) push(k)
  for (const c of asList(opportunity?.categories).slice(0, 3)) push(String(c).replace(/^ic:/, ''))
  for (const t of tokenize(grant?.title || opportunity?.title).slice(0, 5)) push(t)
  if (terms.length < 3) {
    for (const t of tokenize(opportunity?.description).slice(0, 4)) push(t)
  }
  return terms.slice(0, 8).join(' ')
}

/**
 * Fetch 3–5 real comparable awards for a pipeline grant. Loads the linked
 * catalog opportunity (if any) for richer query terms. Never throws — an API
 * failure returns { awards: [], error } so callers degrade cleanly.
 *
 * @returns {Promise<{ enabled: boolean, query: string|null, awards: Array, error?: string }>}
 */
export async function fetchComparableAwardsForGrant(db, grant, { limit = 5 } = {}) {
  if (!isComparableAwardsEnabled()) {
    return { enabled: false, query: null, awards: [] }
  }
  if (!grant || typeof grant !== 'object') {
    return { enabled: true, query: null, awards: [], error: 'grant required' }
  }

  let opportunity = null
  if (grant.funding_opportunity_id && db) {
    try {
      opportunity = await db
        .prepare('SELECT * FROM funding_opportunities WHERE id = ? LIMIT 1')
        .get(grant.funding_opportunity_id)
    } catch (err) {
      log.warn(`linked opportunity load failed (query built from grant only): ${err?.message || err}`)
    }
  }

  const query = buildComparableAwardsQuery(grant, opportunity)
  if (!query) {
    return { enabled: true, query: null, awards: [] }
  }

  try {
    const awards = await fetchComparableAwards({ text: query, limit: Math.max(3, Math.min(5, limit)) })
    log.info(`comparable awards: grant=${grant.id} query="${query}" found=${awards.length}`)
    return { enabled: true, query, awards }
  } catch (error) {
    log.warn(`RePORTER lookup failed for grant ${grant?.id}: ${error?.message || error}`)
    return { enabled: true, query, awards: [], error: error?.message || String(error) }
  }
}

export default {
  COMPARABLE_AWARDS_LABEL,
  isComparableAwardsEnabled,
  buildComparableAwardsQuery,
  fetchComparableAwardsForGrant,
}
