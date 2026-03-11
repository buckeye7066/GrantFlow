import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { createLogger } from '@/utils/logger'

const log = createLogger('useDiscoverSearch')

export function useDiscoverSearch() {
  const [state, set] = useState({
    phase: "idle",
    results: [],
    progress: 0,
    error: null,
    nextCursor: null,
  });

  const handleError = (error) => {
    console.error("[useDiscoverSearch] Error:", error);
    
    let errorPayload;
    
    if (error.response?.data) {
      errorPayload = error.response.data;
    } else if (typeof error === 'string') {
      try {
        errorPayload = JSON.parse(error);
      } catch {
        errorPayload = { message: error };
      }
    } else if (error.message) {
      errorPayload = { message: error.message };
    } else {
      errorPayload = { message: 'Unknown error occurred' };
    }
    
    set({ phase: 'failed', results: [], progress: 0, error: errorPayload, nextCursor: null });
  };

  const startSearch = async (payload) => {
    log.debug('starting search')
    set({ phase: 'loading', results: [], progress: 0, error: null, nextCursor: null });
    
    try {
      // Validate payload
      if (!payload || !payload.profile_id) {
        throw new Error('profile_id is required in payload');
      }

      log.debug('profile id present')
      
      // Start polling
      set(s => ({ ...s, phase: 'polling', progress: 0.1 }));

      // Invoke the search function
      const response = await base44.functions.invoke('searchOpportunities', payload);

      // response is the parsed JSON body (apiFetch throws on non-2xx)
      if (response?.success) {
        const results = response.results || [];
        log.debug('search complete', { results: results.length })
        
        set({
          phase: 'done',
          results: results,
          progress: 1,
          error: null,
          nextCursor: response.paging?.nextCursor ?? null,
        });
      } else {
        console.error('[useDiscoverSearch] Function returned error:', response);
        handleError(response || { message: 'Search failed' });
      }

    } catch (err) {
      console.error('[useDiscoverSearch] Caught error:', err);
      handleError(err);
    }
  };

  const loadMore = async (payload) => {
    if (!state.nextCursor || state.phase === 'loading-more') return;

    set(s => ({...s, phase: 'loading-more'}));

    try {
        const loadMorePayload = {
            ...payload,
            paging: { limit: 25, afterId: state.nextCursor.afterId }
        };
        
        const response = await base44.functions.invoke('searchOpportunities', loadMorePayload);
        
        if (response?.success) {
            set(s => ({
                ...s,
                phase: 'done',
                results: [...s.results, ...(response.results || [])],
                nextCursor: response.paging?.nextCursor ?? null,
            }));
        } else {
            handleError(response || { message: 'Load more failed' });
        }

    } catch(err) {
        handleError(err);
    }
  };

  return { state, startSearch, loadMore };
}