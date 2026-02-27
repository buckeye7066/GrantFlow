import React, { useEffect, useMemo, useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useNavigate } from 'react-router-dom';
import { 
  MapPin, Building2, GraduationCap, Heart, 
  HeartPulse,
  Users, Loader2, CheckCircle, Info, AlertTriangle, ChevronDown
} from 'lucide-react';
import HelpTip from '@/components/help/HelpTip';
import { useToast } from '@/components/ui/use-toast';
import { runRealCrawler } from '@/api/crawlers';
import { createLogger } from '@/utils/logger'
import { createPageUrl } from '@/utils'
import { getProfileContextIncompleteHint } from '@/components/discovery/profileContextIncompleteUi'

const CRAWLER_CONFIGS = [
  {
    id: 'local_funding',
    name: 'Local Funding',
    icon: MapPin,
    description: 'Searches for funding opportunities within 25 miles of your location or school ZIP code',
    details: 'Includes community foundations, United Way, local nonprofits, and regional grant programs. Excludes loans; programs requiring matching funds may be included but will score lower.',
    color: 'text-blue-600'
  },
  {
    id: 'government_funding',
    name: 'Government Funding',
    icon: Building2,
    description: 'Federal, state, and local government grants including NIH, FEMA, Medicare/Medicaid',
    details: 'Searches Grants.gov, state grant databases, and federal agency programs. Includes healthcare funding through CMS.',
    color: 'text-purple-600'
  },
  {
    id: 'health_resources',
    name: 'Health Resources',
    icon: HeartPulse,
    description: 'Reputable, directory-style health support resources (informational links)',
    details: 'Always includes durable national directories; research studies/trials are gated behind explicit consent.',
    color: 'text-rose-600',
  },
  {
    id: 'student_grants',
    name: 'Student Grants & Scholarships',
    icon: GraduationCap,
    description: 'FAFSA, CommonApp, scholarships, and school-specific financial aid',
    details: 'Matches based on GPA, test scores, interests, and accomplishments. Includes need-based and merit-based aid.',
    color: 'text-green-600'
  },
  {
    id: 'ecf_benefits',
    name: 'ECF CHOICES Benefits',
    icon: Heart,
    description: 'Benefits for ECF CHOICES participants and support providers',
    details: 'Two branches: Individual benefits for participants and funding for family model CLS-FM homes and support services.',
    color: 'text-pink-600'
  },
  {
    id: 'special_needs',
    name: 'Special Needs Funding',
    icon: Users,
    description: 'Funding for specific populations: cancer survivors, single parents, disabled individuals',
    details: 'Searches specialized foundations and programs focused on particular health conditions or life circumstances.',
    color: 'text-indigo-600'
  }
];

export default function CrawlerSelection({ 
  profileId, 
  profileData,
  onCrawlComplete,
  itemRequest = null 
}) {
  const navigate = useNavigate()
  const [selectedCrawlers, setSelectedCrawlers] = useState(new Set());
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState({});
  const [results, setResults] = useState({});
  const [errors, setErrors] = useState({});
  const [profileFixHints, setProfileFixHints] = useState({});
  const [showFallbackDetails, setShowFallbackDetails] = useState(false);
  const [minMatchScore, setMinMatchScore] = useState(50); // Lowered to 50 to show more results; crawlers now use 100% of profile signals for scoring
  const { toast } = useToast();
  const log = React.useMemo(() => createLogger('CrawlerSelection'), [])

  const ecfUnlock = useMemo(() => {
    const profile = profileData ?? null
    const sections = profile?.sections ?? {}
    const signals = profile?.signals ?? null
    const waiverSignalPresent =
      profile?.medicaid_waiver_program !== undefined ||
      sections?.government_assistance?.medicaid_waiver_program !== undefined
    const hasAnySignals = Boolean(signals && (signals.keywordSet || signals.location))
    const hasAnySections = Boolean(sections && Object.keys(sections).length > 0)
    const tagList = Array.isArray(profile?.tags) ? profile.tags : []
    const confident = Boolean(hasAnySignals || hasAnySections || waiverSignalPresent || tagList.length > 0)

    const state =
      signals?.location?.state ??
      profile?.state ??
      sections?.basic_information?.state ??
      null

    const waiver =
      profile?.medicaid_waiver_program ??
      sections?.government_assistance?.medicaid_waiver_program ??
      null
    const ecfRole = String(sections?.government_assistance?.ecf_choices_role ?? '').toLowerCase().trim()

    const keywordSet = signals?.keywordSet
    const keywordHas = (needle) =>
      Boolean(needle) &&
      keywordSet &&
      typeof keywordSet.has === 'function' &&
      keywordSet.has(String(needle).toLowerCase())

    const keywordIncludes = (fragment) => {
      const f = String(fragment || '').toLowerCase().trim()
      if (!f) return false
      if (!keywordSet || typeof keywordSet[Symbol.iterator] !== 'function') return false
      for (const kw of keywordSet) {
        if (String(kw || '').toLowerCase().includes(f)) return true
      }
      return false
    }

    const hasEcfWaiver = String(waiver || '').toLowerCase() === 'ecf_choices'
    const hasExplicitEcf = Boolean(ecfRole)

    const isTn =
      !state
        ? hasEcfWaiver || hasExplicitEcf
          ? true
          : keywordIncludes('tennessee') || keywordHas('tn')
        : String(state).toUpperCase() === 'TN'
    const mentionsEcf =
      keywordHas('ecf') ||
      keywordIncludes('employment and community first') ||
      keywordIncludes('ecf choices') ||
      tagList.some((t) => String(t || '').toLowerCase().includes('ecf'))

    const eligibleIndividual = Boolean(
      isTn && (profile?.ecf_participant === true || ecfRole === 'participant' || hasEcfWaiver || mentionsEcf),
    )

    const family = sections?.family_life ?? {}
    const caregiverFlag = family.family_caregiver === true || family.caregiver === true || profile?.caregiver === true
    const caregiverKeyword = keywordHas('caregiver') || keywordIncludes('caregiver')
    const eligibleCaretaker = Boolean(
      isTn && (ecfRole === 'caregiver' || caregiverFlag || caregiverKeyword) && (hasEcfWaiver || mentionsEcf || ecfRole === 'caregiver'),
    )

    const orgType =
      profile?.organization_type ??
      sections?.organization_details?.organization_type ??
      null
    const services = Array.isArray(profile?.services) ? profile.services : []
    const providerFlag =
      ecfRole === 'provider' ||
      profile?.is_provider === true ||
      profile?.provides_residential_support === true ||
      String(orgType || '').toLowerCase() === 'cls_fm' ||
      String(orgType || '').toLowerCase() === 'family_model' ||
      services.some((s) => String(s || '').toLowerCase().includes('residential'))
    const eligibleProvider = Boolean(isTn && providerFlag && (hasEcfWaiver || mentionsEcf || ecfRole === 'provider'))

    const eligibleSupport = Boolean(eligibleCaretaker || eligibleProvider)
    const supportType = eligibleProvider ? 'provider' : eligibleCaretaker ? 'caretaker' : null

    const allowed = Boolean(eligibleIndividual || eligibleSupport)
    let reason = null
    if (!allowed) {
      if (!profileId) reason = 'Select a profile to unlock this crawler.'
      else if (!confident) reason = 'Loading profile eligibilityâ¦'
      else if (!isTn) reason = 'ECF CHOICES is Tennessee-only; profile must be TN (or mention TN).'
      else reason = 'Requires ECF CHOICES participant or caregiver/provider profile.'
    }

    return {
      confident,
      allowed,
      eligibleIndividual,
      eligibleSupport,
      supportType,
      reason,
    }
  }, [profileData, profileId])

  // If user switches profiles and ECF is no longer eligible, auto-uncheck it.
  useEffect(() => {
    if (ecfUnlock.allowed) return
    if (!ecfUnlock.confident) return
    setSelectedCrawlers((prev) => {
      if (!prev.has('ecf_benefits')) return prev
      const next = new Set(prev)
      next.delete('ecf_benefits')
      return next
    })
  }, [ecfUnlock.allowed, profileId])

  const handleToggleCrawler = (crawlerId) => {
    if (crawlerId === 'ecf_benefits' && !ecfUnlock.allowed) {
      toast({
        variant: ecfUnlock.confident ? 'destructive' : 'default',
        title: ecfUnlock.confident ? 'ECF crawler locked' : 'Checking ECF eligibilityâ¦',
        description:
          ecfUnlock.reason ||
          'This crawler is only available for ECF CHOICES participants or their caretakers/providers.',
      })
      return
    }
    setSelectedCrawlers(prev => {
      const newSet = new Set(prev);
      if (newSet.has(crawlerId)) {
        newSet.delete(crawlerId);
      } else {
        newSet.add(crawlerId);
      }
      return newSet;
    });
  };

  const handleSelectAll = () => {
    if (selectedCrawlers.size === CRAWLER_CONFIGS.length) {
      setSelectedCrawlers(new Set());
    } else {
      setSelectedCrawlers(new Set(CRAWLER_CONFIGS.map(c => c.id)));
    }
  };

  const handleRunCrawlers = async () => {
    if (selectedCrawlers.size === 0) {
      toast({
        variant: 'destructive',
        title: 'No crawlers selected',
        description: 'Please select at least one crawler to run'
      });
      return;
    }

    const effectiveProfileId = (typeof profileId === 'string' ? profileId.trim() : null) || null
    if (!effectiveProfileId) {
      toast({
        variant: 'destructive',
        title: 'Select a profile',
        description: 'Select a profile to run crawlers. Crawlers use your profile signals to find matching opportunities.',
      })
      return
    }

    setIsRunning(true);
    setProgress({});
    setResults({});
    setErrors({});
    setProfileFixHints({});

    const crawlersToRun = Array.from(selectedCrawlers);
    log.debug('running crawlers', { count: crawlersToRun.length, profileId: effectiveProfileId })

    // Initialize progress
    crawlersToRun.forEach(id => {
      setProgress(prev => ({ ...prev, [id]: 'running' }));
    });

    // Run crawlers in parallel
    const crawlerPromises = crawlersToRun.map(async (crawlerId) => {
      try {
        const data = await runRealCrawler({
          profileId: effectiveProfileId,
          crawlerType: crawlerId,
          profileData,
          minMatchScore,
          itemRequest: profileData ? {
              location: {
                state: profileData?.signals?.location?.state || profileData?.state || null,
                city: profileData?.signals?.location?.city || profileData?.city || null,
                zip: profileData?.signals?.location?.zip || profileData?.zip_code || null,
              },
              interests: profileData?.signals?.interests ? Array.from(profileData.signals.interests).slice(0, 10) : (profileData?.tags || []).slice(0, 10),
              demographics: profileData?.signals?.demographics ? Array.from(profileData.signals.demographics).slice(0, 10) : [],
              career_goals: profileData?.sections?.career_goals?.primary_goal || profileData?.career_goal || null,
            } : null,
        });

        // Treat backend-reported failure as an error (even though HTTP is 200)
        if (data && data.success === false) {
          const message = data.message || data.error || 'Crawler failed'
          const err = new Error(message)
          err.response = data
          throw err
        }
        
        setProgress(prev => ({ ...prev, [crawlerId]: 'completed' }));
        setResults(prev => ({ ...prev, [crawlerId]: data }));
        setProfileFixHints((prev) => {
          if (!prev[crawlerId]) return prev
          const next = { ...prev }
          delete next[crawlerId]
          return next
        })
        
        return { crawlerId, success: true, data };
      } catch (error) {
        console.error(`[CrawlerSelection] Error running ${crawlerId}:`, error);
        setProgress(prev => ({ ...prev, [crawlerId]: 'error' }));

        let errorMessage = error.message || 'Unknown error';
        if (error.details && typeof error.details === 'object') {
          errorMessage = error.details.message || error.details.error || errorMessage;
        } else if (error.response && typeof error.response === 'object') {
          errorMessage = error.response.message || error.response.error || errorMessage;
        }
        // Surface profile_id requirement message in a user-friendly way
        if (/profile_id|profile.*required|select.*profile/i.test(errorMessage)) {
          errorMessage = 'Select a profile to run crawlers. Crawlers require profile context to match opportunities.';
        }
        const profileIncompleteHint = getProfileContextIncompleteHint(error)
        if (profileIncompleteHint) {
          errorMessage = profileIncompleteHint.headline
          setProfileFixHints((prev) => ({ ...prev, [crawlerId]: profileIncompleteHint }))
        } else {
          setProfileFixHints((prev) => {
            if (!prev[crawlerId]) return prev
            const next = { ...prev }
            delete next[crawlerId]
            return next
          })
        }

        setErrors(prev => ({ ...prev, [crawlerId]: errorMessage }));

        return { crawlerId, success: false, error: errorMessage };
      }
    });

    const allResults = await Promise.all(crawlerPromises);
    
    // Combine all successful results
    const successfulResults = allResults
      .filter(r => r.success)
      .flatMap(r => r.data.opportunities || []);

    const failedResults = allResults.filter(r => !r.success);

    log.debug('crawler results', { opportunities: successfulResults.length, minMatchScore })

    // Notify parent (even when empty, so DiscoverGrants can show zero-results state)
    if (onCrawlComplete) {
      await onCrawlComplete(successfulResults);
    }

    setIsRunning(false);

    // Show completion toast with detailed error info
    const successCount = allResults.filter(r => r.success).length;
    const errorCount = allResults.filter(r => !r.success).length;

    let toastDescription = `${successCount} succeeded, ${errorCount} failed. Found ${successfulResults.length} opportunities.`;
    
    // Add error details if any failed
    if (failedResults.length > 0) {
      const errorDetails = failedResults
        .map(r => {
          const crawlerName = CRAWLER_CONFIGS.find(c => c.id === r.crawlerId)?.name || r.crawlerId;
          return `${crawlerName}: ${r.error}`;
        })
        .join('\n');
      
      toastDescription += `\n\nErrors:\n${errorDetails}`;
    }

    toast({
      title: 'Search complete',
      description: toastDescription,
      variant: errorCount > 0 ? 'destructive' : 'default'
    });
  };

  const allSelected = selectedCrawlers.size === CRAWLER_CONFIGS.length;
  const someSelected = selectedCrawlers.size > 0;
  const hasValidProfile = Boolean((typeof profileId === 'string' ? profileId.trim() : null) || null);
  const anyDbFallback = Object.values(results || {}).some((r) => r && r.used_db_fallback);
  const missingZipLikely = Object.values(results || {}).some((r) => r?.debug && r.debug.has_zip === false);
  const lowKeywordsLikely = Object.values(results || {}).some((r) => r?.debug && (r.debug.keyword_count ?? 0) < 5);

  // Compute missing signal details for the clickable fallback banner
  const missingSignals = useMemo(() => {
    const signals = [];
    const debugEntries = Object.values(results || {}).map(r => r?.debug).filter(Boolean);
    if (!debugEntries.length) return signals;
    const d = debugEntries[0];
    if (d.has_zip === false) signals.push({ label: 'ZIP Code', desc: 'Required for local/geographic matching' });
    if (d.has_state === false) signals.push({ label: 'State', desc: 'Used for state-level program filtering' });
    if ((d.keyword_count ?? 0) < 5) signals.push({ label: 'Keywords / Tags', desc: 'Fewer than 5 keywords limits match quality' });
    if (d.section_count < 5) signals.push({ label: 'Profile Sections', desc: 'Fewer than 5 sections reduces context' });
    if (d.profile_context_incomplete) signals.push({ label: 'Profile Context', desc: 'Profile context is incomplete' });
    return signals;
  }, [results]);

  const fallbackCrawlerNames = useMemo(() =>
    Object.entries(results || {})
      .filter(([, v]) => v?.used_db_fallback)
      .map(([k]) => k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())),
    [results]
  );

  const profileStats = useMemo(() => {
    const d = Object.values(results || {})[0]?.debug;
    return d ? { keywords: d.keyword_count ?? 0, sections: d.section_count ?? 0, coverage: d.coverage_pct ?? 0 } : null;
  }, [results]);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Info className="w-5 h-5" />
            Find Funding
          </CardTitle>
          <CardDescription>
            Choose which funding sources to search. We match results to your profile so you see the most relevant grants first.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {anyDbFallback && (
            <Alert
              variant="warning"
              className="cursor-pointer transition-all hover:shadow-sm"
              onClick={() => setShowFallbackDetails(prev => !prev)}
            >
              <AlertTriangle className="w-4 h-4" />
              <AlertDescription>
                <div className="flex items-start justify-between">
                  <div>
                    Some searches used your curated database (real opportunities we've already found) because the live search returned nothing or your profile is missing key details.
                    <HelpTip text="Live search found no results, or your profile needs more details (ZIP, keywords). We used our curated database instead so you still see relevant opportunities." />
                    <span className="text-xs opacity-60 ml-1">
                      {showFallbackDetails ? '(click to hide)' : '(click for details)'}
                    </span>
                    {missingZipLikely && !showFallbackDetails && (
                      <>
                        <br />
                        <span className="text-sm">Tip: add a ZIP/state to get true local matches.</span>
                      </>
                    )}
                    {lowKeywordsLikely && !showFallbackDetails && (
                      <>
                        <br />
                        <span className="text-sm">Tip: add a few tags/keywords to improve match quality.</span>
                      </>
                    )}
                  </div>
                  <ChevronDown className={`w-4 h-4 shrink-0 ml-2 transition-transform ${showFallbackDetails ? 'rotate-180' : ''}`} />
                </div>

                {showFallbackDetails && (
                  <div className="border-t border-yellow-500/30 pt-3 mt-2 space-y-3">
                    <p className="font-semibold text-sm text-yellow-800">Missing Key Signals in Profile</p>

                    {missingSignals.length === 0 ? (
                      <div className="p-2 bg-green-50 border border-green-200 rounded-md text-sm">
                        All key signals are present. Live search returned no results, so we used your curated database.
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        {missingSignals.map(s => (
                          <div key={s.label} className="p-2 bg-red-50 border border-red-200 rounded-md text-sm">
                            <span className="font-semibold text-red-900">{s.label}</span>
                            <span className="text-gray-500"> — {s.desc}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {fallbackCrawlerNames.length > 0 && (
                      <div>
                        <p className="font-semibold text-xs text-yellow-800 mb-1.5">
                          Searches using curated database ({fallbackCrawlerNames.length}):
                        </p>
                        <div className="flex flex-wrap gap-1">
                          {fallbackCrawlerNames.map(name => (
                            <span key={name} className="px-2 py-0.5 bg-yellow-100 border border-yellow-300 rounded-full text-xs text-yellow-800">
                              {name}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {profileStats && (
                      <div className="p-2 bg-gray-50 rounded-md text-xs text-gray-500">
                        <span className="font-medium">Profile Stats:</span>{' '}
                        Keywords: {profileStats.keywords} · Sections: {profileStats.sections} · Coverage: {profileStats.coverage}%
                      </div>
                    )}
                  </div>
                )}
              </AlertDescription>
            </Alert>
          )}

          {/* Select All Control */}
          <div className="p-4 bg-muted/20 rounded-lg border border-border">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
              <div className="flex items-center gap-3">
                <Checkbox
                  id="select-all-crawlers"
                  checked={allSelected}
                  onCheckedChange={handleSelectAll}
                />
                <label htmlFor="select-all-crawlers" className="font-medium cursor-pointer">
                  {allSelected ? 'Deselect All' : 'Select All'}
                </label>
                {someSelected ? (
                  <span className="text-sm text-muted-foreground">
                    {selectedCrawlers.size} source{selectedCrawlers.size !== 1 ? 's' : ''} selected
                  </span>
                ) : null}
              </div>

              <div className="flex justify-end">
                <Button onClick={handleRunCrawlers} disabled={!someSelected || !hasValidProfile || isRunning} size="lg" className="min-w-[200px]">
                  {isRunning ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Searching...
                    </>
                  ) : (
                    <>
                      Search for Funding
                      {someSelected && ` (${selectedCrawlers.size})`}
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>

          {/* Match score threshold */}
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
              disabled={isRunning}
              className="mt-3 w-full"
            />
          </div>

          {/* Crawler Options */}
          <div className="grid gap-4 md:grid-cols-2">
            {CRAWLER_CONFIGS.map((crawler) => {
              const Icon = crawler.icon;
              const isSelected = selectedCrawlers.has(crawler.id);
              const status = progress[crawler.id];
              const result = results[crawler.id];
              const error = errors[crawler.id];
              const profileFixHint = profileFixHints[crawler.id] || null;
              const isLocked = crawler.id === 'ecf_benefits' && !ecfUnlock.allowed

              return (
                <div
                  key={crawler.id}
                  className={`
                    relative border rounded-lg p-4 transition-all cursor-pointer
                    ${isSelected ? 'border-primary/60 bg-primary/10' : 'border-border hover:border-border/70'}
                    ${status === 'running' ? 'opacity-75' : ''}
                    ${status === 'completed' ? 'border-green-500/60 bg-green-500/10' : ''}
                    ${status === 'error' ? 'border-red-500/60 bg-red-500/10' : ''}
                    ${isLocked ? 'opacity-60 cursor-not-allowed' : ''}
                  `}
                  onClick={() => !isRunning && !isLocked && handleToggleCrawler(crawler.id)}
                >
                  <div className="flex items-start gap-3">
                    <Checkbox
                      id={`crawler-${crawler.id}`}
                      aria-label={`Select ${crawler.name}`}
                      checked={isSelected}
                      onCheckedChange={() => handleToggleCrawler(crawler.id)}
                      disabled={isRunning || isLocked}
                      onClick={(e) => e.stopPropagation()}
                      className="mt-1"
                    />
                    <label htmlFor={`crawler-${crawler.id}`} className="sr-only">
                      Select {crawler.name}
                    </label>
                    <div className="flex-1 space-y-2">
                      <div className="flex items-center gap-2">
                        <Icon className={`w-5 h-5 ${crawler.color}`} />
                        <h3 className="font-semibold inline-flex items-center gap-1">
                          {crawler.name}
                          <HelpTip text={crawler.details} />
                        </h3>
                        {status === 'running' && (
                          <Loader2 className="w-4 h-4 animate-spin text-primary" />
                        )}
                        {status === 'completed' && (
                          <CheckCircle className="w-4 h-4 text-green-600" />
                        )}
                        {status === 'error' && (
                          <AlertTriangle className="w-4 h-4 text-red-600" />
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground">{crawler.description}</p>
                      <p className="text-xs text-muted-foreground">{crawler.details}</p>

                      {isLocked ? (
                        <div className="mt-2 p-2 bg-amber-500/10 border border-amber-500/30 rounded text-xs text-amber-900 dark:text-amber-100">
                          <strong>Locked:</strong> {ecfUnlock.reason || 'Requires ECF CHOICES participant or caregiver/provider profile.'}
                        </div>
                      ) : null}
                      
                      {result && (
                        <div className="mt-2 space-y-1">
                          <div className="text-xs text-green-700 dark:text-green-300 font-medium">
                            Included {result.count || 0} of {result.total_found ?? (result.count || 0)} found
                          </div>
                          {(result.count || 0) === 0 && (result.total_found ?? 0) > 0 && (
                            <div className="text-xs text-amber-700 dark:text-amber-200">
                              None met the match threshold. Try lowering the minimum score above, or add more profile details (ZIP, state, keywords) for better matches.
                            </div>
                          )}
                        </div>
                      )}
                      
                      {error && (
                        <div className="mt-2 p-2 bg-red-500/10 border border-red-500/30 rounded text-xs text-red-800 dark:text-red-200">
                          <strong>Error:</strong> {error}
                        </div>
                      )}

                      {profileFixHint && (
                        <div className="mt-2 p-2 bg-blue-50 border border-blue-200 rounded text-xs text-blue-900 dark:bg-blue-500/10 dark:border-blue-500/30 dark:text-blue-100">
                          <p className="font-semibold">{profileFixHint.headline}</p>
                          <ul className="list-disc ml-4 mt-1 space-y-0.5">
                            {profileFixHint.checklist.map((item) => (
                              <li key={`${crawler.id}-fix-${item}`}>{item}</li>
                            ))}
                          </ul>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="mt-2 h-7 px-2 text-xs"
                            disabled={!profileId}
                            onClick={(event) => {
                              event.preventDefault()
                              event.stopPropagation()
                              if (!profileId) return
                              navigate(createPageUrl('ProfileDetail', { id: profileId }))
                            }}
                          >
                            Go to Profile -&gt; Save
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Run Button */}
          <div className="flex justify-end pt-4 border-t">
            <Button
              onClick={handleRunCrawlers}
              disabled={!someSelected || !hasValidProfile || isRunning}
              size="lg"
              className="min-w-[200px]"
            >
              {isRunning ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Searching...
                </>
              ) : (
                <>
                  Search for Funding
                  {someSelected && ` (${selectedCrawlers.size})`}
                </>
              )}
            </Button>
          </div>

          {/* Results Summary */}
          {Object.keys(results).length > 0 && (
            <div className="mt-6 p-4 bg-green-50 border border-green-200 rounded-lg">
              <h4 className="font-semibold text-green-900 mb-2">Search Results</h4>
              <div className="space-y-1">
                {Object.entries(results).map(([crawlerId, result]) => {
                  const crawler = CRAWLER_CONFIGS.find(c => c.id === crawlerId);
                  return (
                    <div key={crawlerId} className="text-sm text-green-800">
                      <span className="font-medium">{crawler?.name}:</span>{' '}
                      {result.count || 0} included of {result.total_found ?? (result.count || 0)} found
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
