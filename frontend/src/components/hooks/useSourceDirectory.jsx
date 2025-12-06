import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { useToast } from '@/components/ui/use-toast';
import { callFunction } from '@/components/shared/functionClient';

/**
 * Custom hook for managing source directory data and operations with RLS filtering
 * @param {Object} options
 * @param {Object} options.user - Current user object
 * @param {boolean} options.isAdmin - Whether user is admin
 * @param {boolean} options.enabled - Whether to enable data fetching
 * @param {string} options.initialProfileId - Initial profile ID from URL params
 */
export function useSourceDirectory({ user, isAdmin, enabled = true, initialProfileId = null } = {}) {
  const [selectedOrgId, setSelectedOrgId] = useState(initialProfileId);
  const [sourceTypeFilter, setSourceTypeFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSources, setSelectedSources] = useState([]);
  const [crawlingInBackground, setCrawlingInBackground] = useState([]);
  const [expandedSourceId, setExpandedSourceId] = useState(null);
  const [autoDiscoveryRun, setAutoDiscoveryRun] = useState({});

  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Fetch sources with RLS filtering
  const { data: sources = [], isLoading: isLoadingSources } = useQuery({
    queryKey: ['sourceDirectory', user?.email, isAdmin],
    queryFn: () => isAdmin
      ? base44.entities.SourceDirectory.list()
      : base44.entities.SourceDirectory.filter({ created_by: user.email }),
    enabled: enabled && !!user?.email,
  });

  // Fetch organizations with RLS filtering
  const { data: organizations = [], isLoading: isLoadingOrgs } = useQuery({
    queryKey: ['organizations', user?.email, isAdmin],
    queryFn: () => isAdmin
      ? base44.entities.Organization.list('name')
      : base44.entities.Organization.filter({ created_by: user.email }, 'name'),
    enabled: enabled && !!user?.email,
  });

  // Fetch grants with RLS filtering
  const { data: allGrants = [] } = useQuery({
    queryKey: ['grants', user?.email, isAdmin],
    queryFn: () => isAdmin
      ? base44.entities.Grant.list()
      : base44.entities.Grant.filter({ created_by: user.email }),
    enabled: enabled && !!user?.email,
  });

  // Fetch opportunities for expanded source with RLS filtering
  const { data: sourceOpportunities = [], isLoading: isLoadingOpportunities } = useQuery({
    queryKey: ['sourceOpportunities', expandedSourceId, user?.email, isAdmin],
    queryFn: async () => {
      if (!expandedSourceId) return [];
      const source = sources.find(s => s.id === expandedSourceId);
      if (!source) return [];
      
      const opportunities = isAdmin
        ? await base44.entities.FundingOpportunity.filter({
            source: 'source_directory',
            sponsor: source.name
          })
        : await base44.entities.FundingOpportunity.filter({
            source: 'source_directory',
            sponsor: source.name,
            created_by: user.email
          });
      
      return opportunities;
    },
    enabled: enabled && !!expandedSourceId && !!user?.email,
  });

  // Auto-select organization from URL param or first available
  useEffect(() => {
    if (!selectedOrgId && organizations.length > 0) {
      // If initialProfileId is valid and in list, use it
      if (initialProfileId && organizations.some(o => o.id === initialProfileId)) {
        setSelectedOrgId(initialProfileId);
      } else {
        setSelectedOrgId(organizations[0].id);
      }
    }
  }, [organizations, selectedOrgId, initialProfileId]);

  // Validate selected org is in RLS-filtered list
  useEffect(() => {
    if (selectedOrgId && organizations.length > 0 && !organizations.find(o => o.id === selectedOrgId)) {
      setSelectedOrgId(organizations[0]?.id || null);
    }
  }, [selectedOrgId, organizations]);

  // Auto-refresh when crawling
  useEffect(() => {
    if (crawlingInBackground.length > 0) {
      const interval = setInterval(() => {
        queryClient.invalidateQueries({ queryKey: ['sourceDirectory', user?.email, isAdmin] });
      }, 10000);
      return () => clearInterval(interval);
    }
  }, [crawlingInBackground, queryClient, user?.email, isAdmin]);

  // AUTO-DISCOVERY: Run in background when profile is selected
  useEffect(() => {
    if (selectedOrgId && !autoDiscoveryRun[selectedOrgId] && user?.email) {
      const selectedOrg = organizations.find(o => o.id === selectedOrgId);
      
      // Verify user has permission for this org
      if (!selectedOrg || (!isAdmin && selectedOrg.created_by !== user.email)) {
        return;
      }
      
      const orgSources = sources.filter(s => s.discovered_for_organization_id === selectedOrgId);
      
      // Only auto-discover if profile has fewer than 3 sources
      if (selectedOrg && orgSources.length < 3) {
        console.log('[useSourceDirectory] Auto-running discovery for:', selectedOrg.name);
        
        // Mark as run to prevent duplicate discoveries
        setAutoDiscoveryRun(prev => ({ ...prev, [selectedOrgId]: true }));
        
        // Run discovery in background using callFunction
        callFunction('discoverLocalSources', { 
          profile_id: selectedOrgId,
          organization_id: selectedOrgId
        })
          .then(response => {
            console.log('[useSourceDirectory] Auto-discovery completed:', response);
            
            if (response.ok && response.data?.success && response.data?.summary?.new_sources > 0) {
              toast({
                title: '✨ New Sources Discovered',
                description: `Found ${response.data.summary.new_sources} new funding sources for ${selectedOrg.name}`,
              });
              queryClient.invalidateQueries({ queryKey: ['sourceDirectory', user?.email, isAdmin] });
            }
          })
          .catch(err => {
            console.error('[useSourceDirectory] Auto-discovery error:', err);
            // Silent fail for auto-discovery
          });
      }
    }
  }, [selectedOrgId, organizations, sources, autoDiscoveryRun, toast, queryClient, user?.email, isAdmin]);

  const selectedOrg = useMemo(() =>
    organizations.find(o => o.id === selectedOrgId),
    [organizations, selectedOrgId]
  );

  // Helper to verify permission for operations
  const hasPermission = useMemo(() => {
    if (!user?.email || !selectedOrg) return false;
    return isAdmin || selectedOrg.created_by === user.email;
  }, [user?.email, selectedOrg, isAdmin]);

  const relevantSources = useMemo(() => {
    if (!selectedOrgId || !selectedOrg) return [];

    const isStudent = ['high_school_student', 'college_student', 'graduate_student'].includes(selectedOrg.applicant_type);
    const isIndividual = ['individual_need', 'medical_assistance', 'family'].includes(selectedOrg.applicant_type);
    const studentOnlyTypes = ['university', 'community_college'];
    const individualOnlyTypes = ['hospital_system'];

    return sources.filter(source => {
      if (source.discovered_for_organization_id === selectedOrgId) {
        return true;
      }
      if (source.discovered_for_organization_id && source.discovered_for_organization_id !== selectedOrgId) {
        return false;
      }
      if (!source.discovered_for_organization_id) {
        if (!isStudent && studentOnlyTypes.includes(source.source_type)) {
          return false;
        }
        if (!isIndividual && individualOnlyTypes.includes(source.source_type)) {
          return false;
        }
        if (!source.service_area || source.service_area.length === 0) {
          return true;
        }
        if (selectedOrg.state && source.service_area.includes(selectedOrg.state)) return true;
        if (selectedOrg.city && source.service_area.includes(selectedOrg.city)) return true;
        if (source.service_area.includes('National') || source.service_area.includes('USA')) return true;
      }
      return false;
    });
  }, [sources, selectedOrgId, selectedOrg]);

  const sourcesDue = useMemo(() => {
    const now = new Date();
    return relevantSources.filter((source) => {
      if (!source.active) return false;
      if (!source.last_crawled) return true;

      const lastCrawled = new Date(source.last_crawled);
      const frequency = source.crawl_frequency || 'monthly';

      const intervals = {
        daily: 1,
        weekly: 7,
        monthly: 30,
        quarterly: 90,
        annually: 365,
      };

      const daysSinceLastCrawl = (now.getTime() - lastCrawled.getTime()) / (1000 * 60 * 60 * 24);
      return daysSinceLastCrawl >= (intervals[frequency] || 30);
    });
  }, [relevantSources]);

  const filteredSources = useMemo(() => {
    let filtered = relevantSources;

    if (sourceTypeFilter !== 'all') {
      filtered = filtered.filter(s => s.source_type === sourceTypeFilter);
    }

    if (searchQuery) {
      filtered = filtered.filter((source) =>
        source.name.toLowerCase().includes(searchQuery.toLowerCase())
      );
    }

    return filtered;
  }, [relevantSources, searchQuery, sourceTypeFilter]);

  const sourceTypes = useMemo(() => {
    const types = new Set(relevantSources.map(s => s.source_type).filter(Boolean));
    return Array.from(types).sort();
  }, [relevantSources]);

  const sourcesByType = useMemo(() => {
    const grouped = {};
    relevantSources.forEach(source => {
      if (!grouped[source.source_type]) {
        grouped[source.source_type] = [];
      }
      grouped[source.source_type].push(source);
    });
    return grouped;
  }, [relevantSources]);

  // Crawl mutation with permission check
  const crawlMutation = useMutation({
    mutationFn: async (sourceId) => {
      // Verify permission
      if (!hasPermission) {
        throw new Error('You do not have permission to crawl sources for this profile.');
      }
      
      base44.functions.invoke('crawlSourceDirectory', { body: { source_id: sourceId } }).catch(err => {
        console.error('Background crawl error:', err);
      });
      return { sourceId };
    },
    onSuccess: (data) => {
      setCrawlingInBackground(prev => [...prev, data.sourceId]);
      toast({
        title: '🚀 Crawl Started',
        description: 'Crawling in background. Page will auto-refresh when complete.',
        duration: 3000,
      });

      setTimeout(() => {
        setCrawlingInBackground(prev => prev.filter(id => id !== data.sourceId));
        queryClient.invalidateQueries({ queryKey: ['sourceDirectory', user?.email, isAdmin] });
      }, 120000);
    },
    onError: (error) => {
      toast({
        variant: 'destructive',
        title: 'Crawl Failed',
        description: error.message,
      });
    }
  });

  // Bulk crawl mutation with permission check
  const bulkCrawlMutation = useMutation({
    mutationFn: async (sourceIds) => {
      // Verify permission
      if (!hasPermission) {
        throw new Error('You do not have permission to crawl sources for this profile.');
      }
      
      for (const sourceId of sourceIds) {
        base44.functions.invoke('crawlSourceDirectory', { body: { source_id: sourceId } }).catch(err => {
          console.error('Background crawl error:', err);
        });
      }
      return { sourceIds, count: sourceIds.length };
    },
    onSuccess: (data) => {
      setCrawlingInBackground(prev => [...prev, ...data.sourceIds]);
      setSelectedSources([]);
      toast({
        title: '🚀 Bulk Crawl Started',
        description: `${data.count} sources crawling in background. Page will auto-refresh.`,
        duration: 4000,
      });

      setTimeout(() => {
        setCrawlingInBackground(prev => prev.filter(id => !data.sourceIds.includes(id)));
        queryClient.invalidateQueries({ queryKey: ['sourceDirectory', user?.email, isAdmin] });
      }, 300000);
    },
    onError: (error) => {
      toast({
        variant: 'destructive',
        title: 'Bulk Crawl Failed',
        description: error.message,
      });
    }
  });

  // Delete mutation with permission check
  const deleteMutation = useMutation({
    mutationFn: async (target) => {
      // Verify permission
      if (!hasPermission) {
        throw new Error('You do not have permission to delete sources for this profile.');
      }
      
      let sourceIdsToDelete = [];
      
      if (target.type === 'single') {
        sourceIdsToDelete = [target.id];
      } else if (target.type === 'bulk') {
        sourceIdsToDelete = target.ids;
      } else if (target.type === 'by_source_type') {
        const typeSources = sources.filter(s =>
          s.discovered_for_organization_id === selectedOrgId &&
          s.source_type === target.sourceType
        );
        sourceIdsToDelete = typeSources.map(s => s.id);
      }

      const response = await base44.functions.invoke('deleteSourceWithCascade', {
        body: {
          source_ids: sourceIdsToDelete,
          organization_id: selectedOrgId
        }
      });

      return response.data;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['sourceDirectory', user?.email, isAdmin] });
      queryClient.invalidateQueries({ queryKey: ['fundingOpportunities', user?.email, isAdmin] });
      queryClient.invalidateQueries({ queryKey: ['grants', user?.email, isAdmin] });
      setSelectedSources([]);
      
      const messageParts = [];
      messageParts.push(`${result.count} source${result.count !== 1 ? 's' : ''} removed`);
      if (result.opportunitiesDeleted > 0) {
        messageParts.push(`${result.opportunitiesDeleted} opportunity${result.opportunitiesDeleted !== 1 ? 's' : ''} deleted`);
      }
      if (result.grantsDeleted > 0) {
        messageParts.push(`${result.grantsDeleted} grant${result.grantsDeleted !== 1 ? 's' : ''} removed from pipeline`);
      }
      
      toast({
        title: '✅ Cascade Delete Complete',
        description: messageParts.join(', '),
      });
    },
    onError: (error) => {
      toast({
        variant: 'destructive',
        title: 'Delete Failed',
        description: error.message,
      });
    }
  });

  // AI Discovery mutation with permission check
  const discoverMutation = useMutation({
    mutationFn: async (orgId) => {
      // Verify permission
      if (!hasPermission) {
        throw new Error('You do not have permission to discover sources for this profile.');
      }
      
      // CRITICAL: Validate orgId before calling
      if (!orgId) {
        throw new Error('Missing profile_id - cannot discover sources');
      }
      
      console.log('[useSourceDirectory] Manual discovery triggered for org:', orgId);
      const response = await callFunction('discoverLocalSources', { 
        profile_id: orgId,
        organization_id: orgId
      });
      
      if (!response.ok) {
        throw new Error(response.error || 'Discovery failed');
      }
      
      return response.data;
    },
    onSuccess: (data) => {
      console.log('[useSourceDirectory] Manual discovery response:', data);
      
      if (data?.success && data?.summary) {
        toast({
          title: '✅ Discovery Complete',
          description: `Found ${data.summary.total_discovered} sources (${data.summary.new_sources} new, ${data.summary.needs_review} need review)`,
          duration: 5000,
        });
      } else {
        toast({
          title: '✨ Discovery Complete',
          description: data?.message || 'Discovery completed successfully.',
          duration: 3000,
        });
      }
      
      queryClient.invalidateQueries({ queryKey: ['sourceDirectory', user?.email, isAdmin] });
    },
    onError: (error) => {
      console.error('[useSourceDirectory] Discovery error:', error);
      toast({
        variant: 'destructive',
        title: 'Discovery Failed',
        description: error.message || 'An error occurred during discovery.',
      });
    }
  });

  // AI Search mutation with permission check
  const searchSourceMutation = useMutation({
    mutationFn: async ({ source_name, location, organization_id }) => {
      // Verify permission
      if (!hasPermission) {
        throw new Error('You do not have permission to search sources for this profile.');
      }
      
      // CRITICAL: Validate organization_id
      const effectiveOrgId = organization_id || selectedOrgId;
      if (!effectiveOrgId) {
        throw new Error('Missing organization_id - cannot search sources');
      }
      
      console.log('[useSourceDirectory] Searching for source:', { source_name, location, organization_id: effectiveOrgId });
      const response = await callFunction('searchForSource', { 
        source_name, 
        location, 
        organization_id: effectiveOrgId,
        profile_id: effectiveOrgId
      });
      
      if (!response.ok) {
        throw new Error(response.error || 'Search failed');
      }
      
      return response.data;
    },
    onSuccess: (data) => {
      console.log('[useSourceDirectory] Search response:', data);
      
      if (data?.success && data?.source) {
        toast({
          title: '✅ Source Found',
          description: `Found ${data.source.name}. Review and save to add to directory.`,
        });
      } else {
        toast({
          variant: 'destructive',
          title: 'Not Found',
          description: data?.message || 'Could not find information about this source.',
        });
      }
    },
    onError: (error) => {
      console.error('[useSourceDirectory] Search error:', error);
      toast({
        variant: 'destructive',
        title: 'Search Failed',
        description: error.message || 'An error occurred while searching.',
      });
    }
  });

  const isLoading = isLoadingSources || isLoadingOrgs;

  // Clear selections when org changes
  const handleSetSelectedOrgId = (orgId) => {
    setSelectedOrgId(orgId);
    setSelectedSources([]);
    setExpandedSourceId(null);
  };

  return {
    // Data
    sources,
    organizations,
    allGrants,
    sourceOpportunities,
    selectedOrg,
    relevantSources,
    filteredSources,
    sourcesDue,
    sourceTypes,
    sourcesByType,
    
    // State
    selectedOrgId,
    setSelectedOrgId: handleSetSelectedOrgId,
    sourceTypeFilter,
    setSourceTypeFilter,
    searchQuery,
    setSearchQuery,
    selectedSources,
    setSelectedSources,
    crawlingInBackground,
    expandedSourceId,
    setExpandedSourceId,
    
    // Mutations
    crawlMutation,
    bulkCrawlMutation,
    deleteMutation,
    discoverMutation,
    searchSourceMutation,
    
    // Loading states
    isLoading,
    isLoadingOpportunities,
  };
}