import React, { useMemo, useState, useEffect } from 'react';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { getProfile, listProfiles } from '@/api/profiles';
import client, { apiFetch } from '@/api/client';
import { discoverAllForProfile, fetchCrawlerStatus } from '@/api/crawlers';
import { createPageUrl } from '@/utils';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Loader2, Search, User, Lightbulb, ArrowRight, CheckCircle2, AlertTriangle, MessageCircle } from 'lucide-react';
import HelpTip from '@/components/help/HelpTip';
import SearchResults from '@/components/discovery/SearchResults';
import SearchCoveragePanel from '@/components/discovery/SearchCoveragePanel';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/use-toast';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import { useAuthStore } from '@/stores/authStore';
import { createLogger } from '@/utils/logger'
import { CANONICAL_NEED_CATEGORIES, NEED_CATEGORY_GROUPS } from '@/constants/needCategories'
import ReverseLookup from '@/components/discovery/ReverseLookup'
import { getProfileContextIncompleteHint } from '@/components/discovery/profileContextIncompleteUi'
import { openAnyaPanel } from '@/lib/anyaPanel'
import { buildZeroResultDescription } from '@/components/discovery/discoveryToasts'
import {
  inferUsStateZipFromText,
  getExplicitStateZip,
  collectAddressTextForInference,
} from '@/utils/inferLocationFromAddress'
import { useFundingResultsStore } from '@/stores/fundingResultsStore'
import { AUTO_ADD_SCORE, GOOD_MATCH_SCORE } from '@/lib/matchDisplayThresholds'

// Discovery is now asynchronous: a click dispatches the profile-aware crawler
// fleet to the background dispatcher (which runs each relevant crawler to
// completion — no synchronous request to hit Vercel's ~30s proxy 504, and no
// time-budget that returns partial/shortcut results), then the UI polls the
// catalog so matches stream in as crawlers finish. Slow-but-complete by design.
const DISCOVERY_POLL_MS = 12000         // how often to refetch catalog + status (gentle: heavy query)
const DISCOVERY_MAX_WAIT_MS = 5 * 60 * 1000 // stop polling after 5 min (jobs keep running server-side)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Fetch profile-matched catalog opportunities. Shared by the live discover
 * query and the discovery poll loop so both honor the slider as a hard floor.
 */
async function fetchCatalogMatches(profileId, minMatchScore) {
  if (!profileId) return { opportunities: [] }
  const ms = Math.min(100, Math.max(0, Number(minMatchScore) || 0))
  const params = new URLSearchParams({
    min_score: String(ms),
    limit: '2000',
    skip_readiness_check: '1',
    strict: '1',
    allow_relax: '0',
    relax: '0',
  })
  return apiFetch(`/api/matching/profile/${profileId}/opportunities?${params.toString()}`)
}

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

/** Profile API returns sections as [{ section_key, data }, ...]. Normalize to { section_key: data } for reads. */
function sectionsMap(profileDetail) {
  const raw = profileDetail?.sections
  if (!raw) return {}
  if (Array.isArray(raw)) {
    return Object.fromEntries(
      (raw).map((s) => [s?.section_key, s?.data]).filter(([k]) => Boolean(k))
    )
  }
  return typeof raw === 'object' && raw !== null ? raw : {}
}

function normalizeResultMetadata(payload, results) {
  const listLength = Array.isArray(results) ? results.length : 0
  return {
    returned: Number.isFinite(Number(payload?.returned))
      ? Number(payload.returned)
      : Number.isFinite(Number(payload?.count))
        ? Number(payload.count)
        : listLength,
    totalFound: Number.isFinite(Number(payload?.total_found))
      ? Number(payload.total_found)
      : Number.isFinite(Number(payload?.total_scored))
        ? Number(payload.total_scored)
        : listLength,
    totalScored: Number.isFinite(Number(payload?.total_scored)) ? Number(payload.total_scored) : null,
    truncated: Boolean(payload?.truncated),
    thresholdFallbackMessage: payload?.threshold_fallback_message ?? null,
    // Zero-result ladder telemetry (Mission System 5, RC-12). Present only when
    // the backend ran the staged fallback ladder (matching.js / discovery.js).
    diagnostics: extractDiagnostics(payload),
  }
}

// Pull the staged-ladder diagnostics out of a results payload so the UI can
// explain what was searched/expanded and what profile info would help — instead
// of showing a dead-end empty state. Returns null when nothing is present.
function extractDiagnostics(payload) {
  if (!payload || typeof payload !== 'object') return null
  const resultTier = payload.result_tier ?? null
  const tierExplanation = payload.tier_explanation ?? null
  const tierAttempts = Array.isArray(payload.tier_attempts) ? payload.tier_attempts : null
  const profileGaps = Array.isArray(payload.profile_gaps) ? payload.profile_gaps : []
  const directoryOnly = Boolean(payload.directory_only)
  const geoExpanded = Boolean(payload.geo_expanded)
  if (!resultTier && !tierExplanation && !tierAttempts && profileGaps.length === 0 && !directoryOnly && !geoExpanded) {
    return null
  }
  return { resultTier, tierExplanation, tierAttempts, profileGaps, directoryOnly, geoExpanded }
}

// Category taxonomy imported from @/constants/needCategories

export default function DiscoverGrants() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [minMatchScore, setMinMatchScore] = useState(35);
  // Debounce the slider value used to KEY the catalog query so dragging the
  // slider through intermediate values doesn't fire a heavy 2000-row matching
  // query per step (that thundering herd saturated the DB → 503/504 cascade).
  const [debouncedMinMatchScore, setDebouncedMinMatchScore] = useState(35);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedMinMatchScore(minMatchScore), 450);
    return () => clearTimeout(t);
  }, [minMatchScore]);
  // Guard so repeated "Find Funding" clicks don't stack multiple poll loops /
  // re-dispatch the crawler fleet concurrently (each poll re-runs the heavy
  // matcher; stacking them is what overwhelmed the DB).
  const discoveringRef = React.useRef(false);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [profileCompletionHint, setProfileCompletionHint] = useState(null)
  const [categoryQuery, setCategoryQuery] = useState(null)
  const [scoreHint, setScoreHint] = useState(null)
  // Live progress for the async crawler fleet: { active, enqueued, running, crawlerTypes }.
  const [discovery, setDiscovery] = useState(null)
  const [crawlerResultMeta, setCrawlerResultMeta] = useState(null)
  // Mission Goal 7: capture coverage data from the API so the user can see
  // which source families GrantFlow planned, queried, and missed.
  const [coverageInfo, setCoverageInfo] = useState(null)
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
  const setFundingResults = useFundingResultsStore((s) => s.setResults)
  const { isAuthenticated, accessToken, sessionExpired } = useAuthStore((state) => ({
    isAuthenticated: state.isAuthenticated,
    accessToken: state.accessToken,
    sessionExpired: state.sessionExpired,
  }));

  const tokenAvailable = useMemo(() => {
    try {
      return Boolean(accessToken || client.getToken?.());
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

  // Restore last selected profile on mount (only when no URL param is present, to avoid overriding it).
  useEffect(() => {
    const urlProfileId = searchParams.get('profile_id')
    if (!selectedProfileId && !urlProfileId && profiles.length > 0) {
      try {
        const lastProfile = localStorage.getItem('grantflow:discover-last-profile');
        if (lastProfile && profiles.some(p => p.id === lastProfile)) {
          setSelectedProfileId(lastProfile);
        }
      } catch { /* ignore storage errors */ }
    }
  }, [profiles, searchParams, selectedProfileId]);


  // Clear stale results and invalidate caches whenever the effective profile changes
  useEffect(() => {
    setSearchResults([]);
    setCrawlerResultMeta(null);
    setCoverageInfo(null);
    setHasSearched(false);
    setProfileCompletionHint(null);
    queryClient.invalidateQueries({ queryKey: ['discover-catalog'] });
    queryClient.invalidateQueries({ queryKey: ['discover-profile'] });
  }, [effectiveProfileId, queryClient]);


  const { data: profileDetail, isPending: isProfileDetailPending } = useQuery({
    queryKey: ['discover-profile', effectiveProfileId ?? selectedProfileId],
    queryFn: () => getProfile(effectiveProfileId || selectedProfileId),
    enabled: authReady && Boolean(effectiveProfileId || selectedProfileId),
    refetchOnMount: 'always',
  });

  /** Ignore stale profile payloads when the selected id changes until the matching fetch completes. */
  const profileDetailForUi = useMemo(() => {
    const id = effectiveProfileId || selectedProfileId
    if (!profileDetail || !id) return null
    if (String(profileDetail.id) !== String(id)) return null
    return profileDetail
  }, [profileDetail, effectiveProfileId, selectedProfileId])

  // Also fetch organizations to get detailed org data for selected profile
  const { data: organizations = [] } = useQuery({
    queryKey: ['organizations'],
    queryFn: () => client.entities.Organization.list('name'),
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

  // Guard against stale profileDetail from a previously-selected profile.
  // effectiveProfileId is the authoritative identifier; selectedProfileId is the fallback
  // when effectiveProfileId hasn't resolved yet (e.g., URL param not set).
  const profileDetailMatchesCurrent = Boolean(profileDetailForUi);
  const profileForSearch = profileDetailForUi ?? selectedOrg ?? selectedProfile;

  // Catalog match: real funding opportunities from DB, scored by profile needs (relatable grants, not only directory links)
  const { data: catalogMatchResponse } = useQuery({
    // Keyed by the DEBOUNCED slider value — one query per settled value, not per
    // drag step.
    queryKey: ['discover-catalog', effectiveProfileId, debouncedMinMatchScore],
    // Catalog query honors the Discover slider as a HARD floor (strict mode).
    // The user can broaden via "Try Broader Search", which lowers the slider.
    queryFn: () => fetchCatalogMatches(effectiveProfileId, debouncedMinMatchScore),
    enabled: authReady && Boolean(effectiveProfileId),
    staleTime: 0,
    // Keep showing the previous results while a new slider value loads, so the
    // UI never blanks (and the user isn't tempted to re-trigger).
    placeholderData: keepPreviousData,
    // A concurrent crawl can momentarily saturate the DB, so the matcher returns
    // a retryable 503 (catalog_busy) or 504s. Retry — but SPARINGLY with long
    // backoff: this is a heavy query, and aggressive retries amplify the very
    // overload that caused the timeout (a thundering-herd death spiral).
    retry: (failureCount, error) => {
      const status = error?.status
      if (status === 503) return failureCount < 2
      if (status === 504) return failureCount < 1
      return false
    },
    retryDelay: (attempt) => Math.min(3000 * 2 ** attempt, 15000),
  })

  const catalogOpportunities = useMemo(() => {
    const payload = catalogMatchResponse?.data ?? catalogMatchResponse ?? {}
    const rows = payload?.opportunities ?? []
    if (!Array.isArray(rows)) return []
    // Defense in depth: if any backend path leaks results below the user's
    // slider value, the UI must still honor the slider as a hard floor.
    const minScoreFloor = Math.min(100, Math.max(0, Number(debouncedMinMatchScore) || 0))
    return rows
      .filter((opp) => {
        const score = Number(opp.match_score ?? opp.match ?? -Infinity)
        return Number.isFinite(score) && score >= minScoreFloor
      })
      .map((opp) => ({
        id: opp.id,
        title: opp.title,
        program_name: opp.title,
        sponsor: opp.sponsor || opp.funder,
        url: opp.application_url ?? opp.source_url ?? opp.url,
        deadline: opp.deadline,
        deadlineAt: opp.deadline,
        description: opp.description,
        descriptionMd: opp.description,
        match_score: opp.match_score,
        match: opp.match_score,
        matched_fields: opp.match_reasons ?? [],
        matchReasons: opp.match_reasons ?? [],
        source: opp.source || 'catalog',
        usable_for_housing: opp.usable_for_housing ?? false,
        refund_potential: opp.refund_potential ?? false,
        funding_category: opp.funding_category ?? null,
      }))
  }, [catalogMatchResponse, debouncedMinMatchScore])

  const catalogResultMeta = useMemo(() => {
    const payload = catalogMatchResponse?.data ?? catalogMatchResponse ?? {}
    return normalizeResultMetadata(payload, catalogOpportunities)
  }, [catalogMatchResponse, catalogOpportunities])

  // Keep FundingResults store in sync with the combined view so /FundingResults
  // always displays whatever the user last saw on DiscoverGrants.
  useEffect(() => {
    if (catalogOpportunities.length === 0 && searchResults.length === 0) return
    const seen = new Set()
    const merged = []
    for (const opp of catalogOpportunities) {
      const key = opp.id ?? `${opp.title}|${opp.sponsor ?? ''}`
      if (!seen.has(key)) { seen.add(key); merged.push(opp) }
    }
    for (const opp of searchResults) {
      const key = opp.id ?? opp.url ?? `${opp.title}|${opp.sponsor ?? ''}`
      if (!seen.has(key)) { seen.add(key); merged.push(opp) }
    }
    merged.sort((a, b) => (b.match_score ?? b.match ?? 0) - (a.match_score ?? a.match ?? 0))
    const profileIdForStore = effectiveProfileId ?? selectedProfileId
    setFundingResults({
      results: merged,
      profileId: profileIdForStore,
      organizationName: selectedProfile?.display_name ?? null,
      organizationId: selectedProfile?.organization_id ?? null,
      returned: merged.length,
      totalFound: Math.max(
        merged.length,
        (catalogResultMeta?.totalFound ?? 0) + (crawlerResultMeta?.totalFound ?? 0),
      ),
      totalScored: catalogResultMeta?.totalScored ?? null,
      truncated: Boolean(catalogResultMeta?.truncated || crawlerResultMeta?.truncated),
      thresholdFallbackMessage: crawlerResultMeta?.thresholdFallbackMessage ?? null,
      diagnostics: catalogResultMeta?.diagnostics ?? crawlerResultMeta?.diagnostics ?? null,
    })
  }, [catalogOpportunities, catalogResultMeta, searchResults, crawlerResultMeta, effectiveProfileId, selectedProfileId, selectedProfile, setFundingResults])

  const isECFProfile =
    (profileForSearch?.medicaid_enrolled || selectedOrg?.medicaid_enrolled) &&
    (profileForSearch?.medicaid_waiver_program === 'ecf_choices' ||
      selectedOrg?.medicaid_waiver_program === 'ecf_choices');

  // Detect required profile attributes that are missing and would reduce match quality.
  const profileMissingFields = useMemo(() => {
    if (!selectedProfile) return []
    const pid = effectiveProfileId || selectedProfileId
    if (pid && !profileDetailForUi && isProfileDetailPending) return []

    const sections = sectionsMap(profileDetailForUi)
    const basic = sections.basic_information || {}
    const locationFocus = sections.location_focus || {}
    const comp = sections.comprehensive_application || {}
    const explicit = getExplicitStateZip(basic, locationFocus, selectedOrg)
    const addressBlob = collectAddressTextForInference(basic, locationFocus, selectedOrg, comp)
    const inferred = inferUsStateZipFromText(addressBlob)
    const missing = []
    const hasState =
      explicit.state ||
      profileForSearch?.state ||
      inferred.state
    const hasZip =
      explicit.zip ||
      profileForSearch?.zip_code ||
      profileForSearch?.zip ||
      profileForSearch?.postal_code ||
      inferred.zip
    if (!hasState && !hasZip) {
      missing.push('location (state or ZIP code)')
    }
    const hasType = selectedProfile.primary_type || profileForSearch?.primary_type
    if (!hasType) {
      missing.push('profile type')
    }
    return missing
  }, [
    selectedProfile,
    profileDetailForUi,
    profileForSearch,
    selectedOrg,
    effectiveProfileId,
    selectedProfileId,
    isProfileDetailPending,
  ])

  // Structured profile gap flags for profile-aware zero-result guidance
  const profileGaps = useMemo(() => {
    if (!selectedProfile) return {}
    const sections = sectionsMap(profileDetailForUi)
    const basic = sections.basic_information || {}
    const locationFocus = sections.location_focus || {}
    const comp = sections.comprehensive_application || {}
    const explicit = getExplicitStateZip(basic, locationFocus, selectedOrg)
    const addressBlob = collectAddressTextForInference(basic, locationFocus, selectedOrg, comp)
    const inferred = inferUsStateZipFromText(addressBlob)
    const hasLocation =
      explicit.state ||
      explicit.zip ||
      profileForSearch?.state ||
      profileForSearch?.zip_code ||
      profileForSearch?.zip ||
      inferred.state ||
      inferred.zip
    const hasEntityType = Boolean(selectedProfile.primary_type || profileForSearch?.primary_type)
    const interests = profileForSearch?.signals?.interests
    const tags = profileForSearch?.tags
    const hasKeywords = (interests && interests.size > 0) || (Array.isArray(tags) && tags.length > 0)
    return {
      missingLocation: !hasLocation,
      missingEntityType: !hasEntityType,
      missingKeywords: !hasKeywords,
    }
  }, [selectedProfile, profileDetailForUi, profileForSearch, selectedOrg])

  const handleFindFunding = async (overrideCategoryQuery, options = {}) => {
    const profileIdToUse = effectiveProfileId ?? selectedProfileId
    const pid = (typeof profileIdToUse === 'string' ? profileIdToUse.trim() : null) || null
    if (!pid) {
      setProfileCompletionHint(null)
      toast({
        variant: 'destructive',
        title: 'Select a profile',
        description: 'Select a profile to search. We use your profile to match funding opportunities.',
      })
      return
    }
    // Strict-by-default: callers may explicitly broaden by passing
    // { strictMinScore: false } or by lowering the slider.
    const effectiveMinMatchScore = Math.min(
      100,
      Math.max(0, Number(options?.minMatchScoreOverride ?? minMatchScore) || 0),
    )
    const strictMinScore = options?.strictMinScore !== false
    // If a discovery run is already in flight, don't stack another fleet +
    // poll loop (each poll re-runs the heavy matcher — stacking them is what
    // overwhelmed the DB). Just refresh the current view and bail.
    if (discoveringRef.current) {
      await queryClient
        .refetchQueries({ queryKey: ['discover-catalog', effectiveProfileId, debouncedMinMatchScore], exact: true })
        .catch(() => {})
      return
    }
    discoveringRef.current = true
    setIsSearching(true)
    setProfileCompletionHint(null)
    setScoreHint(null)
    const rawCategory =
      overrideCategoryQuery !== undefined ? overrideCategoryQuery : categoryQuery
    // Never treat React events / non-strings as a category (onClick={fn} passes the click event).
    const activeCategoryQuery =
      typeof rawCategory === 'string' && rawCategory.trim()
        ? rawCategory.trim()
        : null
    const baseInterests = profileForSearch?.signals?.interests
      ? Array.from(profileForSearch.signals.interests).slice(0, 10)
      : Array.isArray(profileForSearch?.tags)
        ? profileForSearch.tags.slice(0, 10)
        : []
    // Merge category query keywords into interests when browsing by need category
    const mergedInterests = activeCategoryQuery
      ? [...new Set([...activeCategoryQuery.split(/\s+/).filter(Boolean), ...baseInterests])].slice(0, 15)
      : baseInterests
    const itemRequest = profileForSearch ? {
      location: {
        state: profileForSearch?.signals?.location?.state || profileForSearch?.state || null,
        city: profileForSearch?.signals?.location?.city || profileForSearch?.city || null,
        zip: profileForSearch?.signals?.location?.zip || profileForSearch?.zip_code || null,
      },
      interests: mergedInterests,
      demographics: profileForSearch?.signals?.demographics ? Array.from(profileForSearch.signals.demographics).slice(0, 10) : [],
      career_goals: profileForSearch?.sections?.career_goals?.primary_goal || profileForSearch?.career_goal || null,
      category_query: activeCategoryQuery ?? undefined,
    } : null
    try {
      setProfileCompletionHint(null)
      // Show whatever already matches this profile immediately (instant feedback
      // from opportunities already in the catalog), then stream more in as the
      // background fleet finishes. Refetch ONLY the active (current-slider) query
      // — never the whole ['discover-catalog'] family, which would re-run the
      // heavy matcher for every cached slider value at once.
      await queryClient
        .refetchQueries({ queryKey: ['discover-catalog', effectiveProfileId, debouncedMinMatchScore], exact: true })
        .catch(() => {})

      // Dispatch the FULL, profile-aware crawler fleet to the background
      // dispatcher. The server-side relevance selector runs ONLY the crawlers
      // appropriate for THIS profile (local + comprehensive + government always;
      // scholarship/student only for students; health/clinical-trials only with
      // health indicators + consent; foundation/990 for orgs — never mismatched
      // crawlers), and each runs to COMPLETION server-side. No synchronous
      // request to hit the gateway 504, and no time budget that returns partial
      // results — slow-but-complete, using the full profile.
      const dispatch = await discoverAllForProfile({ profileId: pid }).catch((bgErr) => {
        console.warn('[DiscoverGrants] discover-all dispatch failed:', bgErr?.message || bgErr)
        return null
      })
      const enqueued = Number(dispatch?.jobs_enqueued) || 0
      const crawlerTypes = Array.isArray(dispatch?.crawler_types) ? dispatch.crawler_types : []
      setDiscovery({ active: enqueued > 0, enqueued, running: enqueued, crawlerTypes })

      if (enqueued > 0) {
        toast({
          title: 'Searching funding sources matched to your profile',
          description: `Running ${enqueued} relevant crawler${enqueued === 1 ? '' : 's'}${crawlerTypes.length ? ` (${crawlerTypes.slice(0, 6).join(', ')}${crawlerTypes.length > 6 ? '…' : ''})` : ''}. Matches appear below as each finishes — this can take a few minutes.`,
        })
        // Poll: refetch the catalog so new matches stream into the merged list,
        // and watch the job counters until this run's crawlers have drained.
        const start = Date.now()
        let sawRunning = false
        while (Date.now() - start < DISCOVERY_MAX_WAIT_MS) {
          await sleep(DISCOVERY_POLL_MS)
          const status = await fetchCrawlerStatus(pid).catch(() => null)
          await queryClient
            .refetchQueries({ queryKey: ['discover-catalog', effectiveProfileId, debouncedMinMatchScore], exact: true })
            .catch(() => {})
          const running = Number(status?.running) || 0
          if (running > 0) sawRunning = true
          setDiscovery((d) => (d ? { ...d, running } : d))
          // Done once the dispatched jobs have finished (we saw them running and
          // they drained), with a short grace window in case status lags.
          if (running === 0 && (sawRunning || Date.now() - start > 8000)) break
        }
      }

      // Final pass: pull the complete, profile-matched catalog and hand it to the
      // existing pipeline/store logic (auto-add high-confidence matches, populate
      // the FundingResults store, final summary toast). Honors any broadened
      // slider via effectiveMinMatchScore.
      const finalPayload = await fetchCatalogMatches(pid, effectiveMinMatchScore).catch(() => null)
      const rawOpportunities = Array.isArray(finalPayload?.opportunities)
        ? finalPayload.opportunities
        : Array.isArray(finalPayload?.data?.opportunities)
          ? finalPayload.data.opportunities
          : []
      // Frontend hard floor (defense in depth) — honor the slider as a hard floor.
      const opportunities = strictMinScore
        ? rawOpportunities.filter((opp) => {
            const score = Number(opp.match_score ?? opp.match ?? -Infinity)
            return Number.isFinite(score) && score >= effectiveMinMatchScore
          })
        : rawOpportunities
      setScoreHint(finalPayload?.score_hint || null)
      await handleCrawlerResults(opportunities, finalPayload)
    } catch (error) {
      console.error('[DiscoverGrants] Search error:', error)
      const profileHint = getProfileContextIncompleteHint(error)
      if (profileHint) {
        setProfileCompletionHint(profileHint)
        toast({
          title: 'Profile needs a quick update',
          description: profileHint.headline,
        })
        return
      }
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
      setDiscovery(null)
      discoveringRef.current = false
    }
  }

  // Auto-run Discovery when arriving from onboarding with ?autorun=1
  const autorunTriggered = React.useRef(false)
  useEffect(() => {
    if (autorunTriggered.current) return
    if (searchParams.get('autorun') !== '1') return
    if (!effectiveProfileId || isSearching || hasSearched) return
    autorunTriggered.current = true
    handleFindFunding()
  }, [effectiveProfileId, searchParams, isSearching, hasSearched])

  // Declared as a hoisted function declaration (not const arrow) so the
  // earlier handleFindFunding caller and other forward references stay
  // outside the temporal dead zone. Same reasoning for handleAddToPipeline
  // below — both are used in render-time JSX above their lexical position.
  async function handleCrawlerResults(opportunities, responsePayload = null) {
    log.debug('processing crawler results', { count: opportunities.length })
    const resultMeta = normalizeResultMetadata(responsePayload, opportunities)
    setCrawlerResultMeta(resultMeta)
    if (responsePayload && (responsePayload.coverage_plan || responsePayload.coverage_report)) {
      setCoverageInfo({
        plan: responsePayload.coverage_plan ?? null,
        report: responsePayload.coverage_report ?? null,
        outcomes: Array.isArray(responsePayload.coverage_outcomes) ? responsePayload.coverage_outcomes : null,
        summary: responsePayload.coverage_summary ?? null,
        labels: responsePayload.source_labels ?? null,
        crawlerType: responsePayload.crawler_type ?? null,
      })
    }
    
    // Auto-add high-confidence matches (≥70%).
    let addedCount = 0
    let alreadyCount = 0
    let failedCount = 0
    let attempted = 0

    for (const opp of opportunities) {
      const score = Number(opp.match_score ?? opp.match ?? 0);
      if (Number.isFinite(score) && score >= AUTO_ADD_SCORE) {
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

    if (opportunities.length === 0) {
      toast({
        title: 'No results found',
        description: buildZeroResultDescription(profileGaps),
      })
    } else {
      toast({
        title: 'Search complete',
        description: `Found ${opportunities.length} opportunities. Pipeline update: ${addedCount} added, ${alreadyCount} already in pipeline, ${failedCount} failed (from ${attempted} eligible).`,
      })
    }

    // Update search results to show crawler results
    setHasSearched(true)
    setSearchResults(opportunities);

    // Populate the FundingResults store so /FundingResults page displays results after navigation
    const profileIdForStore = effectiveProfileId ?? selectedProfileId
    setFundingResults({
      results: opportunities,
      profileId: profileIdForStore,
      organizationName: selectedProfile?.display_name ?? null,
      organizationId: selectedProfile?.organization_id ?? null,
      ...resultMeta,
    })
  }

  async function handleAddToPipeline(opportunity, { silent = false } = {}) {
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
    const duplicateUrl = opportunity.application_url ?? opportunity.url ?? null
    if (orgId && duplicateUrl) {
      try {
        const existingGrants = await client.entities.Grant.filter({
          organization_id: orgId,
          url: duplicateUrl,
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
          // The server re-scores the authoritative profile/opportunity before
          // pipeline insert, so client-side match fields are intentionally omitted.
          opportunity_data: {
            title: opportunity.title,
            sponsor: opportunity.sponsor,
            deadline: opportunity.deadlineAt || opportunity.deadline,
            application_url: opportunity.application_url ?? null,
            url: opportunity.url ?? null,
            awardMin: opportunity.awardMin || opportunity.amount_min,
            awardMax: opportunity.awardMax || opportunity.amount_max,
            descriptionMd: opportunity.descriptionMd || opportunity.description,
            eligibilityBullets: opportunity.eligibilityBullets || [],
            source: opportunity.source || 'discovery',
            contact_info: opportunity.contact_info || opportunity.contact || null,
            application_method: opportunity.application_method || null,
            applicationNote: opportunity.application_note || opportunity.applicationNote || null,
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
        queryClient.invalidateQueries({ queryKey: ['profiles'], refetchType: 'all' });
        queryClient.invalidateQueries({ queryKey: ['organizations'] });
        useAuthStore.getState().refreshProfiles({ reason: 'new-org-from-grant', force: true });
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
  }

  // --- Next Steps / Suggestions Logic ---
  const suggestions = React.useMemo(() => {
    const items = [];
    if (!selectedProfile) {
      items.push({ id: 'select-profile', icon: User, text: 'Select a profile to get started', detail: 'Choose a profile from the dropdown above so we can match funding opportunities to your needs.' });
      return items;
    }
    const sections = sectionsMap(profileDetailForUi);
    const sectionKeys = Object.keys(sections);
    if (sectionKeys.length < 3) {
      items.push({ id: 'complete-profile', icon: User, text: 'Complete your profile for better matches', detail: 'Adding more details (location, interests, goals) helps us find more relevant funding.' });
    }
    const basic = sections.basic_information || {};
    const lf = sections.location_focus || {};
    const comp = sections.comprehensive_application || {};
    const explicit = getExplicitStateZip(basic, lf, selectedOrg);
    const blob = collectAddressTextForInference(basic, lf, selectedOrg, comp);
    const inferred = inferUsStateZipFromText(blob);
    if (!explicit.state && !explicit.zip && !inferred.state && !inferred.zip) {
      items.push({ id: 'add-location', icon: Lightbulb, text: 'Add your location (state/ZIP) to your profile', detail: 'Location data is critical for finding local funding and community resources near you.' });
    }
    if (searchResults.length === 0) {
      items.push({ id: 'run-crawlers', icon: Search, text: 'Run a search to discover funding opportunities', detail: 'Click "Find Funding Opportunities" to search all sources matched to your profile.' });
    }
    if (searchResults.length > 0) {
      const highMatches = searchResults.filter(r => (r.match_score || r.match || 0) >= GOOD_MATCH_SCORE);
      if (highMatches.length > 0) {
        items.push({ id: 'review-top', icon: CheckCircle2, text: 'Review your top ' + highMatches.length + ' high-match opportunities', detail: 'These opportunities scored 80%+ match with your profile. Consider adding them to your pipeline.' });
      }
      items.push({ id: 'add-pipeline', icon: ArrowRight, text: 'Add promising grants to your pipeline', detail: 'Use the checkboxes to select opportunities, then click Add to Pipeline to track and manage them.' });
    }
    return items.filter(s => !dismissedSuggestions.includes(s.id));
  }, [selectedProfile, profileDetailForUi, selectedOrg, searchResults, dismissedSuggestions]);

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
              {/* Radix Select treats `value=""` as a special "uncontrolled"
                  sentinel and warns when the prop later becomes a real id —
                  pass undefined when nothing is selected so the placeholder
                  renders without flipping controlled/uncontrolled. */}
              <Select
                value={selectedProfileId || undefined}
                onValueChange={(v) => setSelectedProfileId(v ?? '')}
              >
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

            {/* Profile completeness warning */}
            {selectedProfile && profileMissingFields.length > 0 && (
              <Alert className="bg-amber-50 border-amber-300 mb-6">
                <AlertTriangle className="h-4 w-4 text-amber-600" />
                <AlertDescription className="text-amber-800">
                  <strong>Profile incomplete:</strong> Missing {profileMissingFields.join(' and ')}. Without this information, match scores will be lower and results may be less relevant.{' '}
                  <button
                    type="button"
                    className="underline font-medium"
                    onClick={() => navigate(createPageUrl('ProfileDetail', { id: selectedProfile.id }))}
                  >
                    Complete your profile
                  </button>
                </AlertDescription>
              </Alert>
            )}

            {profileCompletionHint && (
              <Alert className="bg-blue-50 border-blue-300 mb-6">
                <AlertTriangle className="h-4 w-4 text-blue-700" />
                <AlertDescription className="text-blue-900">
                  <strong>{profileCompletionHint.headline}</strong>
                  <ul className="list-disc ml-5 mt-2 space-y-1">
                    {profileCompletionHint.checklist.map((item) => (
                      <li key={`profile-completion-${item}`}>{item}</li>
                    ))}
                  </ul>
                  <div className="mt-3">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        if (selectedProfile?.id) {
                          navigate(createPageUrl('ProfileDetail', { id: selectedProfile.id }))
                          return
                        }
                        navigate(createPageUrl('MyProfiles'))
                      }}
                    >
                      Go to Profile -&gt; Save
                    </Button>
                  </div>
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
                onClick={() => void handleFindFunding()}
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

        {/* Zero-result recovery card: shown after a search completes with no results */}
        {hasSearched && searchResults.length === 0 && catalogOpportunities.length === 0 && !isSearching && (
          <Card className="mb-8 border-amber-200 bg-amber-50/50">
            <CardContent className="p-6 space-y-5">
              <div className="flex items-start gap-3">
                <AlertTriangle className="h-6 w-6 shrink-0 text-amber-600 mt-0.5" />
                <div>
                  <h3 className="text-lg font-semibold text-amber-900">No matches yet — let&apos;s fix that</h3>
                  <p className="text-sm text-amber-800 mt-1">{buildZeroResultDescription(profileGaps)}</p>
                </div>
              </div>

              {/* Score threshold suggestion — when matches exist below the slider */}
              {scoreHint && scoreHint.bestScore > 0 && (
                <div className="flex items-center gap-3 rounded-md bg-blue-50 border border-blue-200 p-3">
                  <span className="text-blue-600 text-lg">&#x1F50D;</span>
                  <div className="flex-1 text-sm text-blue-900">
                    <strong>{scoreHint.totalScored}</strong> opportunities were found but scored below your <strong>{minMatchScore}%</strong> threshold (best match: <strong>{scoreHint.bestScore}%</strong>).
                    {' '}
                    <button
                      className="underline font-medium hover:text-blue-700"
                      onClick={() => { setMinMatchScore(scoreHint.suggestedThreshold); }}
                    >
                      Lower to {scoreHint.suggestedThreshold}% to see ~{scoreHint.countAtSuggested} results
                    </button>
                    {' '}then re-run the search.
                  </div>
                </div>
              )}

              {/* Profile gap checklist with direct links */}
              {selectedProfile?.id && (profileGaps.missingLocation || profileGaps.missingEntityType || profileGaps.missingKeywords) && (
                <div className="space-y-2">
                  <p className="text-sm font-medium text-amber-900">Complete these profile fields to improve matches:</p>
                  <ul className="space-y-1.5">
                    {profileGaps.missingLocation && (
                      <li className="flex items-start gap-2 text-sm text-amber-800">
                        <span className="mt-0.5 text-amber-500">&#x25CB;</span>
                        <Link
                          to={createPageUrl("ProfileDetail", { id: selectedProfile.id, section: "basic_information" })}
                          className="underline hover:text-amber-900 font-medium"
                        >
                          Add your location (state or ZIP code)
                        </Link>
                        <span className="text-amber-700">— unlocks local and state-level programs</span>
                      </li>
                    )}
                    {profileGaps.missingEntityType && (
                      <li className="flex items-start gap-2 text-sm text-amber-800">
                        <span className="mt-0.5 text-amber-500">&#x25CB;</span>
                        <Link
                          to={createPageUrl("ProfileDetail", { id: selectedProfile.id, section: "basic_information" })}
                          className="underline hover:text-amber-900 font-medium"
                        >
                          Set your profile type
                        </Link>
                        <span className="text-amber-700">— filters irrelevant programs</span>
                      </li>
                    )}
                    {profileGaps.missingKeywords && (
                      <li className="flex items-start gap-2 text-sm text-amber-800">
                        <span className="mt-0.5 text-amber-500">&#x25CB;</span>
                        <Link
                          to={createPageUrl("ProfileDetail", { id: selectedProfile.id, section: "financial_information" })}
                          className="underline hover:text-amber-900 font-medium"
                        >
                          Add interests or focus areas
                        </Link>
                        <span className="text-amber-700">— improves keyword matching</span>
                      </li>
                    )}
                  </ul>
                </div>
              )}

              {/* Browse by Need categories — grouped */}
              <div>
                <p className="text-sm font-medium text-amber-900 mb-3">Not finding what you need? Browse by category:</p>
                <div className="space-y-3">
                  {NEED_CATEGORY_GROUPS.map((group) => {
                    const cats = CANONICAL_NEED_CATEGORIES.filter((c) => c.group === group.key)
                    if (cats.length === 0) return null
                    return (
                      <div key={group.key}>
                        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">{group.label}</p>
                        <div className="flex flex-wrap gap-1.5">
                          {cats.map((cat) => (
                            <button
                              key={cat.id}
                              type="button"
                              onClick={async () => {
                                setCategoryQuery(cat.query)
                                await handleFindFunding(cat.query, { strictMinScore: true })
                              }}
                              disabled={isSearching || !selectedProfile}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-white border border-amber-300 text-amber-900 hover:bg-amber-100 hover:border-amber-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                              <span>{cat.icon}</span>
                              {cat.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* Reverse-Lookup: Find Funders Like You (for nonprofits, churches, orgs) */}
              {selectedProfile?.id && (
                <ReverseLookup
                  profileId={selectedProfile.id}
                  profileName={selectedProfile.display_name ?? selectedProfile.name}
                />
              )}

              <div className="flex flex-wrap gap-2 pt-1">
                <Button
                  size="sm"
                  onClick={() => {
                    setMinMatchScore(0)
                    setCategoryQuery(null)
                    void handleFindFunding(null, { minMatchScoreOverride: 0, strictMinScore: true })
                  }}
                  disabled={isSearching || !selectedProfile}
                  className="bg-amber-600 hover:bg-amber-700 text-white"
                >
                  {isSearching ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                      Searching…
                    </>
                  ) : (
                    'Try Broader Search'
                  )}
                </Button>
                {selectedProfile?.id && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-amber-400 text-amber-900 hover:bg-amber-100 whitespace-nowrap"
                    onClick={() => navigate(createPageUrl('ProfileDetail', { id: selectedProfile.id }))}
                  >
                    Update Profile
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2 border-purple-300 text-purple-700 hover:bg-purple-50 whitespace-nowrap"
                  onClick={() => {
                    const msg = profileGaps.missingLocation
                      ? "Help me find grants — I haven't set my location yet"
                      : "Help me improve my profile to get better grant matches"
                    openAnyaPanel({ prefillMessage: msg })
                  }}
                >
                  <MessageCircle className="h-4 w-4" />
                  Get Help from Anya
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Mission Goal 7 — Search coverage panel: which source families GrantFlow
            planned, queried, and missed for this profile + strategy. Renders above
            the results so users can trust why they see what they see. */}
        {coverageInfo && (coverageInfo.plan || coverageInfo.report) ? (
          <SearchCoveragePanel
            coveragePlan={coverageInfo.plan}
            coverageReport={coverageInfo.report}
            coverageOutcomes={coverageInfo.outcomes}
            coverageSummary={coverageInfo.summary}
            sourceLabels={coverageInfo.labels}
            crawlerType={coverageInfo.crawlerType}
          />
        ) : null}

        {/* Live discovery progress: the profile-aware crawler fleet runs in the
            background; matches stream in below as each crawler finishes. */}
        {discovery?.active && (
          <Alert className="mb-4 border-blue-200 bg-blue-50">
            <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
            <AlertDescription className="text-blue-900">
              Searching {discovery.enqueued} funding source{discovery.enqueued === 1 ? '' : 's'} matched to your profile
              {Array.isArray(discovery.crawlerTypes) && discovery.crawlerTypes.length > 0
                ? ` (${discovery.crawlerTypes.slice(0, 6).join(', ')}${discovery.crawlerTypes.length > 6 ? '…' : ''})`
                : ''}
              {typeof discovery.running === 'number' && discovery.running > 0
                ? ` — ${discovery.running} still running.`
                : ' — wrapping up.'}{' '}
              New matches appear below as each finishes; this can take a few minutes.{' '}
              <strong>You can leave this page</strong> — the search keeps running on our servers and results are saved to your catalog and pipeline automatically.
            </AlertDescription>
          </Alert>
        )}

        {/* Results Display: catalog matches (real grants from DB) + crawler results (directories/live crawl), deduped */}
        {((catalogOpportunities.length > 0) || searchResults.length > 0) && (
          <div ref={resultsRef}>
            <SearchResults
              results={(() => {
                const seen = new Set()
                const merged = []
                for (const opp of catalogOpportunities) {
                  const key = opp.id ?? `${opp.title}|${opp.sponsor ?? ''}`
                  if (seen.has(key)) continue
                  seen.add(key)
                  merged.push(opp)
                }
                for (const opp of searchResults) {
                  const key = opp.id ?? opp.url ?? `${opp.title}|${opp.sponsor ?? ''}`
                  if (seen.has(key)) continue
                  seen.add(key)
                  merged.push(opp)
                }
                return merged.sort((a, b) => (b.match_score ?? b.match ?? 0) - (a.match_score ?? a.match ?? 0))
              })()}
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
