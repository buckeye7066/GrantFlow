import { apiFetch } from "@/api/client"

export async function getItemSuggestions({ profileId, limit = 8 } = {}) {
  const searchParams = new URLSearchParams()
  if (profileId) searchParams.set("profile_id", String(profileId))
  if (limit !== undefined && limit !== null) searchParams.set("limit", String(limit))
  const query = searchParams.toString()
  return apiFetch(`/api/items/suggestions${query ? `?${query}` : ""}`)
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
