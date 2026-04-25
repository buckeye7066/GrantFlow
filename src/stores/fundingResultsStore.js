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
      returned: 0,
      totalFound: 0,
      totalScored: null,
      truncated: false,
      thresholdFallbackMessage: null,

      setResults: (data) => set({
        results: Array.isArray(data?.results) ? data.results : [],
        profileId: data?.profileId ?? null,
        organizationName: data?.organizationName ?? null,
        organizationId: data?.organizationId ?? null,
        returned: Number.isFinite(Number(data?.returned)) ? Number(data.returned) : (Array.isArray(data?.results) ? data.results.length : 0),
        totalFound: Number.isFinite(Number(data?.totalFound)) ? Number(data.totalFound) : (Array.isArray(data?.results) ? data.results.length : 0),
        totalScored: Number.isFinite(Number(data?.totalScored)) ? Number(data.totalScored) : null,
        truncated: Boolean(data?.truncated),
        thresholdFallbackMessage: data?.thresholdFallbackMessage ?? null,
      }),

      clear: () => set({
        results: [],
        profileId: null,
        organizationName: null,
        organizationId: null,
        returned: 0,
        totalFound: 0,
        totalScored: null,
        truncated: false,
        thresholdFallbackMessage: null,
      }),
    }),
    {
      name: 'grantflow:funding-results',
      partialize: (state) => ({
        results: state.results,
        profileId: state.profileId,
        organizationName: state.organizationName,
        organizationId: state.organizationId,
        returned: state.returned,
        totalFound: state.totalFound,
        totalScored: state.totalScored,
        truncated: state.truncated,
        thresholdFallbackMessage: state.thresholdFallbackMessage,
      }),
    },
  ),
)
