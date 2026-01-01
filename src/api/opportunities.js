import { apiFetch } from "@/api/client"

function buildQuery(params = {}) {
  const searchParams = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return
    if (key !== "compliance" && value === "all") return
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
