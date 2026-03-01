import { apiFetch } from "@/api/client"

function buildQuery(params = {}) {
  // React Query passes a "query function context" object into queryFn by default.
  // If callers pass an API function directly as `queryFn`, we must ignore that context
  // to avoid generating URLs like `?queryKey=[object Object]&signal=[object AbortSignal]`.
  const looksLikeQueryContext =
    params &&
    typeof params === "object" &&
    (Object.prototype.hasOwnProperty.call(params, "queryKey") ||
      Object.prototype.hasOwnProperty.call(params, "signal") ||
      Object.prototype.hasOwnProperty.call(params, "meta") ||
      Object.prototype.hasOwnProperty.call(params, "client"))

  const effectiveParams = looksLikeQueryContext ? {} : params

  const searchParams = new URLSearchParams()
  Object.entries(effectiveParams).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return
    if (key !== "compliance" && value === "all") return
    if (value && typeof value === "object" && !Array.isArray(value)) return
    searchParams.set(key, String(value))
  })
  return searchParams.toString() ? `?${searchParams.toString()}` : ""
}

export async function listOpportunities(filters = {}) {
  const query = buildQuery(filters)
  return apiFetch(`/api/opportunities${query}`)
}

export async function getOpportunity(id) {
  return apiFetch(`/api/opportunities/${id}`)
}

export async function listOpportunitySources(params = {}) {
  const query = buildQuery(params)
  return apiFetch(`/api/opportunities/meta/sources${query}`)
}

export async function listOpportunityStates(params = {}) {
  const query = buildQuery(params)
  return apiFetch(`/api/opportunities/meta/states${query}`)
}

export async function createOpportunity(payload) {
  return apiFetch("/api/opportunities", {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export async function bulkImportOpportunities(opportunities) {
  return apiFetch("/api/opportunities/bulk", {
    method: "POST",
    body: JSON.stringify({ opportunities }),
  })
}

export async function getGeoSummary() {
  return apiFetch("/api/opportunities/geo/summary")
}

export async function getGeoScored(params = {}) {
  const query = buildQuery(params)
  return apiFetch(`/api/opportunities/geo/scored${query}`)
}
