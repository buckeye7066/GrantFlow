import React, { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { getProfile, listProfiles } from '@/api/profiles';
import { apiFetch } from '@/api/client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, Search, User } from 'lucide-react';
import SearchResults from '@/components/discovery/SearchResults';
import CrawlerSelection from '@/components/discovery/CrawlerSelection';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/use-toast';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import { useAuthStore } from '@/stores/authStore';



export default function DiscoverGrants() {
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  
  const { toast } = useToast();
  const queryClient = useQueryClient();
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

  const { data: profileDetail } = useQuery({
    queryKey: ['discover-profile', selectedProfileId],
    queryFn: () => getProfile(selectedProfileId),
    enabled: authReady && Boolean(selectedProfileId),
  });

  // Also fetch organizations to get detailed org data for selected profile
  const { data: organizations = [] } = useQuery({
    queryKey: ['organizations'],
    queryFn: () => base44.entities.Organization.list('name'),
    enabled: authReady,
  });

  // Memoized selected profile and organization
  const selectedProfile = useMemo(() => 
    profiles.find(p => p.id === selectedProfileId),
    [profiles, selectedProfileId]
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

  const handleCrawlerResults = async (opportunities) => {
    console.log('[DiscoverGrants] Processing crawler results:', opportunities.length);
    
    // Add all 50%+ matches to pipeline automatically
    let addedCount = 0;
    for (const opp of opportunities) {
      const score = Number(opp.match_score ?? opp.match ?? 0);
      if (Number.isFinite(score) && score >= 50) {
        try {
          await handleAddToPipeline(opp);
          addedCount++;
        } catch (error) {
          console.error('[DiscoverGrants] Error adding to pipeline:', error);
        }
      }
    }
    
    toast({
      title: 'Crawler Complete',
      description: `Found ${opportunities.length} opportunities, added ${addedCount} to pipeline (50%+ matches)`,
      variant: 'success'
    });
    
    // Update search results to show crawler results
    setSearchResults(opportunities);
  };

  const handleAddToPipeline = async (opportunity) => {
    console.log('[DiscoverGrants] Adding to pipeline:', opportunity);
    if (!authReady) {
      toast({
        variant: 'destructive',
        title: 'Sign in required',
        description: 'Your session has expired. Please sign in again before updating the pipeline.',
      });
      return;
    }
    
    if (!selectedProfileId) {
      toast({
        variant: 'destructive',
        title: 'No Profile Selected',
        description: 'Please select a profile before adding to pipeline.',
      });
      return;
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
          toast({
            title: 'Already in Pipeline',
            description: `"${opportunity.title}" is already in your pipeline.`,
            variant: 'default',
          });
          return existingGrants[0];
        }
      } catch (e) {
        // Ignore duplicate check errors, continue to add
        console.warn('Duplicate check failed:', e);
      }
    }

    try {
      // IMPORTANT: use apiFetch so Authorization is attached (prevents 401s).
      const newGrant = await apiFetch('/api/grants/from-opportunity', {
        method: 'POST',
        body: JSON.stringify({
          opportunity_id: opportunity.id || null,
          profile_id: selectedProfileId,
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
        toast({
          title: 'Already in Pipeline',
          description: `"${opportunity.title}" is already in your grants pipeline.`,
        });
        return newGrant;
      }
      
      // If a new org was created, refresh profile data
      if (newGrant.organization_id && newGrant.organization_id !== orgId) {
        queryClient.invalidateQueries({ queryKey: ['profiles'] });
        queryClient.invalidateQueries({ queryKey: ['organizations'] });
      }
      
      queryClient.invalidateQueries({ queryKey: ['grants'] });
      toast({
        title: 'Grant Added to Pipeline',
        description: `${opportunity.title} has been added to your grants pipeline.`,
      });
      return newGrant;
    } catch (error) {
      console.error('Failed to add grant to pipeline:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      toast({
        variant: 'destructive',
        title: 'Failed to Add Grant',
        description: message,
      });
    }
  };

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-2">
            <Search className="w-8 h-8 text-blue-600" />
            Discover Funding Opportunities
          </h1>
          <p className="text-slate-600 mt-2">
            Find scholarships, grants, benefits, and assistance programs that match your profile
          </p>
        </header>

        <Card className="shadow-lg border-0 mb-8">
          <CardHeader className="border-b border-slate-100">
            <CardTitle className="flex items-center gap-2">
              <User className="w-5 h-5 text-blue-600" />
              Select Profile to Search
            </CardTitle>
            <CardDescription>
              Choose a profile to run real web crawlers and find matching opportunities
            </CardDescription>
          </CardHeader>
          <CardContent className="p-6">
            {/* Profile Selector */}
            <div className="mb-6">
              <Label className="text-base font-semibold mb-3 block">Select Profile</Label>
              <Select value={selectedProfileId} onValueChange={setSelectedProfileId}>
                <SelectTrigger className="h-12">
                  <SelectValue placeholder="Choose a profile..." />
                </SelectTrigger>
                <SelectContent>
                  {isLoadingProfiles ? (
                    <div className="flex items-center justify-center p-4">
                      <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
                      <span className="ml-2 text-sm text-slate-500">Loading profiles...</span>
                    </div>
                  ) : profiles.length === 0 ? (
                    <div className="p-4 text-center text-sm text-slate-500">
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
                            <User className="w-4 h-4 text-slate-500" />
                            {profile.display_name}
                            {profile.organization_name && (
                              <span className="text-xs text-slate-500">
                                ({profile.organization_name})
                              </span>
                            )}
                            {isProfileECF && (
                              <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200 text-xs">
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
                  ? 'bg-green-50 border-green-200 mb-6'
                  : 'bg-blue-50 border-blue-200 mb-6'
              }>
                <User className={`h-4 w-4 ${
                  isECFProfile ? 'text-green-600' : 'text-blue-600'
                }`} />
                <AlertDescription className={
                  isECFProfile ? 'text-green-900' : 'text-blue-800'
                }>
                  <strong>Selected:</strong> {selectedProfile.display_name}
                  {selectedProfile.organization_name && (
                    <span className="ml-2">({selectedProfile.organization_name})</span>
                  )}
                  {selectedProfile.primary_type && (
                    <span className="ml-2 text-xs">• {selectedProfile.primary_type.replace(/_/g, ' ')}</span>
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

            {/* Crawler Selection */}
            <CrawlerSelection
              profileId={selectedProfileId}
              profileData={profileForSearch}
              onCrawlComplete={handleCrawlerResults}
            />
          </CardContent>
        </Card>

        {/* Results Display */}
        {searchResults.length > 0 && (
          <SearchResults
            results={searchResults}
            profileId={selectedProfileId}
            onAddToPipeline={handleAddToPipeline}
            organizationName={selectedProfile?.display_name}
          />
        )}
      </div>
    </div>
  );
}