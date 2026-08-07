import React, { useMemo, useState, useEffect, useCallback } from 'react';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { getProfile, listProfiles } from '@/api/profiles';
import { listProfileFundingSources } from '@/api/matching';
import client, { apiFetch } from '@/api/client';
import { discoverAllForProfile, fetchCrawlerStatus } from '@/api/crawlers';
import { createPageUrl } from '@/utils';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Loader2, Search, User, Lightbulb, ArrowRight, CheckCircle2, AlertTriangle, MessageCircle, Sparkles, StopCircle } from 'lucide-react';
import HelpTip from '@/components/help/HelpTip';
import SearchResults from '@/components/discovery/SearchResults';
import SearchCoveragePanel from '@/components/discovery/SearchCoveragePanel';
import SourceLaneCoverage from '@/components/discovery/SourceLaneCoverage';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/use-toast';
import { useGuidedTourStore } from '@/stores/guidedTourStore';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import { useAuthStore } from '@/stores/authStore';
import { createLogger } from '@/utils/logger';
import { CANONICAL_NEED_CATEGORIES, NEED_CATEGORY_GROUPS } from '@/constants/needCategories';
import ReverseLookup from '@/components/discovery/ReverseLookup';
import { getProfileContextIncompleteHint } from '@/components/discovery/profileContextIncompleteUi';
import { openAnyaPanel } from '@/lib/anyaPanel';
import { buildZeroResultDescription } from '@/components/discovery/discoveryToasts';
import {
  inferUsStateZipFromText,
  getExplicitStateZip,
  collectAddressTextForInference,
} from '@/utils/inferLocationFromAddress';
import { useFundingResultsStore } from '@/stores/fundingResultsStore';
import {
  AUTO_ADD_SCORE,
  GOOD_MATCH_SCORE,
  MIN_SCORE_SLIDER_MAX,
  minScoreBandLabel,
  translateLegacyMinScore,
} from '@/lib/matchDisplayThresholds';
import MatchScoreGuidanceBand from '@/components/discovery/MatchScoreGuidanceBand';
import { dedupeFundingResults } from '@/utils/fundingDedupe';
import {
  selectVisibleCatalog,
  mergeDiscoveryResults,
  buildResultsReconciliation,
  partitionDiscoverResults,
} from '@/pages/discoverResultsMerge';
import { keepDiscoverCatalogRow, isDirectoryDiscoverRow } from '@/lib/discoverCatalogKeep';

// Discovery is now asynchronous: a click dispatches the profile-aware crawler
// fleet to the background dispatcher (which runs each relevant crawler to
// completion \u2014 no synchronous request to hit Vercel's ~30s proxy 504, and no
// time-budget that returns partial/shortcut results), then the UI polls the
// catalog so matches stream in as crawlers finish. Slow-but-complete by design.
const DISCOVERY_POLL_MS = 12000         // how often to refetch catalog + status (gentle: heavy query)
const DISCOVERY_MAX_WAIT_MS = 5 * 60 * 1000 // stop polling after 5 min (jobs keep running server-side)

// Default minimum match score \u2014 the pipeline bar on the data-point scale
// (mirrors backend DEFAULT_MIN_SCORE). The retired need-anchored default of 75
// is beyond this scale's max real score (~58) and would return nothing.
const DEFAULT_MIN_MATCH_SCORE = AUTO_ADD_SCORE

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Clamp a match-score value to the live slider range (0..MIN_SCORE_SLIDER_MAX),
 * falling back to the intended default when the value is non-finite \u2014 NOT 0
 * (which would silently widen the search to the broadest possible floor and
 * return thousands of low-quality matches). Old-scale values (>30, e.g. a
 * stale 85) are translated to their data-point-scale band first so they can
 * never starve results.
 */
function clampMinScore(value, fallback = DEFAULT_MIN_MATCH_SCORE) {
  const n = translateLegacyMinScore(Number(value))
  const base = Number.isFinite(n) ? n : fallback
  return Math.min(MIN_SCORE_SLIDER_MAX, Math.max(0, base))
}

/**
 * Fetch profile-matched catalog opportunities. Shared by the live discover
 * query and the discovery poll loop.
 *
 * The slider is sent as `min_score` (backend `qualifiesForDisplay` floor).
 * Zero-result recovery remains enabled on purpose (mission rule: never return
 * empty when scored candidates exist). Pass `no_fallback=1` only from debug
 * tooling — Discover never disables recovery.
 */
async function fetchCatalogMatches(profileId, minMatchScore) {
  if (!profileId) return { opportunities: [] }
  const ms = clampMinScore(minMatchScore)
  const params = new URLSearchParams({
    min_score: String(ms),
    limit: '2000',
    skip_readiness_check: '1',
    // Keep pipeline members VISIBLE but flagged (`already_in_pipeline: true`)
    // instead of silently dropping them — the card renders "Already in
    // pipeline" so the operator sees why an item isn't addable (#5).
    pipeline: 'annotate',
  })
  return apiFetch(`/api/matching/profile/${profileId}/opportunities?${params.toString()}`)
}

/**
 * Resolve profile_id: 1) explicit UI selection, 2) URL ?profile_id=,
 * 3) app active profile when it is a real profile, 4) null.
 * Does NOT auto-select first profile (product blocks add-to-pipeline without explicit choice).
 */
function resolveSelectedProfileId(selectedProfileId, searchParams, profiles, activeProfileId) {
  const fromUi = typeof selectedProfileId === 'string' ? selectedProfileId.trim() : null
  if (fromUi) return fromUi
  const fromUrl = searchParams?.get?.('profile_id') ?? null
  const validProfiles = Array.isArray(profiles) ? profiles : []
  if (fromUrl) {
    const valid = validProfiles.some((p) => String(p?.id) === String(fromUrl))
    return valid ? fromUrl : null
  }
  const fromActive =
    typeof activeProfileId === 'string' && activeProfileId && activeProfileId !== '__admin__'
      ? activeProfileId
      : null
  if (fromActive && validProfiles.some((p) => String(p?.id) === String(fromActive))) {
    return fromActive
  }
  return null
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

/**
 * Normalize a profile's interests signal (which may be a Set, an array, or a
 * plain object after JSON round-trips) into a plain array of keyword strings.
 */
function interestsToArray(interests) {
  if (!interests) return []
  if (interests instanceof Set) return Array.from(interests)
  if (Array.isArray(interests)) return interests
  if (typeof interests === 'object') {
    // Plain object after JSON serialization: use its values when they look like
    // keywords, otherwise its keys.
    const values = Object.values(interests)
    if (values.length > 0 && values.every((v) => typeof v === 'string')) return values
    return Object.keys(interests)
  }
  return []
}

const SEARCH_SIGNAL_KEY_RX =
  /(need|goal|interest|focus|mission|program|service|condition|diagnos|school|college|university|student|education|academic|degree|major|career|project|business|farm|church|veteran|military|disability|medical|health|housing|food|utility|rent|transport|equipment|startup|essay|narrative|description|challenge|barrier|eligibility|scholarship|benefit|assistance)/i

function hasUsefulSearchSignal(value, inheritedKey = '', depth = 0) {
  if (value === null || value === undefined || depth > 5) return false
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return false
    return SEARCH_SIGNAL_KEY_RX.test(inheritedKey) && text.length >= 2
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return SEARCH_SIGNAL_KEY_RX.test(inheritedKey)
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasUsefulSearchSignal(item, inheritedKey, depth + 1))
  }
  if (typeof value === 'object') {
    return Object.entries(value).some(([key, child]) =>
      hasUsefulSearchSignal(child, `${inheritedKey}.${key}`, depth + 1),
    )
  }
  return false
}

function profileHasSearchSignal(profileDetail, profileForSearch, selectedProfile) {
  const interests = interestsToArray(profileForSearch?.signals?.interests)
  if (interests.length > 0) return true
  if (Array.isArray(profileForSearch?.tags) && profileForSearch.tags.length > 0) return true
  if (hasUsefulSearchSignal(sectionsMap(profileDetail))) return true
  return hasUsefulSearchSignal({
    primary_type: selectedProfile?.primary_type || profileForSearch?.primary_type,
    display_name: selectedProfile?.display_name || profileForSearch?.display_name,
  })
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
// explain what was searched/expanded and what profile info would help \u2014 instead
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

/**
 * Architecture P1: friendly, dismissible "Improve your matches" card.
 *
 * Renders the backend's `profile_field_prompts` ({ field, label, why,
 * section_key }) as encouraging nudges that deep-link to the relevant profile
 * section. Two layouts:
 *   - variant="prominent": full card for the discovery-pending empty state.
 *   - variant="banner": compact strip shown above results otherwise.
 * Never a gate \u2014 purely additive guidance.
 */
function ImproveMatchesCard({ prompts, profileId, onDismiss, variant = 'banner' }) {
  if (!Array.isArray(prompts) || prompts.length === 0 || !profileId) return null

  const promptLink = (prompt) =>
    prompt.section_key
      ? createPageUrl('ProfileDetail', { id: profileId, section: prompt.section_key })
      : createPageUrl('ProfileDetail', { id: profileId })

  if (variant === 'prominent') {
    return (
      <Card className="mb-6 border-emerald-200 bg-emerald-50/60">
        <CardContent className="p-5 space-y-4">
          <div className="flex items-start gap-3">
            <Sparkles className="h-6 w-6 shrink-0 text-emerald-600 mt-0.5" />
            <div className="flex-1">
              <h3 className="text-base font-semibold text-emerald-900">Improve your matches</h3>
              <p className="text-sm text-emerald-800 mt-0.5">
                Add a few details to your profile and we&apos;ll find more - and more relevant - funding for you.
              </p>
            </div>
            <button
              type="button"
              onClick={onDismiss}
              className="text-xs text-emerald-700 hover:text-emerald-900 underline shrink-0"
            >
              Dismiss
            </button>
          </div>
          <div className="space-y-2">
            {prompts.map((prompt) => (
              <Link
                key={prompt.field}
                to={promptLink(prompt)}
                className="group flex items-start gap-3 rounded-lg border border-emerald-200 bg-white/70 p-3 hover:border-emerald-400 hover:bg-white transition-colors"
              >
                <CheckCircle2 className="w-4 h-4 mt-0.5 text-emerald-500 shrink-0" />
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-slate-900">{prompt.label}</span>
                  <p className="text-xs text-slate-600 mt-0.5 leading-snug">{prompt.why}</p>
                </div>
                <ArrowRight className="w-4 h-4 mt-0.5 text-emerald-400 group-hover:text-emerald-600 shrink-0" />
              </Link>
            ))}
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="mb-4 border-emerald-200 bg-emerald-50/50">
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <Sparkles className="h-5 w-5 shrink-0 text-emerald-600 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold text-emerald-900">Improve your matches</span>
              <span className="text-xs text-emerald-700">
                Add these to unlock more funding:
              </span>
            </div>
            <div className="flex flex-wrap gap-2 mt-2">
              {prompts.map((prompt) => (
                <Link
                  key={prompt.field}
                  to={promptLink(prompt)}
                  title={prompt.why}
                  className="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-white px-3 py-1 text-xs font-medium text-emerald-800 hover:border-emerald-500 hover:bg-emerald-50 transition-colors"
                >
                  {prompt.label}
                  <ArrowRight className="w-3 h-3" />
                </Link>
              ))}
            </div>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="text-xs text-emerald-700 hover:text-emerald-900 underline shrink-0"
          >
            Dismiss
          </button>
        </div>
      </CardContent>
    </Card>
  )
}

export default function DiscoverGrants() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  // Minimum-match-score slider default. On the data-point scale the pipeline bar
  // is AUTO_ADD_SCORE (8); real matches land ~5\u201325, so the default MUST stay low
  // or mid-band matches are silently hidden (Gilbert saw "Score \u2265 19" from the
  // retired 0\u2013100 scale). clampMinScore migrates any stale legacy value (>30)
  // down to a live-scale band so an inflated stored default can never starve.
  const [minMatchScore, setMinMatchScore] = useState(() => clampMinScore(DEFAULT_MIN_MATCH_SCORE));
  // Last catalog result set that loaded SUCCESSFULLY. Rendered whenever the live
  // catalog query is mid-error / mid-load so a transient 503 (catalog_busy) from
  // a concurrent crawl \u2014 or an in-flight live run \u2014 can never blank the stored
  // matches (the "20 matched, 2 shown" collapse). Reset on profile change.
  const [lastGoodCatalog, setLastGoodCatalog] = useState([]);
  // "N sources with matches" reported by the coverage panel, lifted up so the
  // results view can reconcile it honestly against the count actually rendered.
  const [matchedSourceCount, setMatchedSourceCount] = useState(0);
  // Debounce the slider value used to KEY the catalog query so dragging the
  // slider through intermediate values doesn't fire a heavy 2000-row matching
  // query per step (that thundering herd saturated the DB \u2192 503/504 cascade).
  const [debouncedMinMatchScore, setDebouncedMinMatchScore] = useState(DEFAULT_MIN_MATCH_SCORE);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedMinMatchScore(minMatchScore), 450);
    return () => clearTimeout(t);
  }, [minMatchScore]);
  // Guard so repeated "Find Funding" clicks don't stack multiple poll loops /
  // re-dispatch the crawler fleet concurrently (each poll re-runs the heavy
  // matcher; stacking them is what overwhelmed the DB).
  const discoveringRef = React.useRef(false);
  // Cancellation token for the poll loop: bumped whenever the profile changes
  // or the component unmounts so any in-flight poll loop stops touching state
  // and stops issuing stale-keyed heavy matcher queries.
  const pollCancelRef = React.useRef({ cancelled: false, token: 0 });
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [profileCompletionHint, setProfileCompletionHint] = useState(null)
  // Architecture P1: lets the user dismiss the "Improve your matches" prompts.
  const [improvePromptsDismissed, setImprovePromptsDismissed] = useState(false)
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

  // Guided first-cycle tour: register these already-existing refs as spotlight
  // targets (harmless no-op outside the tour) for the 'discover-intro' and
  // 'discover-crawl'/'discover-add' steps.
  useEffect(() => {
    const { registerTarget, unregisterTarget } = useGuidedTourStore.getState()
    registerTarget('discover.searchButton', searchActionsRef)
    registerTarget('discover.resultsPanel', resultsRef)
    return () => {
      unregisterTarget('discover.searchButton')
      unregisterTarget('discover.resultsPanel')
    }
  }, [])
  const [dismissedSuggestions, setDismissedSuggestions] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('grantflow:dismissed-suggestions') || '[]');
    } catch { return []; }
  });
  
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const log = React.useMemo(() => createLogger('DiscoverGrantsPage'), [])
  const setFundingResults = useFundingResultsStore((s) => s.setResults)
  const { isAuthenticated, accessToken, sessionExpired, activeProfileId } = useAuthStore((state) => ({
    isAuthenticated: state.isAuthenticated,
    accessToken: state.accessToken,
    sessionExpired: state.sessionExpired,
    activeProfileId: state.activeProfileId,
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
    () => resolveSelectedProfileId(selectedProfileId, searchParams, profiles, activeProfileId),
    [selectedProfileId, searchParams, profiles, activeProfileId]
  );

  useEffect(() => {
    const urlProfileId = searchParams.get('profile_id')
    if (!urlProfileId || profiles.length === 0) return
    const valid = profiles.some((p) => String(p?.id) === String(urlProfileId))
    if (valid && !selectedProfileId) {
      setSelectedProfileId(urlProfileId)
    }
  }, [searchParams, profiles, selectedProfileId])

  useEffect(() => {
    if (selectedProfileId || searchParams.get('profile_id') || !effectiveProfileId) return
    setSelectedProfileId(effectiveProfileId)
  }, [effectiveProfileId, searchParams, selectedProfileId])

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
        const lastProfile =
          localStorage.getItem('grantflow:discover-last-profile') ||
          localStorage.getItem('grantflow:last-profile-detail-id');
        // Normalize comparison: stored id is a string, profile ids may be numeric.
        if (lastProfile && profiles.some((p) => String(p?.id) === String(lastProfile))) {
          setSelectedProfileId(lastProfile);
        }
      } catch { /* ignore storage errors */ }
    }
  }, [profiles, searchParams, selectedProfileId]);

  // On unmount, cancel any in-flight poll loop.
  useEffect(() => {
    return () => {
      pollCancelRef.current = { cancelled: true, token: pollCancelRef.current.token + 1 }
    }
  }, [])


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
    profiles.find((p) => String(p?.id) === String(effectiveProfileId || selectedProfileId)),
    [profiles, effectiveProfileId, selectedProfileId]
  );

  const selectedOrg = useMemo(
    () =>
      selectedProfile?.organization_id
        ? organizations.find((o) => String(o?.id) === String(selectedProfile.organization_id))
        : null,
    [organizations, selectedProfile],
  );

  // Clear stale results and invalidate caches whenever the effective profile changes.
  // Also bump the poll-loop cancellation token so any in-flight poll for the
  // previous profile stops touching state / issuing stale-keyed queries.
  useEffect(() => {
    pollCancelRef.current = { cancelled: true, token: pollCancelRef.current.token + 1 }
    setSearchResults([]);
    setLastGoodCatalog([]);
    setMatchedSourceCount(0);
    setCrawlerResultMeta(null);
    setCoverageInfo(null);
    setHasSearched(false);
    setProfileCompletionHint(null);
    setFundingResults({
      results: [],
      profileId: effectiveProfileId ?? selectedProfileId ?? null,
      organizationName: selectedProfile?.display_name ?? null,
      organizationId: selectedProfile?.organization_id ?? null,
      returned: 0,
      totalFound: 0,
    })
    queryClient.invalidateQueries({ queryKey: ['discover-catalog'] });
    queryClient.invalidateQueries({ queryKey: ['discover-profile'] });
  }, [
    effectiveProfileId,
    selectedProfileId,
    selectedProfile?.display_name,
    selectedProfile?.organization_id,
    queryClient,
    setFundingResults,
  ]);

  // Guard against stale profileDetail from a previously-selected profile.
  // effectiveProfileId is the authoritative identifier; selectedProfileId is the fallback
  // when effectiveProfileId hasn't resolved yet (e.g., URL param not set).
  const profileDetailMatchesCurrent = Boolean(profileDetailForUi);
  const profileForSearch = profileDetailForUi ?? selectedOrg ?? selectedProfile;

  // Catalog match: real funding opportunities from DB, scored by profile needs (relatable grants, not only directory links)
  const {
    data: catalogMatchResponse,
    isSuccess: catalogIsSuccess,
    isFetching: catalogIsFetching,
  } = useQuery({
    // Keyed by the DEBOUNCED slider value \u2014 one query per settled value, not per
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
    // a retryable 503 (catalog_busy) or 504s. Retry \u2014 but SPARINGLY with long
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

  const catalogPayload = useMemo(() => {
    const payload = catalogMatchResponse?.data ?? catalogMatchResponse ?? {}
    const activeId = effectiveProfileId ? String(effectiveProfileId) : null
    const payloadProfileId =
      payload?.profile_id ??
      payload?.profileId ??
      payload?.profile?.id ??
      null
    if (activeId && payloadProfileId && String(payloadProfileId) !== activeId) {
      return {}
    }
    return payload
  }, [catalogMatchResponse, effectiveProfileId])

  const catalogOpportunities = useMemo(() => {
    const rows = catalogPayload?.opportunities ?? []
    if (!Array.isArray(rows)) return []
    // Slider is a preferred floor for undecided/REVIEW rows. Backend ACCEPT and
    // directory/referral rows must stay visible — "found but not displayed" is
    // a bug. Recovered/relaxed rows also survive when the backend flagged them.
    const minScoreFloor = clampMinScore(debouncedMinMatchScore)
    const recoveryApplied = Boolean(catalogPayload?.relaxation?.applied)
    return dedupeFundingResults(rows
      .filter((opp) => keepDiscoverCatalogRow(opp, minScoreFloor, recoveryApplied))
      .map((opp) => ({
        id: opp.id,
        funding_opportunity_id: opp.funding_opportunity_id,
        opportunity_id: opp.opportunity_id,
        source_id: opp.source_id,
        fingerprint: opp.fingerprint,
        canonical_opportunity_key: opp.canonical_opportunity_key,
        title: opp.title,
        program_name: opp.title,
        sponsor: opp.sponsor || opp.funder,
        application_url: opp.application_url ?? opp.apply_url ?? null,
        source_url: opp.source_url ?? opp.url ?? null,
        url: opp.application_url ?? opp.apply_url ?? opp.source_url ?? opp.url,
        deadline: opp.deadline,
        deadlineAt: opp.deadline,
        description: opp.description,
        descriptionMd: opp.description,
        match_score: opp.match_score,
        match: opp.match_score,
        match_decision: opp.match_decision ?? opp.decision ?? null,
        opportunity_kind: opp.opportunity_kind ?? opp.kind ?? null,
        matched_fields: opp.match_reasons ?? [],
        matchReasons: opp.match_reasons ?? [],
        source: opp.source || 'catalog',
        record_origin: opp.record_origin ?? null,
        usable_for_housing: opp.usable_for_housing ?? false,
        refund_potential: opp.refund_potential ?? false,
        funding_category: opp.funding_category ?? null,
        is_directory: Boolean(opp.is_directory) || isDirectoryDiscoverRow(opp),
        threshold_relaxed: opp.threshold_relaxed ?? false,
        eligibility_relaxed: opp.eligibility_relaxed ?? false,
        geo_expanded: opp.geo_expanded ?? false,
      })))
  }, [catalogPayload, debouncedMinMatchScore])

  const catalogResultMeta = useMemo(() => {
    return normalizeResultMetadata(catalogPayload, catalogOpportunities)
  }, [catalogPayload, catalogOpportunities])

  // Feature A: the matching endpoint returns discovery_pending:true when this
  // profile has never had discovery run. We then show a friendly run-discovery
  // empty state instead of a blank/zero list \u2014 and never imply "no matches".
  const discoveryPending = useMemo(() => {
    return Boolean(catalogPayload?.discovery_pending)
  }, [catalogPayload])

  // Feature B: data-driven guidance band. score_histogram is an array of
  // { min, max, count, top_source } buckets across the 0\u201380 range. Absent on
  // older responses \u2014 the band degrades gracefully (hidden).
  const scoreHistogram = useMemo(() => {
    const buckets = catalogPayload?.score_histogram
    return Array.isArray(buckets) ? buckets : []
  }, [catalogPayload])

  // Fallback "lower your threshold" hint derived from the score histogram, for
  // the common case where matches exist BELOW the slider floor but the backend
  // attached no precise score_hint (that only rides along with crawler results).
  // Without it the zero-result view was a dead end even though the source list
  // reported sub-threshold matches.
  const subThresholdHint = useMemo(() => {
    let belowCount = 0
    let suggested = null
    for (const b of scoreHistogram) {
      const min = Number(b?.min)
      const count = Number(b?.count) || 0
      if (!Number.isFinite(min) || count <= 0) continue
      if (min < minMatchScore) {
        belowCount += count
        // The start of the highest non-empty bucket below the floor reveals the
        // strongest currently-hidden matches when the user lowers to it.
        if (suggested === null || min > suggested) suggested = min
      }
    }
    if (belowCount <= 0 || suggested === null) return null
    return { belowCount, suggested }
  }, [scoreHistogram, minMatchScore])

  // Architecture P1: high-value profile fields that, if filled, would unlock or
  // improve this profile's matches. Surfaced as encouraging prompts (never a
  // gate). Present in both the discovery_pending and the normal response.
  const profileFieldPrompts = useMemo(() => {
    const prompts = catalogPayload?.profile_field_prompts
    return Array.isArray(prompts) ? prompts : []
  }, [catalogPayload])

  const { data: profileFundingSources } = useQuery({
    queryKey: ['discover-profile-funding-sources', effectiveProfileId],
    queryFn: () => listProfileFundingSources(effectiveProfileId, { minScore: 0 }),
    enabled: authReady && Boolean(effectiveProfileId),
    staleTime: 30_000,
  })

  const profileFundingSourceCount = useMemo(() => {
    const n = Number(profileFundingSources?.total)
    return Number.isFinite(n) ? n : 0
  }, [profileFundingSources])

  // Capture the last SUCCESSFUL catalog result so a later transient error or an
  // in-flight live run cannot blank the stored matches. Only a real success
  // (isSuccess && not still fetching) updates it — an empty success legitimately
  // clears it (the user raised the score floor).
  useEffect(() => {
    if (catalogIsSuccess && !catalogIsFetching) {
      setLastGoodCatalog(catalogOpportunities)
    }
  }, [catalogIsSuccess, catalogIsFetching, catalogOpportunities])

  // The catalog list to actually render: fresh success replaces; error/loading
  // keeps the last good set (profile-type-agnostic — no branching on primary_type).
  const visibleCatalogOpportunities = useMemo(
    () =>
      selectVisibleCatalog({
        hasFreshSuccess: catalogIsSuccess,
        fresh: catalogOpportunities,
        lastGood: lastGoodCatalog,
      }),
    [catalogIsSuccess, catalogOpportunities, lastGoodCatalog],
  )

  const combinedOpportunities = useMemo(
    () => mergeDiscoveryResults(visibleCatalogOpportunities, searchResults),
    [visibleCatalogOpportunities, searchResults],
  )

  const discoverPartition = useMemo(
    () => partitionDiscoverResults(combinedOpportunities),
    [combinedOpportunities],
  )

  // Awardable first, directories second — same honesty as ProfileFundingSourcesCard.
  const displayOpportunities = useMemo(
    () => [...discoverPartition.awardable, ...discoverPartition.directories],
    [discoverPartition],
  )

  // Honest reconciliation between the coverage panel's "N sources with matches"
  // and what is actually on screen, so a silent "20 matched / 2 shown" can't
  // recur. Below-floor count comes from the score histogram (subThresholdHint).
  // Headline "shown" is AWARDABLE only — directories never inflate apply-to counts.
  const resultsReconciliation = useMemo(
    () =>
      buildResultsReconciliation({
        shownCount: discoverPartition.awardableCount,
        matchedSourceCount,
        belowFloorCount: subThresholdHint?.belowCount ?? 0,
        minScore: minMatchScore,
        awardableCount: discoverPartition.awardableCount,
        directoryCount: discoverPartition.directoryCount,
      }),
    [discoverPartition, matchedSourceCount, subThresholdHint, minMatchScore],
  )

  // Guided first-cycle tour: advance past the 'discover-crawl' step the
  // moment real results first appear.
  useEffect(() => {
    if (combinedOpportunities.length > 0) {
      useGuidedTourStore.getState().reportCompletion('discover-crawl')
    }
  }, [combinedOpportunities.length])

  // Guided first-cycle tour: a FINISHED search with zero matches must not
  // strand the tour on its event-gated discovery steps (there is nothing to
  // wait for and nothing to add) — unblock them with an honest note instead.
  // reportCompletion above still wins if matches arrive on a later search.
  useEffect(() => {
    if (!hasSearched || isSearching || combinedOpportunities.length > 0) return
    const { unblockStep } = useGuidedTourStore.getState()
    unblockStep(
      'discover-crawl',
      "This search didn't find matches yet — that happens, and it's not the end of the road. You can keep going.",
    )
    unblockStep(
      'discover-add',
      'Nothing to add just yet — continue the tour, then search again after adding more to your profile.',
    )
  }, [hasSearched, isSearching, combinedOpportunities.length])

  // Keep FundingResults store in sync with the combined view so /FundingResults
  // always displays whatever the user last saw on DiscoverGrants.
  useEffect(() => {
    const profileIdForStore = effectiveProfileId ?? selectedProfileId
    if (!profileIdForStore) return
    setFundingResults({
      results: combinedOpportunities,
      profileId: profileIdForStore,
      organizationName: selectedProfile?.display_name ?? null,
      organizationId: selectedProfile?.organization_id ?? null,
      // Apply-to count maps 1:1 to awardable; directories stay in results but do
      // not inflate returned/totalFound (locator rule + assessment item 6).
      returned: discoverPartition.awardableCount,
      totalFound: discoverPartition.awardableCount,
      directoryCount: discoverPartition.directoryCount,
      totalScored: catalogResultMeta?.totalScored ?? null,
      truncated: Boolean(catalogResultMeta?.truncated || crawlerResultMeta?.truncated),
      thresholdFallbackMessage: crawlerResultMeta?.thresholdFallbackMessage ?? null,
      diagnostics: catalogResultMeta?.diagnostics ?? crawlerResultMeta?.diagnostics ?? null,
    })
  }, [combinedOpportunities, discoverPartition, catalogResultMeta, crawlerResultMeta, effectiveProfileId, selectedProfileId, selectedProfile, setFundingResults])

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
    const interestsArr = interestsToArray(profileForSearch?.signals?.interests)
    const tags = profileForSearch?.tags
    const hasKeywords =
      interestsArr.length > 0 ||
      (Array.isArray(tags) && tags.length > 0) ||
      profileHasSearchSignal(profileDetailForUi, profileForSearch, selectedProfile)
    return {
      missingLocation: !hasLocation,
      missingEntityType: !hasEntityType,
      missingKeywords: !hasKeywords,
    }
  }, [selectedProfile, profileDetailForUi, profileForSearch, selectedOrg])

  const handleFindFunding = useCallback(async (overrideCategoryQuery, options = {}) => {
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
    const effectiveMinMatchScore = clampMinScore(
      options?.minMatchScoreOverride ?? minMatchScore,
      minMatchScore,
    )
    const strictMinScore = options?.strictMinScore !== false
    // If a discovery run is already in flight, don't stack another fleet +
    // poll loop (each poll re-runs the heavy matcher \u2014 stacking them is what
    // overwhelmed the DB). Just refresh the current view and bail.
    if (discoveringRef.current) {
      await queryClient
        .refetchQueries({ queryKey: ['discover-catalog', effectiveProfileId, debouncedMinMatchScore], exact: true })
        .catch(() => {})
      return
    }
    discoveringRef.current = true
    // Establish a fresh cancellation token for this run's poll loop.
    const runToken = pollCancelRef.current.token + 1
    pollCancelRef.current = { cancelled: false, token: runToken }
    const isCancelled = () => pollCancelRef.current.cancelled || pollCancelRef.current.token !== runToken
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
    const baseInterests = (() => {
      const arr = interestsToArray(profileForSearch?.signals?.interests)
      if (arr.length > 0) return arr.slice(0, 10)
      return Array.isArray(profileForSearch?.tags) ? profileForSearch.tags.slice(0, 10) : []
    })()
    // Merge category query keywords into interests when browsing by need category
    const mergedInterests = activeCategoryQuery
      ? [...new Set([...activeCategoryQuery.split(/\s+/).filter(Boolean), ...baseInterests])].slice(0, 15)
      : baseInterests
    const demographicsArr = (() => {
      const d = profileForSearch?.signals?.demographics
      if (d instanceof Set) return Array.from(d).slice(0, 10)
      if (Array.isArray(d)) return d.slice(0, 10)
      return []
    })()
    const itemRequest = profileForSearch ? {
      location: {
        state: profileForSearch?.signals?.location?.state || profileForSearch?.state || null,
        city: profileForSearch?.signals?.location?.city || profileForSearch?.city || null,
        zip: profileForSearch?.signals?.location?.zip || profileForSearch?.zip_code || null,
      },
      interests: mergedInterests,
      demographics: demographicsArr,
      career_goals: profileForSearch?.sections?.career_goals?.primary_goal || profileForSearch?.career_goal || null,
      category_query: activeCategoryQuery ?? undefined,
    } : null
    try {
      setProfileCompletionHint(null)
      // Show whatever already matches this profile immediately (instant feedback
      // from opportunities already in the catalog), then stream more in as the
      // background fleet finishes. Refetch ONLY the active (current-slider) query
      // \u2014 never the whole ['discover-catalog'] family, which would re-run the
      // heavy matcher for every cached slider value at once.
      await queryClient
        .refetchQueries({ queryKey: ['discover-catalog', effectiveProfileId, debouncedMinMatchScore], exact: true })
        .catch(() => {})

      // Dispatch the FULL, profile-aware crawler fleet to the background
      // dispatcher. The server-side relevance selector runs ONLY the crawlers
      // appropriate for THIS profile (local + comprehensive + government always;
      // scholarship/student only for students; health/clinical-trials only with
      // health indicators + consent; foundation/990 for orgs \u2014 never mismatched
      // crawlers), and each runs to COMPLETION server-side. No synchronous
      // request to hit the gateway 504, and no time budget that returns partial
      // results \u2014 slow-but-complete, using the full profile.
      // NOTE: do NOT swallow errors here. A failed/timed-out discovery must
      // surface as a "Search failed" toast (handled by the outer catch) instead
      // of silently falling through to the misleading "we haven't searched yet"
      // empty state. discoverAllForProfile now runs the live, gateway-budgeted
      // Crawler OS path which returns a completed synchronous result.
      const dispatch = await discoverAllForProfile({ profileId: pid })
      const enqueued = Number(dispatch?.jobs_enqueued) || 0
      const crawlerTypes = Array.isArray(dispatch?.crawler_types) ? dispatch.crawler_types : []
      // synchronous=true means the OS shim ran the entire profile discovery
      // INSIDE the request \u2014 by the time we see this response the catalog
      // has already been updated and there is nothing to poll for. Polling
      // anyway just adds 12s+ of wasted spinner time before fetchCatalogMatches.
      const synchronous = Boolean(dispatch?.synchronous)
      const partial = Boolean(dispatch?.partial)
      const stored = Number(dispatch?.stored) || 0
      const matches = Number(dispatch?.matches) || 0
      if (!isCancelled()) {
        setDiscovery({ active: enqueued > 0, enqueued, running: enqueued, crawlerTypes, synchronous })
      }

      if (enqueued > 0 && !synchronous) {
        toast({
          title: 'Searching funding sources matched to your profile',
          description: `Running ${enqueued} relevant crawler${enqueued === 1 ? '' : 's'}${crawlerTypes.length ? ` (${crawlerTypes.slice(0, 6).join(', ')}${crawlerTypes.length > 6 ? '\u2026' : ''})` : ''}. Matches appear below as each finishes \u2014 this can take a few minutes.`,
        })
        // Poll: refetch the catalog so new matches stream into the merged list,
        // and watch the job counters until this run's crawlers have drained.
        const start = Date.now()
        let sawRunning = false
        while (Date.now() - start < DISCOVERY_MAX_WAIT_MS) {
          await sleep(DISCOVERY_POLL_MS)
          // The user may have switched profiles or unmounted while we slept;
          // stop touching state and stop issuing stale-keyed heavy queries.
          if (isCancelled()) break
          const status = await fetchCrawlerStatus(pid).catch(() => null)
          if (isCancelled()) break
          await queryClient
            .refetchQueries({ queryKey: ['discover-catalog', effectiveProfileId, debouncedMinMatchScore], exact: true })
            .catch(() => {})
          if (isCancelled()) break
          const running = Number(status?.running) || 0
          if (running > 0) sawRunning = true
          setDiscovery((d) => (d ? { ...d, running } : d))
          // Done once the dispatched jobs have finished (we saw them running and
          // they drained), with a short grace window in case status lags.
          if (running === 0 && (sawRunning || Date.now() - start > 8000)) break
        }
      } else if (synchronous && partial) {
        // The crawl hit the gateway time budget and is finishing in the
        // background. Show what was found so far instead of a 504/empty state.
        toast({
          title: 'Search is taking longer than usual',
          description: 'We’re still searching in the background and have shown the matches found so far. Check back in a minute or run the search again for more.',
        })
      } else if (synchronous) {
        toast({
          title: 'Searched funding sources matched to your profile',
          description: stored > 0 || matches > 0
            ? `Crawler OS found ${stored} new opportunit${stored === 1 ? 'y' : 'ies'} and scored ${matches} match${matches === 1 ? '' : 'es'}${crawlerTypes.length ? ` across ${crawlerTypes.length} source${crawlerTypes.length === 1 ? '' : 's'}` : ''}.`
            : 'Crawler OS finished. Pulling the latest matches now.',
        })
      }

      // If the run was cancelled (profile change / unmount), don't run the final
      // pass against the stale-captured profile.
      if (isCancelled()) return

      // Final pass: pull the complete, profile-matched catalog and hand it to the
      // existing pipeline/store logic (auto-add high-confidence matches, populate
      // the FundingResults store, final summary toast). Honors any broadened
      // slider via effectiveMinMatchScore.
      const finalPayload = await fetchCatalogMatches(pid, effectiveMinMatchScore).catch(() => null)
      if (isCancelled()) return
      const rawOpportunities = Array.isArray(finalPayload?.opportunities)
        ? finalPayload.opportunities
        : Array.isArray(finalPayload?.data?.opportunities)
          ? finalPayload.data.opportunities
          : []
      // Frontend preferred floor for REVIEW/undecided rows. ACCEPT and
      // directory rows from the backend must not be re-dropped here.
      const opportunities = strictMinScore
        ? rawOpportunities.filter((opp) =>
            keepDiscoverCatalogRow(opp, effectiveMinMatchScore, Boolean(finalPayload?.relaxation?.applied)),
          )
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
      // Only clear UI state if this run was not superseded by a newer run/cancel.
      if (!isCancelled()) {
        setIsSearching(false)
        setDiscovery(null)
      }
      discoveringRef.current = false
    }

  }, [effectiveProfileId, selectedProfileId, minMatchScore, debouncedMinMatchScore, categoryQuery, profileForSearch, queryClient, toast, selectedProfile])

  // User-initiated stop. Bumps the same poll-loop cancellation token the
  // profile-change / unmount paths use, so the in-flight loop's next
  // isCancelled() check breaks out and its finally skips the reset. We reset
  // the UI here for instant feedback. Crawlers already dispatched keep running
  // server-side (this stops the client from waiting, not the backend).
  const cancelSearch = useCallback(() => {
    pollCancelRef.current = { cancelled: true, token: pollCancelRef.current.token + 1 }
    discoveringRef.current = false
    setIsSearching(false)
    setDiscovery(null)
    toast({
      title: 'Search stopped',
      description: 'Stopped waiting for results. Any matches already found are shown below; sources already queued keep running in the background.',
    })
  }, [toast])

  // Auto-run Discovery when arriving from onboarding with ?autorun=1.
  // handleFindFunding is memoized via useCallback so the captured profile id
  // (effectiveProfileId/selectedProfileId) is current at invocation.
  const autorunTriggered = React.useRef(false)
  useEffect(() => {
    if (autorunTriggered.current) return
    if (searchParams.get('autorun') !== '1') return
    if (!effectiveProfileId || isSearching || hasSearched) return
    autorunTriggered.current = true
    handleFindFunding()
  }, [effectiveProfileId, searchParams, isSearching, hasSearched, handleFindFunding])

  // Declared as a hoisted function declaration (not const arrow) so the
  // earlier handleFindFunding caller and other forward references stay
  // outside the temporal dead zone. Same reasoning for handleAddToPipeline
  // below \u2014 both are used in render-time JSX above their lexical position.
  async function handleCrawlerResults(opportunities, responsePayload = null) {
    const rawOpportunities = Array.isArray(opportunities) ? opportunities : []
    const uniqueOpportunities = dedupeFundingResults(rawOpportunities)
    const collapsedCount = rawOpportunities.length - uniqueOpportunities.length
    log.debug('processing crawler results', { count: rawOpportunities.length, uniqueCount: uniqueOpportunities.length })
    const resultMeta = normalizeResultMetadata(responsePayload, uniqueOpportunities)
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
    
    // Auto-add only persisted canonical ACCEPT decisions. The browser does not
    // run a second score threshold or eligibility trial; the server still
    // re-validates the exact pair at the write boundary.
    let addedCount = 0
    let alreadyCount = 0
    let skippedCount = 0
    let failedCount = 0
    let attempted = 0

    for (const opp of uniqueOpportunities) {
      // Server-flagged pipeline members are never re-added (they'd only
      // round-trip to an `already` answer).
      if (opp?.already_in_pipeline) { alreadyCount += 1; continue }
      const canonicalDecision = String(opp?.match_decision ?? '').trim().toUpperCase()
      if (canonicalDecision === 'ACCEPT') {
        attempted += 1
        try {
          const result = await handleAddToPipeline(opp, { silent: true, autoAdd: true })
          if (result?.status === 'added') addedCount += 1
          else if (result?.status === 'already') alreadyCount += 1
          else if (result?.status === 'skipped') skippedCount += 1
          else failedCount += 1
        } catch (error) {
          failedCount += 1
          console.error('[DiscoverGrants] Error adding to pipeline:', error)
        }
      }
    }

    // Refresh pipeline once (avoid spamming invalidations during batch add).
    queryClient.invalidateQueries({ queryKey: ['grants'] })

    if (uniqueOpportunities.length === 0) {
      toast({
        title: 'No results found',
        description: buildZeroResultDescription(profileGaps),
      })
    } else {
      const partition = partitionDiscoverResults(uniqueOpportunities)
      const collapseNote = collapsedCount > 0 ? ` Collapsed ${collapsedCount} duplicate variant${collapsedCount === 1 ? '' : 's'}.` : ''
      const dirNote = partition.directoryCount > 0
        ? ` Plus ${partition.directoryCount} director${partition.directoryCount === 1 ? 'y' : 'ies'} to search.`
        : ''
      toast({
        title: 'Search complete',
        description: `Found ${partition.awardableCount} opportunit${partition.awardableCount === 1 ? 'y' : 'ies'} you can apply to.${dirNote}${collapseNote} ${
          attempted > 0
            ? `Auto-added the ${attempted} strongest (score ${AUTO_ADD_SCORE}+): ${addedCount} added, ${alreadyCount} already in pipeline, ${skippedCount} kept out, ${failedCount} failed.`
            : `None reached the score-${AUTO_ADD_SCORE} auto-add bar — browse the results below and add any you want.`
        }`,
      })
    }

    // Update search results to show crawler results
    setHasSearched(true)
    setSearchResults(uniqueOpportunities);

    // Populate the FundingResults store so /FundingResults page displays results after navigation
    const profileIdForStore = effectiveProfileId ?? selectedProfileId
    setFundingResults({
      results: uniqueOpportunities,
      profileId: profileIdForStore,
      organizationName: selectedProfile?.display_name ?? null,
      organizationId: selectedProfile?.organization_id ?? null,
      ...resultMeta,
      returned: uniqueOpportunities.length,
      totalFound: uniqueOpportunities.length,
    })
  }

  async function handleAddToPipeline(opportunity, { silent = false, autoAdd = false } = {}) {
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
    const duplicateUrl = opportunity.application_url ?? opportunity.apply_url ?? null
    if (orgId && duplicateUrl) {
      try {
        const existingGrants = await client.entities.Grant.filter({
          organization_id: orgId,
          url: duplicateUrl,
        });
        // Defensive coercion: the API may return a bare array, a { data: [...] }
        // wrapper, or null on some paths.
        const existingList = Array.isArray(existingGrants)
          ? existingGrants
          : Array.isArray(existingGrants?.data)
            ? existingGrants.data
            : []
        
        if (existingList.length > 0) {
          if (!silent) {
            toast({
              title: 'Already in pipeline',
              description: `"${opportunity.title}" is already in your pipeline.`,
            })
          }
          return { status: 'already', grant: existingList[0] }
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
      const applicationUrl = opportunity.application_url ?? opportunity.apply_url ?? null
      if (!applicationUrl) {
        if (!silent) {
          toast({
            variant: 'destructive',
            title: 'Application link needed',
            description: `"${opportunity.title}" only has a source link. Visit the source and verify the application link before adding it to the pipeline.`,
          })
        }
        return { status: 'failed', error: 'missing_application_url' }
      }

      // IMPORTANT: use apiFetch so Authorization is attached (prevents 401s).
      const newGrant = await apiFetch('/api/grants/from-opportunity', {
        method: 'POST',
        body: JSON.stringify({
          opportunity_id: opportunity.id || null,
          profile_id: profileIdForAdd,
          organization_id: orgId || null,
          auto_add: Boolean(autoAdd),
          // The server re-scores the authoritative profile/opportunity before
          // pipeline insert, so client-side match fields are intentionally omitted.
          opportunity_data: {
            title: opportunity.title,
            sponsor: opportunity.sponsor,
            deadline: opportunity.deadlineAt || opportunity.deadline,
            application_url: applicationUrl,
            url: opportunity.url ?? opportunity.source_url ?? null,
            awardMin: opportunity.awardMin || opportunity.amount_min,
            awardMax: opportunity.awardMax || opportunity.amount_max,
            descriptionMd: opportunity.descriptionMd || opportunity.description,
            eligibilityBullets: opportunity.eligibilityBullets || [],
            source: opportunity.source || 'discovery',
            record_origin:
              opportunity.record_origin ||
              (String(opportunity.source || '').toLowerCase() === 'web_llm' ? 'web_search' : null),
            contact_info: opportunity.contact_info || opportunity.contact || null,
            application_method: opportunity.application_method || null,
            applicationNote: opportunity.application_note || opportunity.applicationNote || null,
          },
        }),
      })

      if (newGrant.not_added_to_pipeline || newGrant.status === 'skipped') {
        if (!silent) {
          toast({
            title: 'Kept out of this pipeline',
            description: newGrant.message || `"${opportunity.title}" was cataloged but did not pass the profile match gates.`,
          })
        }
        return { status: 'skipped', grant: newGrant, reason: newGrant.reason, gate: newGrant.gate, message: newGrant.message }
      }
      
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
        // Await + catch so a rejection never becomes an unhandled promise rejection.
        try {
          await useAuthStore.getState().refreshProfiles({ reason: 'new-org-from-grant', force: true });
        } catch (refreshErr) {
          console.warn('[DiscoverGrants] refreshProfiles failed:', refreshErr?.message || refreshErr)
        }
      }
      
      if (!silent) {
        queryClient.invalidateQueries({ queryKey: ['grants'] })
        toast({
          title: 'Added to pipeline',
          description: `${opportunity.title} has been added to your grants pipeline.`,
        })
      }
      // Capture BEFORE reportCompletion — completing 'discover-add' can
      // advance the tour, and the /GrantDetail steps read tourGrantId.
      useGuidedTourStore.getState().setTourGrantId(newGrant?.id ?? null)
      useGuidedTourStore.getState().reportCompletion('discover-add')
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
    if (combinedOpportunities.length === 0) {
      items.push({ id: 'run-crawlers', icon: Search, text: 'Run a search to discover funding opportunities', detail: 'Click "Find Funding Opportunities" to search all sources matched to your profile.' });
    }
    if (combinedOpportunities.length > 0) {
      const highMatches = combinedOpportunities.filter(r => (r.match_score || r.match || 0) >= GOOD_MATCH_SCORE);
      if (highMatches.length > 0) {
        items.push({ id: 'review-top', icon: CheckCircle2, text: 'Review your top ' + highMatches.length + ' high-match opportunities', detail: `These opportunities scored ${GOOD_MATCH_SCORE}+ (Good or better) against your profile. Consider adding them to your pipeline.` });
      }
      items.push({ id: 'add-pipeline', icon: ArrowRight, text: 'Add promising grants to your pipeline', detail: 'Use the checkboxes to select opportunities, then click Add to Pipeline to track and manage them.' });
    }
    return items.filter(s => !dismissedSuggestions.includes(s.id));
  }, [selectedProfile, profileDetailForUi, selectedOrg, combinedOpportunities, dismissedSuggestions]);

  const dismissSuggestion = (id) => {
    setDismissedSuggestions(prev => {
      const next = [...prev, id];
      try { localStorage.setItem('grantflow:dismissed-suggestions', JSON.stringify(next)); } catch { /* ignore storage errors */ }
      return next;
    });
  };

  // Stable so SourceLaneCoverage's lift-up effect doesn't loop. Only updates
  // state when the reported matched-source count actually changes.
  const handleCoverageReport = useCallback(({ matchedSources }) => {
    setMatchedSourceCount((prev) => (prev === matchedSources ? prev : matchedSources))
  }, [])

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
      searchResultCount: combinedOpportunities.length,
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
                  sentinel and warns when the prop later becomes a real id \u2014
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
                        ? organizations.find(o => String(o?.id) === String(profile.organization_id))
                        : null;
                      const isProfileECF = profileOrg?.medicaid_enrolled && 
                                          profileOrg?.medicaid_waiver_program === 'ecf_choices';
                      
                      return (
                        <SelectItem key={profile.id} value={profile.id}>
                          <div className="flex items-center gap-2">
                            <User className="w-4 h-4 text-muted-foreground" />
                            {profile.display_name}
                            {/* display_name already falls back to the org name on the
                                backend, so only show the parenthetical when the org name
                                actually differs — otherwise it renders "Name (Name)". */}
                            {profile.organization_name && profile.organization_name !== profile.display_name && (
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
                  {selectedProfile.organization_name && selectedProfile.organization_name !== selectedProfile.display_name && (
                    <span className="ml-2">({selectedProfile.organization_name})</span>
                  )}
                  {selectedProfile.primary_type && (
                    <span className="ml-2 text-xs text-muted-foreground">{"\u2022"} {selectedProfile.primary_type.replace(/_/g, ' ')}</span>
                  )}
                  {selectedOrg?.state && <span className="ml-2">{"\u2022"} {selectedOrg.state}</span>}
                  {isECFProfile && (
                    <span className="block mt-1 font-semibold">
                      {"\uD83C\uDFE5"} ECF CHOICES Participant
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

            {/* Find Funding \u2014 single comprehensive search */}
            <div className="space-y-6" ref={searchActionsRef}>
              <div>
                <h3 className="text-lg font-semibold text-foreground">Find Funding Opportunities</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  We'll search all available funding sources - grants, scholarships, benefits, and local programs - matched to your profile.
                </p>
              </div>
              <div className="p-4 bg-muted/20 rounded-lg border border-border">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium text-foreground inline-flex items-center gap-1">
                      Minimum match score
                      <HelpTip text="How closely a source must fit your profile to appear. Lower = more results; higher = only the best fits. Real matches mostly score between 5 and 25." />
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Lower this to see more results; raise it to keep only the strongest matches.
                    </div>
                  </div>
                  <div className="text-sm font-semibold text-foreground">
                    Score &ge; {minMatchScore} &middot; {minScoreBandLabel(minMatchScore)}
                  </div>
                </div>
                {/* Color-coded, notched guidance band (Feature B). Data-driven
                    from score_histogram; band zones come from the canonical
                    thresholds. Track spans 0..30+ on the data-point scale. */}
                <MatchScoreGuidanceBand histogram={scoreHistogram} max={MIN_SCORE_SLIDER_MAX} value={minMatchScore} />
                <input
                  type="range"
                  min={0}
                  max={MIN_SCORE_SLIDER_MAX}
                  step={1}
                  value={Math.min(MIN_SCORE_SLIDER_MAX, minMatchScore)}
                  onChange={(e) => setMinMatchScore(Number(e.target.value))}
                  disabled={isSearching}
                  className="mt-3 w-full"
                />
              </div>
              <div className="flex flex-wrap items-center gap-3">
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
                {isSearching && (
                  <Button
                    onClick={cancelSearch}
                    variant="outline"
                    size="lg"
                    className="border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800"
                  >
                    <StopCircle className="w-4 h-4 mr-2" />
                    Stop
                  </Button>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Discovery-pending empty state (Feature A): the profile has never had
            discovery run, so the backend returned discovery_pending and an empty
            list. Prompt the user to run discovery rather than implying "no
            matches". Suppressed while searching or once any results exist. */}
        {discoveryPending && !hasSearched && !isSearching && combinedOpportunities.length === 0 && (
          <Card className="mb-8 border-blue-200 bg-blue-50/50">
            <CardContent className="p-6 space-y-4 text-center">
              <Sparkles className="h-8 w-8 mx-auto text-blue-600" />
              <div>
                <h3 className="text-lg font-semibold text-blue-900">Run discovery to see funding matches</h3>
                <p className="text-sm text-blue-800 mt-1">
                  We haven&apos;t searched for funding for this profile yet. Run discovery to find grants, scholarships, benefits, and local programs matched to it.
                </p>
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
                  'Run discovery'
                )}
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Architecture P1: prominent "Improve your matches" prompts while
            discovery is still pending \u2014 show the user what to complete now so
            their first discovery returns better results. */}
        {discoveryPending && !isSearching && !improvePromptsDismissed && selectedProfile?.id && (
          <ImproveMatchesCard
            prompts={profileFieldPrompts}
            profileId={selectedProfile.id}
            variant="prominent"
            onDismiss={() => setImprovePromptsDismissed(true)}
          />
        )}

        {/* Zero-result recovery card: shown after a search completes with no results */}
        {hasSearched && combinedOpportunities.length === 0 && !isSearching && (
          <Card className="mb-8 border-amber-200 bg-amber-50/50">
            <CardContent className="p-6 space-y-5">
              <div className="flex items-start gap-3">
                <AlertTriangle className="h-6 w-6 shrink-0 text-amber-600 mt-0.5" />
                <div>
                  <h3 className="text-lg font-semibold text-amber-900">
                    {profileFundingSourceCount > 0
                      ? `${profileFundingSourceCount} profile funding source${profileFundingSourceCount === 1 ? '' : 's'} already found`
                      : "No visible matches here yet - let's keep going"}
                  </h3>
                  <p className="text-sm text-amber-800 mt-1">
                    {profileFundingSourceCount > 0
                      ? 'Discover did not show direct results at this threshold, but Crawler OS already has profile-matched sources saved on the profile. Open those first, then rerun discovery if you need more.'
                      : buildZeroResultDescription(profileGaps)}
                  </p>
                </div>
              </div>

              {profileFundingSourceCount > 0 && selectedProfile?.id && (
                <div className="flex flex-col gap-3 rounded-md border border-blue-200 bg-blue-50 p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-sm text-blue-900">
                    <strong>Crawler OS has matches for this profile.</strong>{' '}
                    They may be directories or profile-specific starting points rather than direct apply-now grants.
                  </div>
                  <Button
                    size="sm"
                    className="shrink-0 bg-blue-600 text-white hover:bg-blue-700"
                    onClick={() => navigate(createPageUrl('ProfileDetail', { id: selectedProfile.id, tab: 'pipeline', focus: 'profile-funding-sources' }))}
                  >
                    Open profile funding sources
                  </Button>
                </div>
              )}

              {/* Score threshold suggestion \u2014 when matches exist below the slider */}
              {scoreHint && scoreHint.bestScore > 0 && (
                <div className="flex items-center gap-3 rounded-md bg-blue-50 border border-blue-200 p-3">
                  <span className="text-blue-600 text-lg">&#x1F50D;</span>
                  <div className="flex-1 text-sm text-blue-900">
                    <strong>{scoreHint.totalScored}</strong> opportunities were found but scored below your minimum score of <strong>{minMatchScore}</strong> (best score: <strong>{scoreHint.bestScore}</strong>).
                    {' '}
                    <button
                      className="underline font-medium hover:text-blue-700"
                      onClick={() => { setMinMatchScore(clampMinScore(scoreHint.suggestedThreshold)); }}
                    >
                      Lower to {clampMinScore(scoreHint.suggestedThreshold)} to see ~{scoreHint.countAtSuggested} results
                    </button>
                    {' '}then re-run the search.
                  </div>
                </div>
              )}

              {/* Fallback below-threshold hint: no precise score_hint, but the
                  histogram shows matches under the current floor. */}
              {!(scoreHint && scoreHint.bestScore > 0) && subThresholdHint && (
                <div className="flex items-center gap-3 rounded-md bg-blue-50 border border-blue-200 p-3">
                  <span className="text-blue-600 text-lg">&#x1F50D;</span>
                  <div className="flex-1 text-sm text-blue-900">
                    <strong>{subThresholdHint.belowCount}</strong> {subThresholdHint.belowCount === 1 ? 'opportunity' : 'opportunities'} scored below your minimum score of <strong>{minMatchScore}</strong>.
                    {' '}
                    <button
                      className="underline font-medium hover:text-blue-700"
                      onClick={() => { setMinMatchScore(clampMinScore(subThresholdHint.suggested)); }}
                    >
                      Lower to {clampMinScore(subThresholdHint.suggested)} to see them
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
                        <span className="text-amber-700">- unlocks local and state-level programs</span>
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
                        <span className="text-amber-700">- filters irrelevant programs</span>
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
                        <span className="text-amber-700">- improves keyword matching</span>
                      </li>
                    )}
                  </ul>
                </div>
              )}

              {/* Browse by Need categories \u2014 grouped */}
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
                      Searching...
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
                {selectedProfile?.id && profileFundingSourceCount > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-blue-300 text-blue-800 hover:bg-blue-50 whitespace-nowrap"
                    onClick={() => navigate(createPageUrl('ProfileDetail', { id: selectedProfile.id, tab: 'pipeline', focus: 'profile-funding-sources' }))}
                  >
                    View saved sources
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2 border-purple-300 text-purple-700 hover:bg-purple-50 whitespace-nowrap"
                  onClick={() => {
                    const msg = profileGaps.missingLocation
                      ? "Help me find grants \u2014 I haven't set my location yet"
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

        {/* Mission Goal 7 \u2014 Search coverage panel: which source families GrantFlow
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

        {/* Source-lane coverage / negative evidence: which sources we searched
            for this profile and which were checked with no current match. Only
            renders once a search has run for a selected profile. */}
        {hasSearched && effectiveProfileId ? (
          <SourceLaneCoverage
            profileId={effectiveProfileId}
            refreshKey={crawlerResultMeta}
            onCoverage={handleCoverageReport}
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
                ? ` (${discovery.crawlerTypes.slice(0, 6).join(', ')}${discovery.crawlerTypes.length > 6 ? '\u2026' : ''})`
                : ''}
              {typeof discovery.running === 'number' && discovery.running > 0
                ? ` \u2014 ${discovery.running} still running.`
                : ' \u2014 wrapping up.'}{' '}
              New matches appear below as each finishes; this can take a few minutes.{' '}
              <strong>You can leave this page</strong> - the search keeps running on our servers and results are saved to your catalog and pipeline automatically.
            </AlertDescription>
          </Alert>
        )}

        {/* Architecture P1: compact "Improve your matches" banner above results
            (not while discovery is pending \u2014 that path shows the prominent card). */}
        {!discoveryPending && !improvePromptsDismissed && selectedProfile?.id &&
          combinedOpportunities.length > 0 && (
          <ImproveMatchesCard
            prompts={profileFieldPrompts}
            profileId={selectedProfile.id}
            variant="banner"
            onDismiss={() => setImprovePromptsDismissed(true)}
          />
        )}

        {/* Count reconciliation: keep the coverage panel's "N sources with
            matches" honest against what is actually on screen, so a silent
            "20 matched / 2 shown" can't recur. Profile-type-agnostic. Also
            surfaces a subtle "updating" state so a mid-crawl catalog refetch
            never reads as an empty search. */}
        {/* Count reconciliation: awardable apply-to count maps 1:1; directories
            are named separately so they never inflate "what can I apply to". */}
        {combinedOpportunities.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700">
            <span>
              Showing <strong>{discoverPartition.awardableCount}</strong> opportunit{discoverPartition.awardableCount === 1 ? 'y' : 'ies'} you can apply to
              {discoverPartition.directoryCount > 0 && (
                <> · <strong>{discoverPartition.directoryCount}</strong> director{discoverPartition.directoryCount === 1 ? 'y' : 'ies'} to search</>
              )}
              {resultsReconciliation?.matched > 0 && (
                <> · <strong>{resultsReconciliation.matched}</strong> of your searched sources {resultsReconciliation.matched === 1 ? 'has' : 'have'} matches</>
              )}
              {catalogIsFetching && <span className="ml-1 text-xs text-slate-400">(updating…)</span>}
            </span>
            {resultsReconciliation?.hidden && (
              <span className="text-slate-600">
                {resultsReconciliation.belowFloorCount} more scored below your filter (≥{resultsReconciliation.minScore}).{' '}
                <button
                  type="button"
                  className="underline font-medium text-blue-700 hover:text-blue-800"
                  onClick={() => setMinMatchScore(clampMinScore(subThresholdHint?.suggested ?? 0))}
                >
                  Lower the score to view all
                </button>
              </span>
            )}
          </div>
        )}

        {/* Results Display: awardable first, directories second */}
        {combinedOpportunities.length > 0 && (
          <div ref={resultsRef}>
            <SearchResults
              results={displayOpportunities}
              profileId={effectiveProfileId ?? selectedProfileId}
              onAddToPipeline={handleAddToPipeline}
              organizationName={selectedProfile?.display_name}
              diagnostics={catalogResultMeta?.diagnostics ?? crawlerResultMeta?.diagnostics ?? null}
            />
          </div>
        )}
      </div>
    </div>
  );
}
