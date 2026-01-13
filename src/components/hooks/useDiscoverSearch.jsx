import { useState } from 'react';
import { base44 } from '@/api/base44Client';

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
    console.log('[useDiscoverSearch] Starting search with payload:', payload);
    set({ phase: 'loading', results: [], progress: 0, error: null, nextCursor: null });
    
    try {
      // Validate payload
      if (!payload || !payload.profile_id) {
        throw new Error('profile_id is required in payload');
      }

      console.log('[useDiscoverSearch] Profile ID:', payload.profile_id);
      
      // Start polling
      set(s => ({ ...s, phase: 'polling', progress: 0.1 }));

      // Invoke the search function
      console.log('[useDiscoverSearch] Invoking searchOpportunities with:', payload);
      const response = await base44.functions.invoke('searchOpportunities', payload);

      console.log('[useDiscoverSearch] Search function response:', response);

      // Check if the function succeeded
      if (response.status === 200 && response.data?.success) {
        const results = response.data.results || [];
        console.log('[useDiscoverSearch] Search complete with', results.length, 'results');
        
        set({
          phase: 'done',
          results: results,
          progress: 1,
          error: null,
          nextCursor: null,
        });
      } else {
        console.error('[useDiscoverSearch] Function returned error:', response.data);
        handleError(response.data || { message: 'Search failed' });
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
        
        if(response.status === 200 && response.data.success) {
            set(s => ({
                ...s,
                phase: 'done',
                results: [...s.results, ...(response.data.results || [])],
                nextCursor: response.data.paging?.nextCursor,
            }));
        } else {
            handleError(response.data);
        }

    } catch(err) {
        handleError(err);
    }
  };

  return { state, startSearch, loadMore };
}