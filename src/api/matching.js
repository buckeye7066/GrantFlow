import { apiFetch } from "@/api/client"

export async function matchProfileToGrants(profileId) {
  if (!profileId) throw new Error("profileId is required")
  return apiFetch(`/api/matching/profile/${profileId}/grants`)
}

