import { apiFetch } from "@/api/client"

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
 * Run a real crawler (local_funding, student_grants, health_resources, etc.).
 * profile_id is required - throws early if missing (developer error).
 * @param {Object} opts
 * @param {string} opts.profileId - Required. Profile ID for context/signals.
 * @param {string} opts.crawlerType
 * @param {Object} [opts.profileData]
 * @param {number} [opts.minMatchScore]
 * @param {Object} [opts.itemRequest]
 * @returns {Promise<Object>}
 */
export async function runRealCrawler({
  profileId,
  crawlerType,
  profileData,
  minMatchScore = 50,
  itemRequest = null,
}) {
  const pid = typeof profileId === 'string' ? profileId.trim() : null
  if (!pid) {
    throw new Error('profile_id is required to run real crawlers. Select a profile first.')
  }
  return apiFetch('/api/real-crawlers/run', {
    method: 'POST',
    body: JSON.stringify({
      crawler_type: crawlerType,
      profile_id: pid,
      profile_data: profileData ?? undefined,
      item_request: itemRequest ?? null,
      min_match_score: minMatchScore,
    }),
  })
}
