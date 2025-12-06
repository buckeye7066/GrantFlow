import { useState, useCallback, useRef } from 'react';
import { base44 } from '@/api/base44Client';

const PHASES = {
  IDLE: 'idle',
  LOADING: 'loading',
  POLLING: 'polling',
  LOADING_MORE: 'loading-more',
  DONE: 'done',
  FAILED: 'failed',
};

const INITIAL_STATE = {
  phase: PHASES.IDLE,
  results: [],
  progress: 0,
  error: null,
  nextCursor: null,
};

function parseError(error) {
  // Normalize various error shapes into a consistent payload
  try {
    if (!error) return { message: 'Unknown error occurred' };
    if (error.response?.data) return error.response.data;
    if (typeof error === 'string') {
      try {
        return JSON.parse(error);
      } catch {
        return { message: error };
      }
    }
    if (error.message) return { message: error.message };
    return { message: 'Unknown error occurred' };
  } catch {
    return { message: 'Unknown error occurred' };
  }
}

function isSuccessEnvelope(data) {
  return !!(data && (data.success === true || data.ok === true));
}

function coerceArray(val, fallback = []) {
  return Array.isArray(val) ? val : fallback;
}

export function useDiscoverSearch() {
  const [state, set] = useState(INITIAL_STATE);
  const hasMore = !!state.nextCursor;
  // request guard to avoid racing updates when multiple searches triggered
  const requestIdRef = useRef(0);

  const handleError = useCallback((error, keepExistingResults = false) => {
    const errorPayload = parseError(error);
    set((s) => ({
      phase: PHASES.FAILED,
      results: keepExistingResults ? s.results : [],
      progress: 0,
      error: errorPayload,
      nextCursor: keepExistingResults ? s.nextCursor : null,
    }));
  }, []);

  const reset = useCallback(() => {
    set(INITIAL_STATE);
  }, []);

  const startSearch = useCallback(
    async (payload) => {
      const rid = ++requestIdRef.current;

      // Hard require profile_id
      const profileId = payload?.profile_id || payload?.profileId;
      if (!profileId) {
        console.error('[useDiscoverSearch] profile_id is required in payload');
        return handleError({ message: 'profile_id is required in payload' });
      }

      console.log('[useDiscoverSearch] Starting search for profile:', profileId);

      // Begin
      set({ phase: PHASES.LOADING, results: [], progress: 0, error: null, nextCursor: null });

      try {
        // Move to polling while backend works
        set((s) => ({ ...s, phase: PHASES.POLLING, progress: 0.1 }));

        // Use { body } envelope
        const response = await base44.functions.invoke('searchOpportunities', {
          body: payload,
        });

        // Handle various response shapes
        const data = response?.data ?? response;
        const status = response?.status ?? 200;
        const error = response?.error;

        if (error) {
          // Some wrappers return { error } separately
          throw error;
        }

        // Progress update while parsing
        set((s) => ({ ...s, progress: 0.7 }));

        const ok = status === 200 && isSuccessEnvelope(data);
        if (!ok) {
          throw data || { message: 'Search failed' };
        }

        const results = coerceArray(data.results, []);
        const nextCursor = data.paging?.nextCursor || null;

        // Ignore outdated request responses
        if (rid !== requestIdRef.current) return;

        set({
          phase: PHASES.DONE,
          results,
          progress: 1,
          error: null,
          nextCursor,
        });
      } catch (err) {
        // Ignore outdated request errors
        if (rid !== requestIdRef.current) return;
        handleError(err, false);
      }
    },
    [handleError]
  );

  const loadMore = useCallback(
    async (payload) => {
      if (!state.nextCursor) return;

      // Disallow concurrent phases
      if (
        state.phase === PHASES.LOADING ||
        state.phase === PHASES.LOADING_MORE ||
        state.phase === PHASES.POLLING
      ) {
        console.warn('[useDiscoverSearch] Cannot load more while in phase:', state.phase);
        return;
      }

      set((s) => ({ ...s, phase: PHASES.LOADING_MORE }));

      try {
        const loadMorePayload = {
          ...payload,
          paging: { limit: 25, afterId: state.nextCursor?.afterId },
        };

        const response = await base44.functions.invoke('searchOpportunities', {
          body: loadMorePayload,
        });

        // Handle various response shapes
        const data = response?.data ?? response;
        const status = response?.status ?? 200;
        const error = response?.error;

        if (error) throw error;

        const ok = status === 200 && isSuccessEnvelope(data);
        if (!ok) throw data || { message: 'Load more failed' };

        const newResults = coerceArray(data.results, []);
        const nextCursor = data.paging?.nextCursor || null;

        set((s) => ({
          ...s,
          phase: PHASES.DONE,
          results: [...s.results, ...newResults],
          nextCursor,
          progress: 1,
          error: null,
        }));
      } catch (err) {
        // Do NOT clear existing results on loadMore error
        handleError(err, true);
      }
    },
    [state.nextCursor, state.phase, handleError]
  );

  return {
    state,
    startSearch,
    loadMore,
    reset,
    hasMore,
    PHASES,
  };
}