import React, { useMemo, useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { getProfile, listProfiles } from '@/api/profiles';
import { apiFetch } from '@/api/client';
import { runRealCrawler } from '@/api/crawlers';
import { createPageUrl } from '@/utils';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Loader2, Search, User, Lightbulb, ArrowRight, CheckCircle2 } from 'lucide-react';
import HelpTip from '@/components/help/HelpTip';
import SearchResults from '@/components/discovery/SearchResults';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/use-toast';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import { useAuthStore } from '@/stores/authStore';
import { createLogger } from '@/utils/logger'



/**
 * Resolve profile_id: 1) explicit UI selection, 2) URL ?profile_id=, 3) null.
 * Does NOT auto-select first profile (product blocks add-to-pipeline without explicit choice).
 */
function resolveSelectedProfileId(selectedProfileId, searchParams, profiles) {
  const fromUi = typeof selectedProfileId === 'string' ? selectedProfileId.trim() : null
  if (fromUi) return fromUi
  const fromUrl = searchParams?.get?.('profile_id') ?? null
  if (!fromUrl) return null
  const valid = Array.isArray(profiles) && profiles.some((p) => String(p?.id) === String(fromUrl))
  return valid ? fromUrl : null
}

export default function DiscoverGrants() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [minMatchScore, setMinMatchScore] = useState(50);
  const [isSearching, setIsSearching] = useState(false);
  const profileSelectorRef = React.useRef(null)
  const searchActionsRef = React.useRef(null)
  const resultsRef = React.useRef(null)
  const [dismissedSuggestions, setDismissedSuggestions] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('grantflow:dismissed-suggestions') || '[]');
    } catch { return []; }
  });
  
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const log = React.useMemo(() => createLogger('DiscoverGrantsPage'), [])
  const { isAuthenticated, accessToken, sessionExpired } = useAuthStore((state) => ({
    isAuthenticated: state.isAuthenticated,
    accessToken: state.accessToken,
    sessionExpired: state.sessionExpired,
  }));

  const tokenAvailable = useMemo(() => {
    try {
      return Boolean(accessToken || base44.getToken?.());
    } catch {
      return Boolean(accessToken);
    }
  }, [accessToken]);

  const authReady = !sessionExpired && (isAuthenticated || tokenAvailable);

  // Fetch profiles instead of organizations
  const { data: profiles = [], isLoading: isLoadingProfiles } = useQuery({
    queryKey: ['profiles'],
    queryFn: () => listProfiles(),
    enabled: authReady,
  });

  const effectiveProfileId = useMemo(
    () => resolveSelectedProfileId(selectedProfileId, searchParams, profiles),
    [selectedProfileId, searchParams, profiles]
  );

  useEffect(() => {
    const urlProfileId = searchParams.get('profile_id')
    if (!urlProfileId || profiles.length === 0) return
    const valid = profiles.some((p) => String(p?.id) === String(urlProfileId))
    if (valid && !selectedProfileId) {
      setSelectedProfileId(urlProfileId)
    }
  }, [searchParams, profiles, selectedProfileId])

  // Persist last selected profile for session continuity
  useEffect(() => {
    if (selectedProfileId) {
      try { localStorage.setItem('grantflow:discover-last-profile', selectedProfileId); } catch { /* ignore storage errors */ }
    }
  }, [selectedProfileId]);

  // Restore last selected profile on mount
  useEffect(() => {
    if (!selectedProfileId && profiles.length > 0) {
      try {
        const lastProfile = localStorage.getItem('grantflow:discover-last-profile');
        if (lastProfile && profiles.some(p => p.id === lastProfile)) {
          setSelectedProfileId(lastProfile);
        }
      } catch { /* ignore storage errors */ }
    }
  }, [profiles]);


  const { data: profileDetail } = useQuery({
    queryKey: ['discover-profile', effectiveProfileId ?? selectedProfileId],
    queryFn: () => getProfile(effectiveProfileId || selectedProfileId),
    enabled: authReady && Boolean(effectiveProfileId || selectedProfileId),
  });

  // Also fetch organizations to get detailed org data for selected profile
  const { data: organizations = [] } = useQuery({
    queryKey: ['organizations'],
    queryFn: () => base44.entities.Organization.list('name'),
    enabled: authReady,
  });

  const selectedProfile = useMemo(() =>
    profiles.find(p => p.id === (effectiveProfileId || selectedProfileId)),
    [profiles, effectiveProfileId, selectedProfileId]
  );

  const selectedOrg = useMemo(
    () =>
      selectedProfile?.organization_id
        ? organizations.find((o) => o.id === selectedProfile.organization_id)
        : null,
    [organizations, selectedProfile],
  );

  const profileForSearch = profileDetail ?? selectedOrg ?? selectedProfile;

  const isECFProfile =
    (profileForSearch?.medicaid_enrolled || selectedOrg?.medicaid_enrolled) &&
    (profileForSearch?.medicaid_waiver_program === 'ecf_choices' ||
      selectedOrg?.medicaid_waiver_program === 'ecf_choices');

  const handleFindFunding = async () => {
    const profileIdToUse = effectiveProfileId ?? selectedProfileId
    const pid = (typeof profileIdToUse === 'string' ? profileIdToUse.trim() : null) || null
    if (!pid) {
      toast({
        variant: 'destructive',
        title: 'Select a profile',
        description: 'Select a profile to search. We use your profile to match funding opportunities.',
      })
      return
    }
    setIsSearching(true)
    const itemRequest = profileForSearch ? {
      location: {
        state: profileForSearch?.signals?.location?.state || profileForSearch?.state || null,
        city: profileForSearch?.signals?.location?.city || profileForSearch?.city || null,
        zip: profileForSearch?.signals?.location?.zip || profileForSearch?.zip_code || null,
      },
      interests: profileForSearch?.signals?.interests ? Array.from(profileForSearch.signals.interests).slice(0, 10) : (profileForSearch?.tags || []).slice(0, 10),
      demographics: profileForSearch?.signals?.demographics ? Array.from(profileForSearch.signals.demographics).slice(0, 10) : [],
      career_goals: profileForSearch?.sections?.career_goals?.primary_goal || profileForSearch?.career_goal || null,
    } : null
    try {
      const data = await runRealCrawler({
        profileId: pid,
        crawlerType: 'comprehensive',
        profileData: profileForSearch,
        minMatchScore,
        itemRequest,
      })
      if (data && data.success === false) {
        const message = data.message || data.error || 'Search failed'
        toast({
          variant: 'destructive',
          title: 'Search failed',
          description: message,
        })
        return
      }
      const opportunities = data?.opportunities ?? []
      await handleCrawlerResults(opportunities)
    } catch (error) {
      console.error('[DiscoverGrants] Search error:', error)
      const errorMessage = error?.message || error?.response?.message || error?.response?.error || 'Search failed. Please try again.'
      toast({
        variant: 'destructive',
        title: 'Search failed',
        description: /profile_id|profile.*required|select.*profile/i.test(errorMessage)
          ? 'Select a profile to run the search. We need your profile to match opportunities.'
          : errorMessage,
      })
    } finally {
      setIsSearching(false)
    }
  }

  const handleCrawlerResults = async (opportunities) => {
    log.debug('processing crawler results', { count: opportunities.length })
    
    // Add all 50%+ matches to pipeline automatically
    let addedCount = 0
    let alreadyCount = 0
    let failedCount = 0
    let attempted = 0

    for (const opp of opportunities) {
      const score = Number(opp.match_score ?? opp.match ?? 0);
      if (Number.isFinite(score) && score >= 50) {
        attempted += 1
        try {
          const result = await handleAddToPipeline(opp, { silent: true })
          if (result?.status === 'added') addedCount += 1
          else if (result?.status === 'already') alreadyCount += 1
          else failedCount += 1
        } catch (error) {
          failedCount += 1
          console.error('[DiscoverGrants] Error adding to pipeline:', error)
        }
      }
    }

    // Refresh pipeline once (avoid spamming invalidations during batch add).
    queryClient.invalidateQueries({ queryKey: ['grants'] })

    toast({
      title: 'Search complete',
      description: `Found ${opportunities.length} opportunities. Pipeline update: ${addedCount} added, ${alreadyCount} already in pipeline, ${failedCount} failed (from ${attempted} eligible).`,
    })
    
    // Update search results to show crawler results
    setSearchResults(opportunities);
  };

  const handleAddToPipeline = async (opportunity, { silent = false } = {}) => {
    log.debug('add to pipeline requested')
    if (!authReady) {
      if (!silent) {
        toast({
          variant: 'destructive',
          title: 'Sign in required',
          description: 'Your session has expired. Please sign in again before updating the pipeline.',
        })
      }
      return { status: 'failed', error: 'not_authenticated' }
    }
    
    const profileIdForAdd = effectiveProfileId || selectedProfileId
    if (!profileIdForAdd) {
      if (!silent) {
        toast({
          variant: 'destructive',
          title: 'No profile selected',
          description: 'Please select a profile before adding to pipeline.',
        })
      }
      return { status: 'failed', error: 'missing_profile' }
    }

    const orgId = selectedProfile?.organization_id;
    
    // Check for duplicates if we have an org
    if (orgId && opportunity.url) {
      try {
        const existingGrants = await base44.entities.Grant.filter({
          organization_id: orgId,
          url: opportunity.url
        });
        
        if (existingGrants.length > 0) {
          if (!silent) {
            toast({
              title: 'Already in pipeline',
              description: `"${opportunity.title}" is already in your pipeline.`,
            })
          }
          return { status: 'already', grant: existingGrants[0] }
        }
      } catch (e) {
        // Ignore duplicate check errors, continue to add
        console.warn('Duplicate check failed:', e);
      }
    }

    try {
      // Validate required data before sending
      if (!opportunity.title) {
        if (!silent) {
          toast({
            variant: 'destructive',
            title: 'Invalid opportunity',
            description: 'The opportunity is missing required information (title).',
          })
        }
        return { status: 'failed', error: 'missing_title' }
      }

      // IMPORTANT: use apiFetch so Authorization is attached (prevents 401s).
      const newGrant = await apiFetch('/api/grants/from-opportunity', {
        method: 'POST',
        body: JSON.stringify({
          opportunity_id: opportunity.id || null,
          profile_id: profileIdForAdd,
          organization_id: orgId || null,
          match_score: opportunity.match || opportunity.match_score,
          match_reasons: opportunity.matchReasons || opportunity.matched_fields || [],
          // Include full opportunity data for synthetic opportunities
          opportunity_data: {
            title: opportunity.title,
            sponsor: opportunity.sponsor,
            deadline: opportunity.deadlineAt || opportunity.deadline,
            url: opportunity.url || opportunity.application_url,
            awardMin: opportunity.awardMin || opportunity.amount_min,
            awardMax: opportunity.awardMax || opportunity.amount_max,
            descriptionMd: opportunity.descriptionMd || opportunity.description,
            eligibilityBullets: opportunity.eligibilityBullets || [],
            source: opportunity.source || 'discovery',
          },
        }),
      })
      
      // Check if it was already in pipeline
      if (newGrant.already_exists) {
        if (!silent) {
          toast({
            title: 'Already in pipeline',
            description: `"${opportunity.title}" is already in your grants pipeline.`,
          })
        }
        return { status: 'already', grant: newGrant }
      }
      
      // If a new org was created, refresh profile data
      if (newGrant.organization_id && newGrant.organization_id !== orgId) {
        queryClient.invalidateQueries({ queryKey: ['profiles'] });
        queryClient.invalidateQueries({ queryKey: ['organizations'] });
      }
      
      if (!silent) {
        queryClient.invalidateQueries({ queryKey: ['grants'] })
        toast({
          title: 'Added to pipeline',
          description: `${opportunity.title} has been added to your grants pipeline.`,
        })
      }
      return { status: 'added', grant: newGrant }
    } catch (error) {
      console.error('Failed to add grant to pipeline:', error);
      
      // Extract error details from the response
      // Backend returns error info at top level: { error, message, requestId }
      const errorCode = error?.errorCode || error?.error || 'unknown_error'
      const requestId = error?.requestId || null
      
      // Provide user-friendly messages based on error type
      let userMessage = 'An unexpected error occurred. Please try again.'
      
      if (errorCode === 'missing_required_field' || errorCode === 'missing_opportunity_title') {
        userMessage = 'The opportunity is missing required information. Please check and try again.'
      } else if (errorCode === 'invalid_opportunity_data') {
        userMessage = 'The opportunity data format is invalid. Please try again or contact support.'
      } else if (errorCode === 'access_control_error') {
        userMessage = 'Access denied. You may not have permission to add grants to this profile.'
      } else if (errorCode === 'database_error') {
        userMessage = 'A database error occurred. Please try again in a moment.'
      } else if (errorCode === 'opportunity_expired') {
        userMessage = 'This opportunity has expired and cannot be added to your pipeline.'
      } else if (errorCode === 'profile_not_found') {
        userMessage = 'The selected profile was not found. Please refresh and try again.'
      } else if (errorCode === 'opportunity_not_found') {
        userMessage = 'The opportunity was not found in the database. Please try again.'
      } else if (errorCode === 'invalid_reference') {
        userMessage = 'One or more references are invalid. Please verify the opportunity and profile exist.'
      } else if (error?.message) {
        // Use the error message if available
        userMessage = error.message
      }
      
      if (!silent) {
        toast({
          variant: 'destructive',
          title: 'Failed to add grant',
          description: userMessage,
        })
      }
      
      // Log error details for debugging
      log.debug('add to pipeline failed', {
        errorCode,
        requestId,
        opportunityTitle: opportunity.title,
        profileId: profileIdForAdd,
      })
      
      return { status: 'failed', error: errorCode, message: userMessage, requestId }
    }
  };

  // --- Next Steps / Suggestions Logic ---
  const suggestions = React.useMemo(() => {
    const items = [];
    if (!selectedProfile) {
      items.push({ id: 'select-profile', icon: User, text: 'Select a profile to get started', detail: 'Choose a profile from the dropdown above so we can match funding opportunities to your needs.' });
      return items;
    }
    const sections = profileDetail?.sections || {};
    const sectionKeys = Object.keys(sections);
    if (sectionKeys.length < 3) {
      items.push({ id: 'complete-profile', icon: User, text: 'Complete your profile for better matches', detail: 'Adding more details (location, interests, goals) helps us find more relevant funding.' });
    }
    if (!sections.basic_information?.state && !sections.basic_information?.zip_code) {
      items.push({ id: 'add-location', icon: Lightbulb, text: 'Add your location (state/ZIP) to your profile', detail: 'Location data is critical for finding local funding and community resources near you.' });
    }
    if (searchResults.length === 0) {
      items.push({ id: 'run-crawlers', icon: Search, text: 'Run a search to discover funding opportunities', detail: 'Click "Find Funding Opportunities" to search all sources matched to your profile.' });
    }
    if (searchResults.length > 0) {
      const highMatches = searchResults.filter(r => (r.match_score || r.match || 0) >= 80);
      if (highMatches.length > 0) {
        items.push({ id: 'review-top', icon: CheckCircle2, text: 'Review your top ' + highMatches.length + ' high-match opportunities', detail: 'These opportunities scored 80%+ match with your profile. Consider adding them to your pipeline.' });
      }
      items.push({ id: 'add-pipeline', icon: ArrowRight, text: 'Add promising grants to your pipeline', detail: 'Use the checkboxes to select opportunities, then click Add to Pipeline to track and manage them.' });
    }
    return items.filter(s => !dismissedSuggestions.includes(s.id));
  }, [selectedProfile, profileDetail, searchResults, dismissedSuggestions]);

  const dismissSuggestion = (id) => {
    setDismissedSuggestions(prev => {
      const next = [...prev, id];
      try { localStorage.setItem('grantflow:dismissed-suggestions', JSON.stringify(next)); } catch { /* ignore storage errors */ }
      return next;
    });
  };

  const scrollToRef = (ref) => {
    if (!ref?.current) return false;
    ref.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return true;
  };

  const suggestionActionLabel = (suggestionId) => {
    switch (suggestionId) {
      case 'select-profile':
        return profiles.length === 0 ? 'Create a profile' : 'Select profile';
      case 'complete-profile':
      case 'add-location':
        return 'Open profile';
      case 'run-crawlers':
        return isSearching ? 'Search in progress' : 'Run search now';
      case 'review-top':
      case 'add-pipeline':
        return 'View search results';
      default:
        return 'Open next step';
    }
  };

  const handleSuggestionAction = async (suggestionId) => {
    const activeProfileId = effectiveProfileId || selectedProfileId || null
    log.debug('suggested next step clicked', {
      suggestionId,
      activeProfileId,
      searchResultCount: searchResults.length,
    })

    switch (suggestionId) {
      case 'select-profile': {
        if (profiles.length === 0) {
          navigate(createPageUrl('MyProfiles'));
          return;
        }
        scrollToRef(profileSelectorRef);
        return;
      }
      case 'complete-profile':
      case 'add-location': {
        if (selectedProfile?.id) {
          navigate(createPageUrl('ProfileDetail', { id: selectedProfile.id }));
          return;
        }
        if (profiles.length === 0) {
          navigate(createPageUrl('MyProfiles'));
          return;
        }
        scrollToRef(profileSelectorRef);
        return;
      }
      case 'run-crawlers': {
        if (isSearching) return;
        scrollToRef(searchActionsRef);
        await handleFindFunding();
        return;
      }
      case 'review-top':
      case 'add-pipeline': {
        const movedToResults = scrollToRef(resultsRef);
        if (!movedToResults) {
          navigate(createPageUrl('Pipeline', activeProfileId ? { profile_id: activeProfileId } : undefined));
        }
        return;
      }
      default:
        return;
    }
  };

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-foreground flex items-center gap-2">
            <Search className="w-8 h-8 text-primary" />
            Discover Funding Opportunities
            <HelpTip text="Search across multiple funding databases to find grants, scholarships, and assistance programs that match your profile. Results are scored based on how well they fit your location, demographics, and needs." />
          </h1>
          <p className="text-muted-foreground mt-2">
            Find scholarships, grants, benefits, and assistance programs that match your profile
          </p>
        </header>

        {/* Next Steps / Suggestions Panel */}
        {suggestions.length > 0 && (
          <Card className="mb-8 border-amber-200 bg-amber-50/50">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-lg">
                <Lightbulb className="w-5 h-5 text-amber-600" />
                Suggested Next Steps
                <HelpTip text="These suggestions are personalized based on your profile and activity. Dismiss any you have already completed." />
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="space-y-3">
                {suggestions.map((s) => {
                  const Icon = s.icon;
                  return (
                    <div key={s.id} className="flex items-start gap-3 p-3 bg-white rounded-lg border border-amber-100 group">
                      <button
                        type="button"
                        onClick={() => void handleSuggestionAction(s.id)}
                        className="flex flex-1 min-w-0 items-start gap-3 text-left rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                      >
                        <Icon className="w-5 h-5 text-amber-600 mt-0.5 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-foreground">{s.text}</p>
                          <p className="text-sm text-muted-foreground mt-0.5">{s.detail}</p>
                          <p className="text-xs text-primary font-medium mt-2 inline-flex items-center gap-1">
                            {suggestionActionLabel(s.id)}
                            <ArrowRight className="w-3.5 h-3.5" />
                          </p>
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          dismissSuggestion(s.id);
                        }}
                        className="text-xs text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0 mt-1"
                        title="Dismiss this suggestion"
                      >
                        Dismiss
                      </button>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}

        <Card className="shadow-lg mb-8">
          <CardHeader className="border-b border-border">
            <CardTitle className="flex items-center gap-2">
              <User className="w-5 h-5 text-primary" />
              Select Profile to Search
            </CardTitle>
            <CardDescription>
              Choose a profile so we can search for grants that match you
            </CardDescription>
          </CardHeader>
          <CardContent className="p-6">
            {/* Profile Selector */}
            <div className="mb-6" ref={profileSelectorRef}>
              <Label className="text-base font-semibold mb-3 block">Select Profile</Label>
              <Select value={selectedProfileId} onValueChange={setSelectedProfileId}>
                <SelectTrigger className="h-12">
                  <SelectValue placeholder="Choose a profile..." />
                </SelectTrigger>
                <SelectContent>
                  {isLoadingProfiles ? (
                    <div className="flex items-center justify-center p-4">
                      <Loader2 className="w-4 h-4 animate-spin text-primary" />
                      <span className="ml-2 text-sm text-muted-foreground">Loading profiles...</span>
                    </div>
                  ) : profiles.length === 0 ? (
                    <div className="p-4 text-center text-sm text-muted-foreground">
                      No profiles available. Create a profile first.
                    </div>
                  ) : (
                    profiles.map(profile => {
                      // Get org for this profile to check ECF status
                      const profileOrg = profile.organization_id 
                        ? organizations.find(o => o.id === profile.organization_id)
                        : null;
                      const isProfileECF = profileOrg?.medicaid_enrolled && 
                                          profileOrg?.medicaid_waiver_program === 'ecf_choices';
                      
                      return (
                        <SelectItem key={profile.id} value={profile.id}>
                          <div className="flex items-center gap-2">
                            <User className="w-4 h-4 text-muted-foreground" />
                            {profile.display_name}
                            {profile.organization_name && (
                              <span className="text-xs text-muted-foreground">
                                ({profile.organization_name})
                              </span>
                            )}
                            {isProfileECF && (
                              <Badge
                                variant="outline"
                                className="bg-green-500/10 text-green-800 border-green-500/20 text-xs dark:bg-green-500/15 dark:text-green-200 dark:border-green-500/30"
                              >
                                ECF CHOICES
                              </Badge>
                            )}
                          </div>
                        </SelectItem>
                      );
                    })
                  )}
                </SelectContent>
              </Select>
            </div>

            {/* Selected Profile Info */}
            {selectedProfile && (
              <Alert className={
                isECFProfile
                  ? 'bg-green-500/10 border-green-500/20 mb-6 dark:bg-green-500/15 dark:border-green-500/30'
                  : 'bg-primary/10 border-primary/20 mb-6'
              }>
                <User className={`h-4 w-4 ${
                  isECFProfile ? 'text-green-600 dark:text-green-300' : 'text-primary'
                }`} />
                <AlertDescription className={
                  isECFProfile ? 'text-green-800 dark:text-green-100' : 'text-foreground'
                }>
                  <strong>Selected:</strong> {selectedProfile.display_name}
                  {selectedProfile.organization_name && (
                    <span className="ml-2">({selectedProfile.organization_name})</span>
                  )}
                  {selectedProfile.primary_type && (
                    <span className="ml-2 text-xs text-muted-foreground">• {selectedProfile.primary_type.replace(/_/g, ' ')}</span>
                  )}
                  {selectedOrg?.state && <span className="ml-2">• {selectedOrg.state}</span>}
                  {isECFProfile && (
                    <span className="block mt-1 font-semibold">
                      🏥 ECF CHOICES Participant
                    </span>
                  )}
                </AlertDescription>
              </Alert>
            )}

            {/* Find Funding — single comprehensive search */}
            <div className="space-y-6" ref={searchActionsRef}>
              <div>
                <h3 className="text-lg font-semibold text-foreground">Find Funding Opportunities</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  We'll search all available funding sources — grants, scholarships, benefits, and local programs — matched to your profile.
                </p>
              </div>
              <div className="p-4 bg-muted/20 rounded-lg border border-border">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium text-foreground inline-flex items-center gap-1">
                      Minimum match score
                      <HelpTip text="How closely a grant must fit your profile to appear. Lower = more results; higher = only the best fits." />
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Lower this to see more results; raise it to keep only the strongest matches.
                    </div>
                  </div>
                  <div className="text-sm font-semibold text-foreground">{minMatchScore}%</div>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={minMatchScore}
                  onChange={(e) => setMinMatchScore(Number(e.target.value))}
                  disabled={isSearching}
                  className="mt-3 w-full"
                />
              </div>
              <Button
                onClick={handleFindFunding}
                disabled={!selectedProfile || isSearching}
                size="lg"
                className="min-w-[240px]"
              >
                {isSearching ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Searching...
                  </>
                ) : (
                  'Find Funding Opportunities'
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Results Display */}
        {searchResults.length > 0 && (
          <div ref={resultsRef}>
            <SearchResults
              results={searchResults}
              profileId={effectiveProfileId ?? selectedProfileId}
              onAddToPipeline={handleAddToPipeline}
              organizationName={selectedProfile?.display_name}
            />
          </div>
        )}
      </div>
    </div>
  );
}
