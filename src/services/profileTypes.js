/**
 * profileTypes.js (frontend)
 *
 * Single frontend entry point for the canonical profile-type list.
 * Backed by:
 *   - shared/profileTypeOptions.js — curated, dependency-free static
 *     list (used as the immediate render-time fallback so selectors
 *     don't flash empty options before /api/profile-types resolves).
 *   - GET /api/profile-types — backend route returning the same list
 *     enriched with anya labels, recommended strategy, default needs,
 *     and source counts.
 *
 * Every UI selector that asks the user "what kind of profile is
 * this?" MUST import from here so we never drift from the backend
 * registry. A vitest (tests/unit/profile-type-options.test.mjs)
 * guards the contract.
 */
import { useQuery } from "@tanstack/react-query"

import {
  PROFILE_TYPE_OPTIONS,
  PROFILE_TYPE_UI_ALIASES,
  canonicalizeProfileTypeId,
  getGroupedProfileTypeOptions,
} from "../../shared/profileTypeOptions.js"
import { apiFetch } from "@/api/client"

export {
  PROFILE_TYPE_OPTIONS,
  PROFILE_TYPE_UI_ALIASES,
  canonicalizeProfileTypeId,
  getGroupedProfileTypeOptions,
}

/**
 * React Query hook to load the canonical list (enriched). Falls back
 * to the static curated list while loading or on error so selectors
 * are never blank.
 */
export function useProfileTypes() {
  const query = useQuery({
    queryKey: ["profile-types", "bundle"],
    queryFn: async () => {
      const data = await apiFetch("/api/profile-types")
      if (!data || !Array.isArray(data?.items)) throw new Error("Invalid /api/profile-types response")
      return data
    },
    staleTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    retry: 1,
  })

  const items = Array.isArray(query.data?.items) && query.data.items.length > 0
    ? query.data.items
    : PROFILE_TYPE_OPTIONS

  const grouped = Array.isArray(query.data?.grouped) && query.data.grouped.length > 0
    ? query.data.grouped
    : getGroupedProfileTypeOptions().map(({ group, options }) => ({ group, options }))

  return {
    items,
    grouped,
    aliases: query.data?.aliases ?? PROFILE_TYPE_UI_ALIASES,
    loading: query.isLoading,
    error: query.error,
  }
}

/**
 * Convenience: human-readable label for a raw stored value (handles
 * legacy aliases and unknown strings cleanly so no UI ever renders a
 * raw snake_case identifier to the user).
 */
export function labelForProfileType(raw, fallback = null) {
  const id = canonicalizeProfileTypeId(raw)
  const match = PROFILE_TYPE_OPTIONS.find((option) => option.id === id)
  if (match) return match.label
  if (typeof raw === "string" && raw.trim()) {
    return raw
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase())
  }
  return fallback
}
