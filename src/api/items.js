import { apiFetch } from "@/api/client"

export async function getItemSuggestions({ profileId, limit = 8 } = {}) {
  const searchParams = new URLSearchParams()
  if (profileId) searchParams.set("profile_id", String(profileId))
  if (limit !== undefined && limit !== null) searchParams.set("limit", String(limit))
  const query = searchParams.toString()
  return apiFetch(`/api/items/suggestions${query ? `?${query}` : ""}`)
}

/**
 * Search the canonical profile-scoped item engine.
 *
 * `items` may be one verbatim free-text request or a list. When omitted, the
 * server searches the profile's own declared + derived item list. The response
 * keeps catalog matches and live-web research leads in one evidence-rich,
 * per-item report rather than reducing the request to generic keywords.
 */
export async function searchProfileItemNeeds({
  profileId,
  items,
  variant = "funding",
  maxResults,
} = {}) {
  const id = String(profileId || "").trim()
  if (!id || id === "all" || id === "__admin__") {
    throw new Error("Select a profile before searching for item funding.")
  }
  const hasItems = Array.isArray(items)
    ? items.some((item) => String(item || "").trim())
    : Boolean(String(items || "").trim())
  return apiFetch(`/api/item-needs/${encodeURIComponent(id)}/search`, {
    method: "POST",
    body: JSON.stringify({
      ...(hasItems ? { items } : {}),
      variant: variant === "gift" ? "gift" : "funding",
      ...(Number.isFinite(Number(maxResults)) ? { max_results: Number(maxResults) } : {}),
    }),
  })
}

/**
 * The profile's PREDETERMINED needs plan (org-type driven).
 *
 * Read-only and search-free — returns `open`, `suppressed` (with the field and
 * value that suppressed each one), `not_applicable`, and `user_added`.
 */
export async function getNeedsPlan({ profileId } = {}) {
  const id = String(profileId || "").trim()
  if (!id || id === "all" || id === "__admin__") {
    throw new Error("Select a profile to see its needs plan.")
  }
  return apiFetch(`/api/item-needs/${encodeURIComponent(id)}/needs-plan`)
}

/**
 * Run a real search for the plan's needs.
 *
 * The response carries `search_backends` — when a provider is unkeyed or down
 * the caller MUST show that rather than presenting an empty list as an answer.
 */
export async function searchNeedsPlan({ profileId, codes, offset, includeUserNeeds, variant } = {}) {
  const id = String(profileId || "").trim()
  if (!id || id === "all" || id === "__admin__") {
    throw new Error("Select a profile before searching its needs plan.")
  }
  return apiFetch(`/api/item-needs/${encodeURIComponent(id)}/needs-plan/search`, {
    method: "POST",
    body: JSON.stringify({
      ...(Array.isArray(codes) && codes.length ? { codes } : {}),
      ...(Number.isFinite(offset) ? { offset } : {}),
      ...(includeUserNeeds === false ? { include_user_needs: false } : {}),
      ...(variant ? { variant } : {}),
    }),
  })
}

export async function searchGreenHomePrograms({ profileId } = {}) {
  const id = String(profileId || "").trim()
  if (!id || id === "all" || id === "__admin__") {
    throw new Error("Select a profile before searching for no-cost green home upgrades.")
  }
  return apiFetch(`/api/item-needs/${encodeURIComponent(id)}/green-home`, {
    method: "POST",
  })
}
