import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { useAuthContext } from '@/components/hooks/useAuthRLS';
import { createPageUrl } from '@/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { 
  Loader2, 
  Search, 
  User, 
  Target,
  Zap,
  UserCheck,
  MapPin,
  CheckCircle2,
  Save,
  History,
  Trash2,
  AlertCircle,
  X,
  Sparkles
} from 'lucide-react';
import SearchResults from '@/components/discovery/SearchResults';
import AISearchFilters from '@/components/discovery/AISearchFilters';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/use-toast';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import { motion } from 'framer-motion';
import { 
  runComprehensiveMatch, 
  runStandardSearch,
  runAISmartMatch,
  saveAndAutoAdvance
} from '@/components/discovery/discoveryHelpers';
import {
  showNoProfileToast,
  toastSearchStart,
  toastSuccess,
} from '@/components/discovery/discoveryToasts';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import ProfileCompletenessAlert from '@/components/organizations/ProfileCompletenessAlert';
import AutoDiscoveryButton from '@/components/discovery/AutoDiscoveryButton';
import { log } from '@/components/shared/logger';
import { ANALYSIS_DELAY_MS } from '@/components/shared/constants';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS - Moved outside component to avoid recreation
// ─────────────────────────────────────────────────────────────────────────────

const SEARCH_TEMPLATES = [
  {
    id: 'ai_smart_match',
    name: 'AI Smart Match',
    description: 'Uses your complete profile to find the best-fit opportunities from all sources',
    specialties: ['Full profile analysis', 'Cross-database matching', 'Personalized scoring'],
    icon: Zap,
    fields: ['profile', 'history'],
    useAIMatch: true,
    badge: 'RECOMMENDED',
    color: 'purple'
  },
  {
    id: 'comprehensive',
    name: 'Federal Grants & Benefits',
    description: 'Searches Grants.gov and Benefits.gov for government programs you qualify for',
    specialties: ['Federal grants', 'SNAP/Medicaid/SSI', 'Housing assistance', 'LIHEAP'],
    icon: Target,
    fields: ['profile', 'search_types'],
    useComprehensiveMatch: true,
    color: 'blue'
  },
  {
    id: 'local_sources',
    name: 'Local & Community Sources',
    description: 'Finds Rotary clubs, community foundations, and local scholarships in your ZIP code',
    specialties: ['Service clubs (Rotary, Lions, Kiwanis)', 'Community foundations', 'Local business scholarships', 'Church programs'],
    icon: MapPin,
    fields: ['profile', 'radius'],
    prompt: `Identify local, state, and regional funding sources available near the profile's location.`,
    color: 'green'
  },
  {
    id: 'university_scholarships',
    name: 'University Scholarships',
    description: 'Searches your target colleges for merit, need-based, and activity-specific scholarships',
    specialties: ['Merit scholarships', 'Band/Music awards', 'Forensics/Debate', 'Department-specific', 'Athletic opportunities'],
    icon: UserCheck,
    fields: ['profile'],
    useUniversitySearch: true,
    color: 'amber',
    requiresTargetColleges: true
  },
  {
    id: 'ecf_services',
    name: 'ECF CHOICES Services',
    description: 'Discovers TennCare-covered gyms, food banks, transportation, and equipment in your area',
    specialties: ['Gym memberships', 'Food assistance', 'Medical transport', 'Respite care', 'DME suppliers'],
    icon: Zap,
    fields: ['profile'],
    useECFDiscovery: true,
    color: 'teal',
    requiresECF: true
  }
];

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export default function DiscoverGrants() {
  const { toast } = useToast();
  const [selectedOrgId, setSelectedOrgId] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState('comprehensive'); 
  const [searchState, setSearchState] = useState('idle');
  const [searchResults, setSearchResults] = useState([]);
  const [errorMessage, setErrorMessage] = useState(null);
  const [searchFilters, setSearchFilters] = useState({});
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [saveSearchName, setSaveSearchName] = useState('');
  const [showSavedSearches, setShowSavedSearches] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [diagnosticData, setDiagnosticData] = useState(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);

  // Ref for background analysis timeout cleanup
  const analysisTimeoutRef = useRef(null);
  const initialUrlSyncDone = useRef(false);

  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (analysisTimeoutRef.current) {
        clearTimeout(analysisTimeoutRef.current);
      }
    };
  }, []);

  const { user, isAdmin, isLoadingUser } = useAuthContext();

  const { data: organizations = [], refetch: refetchOrganizations, isLoading: isLoadingOrgs, error: orgsError } = useQuery({
    queryKey: ['organizations', user?.email, isAdmin],
    queryFn: async () => {
      log.info('Fetching organizations');
      const result = isAdmin
        ? await base44.entities.Organization.list()
        : await base44.entities.Organization.filter({ created_by: user?.email });
      log.info(`Organizations fetched: ${result?.length || 0} profiles`);
      return result || [];
    },
    enabled: !!user?.email,
    refetchOnWindowFocus: true,
    retry: 3,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10000),
    staleTime: 0, // Always fresh data when switching profiles
  });

  // M3 FIX: Added user context to savedSearches query key
  const { data: savedSearches = [] } = useQuery({
    queryKey: ['savedSearches', selectedOrgId, user?.email, isAdmin],
    queryFn: () => selectedOrgId && selectedOrgId !== "all" 
      ? base44.entities.SavedSearch.filter({ organization_id: selectedOrgId })
      : Promise.resolve([]),
    enabled: !!selectedOrgId && selectedOrgId !== "all",
    staleTime: 0, // Always fresh when profile changes
  });

  const selectedOrg = useMemo(() => {
    const org = organizations.find(o => o.id === selectedOrgId);
    if (selectedOrgId && !org && organizations.length > 0) {
      log.warn('Selected org not found', { selectedOrgId });
    }
    return org;
  }, [organizations, selectedOrgId]);

  // Sync selectedOrgId from URL on initial mount - auto-select profile from URL
  // Also auto-select if there's only one organization
  useEffect(() => {
    if (organizations.length === 0) return;
    
    const params = new URLSearchParams(location.search);
    const orgId = params.get('organization_id');
    
    if (orgId) {
      const orgExists = organizations.find(o => o.id === orgId);
      if (orgExists && selectedOrgId !== orgId) {
        log.info('Auto-selecting profile from URL', { orgId });
        setSelectedOrgId(orgId);
        initialUrlSyncDone.current = true;
      }
    } else if (!selectedOrgId && organizations.length === 1 && !initialUrlSyncDone.current) {
      // Auto-select if there's only one profile available
      log.info('Auto-selecting only available profile', { orgId: organizations[0].id });
      setSelectedOrgId(organizations[0].id);
      initialUrlSyncDone.current = true;
    }
  }, [organizations, location.search, selectedOrgId]);

  // Clear search results when profile changes to prevent cross-profile data leakage
  useEffect(() => {
    setSearchResults([]);
    setSearchState('idle');
    setErrorMessage(null);
  }, [selectedOrgId]);

  const isECFProfile = selectedOrg?.medicaid_enrolled && selectedOrg?.medicaid_waiver_program === 'ecf_choices';
  const isLoading = searchState === 'loading';

  // FIXED: Precise query invalidation with selectedOrgId
  const saveSearchMutation = useMutation({
    mutationFn: async (searchData) => {
      return await base44.entities.SavedSearch.create(searchData);
    },
    onSuccess: () => {
      // M3 FIX: Match savedSearches invalidation key with query key
      queryClient.invalidateQueries({ queryKey: ['savedSearches', selectedOrgId, user?.email, isAdmin] });
      setShowSaveDialog(false);
      setSaveSearchName('');
      toast({
        title: "Search Saved",
        description: "Your search has been saved and can be reloaded later.",
      });
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Save Failed",
        description: error?.message || "Failed to save search.",
      });
    }
  });

  const deleteSavedSearchMutation = useMutation({
    mutationFn: (id) => base44.entities.SavedSearch.delete(id),
    onSuccess: () => {
      // M3 FIX: Match savedSearches invalidation key with query key
      queryClient.invalidateQueries({ queryKey: ['savedSearches', selectedOrgId, user?.email, isAdmin] });
      toast({
        title: "Search Deleted",
        description: "Saved search has been removed.",
      });
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Delete Failed",
        description: error?.message || "Failed to delete search.",
      });
    }
  });

  // FIXED: Diagnostics with loading state
  const runDiagnostics = useCallback(async () => {
    if (!selectedOrgId || !selectedOrg) {
      toast({
        variant: "destructive",
        title: "No Profile Selected",
        description: "Please select a profile to run diagnostics.",
      });
      return;
    }

    setShowDiagnostics(true);
    setDiagnosticsLoading(true);
    setDiagnosticData(null);

    try {
      // CRITICAL: Use selectedOrgId (UUID), never selectedOrg.name
      log.info('Running diagnostics for profile:', { id: selectedOrgId, name: selectedOrg?.name });
      
      const response = await base44.functions.invoke('searchOpportunities', {
        body: { profile_id: selectedOrgId }
      });

      // Handle axios response structure
      const responseData = response?.data || response;
      log.info('Diagnostics response:', responseData);

      setDiagnosticData({
        totalInDb: responseData?.metadata?.total_in_db || 0,
        passedFilter: responseData?.metadata?.passed_filter || 0,
        profileType: responseData?.metadata?.profile_type || 'unknown',
        keywordsExtracted: responseData?.metadata?.keywords_extracted || 0,
        flagsExtracted: responseData?.metadata?.flags_extracted || 0,
        results: responseData?.results || [],
        topScores: (responseData?.results || []).slice(0, 10).map(r => ({
          title: r.title || 'Untitled Opportunity',
          score: r.match || 0,
          reasons: r.matchReasons || []
        }))
      });

      toast({
        title: "Diagnostics Complete",
        description: `Found ${responseData?.metadata?.total_in_db || 0} opportunities in database.`,
      });
    } catch (error) {
      log.error('Diagnostics failed:', error);
      const errorMsg = error?.message || error?.error || 'An unexpected error occurred during diagnostics.';
      
      toast({
        variant: "destructive",
        title: "Diagnostics Failed",
        description: errorMsg,
      });
      setDiagnosticData(null);
    } finally {
      setDiagnosticsLoading(false);
    }
  }, [selectedOrgId, selectedOrg, toast]);

  const handleManualRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      log.info('Manual refresh initiated');
      const result = await refetchOrganizations();
      const count = result.data?.length || 0;
      log.info(`Manual refresh result: ${count} profiles`);
      
      toast({
        title: '✅ Profile List Refreshed',
        description: `Loaded ${count} profiles.`,
      });
      return true;
    } catch (error) {
      log.error('Manual refresh failed:', error);
      
      toast({
        variant: 'destructive',
        title: 'Refresh Failed',
        description: error?.message || 'Failed to refresh profiles',
      });
      return false;
    } finally {
      setIsRefreshing(false);
    }
  }, [refetchOrganizations, toast]);

  const handleTemplateSelect = useCallback((templateId) => {
    setSelectedTemplate(templateId);
    setSearchResults([]);
    setSearchState('idle');
    setErrorMessage(null);
  }, []);

  const handleSaveSearch = useCallback(() => {
    if (!saveSearchName.trim()) {
      toast({
        variant: "destructive",
        title: "Name Required",
        description: "Please enter a name for this search.",
      });
      return;
    }

    if (!selectedOrgId || selectedOrgId === "all") {
      toast({
        variant: "destructive",
        title: "No Profile Selected",
        description: "Please select a specific profile to save the search.",
      });
      return;
    }

    const searchData = {
      organization_id: selectedOrgId,
      search_name: saveSearchName.trim(),
      search_template: selectedTemplate,
      search_filters: searchFilters,
      results_count: searchResults.length,
      results: searchResults,
      search_date: new Date().toISOString(),
    };

    saveSearchMutation.mutate(searchData);
  }, [saveSearchName, selectedOrgId, selectedTemplate, searchFilters, searchResults, saveSearchMutation, toast]);

  const handleLoadSavedSearch = useCallback((savedSearch) => {
    setSelectedTemplate(savedSearch.search_template);
    setSearchResults(savedSearch.results || []);
    setSearchState('success');
    setShowSavedSearches(false);
    
    toast({
      title: "Search Loaded",
      description: `Loaded "${savedSearch.search_name}" with ${savedSearch.results_count} results.`,
    });
  }, [toast]);

  const handleDiscover = useCallback(async () => {
    log.info('Discover initiated', {
      selectedOrgId,
      selectedTemplate,
      hasSelectedOrg: !!selectedOrg,
    });

    if (!selectedOrgId) {
      showNoProfileToast(toast);
      return;
    }

    if (!selectedOrg) {
      log.error('Selected org not found in list', { selectedOrgId });
      
      toast({
        variant: 'destructive',
        title: 'Profile Not Found',
        description: 'The selected profile is not available. Refreshing profile list...',
      });
      
      const refreshSuccess = await handleManualRefresh();
      if (!refreshSuccess) return;
      return;
    }

    if (!selectedOrg.id || !selectedOrg.name) {
      log.error('Selected org has missing required fields', { selectedOrg });
      toast({
        variant: 'destructive',
        title: 'Invalid Profile Data',
        description: 'The selected profile data is incomplete. Please try a different profile.',
      });
      return;
    }

    const template = SEARCH_TEMPLATES.find(t => t.id === selectedTemplate);

    setSearchState('loading');
    setSearchResults([]);
    setErrorMessage(null);

    try {
      const existingGrants = await base44.entities.Grant.filter({
        organization_id: selectedOrgId
      });
      
      // ONLY filter by URL, not by title (title matching is too aggressive)
      const existingUrls = new Set(
        existingGrants
          .map(g => g.url?.toLowerCase().trim())
          .filter(url => url && url.length > 10) // Only real URLs, not empty or short
      );
      
      log.info('Filtering duplicates by URL only', { 
        existingGrants: existingGrants.length,
        existingUrls: existingUrls.size
      });

      let result;

      // CRITICAL: Always pass the full selectedOrg object with .id property
      // The helpers will use selectedOrg.id (UUID), never selectedOrg.name
      // CRITICAL: Log before calling to verify we have valid profile
      console.log('[DiscoverGrants] About to call discovery with:', { 
        id: selectedOrg?.id, 
        name: selectedOrg?.name,
        hasId: !!selectedOrg?.id,
        idType: typeof selectedOrg?.id,
        template: selectedTemplate 
      });

      if (template?.useAIMatch) {
        toastSearchStart(toast, true);
        result = await runAISmartMatch(selectedOrg, searchFilters);
        
        // Handle graceful errors from AI Smart Match - no toast, just fall through
        if (!result.success && result.error) {
          log.warn('AI Smart Match returned error, showing empty results:', result.error);
          setSearchResults([]);
          setSearchState('success');
          return;
        }
        
        toastSuccess(toast, result.count, 'AI Smart Match');
      } else if (template?.useComprehensiveMatch) {
        toastSearchStart(toast, true);
        toast({
          title: '🏛️ Searching Federal Databases',
          description: 'Querying Grants.gov & Benefits.gov for programs you qualify for...',
          duration: 5000,
        });
        console.log('[DiscoverGrants] Calling runComprehensiveMatch with org:', selectedOrg);
        result = await runComprehensiveMatch(selectedOrg, searchFilters);
        toastSuccess(toast, result.count, 'Federal Grants & Benefits');
      } else if (template?.useUniversitySearch) {
        // University Scholarship Search - crawl each target college
        toastSearchStart(toast, true);
        const targetColleges = selectedOrg?.target_colleges || [];
        
        if (targetColleges.length === 0) {
          toast({
            variant: 'destructive',
            title: 'No Target Colleges',
            description: 'Please add target colleges to your profile first.',
          });
          setSearchState('idle');
          return;
        }
        
        toast({
          title: '🎓 Searching University Scholarships',
          description: `Crawling ${targetColleges.length} college${targetColleges.length > 1 ? 's' : ''} for scholarships...`,
          duration: 8000,
        });
        
        let allScholarships = [];
        for (const college of targetColleges.slice(0, 5)) { // Limit to 5 colleges
          try {
            const response = await base44.functions.invoke('crawlUniversityScholarships', {
              body: { organization_id: selectedOrgId, university_name: college }
            });
            const data = response?.data;
            if (data?.success && data?.scholarships_found > 0) {
              log.info(`Found ${data.scholarships_found} scholarships at ${college}`);
            }
          } catch (err) {
            log.warn(`Failed to crawl ${college}:`, err?.message);
          }
        }
        
        // After crawling, fetch the grants that were created
        const newGrants = await base44.entities.Grant.filter({
          organization_id: selectedOrgId,
          status: 'discovered'
        });
        
        result = {
          opportunities: newGrants.map(g => ({
            title: g.title,
            sponsor: g.funder,
            url: g.url,
            description: g.program_description,
            deadline: g.deadline,
            match: 85, // University-specific matches are high quality
            source: 'university_scholarship'
          })),
          count: newGrants.length
        };
        
        toastSuccess(toast, result.count, 'University Scholarships');
      } else if (template?.useECFDiscovery) {
        // ECF CHOICES Service Discovery
        toastSearchStart(toast, true);
        toast({
          title: '🏥 Discovering ECF CHOICES Services',
          description: 'Finding gyms, food banks, transportation, and more in your area...',
          duration: 8000,
        });
        
        try {
          const response = await base44.functions.invoke('discoverECFServices', {
            body: { profile_id: selectedOrgId }
          });
          const data = response?.data;
          
          if (data?.success) {
            result = {
              opportunities: (data.services || []).map(s => ({
                title: s.title,
                sponsor: s.sponsor,
                url: s.url,
                descriptionMd: s.descriptionMd,
                eligibilityBullets: s.eligibilityBullets,
                match: 90, // ECF services are pre-qualified
                source: 'ecf_choices_discovery'
              })),
              count: data.discovered_count || 0
            };
            toastSuccess(toast, result.count, 'ECF CHOICES Services');
          } else {
            throw new Error(data?.error || 'ECF discovery failed');
          }
        } catch (err) {
          log.error('ECF discovery error:', err);
          throw err;
        }
      } else if (template?.id === 'local_sources') {
        // Local Sources - Community foundations, Rotary clubs, etc.
        toastSearchStart(toast, true);
        toast({
          title: '📍 Searching Local Sources',
          description: `Finding community foundations and service clubs near ${selectedOrg?.zip || selectedOrg?.city || 'your area'}...`,
          duration: 8000,
        });
        
        try {
          const response = await base44.functions.invoke('discoverLocalSources', {
            body: { profile_id: selectedOrgId, profile_data: selectedOrg }
          });
          const data = response?.data;
          
          if (data?.success) {
            // Local sources are saved to SourceDirectory, now search opportunities
            const searchResponse = await base44.functions.invoke('searchOpportunities', {
              body: { profile_id: selectedOrgId, profile_data: selectedOrg, filters: searchFilters }
            });
            const searchData = searchResponse?.data;
            
            result = {
              opportunities: searchData?.results || [],
              count: searchData?.count || 0,
              message: `Found ${data.summary?.new_sources || 0} new local sources and ${searchData?.count || 0} matching opportunities.`
            };
            
            toast({
              title: '📍 Local Discovery Complete',
              description: `Added ${data.summary?.new_sources || 0} new sources, found ${result.count} opportunities.`,
              duration: 6000,
            });
          } else {
            throw new Error(data?.error || 'Local source discovery failed');
          }
        } catch (err) {
          log.error('Local sources error:', err);
          throw err;
        }
      } else {
        toastSearchStart(toast, false);
        // CRITICAL: Pass selectedOrgId (UUID from state) and selectedOrg for efficiency
        console.log('[DiscoverGrants] Calling runStandardSearch with orgId:', selectedOrgId);
        result = await runStandardSearch(template, selectedOrgId, searchFilters, selectedOrg);
        
        if (result.opportunities && result.opportunities.length > 0) {
          const avgScore = result.opportunities.reduce((sum, o) => sum + (o.match || 0), 0) / result.opportunities.length;
          
          if (avgScore < 60) {
            toast({
              title: '⚠️ Low Match Quality',
              description: `Found ${result.opportunities.length} opportunities but average match score is ${Math.round(avgScore)}%. Consider adding more profile details.`,
              variant: 'default',
              duration: 8000,
            });
          }
        }
        
        toastSuccess(toast, result.count, template?.name);
      }

      const allOpportunities = result.opportunities || [];
      const beforeFilterCount = allOpportunities.length;
      
      // ONLY filter by URL match - title matching was removing too many results
      const filteredOpportunities = allOpportunities.filter(opp => {
        const oppUrl = opp.url?.toLowerCase().trim();
        if (oppUrl && oppUrl.length > 10 && existingUrls.has(oppUrl)) {
          log.debug('Filtering duplicate by URL:', oppUrl);
          return false;
        }
        return true;
      });
      
      const filteredCount = beforeFilterCount - filteredOpportunities.length;
      
      if (filteredCount > 0) {
        log.info(`Filtered out ${filteredCount} duplicates already in pipeline`);
        toast({
          title: '🔍 Duplicates Filtered',
          description: `Removed ${filteredCount} opportunities already in your pipeline. Showing ${filteredOpportunities.length} new results.`,
          duration: 5000,
        });
      }

      setSearchResults(filteredOpportunities);
      setSearchState('success');

      // Auto-save to pipeline and trigger AI processing
      if (filteredOpportunities.length > 0) {
        log.info('Auto-saving opportunities to pipeline and triggering AI processing');
        
        toast({
          title: '💾 Saving to Pipeline',
          description: `Adding ${filteredOpportunities.length} opportunities to your pipeline...`,
          duration: 3000,
        });

        const saveResult = await saveAndAutoAdvance(filteredOpportunities, selectedOrg);
        
        log.info('Save and auto-advance result:', saveResult);
        
        // Invalidate grants queries to refresh pipeline
        queryClient.invalidateQueries({ queryKey: ['grants'] });
        
        toast({
          title: '✅ Pipeline Updated',
          description: saveResult.summary,
          duration: 6000,
        });
      }

    } catch (error) {
      log.error('Search error', '-', error?.message || String(error));
      
      // Extract user-friendly message
      let message = 'An unexpected error occurred while searching';
      if (error?.message) {
        message = error.message;
      } else if (typeof error === 'string') {
        message = error;
      } else if (error?.error) {
        message = typeof error.error === 'string' ? error.error : JSON.stringify(error.error);
      }
      
      setErrorMessage(message);
      toast({
        variant: 'destructive',
        title: 'Search Failed',
        description: message,
      });
      
      setSearchState('error');
    }
  }, [selectedOrgId, selectedOrg, selectedTemplate, searchFilters, handleManualRefresh, toast]);

  // FIXED: Use user from React Query, avoid duplicate base44.auth.me() call
  const handleAddToPipeline = useCallback(async (opportunity) => {
    log.info('Adding to pipeline:', opportunity?.title);
    
    try {
      if (opportunity.url) {
        const existingGrants = await base44.entities.Grant.filter({
          organization_id: selectedOrgId,
          url: opportunity.url
        });
        
        if (existingGrants.length > 0) {
          toast({
            title: 'Already in Pipeline',
            description: `"${opportunity.title}" is already in your pipeline.`,
            variant: 'default',
          });
          return existingGrants[0];
        }
      }
      
      // Use user from React Query if available, fallback to API call
      const currentUser = user || await base44.auth.me();
      
      const grantData = {
        organization_id: selectedOrgId,
        title: opportunity.title || 'Untitled Opportunity',
        funder: opportunity.sponsor || 'Unknown Funder',
        url: opportunity.url || '',
        deadline: opportunity.deadlineAt || opportunity.deadline || null,
        award_floor: opportunity.awardMin || null,
        award_ceiling: opportunity.awardMax || null,
        eligibility_summary: opportunity.eligibilityBullets?.join('\n') || '',
        program_description: opportunity.description || opportunity.descriptionMd || '', 
        status: 'discovered',
        match_score: opportunity.match || 0,
        ai_status: 'queued',
      };

      const newGrant = await base44.entities.Grant.create(grantData);
      
      const now = new Date();
      // Note: TimeEntry creation is admin-only, skipped for non-admin users
      if (user?.role === 'admin') {
        try {
          await base44.entities.TimeEntry.create({
            organization_id: selectedOrgId,
            user_id: currentUser.id,
            task_category: 'Research',
            start_at: new Date(now.getTime() - 6 * 60 * 1000).toISOString(),
            end_at: now.toISOString(),
            raw_minutes: 6,
            rounded_minutes: 6,
            note: `Initial assessment and pipeline setup for "${newGrant.title}"`,
            source: 'auto',
            invoiced: false
          });
        } catch (timeError) {
          console.warn('[DiscoverGrants] Could not create time entry:', timeError);
        }
      }
      
      // L7 FIX: Precise invalidation keys with user context
      queryClient.invalidateQueries({ queryKey: ['grants', user?.email, isAdmin] });
      queryClient.invalidateQueries({ queryKey: ['recentTimeEntries', user?.email] });
      
      toast({
        title: '✅ Added to Pipeline',
        description: `${opportunity.title} added. Running full pipeline automation...`,
      });
      
      try {
        await base44.entities.Grant.update(newGrant.id, {
          ai_status: 'queued',
          status: 'interested'
        });

        // L7 FIX: Precise invalidation key
        queryClient.invalidateQueries({ queryKey: ['grants', user?.email, isAdmin] });

        toast({
          title: '✅ Added to Pipeline',
          description: `"${newGrant.title}" added and queued for AI analysis.`,
          duration: 5000,
        });

        // M10 FIX: Added finally block to clear timeout ref
        analysisTimeoutRef.current = window.setTimeout(async () => {
          try {
            const analysisResponse = await base44.functions.invoke('analyzeGrant', {
              body: { grant_id: newGrant.id, organization_id: selectedOrgId }
            });

            if (analysisResponse.data?.success) {
              // L7 FIX: Precise invalidation key
              queryClient.invalidateQueries({ queryKey: ['grants', user?.email, isAdmin] });
              log.info('Background analysis completed for:', newGrant.title);
            }
          } catch (bgError) {
            log.warn('Background analysis deferred:', bgError?.message);
          } finally {
            analysisTimeoutRef.current = null;
          }
        }, ANALYSIS_DELAY_MS);

      } catch (analysisError) {
        const errorMsg = analysisError?.message || '';
        const isRateLimit = errorMsg.toLowerCase().includes('rate limit');

        log.error('Auto-analysis failed:', { error: errorMsg, isRateLimit });

        await base44.entities.Grant.update(newGrant.id, {
          ai_status: isRateLimit ? 'rate_limited' : 'queued',
          status: 'interested'
        });

        toast({
          title: isRateLimit ? '⏳ Rate Limited' : '⚠️ Analysis Queued',
          description: isRateLimit 
            ? `"${newGrant.title}" added. AI analysis will retry when rate limit resets.`
            : `"${newGrant.title}" added. AI analysis queued for later.`,
          duration: 5000,
        });
      }
      
      return newGrant;
    } catch (error) {
      log.error('Failed to add grant to pipeline:', error);
      
      toast({
        variant: 'destructive',
        title: 'Failed to Add Grant',
        description: error?.message || 'Unknown error',
      });
      
      throw error;
    }
  }, [selectedOrgId, user, queryClient, toast]);

  const hasResults = searchState === 'success';
  const hasError = searchState === 'error';

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-purple-50 p-6">
      <div className="max-w-7xl mx-auto">
        <header className="mb-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-2">
                <Search className="w-8 h-8 text-blue-600" />
                Discover Funding Opportunities
              </h1>
              <p className="text-slate-600 mt-2">
                AI-powered opportunity discovery
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                onClick={() => setShowFilters(!showFilters)}
                variant={showFilters ? "default" : "outline"}
                size="sm"
                className="gap-2"
              >
                <Sparkles className="w-4 h-4" />
                {showFilters ? 'Hide' : 'Show'} Filters
              </Button>
              {selectedOrgId && selectedOrgId !== "all" && selectedOrg && (
                <AutoDiscoveryButton
                  profileId={selectedOrgId}
                  profileName={selectedOrg.name}
                  onComplete={() => {
                    toast({
                      title: '💡 Next Step',
                      description: 'New sources added! Click "Discover Opportunities" to search them.',
                      duration: 8000,
                    });
                  }}
                />
              )}
              {selectedOrgId && selectedOrgId !== "all" && (
                <Button
                  onClick={runDiagnostics}
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  disabled={diagnosticsLoading}
                >
                  {diagnosticsLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <AlertCircle className="w-4 h-4" />
                  )}
                  Diagnostics
                </Button>
              )}
              {selectedOrgId && selectedOrgId !== "all" && savedSearches.length > 0 && (
                <Button
                  onClick={() => setShowSavedSearches(true)}
                  variant="outline"
                  size="sm"
                  className="gap-2"
                >
                  <History className="w-4 h-4" />
                  Saved Searches ({savedSearches.length})
                </Button>
              )}
              <Button
                onClick={handleManualRefresh}
                disabled={isRefreshing || isLoadingOrgs}
                variant="outline"
                size="sm"
                className="gap-2"
              >
                {isRefreshing ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Refreshing...
                  </>
                ) : (
                  <>
                    <Search className="w-4 h-4" />
                    Refresh Profiles
                  </>
                )}
              </Button>
            </div>
          </div>
        </header>

        {/* Diagnostics Panel */}
        {showDiagnostics && (
          <Card className="mb-8 border-2 border-purple-200 bg-purple-50">
            <CardHeader>
              <div className="flex items-start justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2 text-purple-900">
                    <AlertCircle className="w-5 h-5" />
                    Search Diagnostics
                  </CardTitle>
                  <CardDescription className="text-purple-700">
                    Analysis of why results are/aren't being found
                  </CardDescription>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowDiagnostics(false)}
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {diagnosticsLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-8 h-8 animate-spin text-purple-600 mr-3" />
                  <span className="text-purple-700">Running diagnostics...</span>
                </div>
              ) : diagnosticData ? (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div className="p-3 bg-white rounded-lg">
                      <p className="text-xs text-slate-500 uppercase font-semibold">Database</p>
                      <p className="text-2xl font-bold text-slate-900">{diagnosticData.totalInDb}</p>
                      <p className="text-xs text-slate-600">Total Opportunities</p>
                    </div>
                    <div className="p-3 bg-white rounded-lg">
                      <p className="text-xs text-slate-500 uppercase font-semibold">Matched</p>
                      <p className="text-2xl font-bold text-emerald-600">{diagnosticData.passedFilter}</p>
                      <p className="text-xs text-slate-600">Score ≥ 20</p>
                    </div>
                    <div className="p-3 bg-white rounded-lg">
                      <p className="text-xs text-slate-500 uppercase font-semibold">Keywords</p>
                      <p className="text-2xl font-bold text-blue-600">{diagnosticData.keywordsExtracted}</p>
                      <p className="text-xs text-slate-600">Extracted</p>
                    </div>
                    <div className="p-3 bg-white rounded-lg">
                      <p className="text-xs text-slate-500 uppercase font-semibold">Flags</p>
                      <p className="text-2xl font-bold text-purple-600">{diagnosticData.flagsExtracted}</p>
                      <p className="text-xs text-slate-600">Profile Attributes</p>
                    </div>
                  </div>

                  {diagnosticData.totalInDb === 0 && (
                    <Alert className="bg-amber-50 border-amber-200">
                      <AlertCircle className="h-4 w-4 text-amber-600" />
                      <AlertDescription className="text-amber-900">
                        <strong>No opportunities in database!</strong> You need to run the data crawlers first.
                        Go to <Link to={createPageUrl("DataSources")} className="underline font-semibold">Data Sources</Link> and run the crawlers.
                      </AlertDescription>
                    </Alert>
                  )}

                  {diagnosticData.totalInDb > 0 && diagnosticData.passedFilter === 0 && (
                    <Alert className="bg-red-50 border-red-200">
                      <AlertCircle className="h-4 w-4 text-red-600" />
                      <AlertDescription className="text-red-900">
                        <strong>No matches found!</strong> Try adding more profile details like location, program focus, or demographic information.
                      </AlertDescription>
                    </Alert>
                  )}

                  {diagnosticData.topScores && diagnosticData.topScores.length > 0 && (
                    <div className="p-4 bg-white rounded-lg">
                      <h4 className="font-semibold text-slate-900 mb-3">Top 10 Scoring Opportunities</h4>
                      <div className="space-y-2">
                        {diagnosticData.topScores.map((item, idx) => (
                          <div key={idx} className="flex items-start gap-3 text-sm">
                            <Badge variant={item.score >= 50 ? 'default' : 'outline'} className="shrink-0">
                              {item.score}
                            </Badge>
                            <div className="flex-1">
                              <p className="font-medium text-slate-900">{item.title}</p>
                              {item.reasons && item.reasons.length > 0 && (
                                <p className="text-xs text-slate-600">{item.reasons.join(', ')}</p>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="text-center py-8 text-slate-500">
                  Click "Diagnostics" to analyze search performance
                </div>
              )}
            </CardContent>
          </Card>
        )}

        <h2 className="text-2xl font-semibold text-slate-800 mb-4">Choose a Search Method</h2>
        <p className="text-slate-600 mb-6">Select the approach that best fits your needs to find relevant opportunities.</p>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
          {SEARCH_TEMPLATES.map((template) => {
            const Icon = template.icon;
            const colorClasses = {
              purple: { bg: 'bg-purple-100', text: 'text-purple-600', ring: 'ring-purple-500', badge: 'bg-purple-600' },
              blue: { bg: 'bg-blue-100', text: 'text-blue-600', ring: 'ring-blue-500', badge: 'bg-blue-600' },
              green: { bg: 'bg-green-100', text: 'text-green-600', ring: 'ring-green-500', badge: 'bg-green-600' },
              amber: { bg: 'bg-amber-100', text: 'text-amber-600', ring: 'ring-amber-500', badge: 'bg-amber-600' },
              teal: { bg: 'bg-teal-100', text: 'text-teal-600', ring: 'ring-teal-500', badge: 'bg-teal-600' }
            };
            const colors = colorClasses[template.color] || colorClasses.blue;
            
            // Check if template is available for selected profile
            const isDisabled = 
              (template.requiresECF && !isECFProfile) ||
              (template.requiresTargetColleges && (!selectedOrg?.target_colleges || selectedOrg.target_colleges.length === 0));
            
            const disabledReason = template.requiresECF && !isECFProfile
              ? 'Requires ECF CHOICES enrollment'
              : template.requiresTargetColleges && (!selectedOrg?.target_colleges || selectedOrg.target_colleges.length === 0)
              ? 'Add target colleges to profile first'
              : null;
            
            return (
              <motion.div
                key={template.id}
                whileHover={isDisabled ? {} : { scale: 1.02 }}
                whileTap={isDisabled ? {} : { scale: 0.98 }}
              >
                <Card
                  className={`cursor-pointer transition-all h-full ${
                    isDisabled 
                      ? 'opacity-50 cursor-not-allowed'
                      : selectedTemplate === template.id
                      ? `ring-2 ${colors.ring} shadow-lg`
                      : 'hover:shadow-md'
                  }`}
                  onClick={() => !isDisabled && handleTemplateSelect(template.id)}
                >
                  <CardHeader className="pb-2">
                    <div className="flex items-start gap-3">
                      <div className={`p-2 rounded-lg ${
                        selectedTemplate === template.id
                          ? `${colors.bg} ${colors.text}`
                          : 'bg-slate-100 text-slate-600'
                      }`}>
                        <Icon className="w-5 h-5" />
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <CardTitle className="text-base">{template.name}</CardTitle>
                          {template.badge && (
                            <Badge className={`${colors.badge} text-white text-xs`}>{template.badge}</Badge>
                          )}
                        </div>
                        <CardDescription className="text-sm mt-1">
                          {template.description}
                        </CardDescription>
                      </div>
                      {selectedTemplate === template.id && (
                        <CheckCircle2 className={`w-5 h-5 ${colors.text}`} />
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="pt-0">
                    {template.specialties && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {template.specialties.slice(0, 4).map((specialty, idx) => (
                          <Badge key={idx} variant="outline" className="text-xs font-normal">
                            {specialty}
                          </Badge>
                        ))}
                        {template.specialties.length > 4 && (
                          <Badge variant="outline" className="text-xs font-normal">
                            +{template.specialties.length - 4} more
                          </Badge>
                        )}
                      </div>
                    )}
                    {isDisabled && disabledReason && (
                      <p className="text-xs text-amber-600 mt-2 font-medium">
                        ⚠️ {disabledReason}
                      </p>
                    )}
                  </CardContent>
                </Card>
              </motion.div>
            );
          })}
        </div>

        {/* Only show profile selector if no profile is pre-selected or user has multiple profiles */}
        {(!selectedOrgId || organizations.length > 1) && (
        <Card className="shadow-lg border-0 mb-8">
          <CardHeader className="border-b border-slate-100">
            <CardTitle className="flex items-center gap-2">
              <User className="w-5 h-5 text-blue-600" />
              Select Profile to Search
            </CardTitle>
            <CardDescription>
              Choose an organization or individual to use for the search
            </CardDescription>
          </CardHeader>
          <CardContent className="p-6">
            <div className="space-y-4">
              <div>
                <Label className="text-base font-semibold mb-3 block">Select Profile</Label>
                {isLoadingOrgs ? (
                  <div className="flex items-center gap-2 p-3 text-slate-500">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading profiles...
                  </div>
                ) : orgsError ? (
                  <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>
                      Error loading profiles: {orgsError?.message || 'Unknown error'}
                      <Button onClick={handleManualRefresh} variant="outline" size="sm" className="ml-4">
                        Retry
                      </Button>
                    </AlertDescription>
                  </Alert>
                ) : organizations.length === 0 ? (
                  <Alert>
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>
                      No profiles found. Please create a profile first.
                      <Link to={createPageUrl("Organizations")} className="ml-2 underline font-semibold">
                        Create Profile
                      </Link>
                    </AlertDescription>
                  </Alert>
                ) : (
                  <select
                    value={selectedOrgId || ""}
                    onChange={(e) => {
                      log.info('Profile selected', { newValue: e.target.value });
                      setSelectedOrgId(e.target.value);
                    }}
                    className="w-full h-12 px-3 py-2 border border-slate-300 rounded-md bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="">Choose an organization or individual...</option>
                    {organizations.map(org => {
                      const isOrgECF = org.medicaid_enrolled && org.medicaid_waiver_program === 'ecf_choices';
                      return (
                        <option key={org.id} value={org.id}>
                          {org.name} {isOrgECF ? '(ECF CHOICES)' : ''}
                        </option>
                      );
                    })}
                  </select>
                )}
              </div>

              {selectedOrg && (
                <>
                  <Alert className={
                    isECFProfile
                      ? 'bg-green-50 border-green-200'
                      : 'bg-blue-50 border-blue-200'
                  }>
                    <User className={`h-4 w-4 ${
                      isECFProfile ? 'text-green-600' : 'text-blue-600'
                    }`} />
                    <AlertDescription className={
                      isECFProfile ? 'text-green-900' : 'text-blue-800'
                    }>
                      <div className="flex items-center justify-between">
                        <div>
                          <strong>Selected:</strong> {selectedOrg.name}
                          {selectedOrg.applicant_type && (
                            <span className="ml-2">({selectedOrg.applicant_type.replace(/_/g, ' ')})</span>
                          )}
                          {selectedOrg.state && <span className="ml-2">• {selectedOrg.state}</span>}
                          {isECFProfile && (
                            <span className="block mt-1 font-semibold">
                              🏥 ECF CHOICES Participant
                            </span>
                          )}
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setSelectedOrgId('');
                            setSearchResults([]);
                            setSearchState('idle');
                            setErrorMessage(null);
                          }}
                          className="text-slate-500 hover:text-slate-700"
                        >
                          <X className="w-4 h-4 mr-1" />
                          Reset
                        </Button>
                      </div>
                    </AlertDescription>
                  </Alert>

                  <div className="mt-4">
                    <ProfileCompletenessAlert organization={selectedOrg} />
                  </div>
                </>
              )}
            </div>
          </CardContent>
        </Card>
        )}
        
        {/* Show selected profile summary when auto-selected (single profile scenario) */}
        {selectedOrg && organizations.length === 1 && (
          <Alert className={`mb-8 ${isECFProfile ? 'bg-green-50 border-green-200' : 'bg-blue-50 border-blue-200'}`}>
            <User className={`h-4 w-4 ${isECFProfile ? 'text-green-600' : 'text-blue-600'}`} />
            <AlertDescription className={isECFProfile ? 'text-green-900' : 'text-blue-800'}>
              <strong>Searching for:</strong> {selectedOrg.name}
              {selectedOrg.applicant_type && (
                <span className="ml-2">({selectedOrg.applicant_type.replace(/_/g, ' ')})</span>
              )}
              {selectedOrg.state && <span className="ml-2">• {selectedOrg.state}</span>}
              {isECFProfile && (
                <span className="block mt-1 font-semibold">🏥 ECF CHOICES Participant</span>
              )}
            </AlertDescription>
          </Alert>
        )}

        {/* AI Search Filters */}
        {showFilters && (
          <div className="mb-8">
            <AISearchFilters
              filters={searchFilters}
              onChange={setSearchFilters}
              onApply={(filters) => {
                setSearchFilters(filters);
                setShowFilters(false);
                toast({
                  title: 'Filters Applied',
                  description: 'Your search preferences have been saved.',
                });
              }}
            />
          </div>
        )}

        <div className="flex flex-col sm:flex-row gap-3 pt-4 mb-8">
          <Button
            onClick={handleDiscover}
            disabled={!selectedOrgId || isLoading}
            className="bg-blue-600 hover:bg-blue-700 flex-1"
            size="lg"
          >
            {isLoading ? (
              <>
                <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                Searching...
              </>
            ) : (
              <>
                <Search className="w-5 h-5 mr-2" />
                Discover Opportunities
              </>
            )}
          </Button>

          {hasResults && searchResults.length > 0 && selectedOrgId && selectedOrgId !== "all" && (
            <Button
              onClick={() => setShowSaveDialog(true)}
              variant="outline"
              size="lg"
              className="gap-2"
            >
              <Save className="w-5 h-5" />
              Save Search
            </Button>
          )}
        </div>

        {isLoading && (
          <Card className="shadow-lg border-0">
            <CardContent className="p-12 text-center">
              <Loader2 className="w-12 h-12 animate-spin text-blue-600 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">Searching for Opportunities</h3>
              <p className="text-slate-600">
                Analyzing thousands of funding opportunities to find the best matches...
              </p>
            </CardContent>
          </Card>
        )}

        {hasError && (
          <Card className="shadow-lg border-0 border-l-4 border-l-red-500">
            <CardContent className="p-8">
              <div className="flex items-start gap-4">
                <div className="p-3 bg-red-50 rounded-lg">
                  <Target className="w-6 h-6 text-red-600" />
                </div>
                <div className="flex-1">
                  <h3 className="text-lg font-semibold text-slate-900 mb-2">Search Error</h3>
                  <p className="text-slate-600 mb-4">{errorMessage}</p>
                  <div className="flex gap-3">
                    {selectedOrgId && (
                      <Button onClick={handleDiscover} variant="default">
                        Try Again
                      </Button>
                    )}
                    <Button onClick={handleManualRefresh} variant="outline">
                      Refresh Profile List
                    </Button>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {hasResults && searchResults.length === 0 && (
          <Card className="shadow-lg border-0">
            <CardContent className="p-12 text-center">
              <Target className="w-16 h-16 mx-auto text-slate-300 mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">No Matches Found</h3>
              <p className="text-slate-600">
                No opportunities found for this profile. Try adjusting the profile details or search method.
              </p>
            </CardContent>
          </Card>
        )}

        {!hasResults && !isLoading && !hasError && (
          <Card className="shadow-lg border-0">
            <CardContent className="p-12 text-center">
              <Target className="w-16 h-16 mx-auto text-slate-300 mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">Ready to Discover Opportunities</h3>
              <p className="text-slate-600">
                Select a profile and a search method above to get started
              </p>
            </CardContent>
          </Card>
        )}

        {hasResults && searchResults.length > 0 && (
          <SearchResults
            results={searchResults}
            onAddToPipeline={handleAddToPipeline}
            isLoading={isLoading}
            selectedOrgId={selectedOrgId}
          />
        )}
      </div>

      {/* Save Search Dialog */}
      <Dialog open={showSaveDialog} onOpenChange={setShowSaveDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save Search</DialogTitle>
            <DialogDescription>
              Give this search a name so you can easily find and reload it later.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Input
              placeholder="e.g., Medical Assistance Search - January 2025"
              value={saveSearchName}
              onChange={(e) => setSaveSearchName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleSaveSearch();
                }
              }}
            />
            <p className="text-xs text-slate-500 mt-2">
              Found {searchResults.length} opportunities using {SEARCH_TEMPLATES.find(t => t.id === selectedTemplate)?.name}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSaveDialog(false)}>
              Cancel
            </Button>
            <Button 
              onClick={handleSaveSearch}
              disabled={saveSearchMutation.isPending || !saveSearchName.trim()}
            >
              {saveSearchMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="w-4 h-4 mr-2" />
                  Save Search
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Saved Searches Dialog */}
      <Dialog open={showSavedSearches} onOpenChange={setShowSavedSearches}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Saved Searches</DialogTitle>
            <DialogDescription>
              Load a previously saved search for {selectedOrg?.name}
            </DialogDescription>
          </DialogHeader>
          <div className="flex-grow overflow-y-auto max-h-[60vh] pr-2">
            {savedSearches.length === 0 ? (
              <div className="text-center py-12">
                <History className="w-12 h-12 mx-auto text-slate-300 mb-4" />
                <p className="text-slate-600">No saved searches yet</p>
                <p className="text-sm text-slate-500 mt-2">
                  Complete a search and click "Save Search" to save it for later
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {savedSearches.map((search) => {
                  const template = SEARCH_TEMPLATES.find(t => t.id === search.search_template);
                  const Icon = template?.icon || Search;
                  
                  return (
                    <Card key={search.id} className="transition-shadow">
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between">
                          <div className="flex items-start gap-3 flex-1 min-w-0">
                            <div className="p-2 bg-blue-50 rounded-lg shrink-0">
                              <Icon className="w-5 h-5 text-blue-600" />
                            </div>
                            <div className="flex-1 overflow-hidden">
                              <h3 className="font-semibold text-slate-900 truncate">
                                {search.search_name}
                              </h3>
                              <p className="text-sm text-slate-600 mt-1 truncate">
                                {template?.name || search.search_template} • {search.results_count} results
                              </p>
                              <p className="text-xs text-slate-500 mt-1">
                                {new Date(search.search_date).toLocaleDateString()} at {new Date(search.search_date).toLocaleTimeString()}
                              </p>
                            </div>
                          </div>
                          <div className="flex gap-2 ml-4 shrink-0">
                            <Button
                              size="sm"
                              onClick={() => handleLoadSavedSearch(search)}
                            >
                              Load
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => deleteSavedSearchMutation.mutate(search.id)}
                              disabled={deleteSavedSearchMutation.isPending}
                              className="p-2 h-auto"
                            >
                              <Trash2 className="w-4 h-4 text-red-500" />
                            </Button>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}