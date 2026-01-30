import { apiFetch } from "@/api/client"

export async function getItemSuggestions({ profileId, limit = 8 } = {}) {
  const searchParams = new URLSearchParams()
  if (profileId) searchParams.set("profile_id", String(profileId))
  if (limit !== undefined && limit !== null) searchParams.set("limit", String(limit))
  const query = searchParams.toString()
  return apiFetch(`/api/items/suggestions${query ? `?${query}` : ""}`)
}

