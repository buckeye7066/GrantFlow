import { apiFetch } from "@/api/client"
import { AUTO_ADD_SCORE } from "@/lib/matchDisplayThresholds"

export async function listCrawlerJobs(params = {}) {
  const searchParams = new URLSearchParams()
  Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .forEach(([key, value]) => searchParams.set(key, String(value)))
  const query = searchParams.toString()
  return apiFetch(`/api/crawlers/jobs${query ? `?${query}` : ""}`)
}

export async function getCrawlerJob(id) {
  return apiFetch(`/api/crawlers/jobs/${id}`)
}

export async function createCrawlerJob(payload) {
  return apiFetch("/api/crawlers/jobs", {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export async function listCrawlerMetrics(params = {}) {
  const searchParams = new URLSearchParams()
  Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .forEach(([key, value]) => searchParams.set(key, String(value)))
  const query = searchParams.toString()
  return apiFetch(`/api/crawlers/jobs/metrics${query ? `?${query}` : ""}`)
}

export async function retryCrawlerJob(id) {
  return apiFetch(`/api/crawlers/jobs/${id}/retry`, {
    method: "POST",
  })
}

export async function cancelCrawlerJob(id, reason) {
  return apiFetch(`/api/crawlers/jobs/${id}/cancel`, {
    method: "POST",
    body: JSON.stringify(
      reason && reason.trim()
        ? { reason: reason.trim() }
        : {},
    ),
  })
}

export async function triggerProfileEnrichment({ profileId, sections, prompt }) {
  if (!profileId) {
    throw new Error("profileId is required to enrich a profile")
  }

  return createCrawlerJob({
    type: "profile_enrichment",
    profile_id: profileId,
    parameters: {
      sections: Array.isArray(sections) && sections.length > 0 ? sections : undefined,
      prompt: prompt?.trim() || undefined,
    },
  })
}

export async function updateCrawlerJob(id, payload) {
  return apiFetch(`/api/crawlers/jobs/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  })
}

export async function fetchCrawlerStatus(profileId) {
  if (!profileId) {
    throw new Error("profileId is required to fetch crawler status")
  }
  return apiFetch(`/api/crawlers/auto-discovery-status/${profileId}`)
}

/**
 * List all available crawlers (featured + more) from the backend.
 * @returns {Promise<{crawlers: Array, total: number}>}
 */
export async function listRealCrawlers() {
  return apiFetch('/api/real-crawlers/list')
}

/**
 * Run smart funding search (recommended sources from profile: geo + national + state waiver).
 * Single button: "Find Real Funding For Me".
 * @param {Object} opts
 * @param {string} opts.profileId - Required.
 * @param {number} [opts.minMatchScore] - Current-scale display preference.
 * @param {string} [opts.state]
 * @param {string} [opts.city]
 * @param {string} [opts.applicantType]
 * @returns {Promise<{ success, count, opportunities, sources_used }>}
 */
export async function runSmartCrawler({
  profileId,
  minMatchScore = AUTO_ADD_SCORE,
  state,
  city,
  applicantType,
  primaryCategory = null,
  intentTerms = null,
}) {
  const pid = typeof profileId === 'string' ? profileId.trim() : null
  if (!pid) throw new Error('profile_id is required. Select a profile first.')
  return apiFetch('/api/real-crawlers/run-smart', {
    method: 'POST',
    body: JSON.stringify({
      profile_id: pid,
      min_match_score: minMatchScore,
      state: state || undefined,
      city: city || undefined,
      applicant_type: applicantType || undefined,
      // Forward Smart Matcher intent so the run-smart endpoint dispatches
      // license_reinstatement / certification_training strategies when the
      // user is searching for professional development funding.
      primary_category: primaryCategory || undefined,
      intent_terms: Array.isArray(intentTerms) && intentTerms.length > 0
        ? intentTerms
        : undefined,
    }),
  })
}

/**
 * Search for a specific need/item using curated data + live web search.
 * Calls POST /api/real-crawlers/specific-need which re-ranks this profile's
 * Crawler OS results against the need AND runs a need-keyed live web search
 * (SearXNG/Brave) whose hits come back as labeled leads
 * (result_source='web_search'). Pass variant='gift' to bias the web queries
 * toward donation / in-kind programs ("organizations that donate X").
 * profile_id is required â throws early if missing.
 * @param {Object} opts
 * @param {string} opts.profileId - Required. Profile ID for context/signals.
 * @param {string} opts.needText - Required. Human-readable need description.
 * @param {number} [opts.minItemRelevance] - Query-ranking floor; not a match or eligibility threshold.
 * @param {number} [opts.minMatchScore] - Deprecated alias for minItemRelevance.
 * @param {number} [opts.maxResults]
 * @param {('funding'|'gift')} [opts.variant]
 * @returns {Promise<Object>}
 */
export async function searchSpecificNeed({
  profileId,
  needText,
  minItemRelevance,
  minMatchScore,
  maxResults = 30,
  variant = 'funding',
}) {
  const pid = typeof profileId === 'string' ? profileId.trim() : null
  if (!pid) {
    throw new Error('profile_id is required. Select a profile first.')
  }
  if (!needText || typeof needText !== 'string' || needText.trim().length < 2) {
    throw new Error('Enter what you are looking for (at least 2 characters).')
  }
  const requestedItemRelevance = minItemRelevance ?? minMatchScore
  return apiFetch('/api/real-crawlers/specific-need', {
    method: 'POST',
    body: JSON.stringify({
      profile_id: pid,
      need_text: needText.trim(),
      ...(requestedItemRelevance === undefined
        ? {}
        : { min_item_relevance: requestedItemRelevance }),
      max_results: maxResults,
      variant: variant === 'gift' ? 'gift' : 'funding',
    }),
  })
}

/**
 * Run a named real crawler (local_funding, student_grants, health_resources, etc.).
 * profile_id is required â throws early if missing (developer error).
 * @param {Object} opts
 * @param {string} opts.profileId - Required. Profile ID for context/signals.
 * @param {string} opts.crawlerType - Crawler type key.
 * @param {Object} [opts.profileData] - Optional pre-fetched profile data.
 * @param {number} [opts.minMatchScore] - Minimum match score threshold (default AUTO_ADD_SCORE).
 * @param {boolean} [opts.strictMinScore] - When true, do not relax threshold if nothing meets min (Discover).
 * @param {Object|null} [opts.itemRequest] - Optional specific item request.
 * @returns {Promise<Object>}
 */
export async function runRealCrawler({
  profileId,
  crawlerType,
  profileData,
  minMatchScore = AUTO_ADD_SCORE,
  strictMinScore = false,
  itemRequest = null,
}) {
  const pid = typeof profileId === 'string' ? profileId.trim() : null
  if (!pid) {
    throw new Error('profile_id is required to run real crawlers. Select a profile first.')
  }
  const result = await apiFetch('/api/real-crawlers/run', {
    method: 'POST',
    body: JSON.stringify({
      crawler_type: crawlerType,
      profile_id: pid,
      profile_data: profileData ?? undefined,
      item_request: itemRequest ?? null,
      min_match_score: minMatchScore,
      ...(strictMinScore ? { strict_min_score: true } : {}),
    }),
  })
  if (result?.success === false) {
    throw new Error(result?.error || 'Crawler failed')
  }
  return result
}

/**
 * Fire the FULL relevance-gated discovery fleet for a profile, in the BACKGROUND.
 * Reuses the canonical relevance selector server-side (POST
 * /api/real-crawlers/discover-all → triggerAutoDiscoveryCrawlers), so only the
 * crawlers relevant to THIS profile type are dispatched (a corporation never
 * gets student crawlers; a student never gets military/fire crawlers).
 *
 * Returns the honest enqueued summary { jobs_enqueued, crawler_types } so the UI
 * can report exactly how many relevant crawlers were dispatched. profile_id is
 * required — throws early if missing.
 * @param {Object} opts
 * @param {string} opts.profileId - Required. Profile ID to discover for.
 * @returns {Promise<{ success: boolean, profile_id: string, jobs_enqueued: number, crawler_types: string[] }>}
 */
export async function discoverAllForProfile({ profileId }) {
  const pid = typeof profileId === 'string' ? profileId.trim() : null
  if (!pid) {
    throw new Error('profile_id is required to discover funding. Select a profile first.')
  }
  // Crawler OS cutover: the legacy /discover-all endpoint enqueues background
  // crawler jobs whose types are now SUPERSEDED by the Crawler OS — the
  // dispatcher marks them "completed" with zero results, so discover-all can
  // never surface new funding (and frequently 504s while enqueuing, which the UI
  // mis-rendered as "never searched"). Route discovery to the LIVE, in-process
  // path (/run-smart → runProfileDiscoveryLive): it runs the full profile-aware
  // discovery (federal APIs + open-web lane) under a gateway-safe time budget
  // and PERSISTS matches before responding. Shape the result so the existing
  // DiscoverGrants handler treats it as a completed synchronous run and pulls
  // the freshly-persisted matches via its final fetchCatalogMatches pass.
  const res = await apiFetch('/api/real-crawlers/run-smart', {
    method: 'POST',
    body: JSON.stringify({ profile_id: pid }),
  })
  const stored = Number(res?.count ?? res?.stored ?? res?.inserted ?? res?.total_found) || 0
  const sources = Array.isArray(res?.sources_used)
    ? res.sources_used
    : Array.isArray(res?.sources)
      ? res.sources
      : []
  return {
    success: res?.success !== false,
    profile_id: pid,
    synchronous: true,
    jobs_enqueued: 0,
    stored,
    matches: Number(res?.matches ?? res?.count) || stored,
    crawler_types: sources,
    partial: Boolean(res?.partial || res?.timed_out),
  }
}
