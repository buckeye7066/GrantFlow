import { useState, useMemo, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';

// ID validation patterns
const ID_PATTERN = /^[0-9a-f]{24}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate that a profile ID is in the correct format
 */
function isValidProfileId(id) {
  if (!id || typeof id !== 'string') return false;
  const trimmed = id.trim();
  return ID_PATTERN.test(trimmed) || UUID_PATTERN.test(trimmed);
}

/**
 * Custom hook for profile matching functionality with RLS filtering
 * @param {Object} options
 * @param {Object} options.user - Current user object
 * @param {boolean} options.isAdmin - Whether user is admin
 * @param {boolean} options.enabled - Whether to enable data fetching
 */
export function useProfileMatcher({ user, isAdmin, enabled = true } = {}) {
  const [selectedOrgId, setSelectedOrgId] = useState('');
  const [matches, setMatches] = useState(null);
  const [isMatching, setIsMatching] = useState(false);
  const [error, setError] = useState(null);

  // Fetch organizations with RLS filtering and user-aware query key
  const { data: organizations = [], isLoading: isLoadingOrgs } = useQuery({
    queryKey: ['organizations', user?.email, isAdmin],
    queryFn: () => isAdmin
      ? base44.entities.Organization.list('name')
      : base44.entities.Organization.filter({ created_by: user.email }, 'name'),
    enabled: enabled && !!user?.email,
  });

  // Validate selected org when organizations change
  useEffect(() => {
    if (selectedOrgId && organizations.length > 0 && !organizations.find(o => o.id === selectedOrgId)) {
      setSelectedOrgId('');
      setMatches(null);
    }
  }, [selectedOrgId, organizations]);

  // Memoized selected organization
  const selectedOrg = useMemo(() => 
    organizations.find(org => org.id === selectedOrgId),
    [organizations, selectedOrgId]
  );

  // Handle matching with permission verification
  const handleMatch = async () => {
    if (!selectedOrgId) {
      setError('Please select a profile first.');
      return;
    }
    
    // FAIL-SAFE: Validate ID format before sending
    if (!isValidProfileId(selectedOrgId)) {
      console.warn('[useProfileMatcher] Invalid profile ID format:', selectedOrgId);
      setError('The selected profile does not have a valid ID.');
      return;
    }
    
    // Verify user is authenticated
    if (!user?.email) {
      setError('You must be logged in to run matching.');
      return;
    }

    // Verify user has permission to match this profile
    const org = organizations.find(o => o.id === selectedOrgId);
    if (!org) {
      setError('Selected profile not found or you do not have access.');
      return;
    }

    if (!org.id) {
      console.warn('[useProfileMatcher] Organization object missing id:', org);
      setError('The selected profile does not have a valid ID.');
      return;
    }

    if (!isAdmin && org.created_by !== user.email) {
      setError('You do not have permission to run matching on this profile.');
      return;
    }
    
    setIsMatching(true);
    setError(null);
    
    try {
      // CRITICAL: Always use org.id (UUID), never org.name
      // MINIMAL PAYLOAD - only organization_id
      const payload = { organization_id: org.id };
      console.log('[useProfileMatcher] Calling matchProfileToGrants with payload:', JSON.stringify(payload));
      
      const response = await base44.functions.invoke('matchProfileToGrants', payload);
      
      console.log('[useProfileMatcher] Response:', { 
        success: response.data?.success, 
        error: response.data?.error,
        matchCount: response.data?.matches?.length 
      });
      
      // Handle axios response structure
      const data = response?.data || response;
      
      if (data?.success) {
        // Sort by match score descending
        const sortedMatches = (data.matches || []).sort((a, b) => 
          b.match_score - a.match_score
        );
        setMatches(sortedMatches);
      } else {
        setError(data?.message || data?.error || 'Failed to calculate matches');
      }
    } catch (err) {
      console.error('[useProfileMatcher] Matching failed:', err);
      // Extract message from axios error response if available
      const errMsg = err?.response?.data?.message || err?.response?.data?.error || err.message || 'An error occurred while matching grants';
      setError(errMsg);
    } finally {
      setIsMatching(false);
    }
  };

  // Clear matches when org selection changes
  const handleSetSelectedOrgId = (orgId) => {
    setSelectedOrgId(orgId);
    setMatches(null);
    setError(null);
  };

  return {
    organizations,
    isLoadingOrgs,
    selectedOrgId,
    setSelectedOrgId: handleSetSelectedOrgId,
    selectedOrg,
    matches,
    isMatching,
    error,
    handleMatch,
  };
}