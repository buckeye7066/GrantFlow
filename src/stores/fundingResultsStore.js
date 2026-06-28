import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Persisted funding-results store, profile-scoped.
 *
 * Invariants (see docs/PROFILE_SCOPING.md):
 *   1. Every entry stamps the profileId at write time.
 *   2. Readers must call `getResultsForProfile(activeId)` so a stored
 *      result tagged with a different profileId never bleeds across profiles.
 *   3. On hydrate, if the persisted profileId disagrees with the active
 *      profile in authStore, the store self-evicts within one tick.
 *   4. authStore.setActiveProfileId() also calls .clear() on profile change
 *      and clearAllProfileScopedStorage() — so even if a reader forgets to
 *      use the selector, the underlying state is empty.
 *
 * `diagnostics` carries the zero-result ladder telemetry the backend produces
 * (result tier, what was searched/expanded, profile gaps, honest explanation)
 * so the UI can render an explanatory zero-result state instead of a dead end.
 * (Mission System 5, RC-12.)
 */
const EMPTY_RESULT_VIEW = Object.freeze({
  results: [],
  profileId: null,
  organizationName: null,
  organizationId: null,
  returned: 0,
  totalFound: 0,
  totalScored: null,
  truncated: false,
  thresholdFallbackMessage: null,
  diagnostics: null,
})

export const useFundingResultsStore = create(
  persist(
    (set, get) => ({
      results: [],
      profileId: null,
      organizationName: null,
      organizationId: null,
      returned: 0,
      totalFound: 0,
      totalScored: null,
      truncated: false,
      thresholdFallbackMessage: null,
      diagnostics: null,

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
        diagnostics: data?.diagnostics ?? null,
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
        diagnostics: null,
      }),

      /**
       * Profile-scoped read. Returns an empty result view when the persisted
       * profileId does not strictly equal `requestedProfileId`. This is the
       * canonical way for pages to read results — never read .results
       * directly without going through this selector.
       *
       * @param {string|null|undefined} requestedProfileId
       * @returns {typeof EMPTY_RESULT_VIEW}
       */
      getResultsForProfile: (requestedProfileId) => {
        const state = get()
        const requested =
          requestedProfileId === null || requestedProfileId === undefined
            ? null
            : String(requestedProfileId)
        const stored =
          state.profileId === null || state.profileId === undefined
            ? null
            : String(state.profileId)
        if (!requested || !stored || requested !== stored) {
          return EMPTY_RESULT_VIEW
        }
        return {
          results: state.results,
          profileId: state.profileId,
          organizationName: state.organizationName,
          organizationId: state.organizationId,
          returned: state.returned,
          totalFound: state.totalFound,
          totalScored: state.totalScored,
          truncated: state.truncated,
          thresholdFallbackMessage: state.thresholdFallbackMessage,
          diagnostics: state.diagnostics,
        }
      },
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
        diagnostics: state.diagnostics,
      }),
      onRehydrateStorage: () => (state, error) => {
        // Self-evict on profile mismatch. We avoid importing authStore here
        // (would cycle) so we read the persisted active profile id straight
        // out of localStorage. authStore.hydrateFromStorage() reads the same
        // key on boot, so they agree.
        if (error || !state) return
        if (typeof window === 'undefined') return
        try {
          const activeId = window.localStorage.getItem('grantflow:active-profile-id')
          const stored = state.profileId
          if (stored && activeId && String(stored) !== String(activeId)) {
            // Direct mutation of the rehydrated state object plus a deferred
            // setState ensures the store fires a re-render with the cleared
            // values within the same tick.
            state.results = []
            state.profileId = null
            state.organizationName = null
            state.organizationId = null
            state.returned = 0
            state.totalFound = 0
            state.totalScored = null
            state.truncated = false
            state.thresholdFallbackMessage = null
            state.diagnostics = null
            try {
              useFundingResultsStore.setState({
                results: [],
                profileId: null,
                organizationName: null,
                organizationId: null,
                returned: 0,
                totalFound: 0,
                totalScored: null,
                truncated: false,
                thresholdFallbackMessage: null,
                diagnostics: null,
              })
            } catch { /* ignore */ }
            if (import.meta.env?.DEV) {
              try {
              console.info('[fundingResultsStore] evicted stored results — profile mismatch on rehydrate', {
                stored_profile_id: stored,
                active_profile_id: activeId,
              })
              } catch { /* ignore */ }
            }
          }
        } catch { /* ignore */ }
      },
    },
  ),
)
