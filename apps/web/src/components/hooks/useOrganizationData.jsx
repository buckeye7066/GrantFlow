import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';

/**
 * Consolidated data fetching hook for organization profile
 * Handles all queries needed for the profile view
 * 
 * @param {string} organizationId - The organization ID
 * @param {number} manualRetryCount - Manual retry counter
 * @returns {Object} All data and loading states
 */
export function useOrganizationData(organizationId, manualRetryCount = 0) {
  // ISOLATION: Validate organizationId is present
  if (!organizationId) {
    console.warn('[useOrganizationData] ISOLATION: No organizationId provided');
  }
  
  // Main organization data
  const { 
    data: organization, 
    isLoading: isLoadingOrg, 
    error: orgError,
    refetch: refetchOrg 
  } = useQuery({
    queryKey: ['organization', organizationId, manualRetryCount],
    queryFn: async () => {
      // ISOLATION: Require valid organizationId
      if (!organizationId) {
        throw new Error('ISOLATION_ERROR: organizationId is required');
      }
      
      console.log('[useOrganizationData] Fetching organization:', organizationId);
      const result = await base44.entities.Organization.get(organizationId);
      
      // SECURITY: Log-safe (no PHI in console)
      console.log('[useOrganizationData] Fetched organization:', { 
        id: result?.id, 
        name: result?.name, 
        type: result?.applicant_type 
      });
      
      if (!result) {
        throw new Error('Organization not found');
      }
      
      // ISOLATION: Verify the result matches the requested ID
      if (result.id !== organizationId) {
        console.error('[useOrganizationData] ISOLATION_VIOLATION: Returned org does not match requested ID');
        throw new Error('ISOLATION_VIOLATION: Cross-profile access blocked');
      }
      
      return result;
    },
    enabled: !!organizationId,
    retry: 2,
    retryDelay: 1000,
    staleTime: 0, // Always refetch to get latest data
    gcTime: 0, // Don't cache - always get fresh data
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  });

  // SECURITY: Contact methods for THIS organization ONLY
  const { data: contactMethods = [], isLoading: isLoadingContacts } = useQuery({
    queryKey: ['contactMethods', organizationId],
    queryFn: async () => {
      if (!organizationId) return [];
      
      const fetchedContacts = await base44.entities.ContactMethod.filter({ organization_id: organizationId });
      
      // SECURITY: Verify all contacts belong to this profile
      const invalidContacts = fetchedContacts.filter(c => c.organization_id !== organizationId);
      if (invalidContacts.length > 0) {
        console.error('[useOrganizationData] SECURITY: Cross-profile contact contamination', {
          organizationId,
          invalid_count: invalidContacts.length
        });
        return fetchedContacts.filter(c => c.organization_id === organizationId);
      }
      
      return fetchedContacts;
    },
    enabled: !!organizationId && !!organization,
    staleTime: 1000 * 60 * 2,
  });

  // SECURITY: Grants for THIS organization ONLY
  const { data: grants = [], isLoading: isLoadingGrants } = useQuery({
    queryKey: ['grants', organizationId],
    queryFn: async () => {
      if (!organizationId) return [];
      
      const fetchedGrants = await base44.entities.Grant.filter({ organization_id: organizationId });
      
      // SECURITY: Verify all grants belong to this profile
      const invalidGrants = fetchedGrants.filter(g => g.organization_id !== organizationId);
      if (invalidGrants.length > 0) {
        console.error('[useOrganizationData] SECURITY: Cross-profile grant contamination', {
          organizationId,
          invalid_count: invalidGrants.length
        });
        return fetchedGrants.filter(g => g.organization_id === organizationId);
      }
      
      return fetchedGrants;
    },
    enabled: !!organizationId && !!organization,
    staleTime: 1000 * 60 * 2,
  });

  // SECURITY: Funding sources discovered for THIS org ONLY
  // PRIMARY KEY: profile_id (set by backend saveFundingSources)
  const { data: fundingSources = [], isLoading: isLoadingSources, refetch: refetchFundingSources } = useQuery({
    queryKey: ['fundingSources', organizationId],
    queryFn: async () => {
      if (!organizationId) {
        console.warn('[useOrganizationData] No organizationId - returning empty sources');
        return [];
      }
      
      console.log('[useOrganizationData] Fetching funding sources for profile_id:', organizationId);
      
      try {
        // Try all possible ownership fields
        const [sourcesByProfileId, sourcesByOrgId] = await Promise.all([
          base44.entities.SourceDirectory.filter({ profile_id: organizationId }).catch(() => []),
          base44.entities.SourceDirectory.filter({ discovered_for_organization_id: organizationId }).catch(() => [])
        ]);
        
        console.log('[useOrganizationData] Sources by profile_id:', sourcesByProfileId?.length || 0);
        console.log('[useOrganizationData] Sources by discovered_for_organization_id:', sourcesByOrgId?.length || 0);
        
        // Merge and deduplicate
        const uniqueSourcesMap = new Map();
        [...(sourcesByProfileId || []), ...(sourcesByOrgId || [])].forEach(s => {
          if (s && s.id) uniqueSourcesMap.set(s.id, s);
        });
        
        const sources = Array.from(uniqueSourcesMap.values());
        
        console.log('[useOrganizationData] FUNDING_SOURCES_FINAL:', {
          organizationId,
          merged: sources.length,
          sampleNames: sources.slice(0, 3).map(s => s.name)
        });
        
        return sources;
      } catch (error) {
        console.error('[useOrganizationData] Error fetching sources:', error.message);
        return [];
      }
    },
    enabled: !!organizationId && !!organization,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  });

  // SECURITY: Documents for THIS organization ONLY
  const { 
    data: documents = [], 
    isLoading: isLoadingDocuments,
    refetch: refetchDocuments 
  } = useQuery({
    queryKey: ['documents', organizationId],
    queryFn: async () => {
      if (!organizationId) return [];
      
      const fetchedDocs = await base44.entities.Document.filter({ organization_id: organizationId });
      
      // SECURITY: Verify all documents belong to this profile
      const invalidDocs = fetchedDocs.filter(d => d.organization_id !== organizationId);
      if (invalidDocs.length > 0) {
        console.error('[useOrganizationData] SECURITY: Cross-profile document contamination', {
          organizationId,
          invalid_count: invalidDocs.length
        });
        return fetchedDocs.filter(d => d.organization_id === organizationId);
      }
      
      return fetchedDocs;
    },
    enabled: !!organizationId && !!organization,
    staleTime: 1000 * 60 * 2,
  });

  // Taxonomy for labels
  const { data: taxonomyItems = [] } = useQuery({
    queryKey: ['taxonomy'],
    queryFn: () => base44.entities.Taxonomy.list(),
    staleTime: 1000 * 60 * 30, // 30 minutes - rarely changes
  });

  // Derived contact arrays
  const emails = contactMethods.filter(c => c.type === 'email');
  const phones = contactMethods.filter(c => c.type === 'phone');

  // Overall loading state
  const isLoading = isLoadingOrg;

  return {
    // Data
    organization,
    contactMethods,
    emails,
    phones,
    grants,
    fundingSources,
    documents,
    taxonomyItems,
    
    // Loading states
    isLoading,
    isLoadingOrg,
    isLoadingContacts,
    isLoadingGrants,
    isLoadingSources,
    isLoadingDocuments,
    
    // Error
    orgError,
    
    // Refetch functions
    refetchOrg,
    refetchDocuments,
    refetchFundingSources,
  };
}