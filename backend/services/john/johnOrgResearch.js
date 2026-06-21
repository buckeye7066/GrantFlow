/**
 * John — pre-draft web research.
 *
 * Before John drafts outreach for a lead, this looks the organization up on the
 * live web (via the shared searchWeb engine) and distills the top results into a
 * short "what we know about this org" context string that the AI composer feeds
 * into the draft prompt.
 *
 * Strict guarantees (asserted by tests):
 *   - FAILURE-TOLERANT: if web search is unavailable (e.g. SEARXNG_URL unset and
 *     no Brave key), returns [] / throws internally, John drafts WITHOUT research.
 *     This function NEVER throws and NEVER blocks the draft.
 *   - TIME-BOUNDED: a single short search with a small per-query timeout.
 *   - NO FABRICATION: the summary uses ONLY the title + snippet text returned by
 *     the search engine. It invents nothing.
 *
 * Gating: set JOHN_WEB_RESEARCH=off to disable entirely.
 */

import { searchWeb } from '../crawlers/webSearchEngine.js'

const MAX_RESULTS = 4
const DEFAULT_TIMEOUT_MS = 6000

/** Whether the pre-draft research step is enabled (default on; off via env). */
export function orgResearchEnabled() {
  return String(process.env.JOHN_WEB_RESEARCH || '').toLowerCase() !== 'off'
}

/** Build the search query from the org name + location, when we have a name. */
export function buildResearchQuery(orgName, location) {
  const name = String(orgName || '').trim()
  if (!name) return ''
  const loc = String(location || '').trim()
  return loc ? `${name} ${loc}` : name
}

/**
 * Turn raw search results into a short, plain-text context block. Uses only the
 * returned title + snippet; never adds claims. Returns '' when nothing usable.
 */
export function summarizeResearch(results) {
  if (!Array.isArray(results) || results.length === 0) return ''
  const lines = []
  for (const r of results.slice(0, MAX_RESULTS)) {
    if (!r || typeof r !== 'object') continue
    const title = String(r.title || '').replace(/\s+/g, ' ').trim()
    const snippet = String(r.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 240)
    if (!title && !snippet) continue
    if (title && snippet) lines.push(`- ${title}: ${snippet}`)
    else lines.push(`- ${title || snippet}`)
  }
  return lines.join('\n')
}

/**
 * Research an organization on the web for John's draft prompt.
 *
 * @param {Object} args
 * @param {string} args.orgName       Organization name (required to search).
 * @param {string} [args.location]    Org location, appended to the query.
 * @param {Object} [args.logger]      Optional logger (warn).
 * @param {number} [args.timeoutMs]   Per-query network budget.
 * @returns {Promise<{ summary: string, results: Array, query: string }>}
 *          Always resolves; on any failure returns an empty summary/results.
 */
export async function researchOrganization({ orgName, location, logger, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const empty = { summary: '', results: [], query: '' }
  if (!orgResearchEnabled()) return empty

  const query = buildResearchQuery(orgName, location)
  if (!query) return empty

  let results = []
  try {
    results = await searchWeb(query, { count: MAX_RESULTS, timeoutMs })
  } catch (err) {
    // searchWeb is itself failure-tolerant, but defend against any unexpected
    // throw so research can never block or fail a draft.
    logger?.warn?.('[John] org research search threw; drafting without research', {
      error: err?.message || String(err),
    })
    return { ...empty, query }
  }

  if (!Array.isArray(results) || results.length === 0) return { ...empty, query }

  const summary = summarizeResearch(results)
  return { summary, results, query }
}

export default { researchOrganization, summarizeResearch, buildResearchQuery, orgResearchEnabled }
