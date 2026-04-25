import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Store for passing search results to FundingResults page across navigation.
 * Set by DiscoverGrants after crawler completion; read by FundingResults.
 */
export const useFundingResultsStore = create(
  persist(
    (set) => ({
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
    }),
    {
      name: 'grantflow:funding-results',
      partialize: (state) => ({
        results: state.results,
        profileId: state.profileId,
        organizationName: state.organizationName,
        organizationId: state.organizationId,
      }),
    },
  ),
)
