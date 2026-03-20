import { create } from 'zustand'

/**
 * Store for passing search results to FundingResults page across navigation.
 * Set by DiscoverGrants after crawler completion; read by FundingResults.
 */
export const useFundingResultsStore = create((set) => ({
  results: [],
  profileId: null,
  organizationName: null,
  organizationId: null,

  setResults: (data) => set({
    results: Array.isArray(data?.results) ? data.results : [],
    profileId: data?.profileId ?? null,
    organizationName: data?.organizationName ?? null,
    organizationId: data?.organizationId ?? null,
  }),

  clear: () => set({ results: [], profileId: null, organizationName: null, organizationId: null }),
}))
