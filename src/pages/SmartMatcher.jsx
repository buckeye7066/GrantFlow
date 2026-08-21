import React, { useMemo, useState, useCallback, useEffect, useRef } from "react"
import { Sparkles, Search, Filter, SlidersHorizontal, Star, TrendingUp, Award, Plus, X, CheckSquare, Target, Loader2, MapPin, User, Zap, ArrowRight, CheckCircle2, AlertTriangle, Lightbulb, ExternalLink, FolderOpen } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Checkbox } from "@/components/ui/checkbox"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query"
import { apiFetch } from "@/api/client"
import { getItemSuggestions } from "@/api/items"
import { getProfile } from "@/api/profiles"
import { discoverAllForProfile } from "@/api/crawlers"
import { interpretMatcherIntent, getMatchingGaps, listProfileFundingSources } from "@/api/matching"
import ProfileSelect from "@/components/shared/ProfileSelect"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useToast } from "@/components/ui/use-toast"
import { Link } from "react-router-dom"
import { createPageUrl } from "@/utils"
import { formatReasonText, humanizeMatchReason } from "@/utils/reasonText"
import { safeHttpUrl } from "@/lib/safeUrl"
import {
  AUTO_ADD_SCORE,
  GOOD_MATCH_SCORE,
  STRONG_MATCH_SCORE,
  MIN_SCORE_SLIDER_MAX,
  minScoreBandLabel,
} from "@/lib/matchDisplayThresholds"
import MatchScoreGuidanceBand from "@/components/discovery/MatchScoreGuidanceBand"

// ---------------------------------------------------------------------------
// Persistent needs helpers \u2013 stored in localStorage keyed per profile
// ---------------------------------------------------------------------------

const NEEDS_STORAGE_PREFIX = "grantflow:matcher-needs:"

// A MISSING score is not a zero. `?? 0` on a NULL match_score renders
// "Score 0" — a claim that the engine looked and measured nothing — which is
// indistinguishable from a row nothing ever scored (the Number(null) === 0
// class this repo has been burned by). An unscored row says so.
function scoreBadgeText(score) {
    if (score === null || score === undefined || score === "") return "Not scored"
    const n = Number(score)
    return Number.isFinite(n) ? `Score ${n}` : "Not scored"
}

// Collision-resistant id generator for custom needs. Combines a timestamp with
// an always-incrementing counter (and crypto.randomUUID when available) so two
// needs created in the same millisecond never share an id.
let customNeedCounter = 0
function generateCustomNeedId() {
    customNeedCounter += 1
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return "need_custom_" + crypto.randomUUID()
    }
    return "need_custom_" + Date.now() + "_" + customNeedCounter
}

function loadNeeds(profileId) {
    if (!profileId) return { checked: {}, customItems: [] }
    try {
        const raw = localStorage.getItem(NEEDS_STORAGE_PREFIX + profileId)
        if (!raw) return { checked: {}, customItems: [] }
        const parsed = JSON.parse(raw)
        return {
            checked: parsed.checked && typeof parsed.checked === "object" ? parsed.checked : {},
            customItems: Array.isArray(parsed.customItems) ? parsed.customItems : [],
        }
    } catch {
        return { checked: {}, customItems: [] }
    }
}

function saveNeeds(profileId, state) {
    if (!profileId) return
    try {
        localStorage.setItem(NEEDS_STORAGE_PREFIX + profileId, JSON.stringify(state))
    } catch (err) {
        // Surface the failure instead of silently swallowing it (e.g. quota).
        console.warn("[SmartMatcher] Failed to persist needs state to localStorage:", err)
    }
}

// Impact badge colors for profile gaps
const IMPACT_COLORS = {
  critical: "bg-red-100 text-red-700 border-red-200",
  high: "bg-amber-100 text-amber-700 border-amber-200",
  medium: "bg-blue-100 text-blue-700 border-blue-200",
}

// Slider track upper bound + guidance zones come from the canonical
// src/lib/matchDisplayThresholds.js (data-point scale, 0..30+) and the shared
// MatchScoreGuidanceBand component \u2014 this page previously carried its own
// 0\u2013100 copy with dead 40/70/85 zone stops.

/**
 * Architecture P1: friendly, dismissible "Improve your matches" card.
 *
 * Renders the backend's `profile_field_prompts` ({ field, label, why,
 * section_key }) as encouraging nudges that deep-link to the relevant profile
 * section. variant="prominent" for the discovery-pending empty state,
 * variant="banner" for a compact strip above results. Never a gate.
 */
function ImproveMatchesCard({ prompts, profileId, onDismiss, variant = "banner" }) {
  if (!Array.isArray(prompts) || prompts.length === 0 || !profileId) return null

  const promptLink = (prompt) =>
    prompt.section_key
      ? createPageUrl("ProfileDetail", { id: profileId, section: prompt.section_key })
      : createPageUrl("ProfileDetail", { id: profileId })

  if (variant === "prominent") {
    return (
      <Card className="mb-6 border-emerald-200 bg-emerald-50/60">
        <CardContent className="p-5 space-y-4">
          <div className="flex items-start gap-3">
            <Sparkles className="h-6 w-6 shrink-0 text-emerald-600 mt-0.5" />
            <div className="flex-1">
              <h3 className="text-base font-semibold text-emerald-900">Improve your matches</h3>
              <p className="text-sm text-emerald-800 mt-0.5">
                Add a few details to your profile and we&apos;ll find more — and more relevant — funding for you.
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
              <span className="text-xs text-emerald-700">Add these to unlock more funding:</span>
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

function formatFundingSourceMeta(source) {
  return [
    source.sponsor,
    source.geography,
    source.is_directory ? "Directory to search" : null,
    source.deadline ? `Due ${source.deadline}` : source.is_rolling ? "Rolling" : null,
  ].filter(Boolean).join(" - ")
}

function CrawlerOsSourcePreview({ sources, profileId, isLoading, onRunDiscovery, isRunning }) {
  if (isLoading) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-5 text-left">
        <p className="text-sm text-slate-500">Checking profile funding sources...</p>
      </div>
    )
  }

  if (!sources.length || !profileId) return null

  const profileSourcesUrl = createPageUrl("ProfileDetail", {
    id: profileId,
    tab: "pipeline",
    focus: "profile-funding-sources",
  })

  return (
    <div className="space-y-4 text-left">
      <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-emerald-900">
              <FolderOpen className="h-5 w-5 shrink-0" />
              <h3 className="text-base font-semibold">
                Crawler OS already found {sources.length} profile funding source{sources.length === 1 ? "" : "s"}
              </h3>
            </div>
            <p className="mt-1 text-sm leading-6 text-emerald-800">
              The strict Smart Matcher catalog view returned zero rows at these settings, but the profile does have Crawler OS sources saved. They are shown separately so we do not pretend a directory is an apply-now grant.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button asChild size="sm" className="bg-emerald-700 hover:bg-emerald-800">
              <Link to={profileSourcesUrl}>
                Open profile sources
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onRunDiscovery}
              disabled={isRunning}
              className="border-emerald-300 text-emerald-800 hover:bg-emerald-50"
            >
              {isRunning ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Zap className="mr-2 h-4 w-4" />
              )}
              {isRunning ? "Running..." : "Run full discovery"}
            </Button>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        {sources.slice(0, 5).map((source) => {
          const href = safeHttpUrl(source.url)
          const RowTag = href ? "a" : "div"
          return (
            <RowTag
              key={source.id}
              {...(href ? { href, target: "_blank", rel: "noopener noreferrer" } : {})}
              className="flex items-start justify-between gap-3 rounded-lg border border-slate-200 bg-white p-3 transition hover:border-blue-200 hover:bg-blue-50/40"
            >
              <div className="min-w-0">
                <div className="flex items-start gap-2">
                  <span className="inline-flex h-6 min-w-[2.25rem] items-center justify-center rounded bg-emerald-50 px-1.5 text-xs font-mono font-semibold text-emerald-700">
                    {source.match_score ?? "-"}
                  </span>
                  <div className="min-w-0">
                    <p className="font-medium text-slate-900">{source.title}</p>
                    <p className="mt-0.5 text-xs text-slate-500">{formatFundingSourceMeta(source)}</p>
                  </div>
                </div>
                {source.why ? <p className="mt-1 line-clamp-2 text-xs text-slate-600">{source.why}</p> : null}
              </div>
              {href ? (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-blue-200 bg-white px-2 py-1 text-xs font-medium text-blue-700">
                  Open <ExternalLink className="h-3 w-3" />
                </span>
              ) : (
                <span className="shrink-0 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-500">No URL</span>
              )}
            </RowTag>
          )
        })}
      </div>
    </div>
  )
}

export default function SmartMatcher() {
    const [selectedProfileId, setSelectedProfileId] = useState("")
    const [searchQuery, setSearchQuery] = useState("")
    /** When set, catalog query uses OR across these terms (from \u201cUnderstand & search\u201d). */
    const [parsedSearchTerms, setParsedSearchTerms] = useState(null)
    const [intentSummary, setIntentSummary] = useState("")
    // Captured from interpretMatcherIntent so the catalog query can skip
    // SSI/SNAP/TANF when the user is searching for professional development /
    // continuing education funding (Smart Matcher spec \u00a73, \u00a74).
    const [intentPrimaryCategory, setIntentPrimaryCategory] = useState(null)
    const [intentExcludedCategories, setIntentExcludedCategories] = useState([])
    const [intentBrandedProgram, setIntentBrandedProgram] = useState(null)
    const [intentCredentials, setIntentCredentials] = useState([])
    const [freeTextNeed, setFreeTextNeed] = useState("")
    // Pipeline bar on the data-point scale (the old default of 50 sits beyond
    // the top 1% of real scores and returned near-nothing).
    const [minScore, setMinScore] = useState(AUTO_ADD_SCORE)
    const [selectedOpp, setSelectedOpp] = useState(null)
    // Architecture P1: lets the user dismiss the "Improve your matches" prompts.
    const [improvePromptsDismissed, setImprovePromptsDismissed] = useState(false)
    const { toast } = useToast()
    const queryClient = useQueryClient()
    const [isSearchingNeeds, setIsSearchingNeeds] = useState(false)
    // Tracks which profile we already auto-populated keywords for (avoids re-populating on re-render)
    const autoPopulatedProfileRef = useRef(null)

  useEffect(() => {
        if (selectedProfileId) return
        try {
          const params = new URLSearchParams(window.location.search)
          const remembered =
            params.get("profile_id") ||
            params.get("profileId") ||
            localStorage.getItem("grantflow:last-profile-detail-id") ||
            localStorage.getItem("grantflow:discover-last-profile")
          if (remembered && remembered !== "__admin__" && remembered !== "all") {
            setSelectedProfileId(remembered)
          }
        } catch {
          // If browser storage is unavailable, the visible profile picker remains the source of truth.
        }
  }, [selectedProfileId])

  useEffect(() => {
        if (!selectedProfileId || selectedProfileId === "all" || selectedProfileId === "__admin__") return
        try {
          localStorage.setItem("grantflow:last-profile-detail-id", selectedProfileId)
          localStorage.setItem("grantflow:discover-last-profile", selectedProfileId)
        } catch {
          // Non-critical persistence only; the selected profile is still held in component state.
        }
  }, [selectedProfileId])

  // -- Matching gaps: live profile completeness check --
  const { data: matchingGapsResponse, isLoading: isGapsLoading } = useQuery({
    queryKey: ['matching-gaps', selectedProfileId],
    queryFn: () => getMatchingGaps(selectedProfileId),
    enabled: Boolean(selectedProfileId) && selectedProfileId !== 'all',
    staleTime: 60_000,
  })

  // -- Persistent needs state per profile --
  const [needsState, setNeedsState] = useState({ checked: {}, customItems: [] })
  const [newNeedText, setNewNeedText] = useState("")

  // Load needs when profile changes. loadNeeds is a cheap synchronous read of a
  // single localStorage key keyed by profile, so it only re-runs when the
  // profile id actually changes (effect dependency).
  useEffect(() => {
        setNeedsState(loadNeeds(selectedProfileId))
  }, [selectedProfileId])

  // Persist needs whenever they change
  useEffect(() => {
        saveNeeds(selectedProfileId, needsState)
  }, [selectedProfileId, needsState])

  // -- Reset all search state when profile switches --
  useEffect(() => {
        setSearchQuery("")
        setParsedSearchTerms(null)
        setIntentSummary("")
        setIntentPrimaryCategory(null)
        setIntentExcludedCategories([])
        setIntentBrandedProgram(null)
        setIntentCredentials([])
        setFreeTextNeed("")
        setSelectedOpp(null)
        setIsSearchingNeeds(false)
        autoPopulatedProfileRef.current = null
        queryClient.invalidateQueries({ queryKey: ["smart-matcher"] })
  }, [selectedProfileId, queryClient])

  const matchingGaps = useMemo(() => {
    const payload = matchingGapsResponse?.data ?? matchingGapsResponse ?? {}
    return {
      gaps: Array.isArray(payload.gaps) ? payload.gaps : [],
      completed: payload.completed ?? 0,
      total_items: payload.total_items ?? 8,
      success_steps: Array.isArray(payload.success_steps) ? payload.success_steps : [],
    }
  }, [matchingGapsResponse])

  // -- Needs handlers --
  const toggleNeed = useCallback((needId) => {
        setNeedsState((prev) => ({
                ...prev,
                checked: { ...prev.checked, [needId]: !prev.checked[needId] },
        }))
  }, [])

  const addCustomNeed = useCallback(() => {
        const text = newNeedText.trim()
        if (!text) return
        const id = generateCustomNeedId()
        setNeedsState((prev) => ({
                ...prev,
                customItems: [...prev.customItems, { id, name: text, category: "custom" }],
        }))
        setNewNeedText("")
  }, [newNeedText])

  const removeCustomNeed = useCallback((needId) => {
        setNeedsState((prev) => ({
                ...prev,
                customItems: prev.customItems.filter((i) => i.id !== needId),
                checked: (() => { const c = { ...prev.checked }; delete c[needId]; return c })(),
        }))
  }, [])

  // -- Item suggestions (inferred needs) --
  const { data: suggestionsResponse, isLoading: isSuggestionsLoading } = useQuery({
        queryKey: ['item-suggestions', selectedProfileId],
        queryFn: () => getItemSuggestions({ profileId: selectedProfileId }),
        enabled: Boolean(selectedProfileId) && selectedProfileId !== 'all',
        staleTime: 300_000,
  })

  const inferredNeeds = useMemo(() => {
        const payload = suggestionsResponse?.data ?? suggestionsResponse ?? {}
        const suggestions = payload?.suggestions ?? []
        if (!Array.isArray(suggestions)) return []
        // Ensure every inferred need has a stable unique id used both for the
        // checked-state map key and the React render key. Falls back to a
        // name+index-namespaced id when the backend omits one.
        return suggestions.map((s, idx) => {
            const stableId = s?.id !== null && s?.id !== undefined ? String(s.id) : `need_inferred_${idx}_${s?.name ?? ""}`
            return { ...s, _key: stableId }
        })
  }, [suggestionsResponse])

  // -- Auto-populate search keywords from inferred needs on first profile load --
  // Only runs once per profile selection; skips if the user has already typed a query.
  useEffect(() => {
        if (!selectedProfileId || selectedProfileId === 'all') return
        if (isSuggestionsLoading) return
        if (inferredNeeds.length === 0) return
        if (autoPopulatedProfileRef.current === selectedProfileId) return
        // Don't overwrite a query the user typed manually
        if (searchQuery.trim()) {
                autoPopulatedProfileRef.current = selectedProfileId
                return
        }
        autoPopulatedProfileRef.current = selectedProfileId
        const keywords = inferredNeeds.slice(0, 5).map((n) => n.name).join(" ")
        setSearchQuery(keywords)
        setParsedSearchTerms(null)
        setIntentSummary("")
  }, [selectedProfileId, inferredNeeds, isSuggestionsLoading, searchQuery])

  // -- Fetch selected profile data --
  const { data: selectedProfile } = useQuery({
        queryKey: ['profile', selectedProfileId],
        queryFn: () => getProfile(selectedProfileId),
        enabled: Boolean(selectedProfileId) && selectedProfileId !== 'all',
        staleTime: 300_000,
  })

  // -- Profile-scoped Crawler OS discovery mutation --
  const interpretMutation = useMutation({
    mutationFn: () => interpretMatcherIntent(freeTextNeed),
    onSuccess: (raw) => {
      const payload = raw?.data ?? raw ?? {}
      const terms = Array.isArray(payload.search_terms) ? payload.search_terms.filter(Boolean) : []
      if (terms.length === 0) {
        // Clear any stale intent from a prior successful interpretation so the
        // catalog query does not silently keep reusing old terms.
        setParsedSearchTerms(null)
        setIntentSummary("")
        setIntentPrimaryCategory(null)
        setIntentExcludedCategories([])
        setIntentBrandedProgram(null)
        setIntentCredentials([])
        toast({
          title: "Could not extract search terms",
          description: "Try rephrasing with what you need (for example travel, vehicle, rent, medical).",
          variant: "destructive",
        })
        return
      }
      setParsedSearchTerms(terms.map((t) => String(t).toLowerCase().trim()).filter(Boolean))
      setIntentSummary(typeof payload.summary === "string" ? payload.summary : "")
      setIntentPrimaryCategory(typeof payload.primary_category === "string" ? payload.primary_category : null)
      setIntentExcludedCategories(Array.isArray(payload.excluded_categories) ? payload.excluded_categories : [])
      setIntentBrandedProgram(payload.branded_program ?? null)
      setIntentCredentials(Array.isArray(payload.credentials_detected) ? payload.credentials_detected : [])
      setSearchQuery(terms.join(", "))
      queryClient.invalidateQueries({ queryKey: ["smart-matcher"] })
      toast({
        title: "Search updated from your description",
        description: payload.summary || `Using ${terms.length} focus terms for the catalog.`,
      })
    },
    onError: (err) => {
      const limited =
        err?.status === 429 ||
        err?.errorCode === "rate_limit_exceeded" ||
        /rate_limit|too many requests/i.test(String(err?.message || ""))
      const retrySec = Number(err?.details?.retry_after_seconds)
      const waitHint =
        Number.isFinite(retrySec) && retrySec > 0
          ? retrySec < 90
            ? `Wait about ${retrySec} seconds, then try again.`
            : `Wait about ${Math.ceil(retrySec / 60)} minutes, then try again.`
          : "Wait about a minute, then try again."
      toast({
        title: limited ? "Temporarily rate-limited" : "Could not interpret request",
        description: limited
          ? `${waitHint} Your description was not lost — you can retry the same text.`
          : err?.message ?? "Try again or use keywords below.",
        variant: "destructive",
      })
    },
  })

  const discoverAllMutation = useMutation({
        mutationFn: () => discoverAllForProfile({ profileId: selectedProfileId }),
        onSuccess: (raw) => {
                const data = raw?.data ?? raw ?? {}
                queryClient.invalidateQueries({ queryKey: ['smart-matcher'] })
                queryClient.invalidateQueries({ queryKey: ['smart-profile-funding-sources', selectedProfileId] })
                queryClient.invalidateQueries({ queryKey: ['profile-funding-sources', selectedProfileId] })
                const enqueued = Number(data?.jobs_enqueued ?? 0)
                const crawlerTypes = Array.isArray(data?.crawler_types) ? data.crawler_types : []
                toast({
                        title: data?.throttled
                                ? 'Crawler OS already ran recently'
                                : `Crawler OS started ${enqueued} relevant crawler${enqueued === 1 ? '' : 's'}`,
                        description: data?.throttled
                                ? 'The most recent crawl used the same profile snapshot, so GrantFlow kept the fresh results instead of rerunning the same work.'
                                : crawlerTypes.length
                                  ? `Queued: ${crawlerTypes.slice(0, 6).join(', ')}${crawlerTypes.length > 6 ? '...' : ''}. Results will save back to this profile.`
                                  : 'Crawler OS accepted the profile request. Results will save back to this profile as jobs finish.',
                })
        },
        onError: (err) => {
                toast({ title: 'Crawler OS did not start', description: err?.message ?? 'Unknown error', variant: 'destructive' })
        },
  })

  const handleSearchNeeds = useCallback(() => {
        const checkedInferred = inferredNeeds
                .filter((s) => needsState.checked[s._key])
                .map((s) => s.name)
        const checkedCustom = needsState.customItems
                .filter((i) => needsState.checked[i.id])
                .map((i) => i.name)
        const allChecked = [...checkedInferred, ...checkedCustom].filter(Boolean)
        if (allChecked.length === 0) return

        const parsed = allChecked
          .flatMap((t) => String(t).toLowerCase().trim().split(/\s+/))
          .filter(Boolean)
        if (parsed.length === 0) return

        const query = allChecked.join(" ")
        setSearchQuery(query)
        setParsedSearchTerms(parsed)
        setIntentSummary("")
        // Only flip into the "searching needs" state once we know there is a
        // valid, non-empty query to run.
        setIsSearchingNeeds(true)

        // Force refetch even if keywords haven't changed
        queryClient.invalidateQueries({ queryKey: ["smart-matcher"] })

        // Toast feedback
        toast({ title: `Searching ${allChecked.length} selected need${allChecked.length === 1 ? "" : "s"}...` })
  }, [inferredNeeds, needsState, setSearchQuery, queryClient, toast])

  // -- Matching data --
  const { data: scoredResponse, isLoading: isScoring } = useQuery({
        queryKey: ['smart-matcher', selectedProfileId, minScore, searchQuery, parsedSearchTerms, intentPrimaryCategory, intentExcludedCategories.join('|'), freeTextNeed],
        queryFn: async () => {
                if (!selectedProfileId || selectedProfileId === 'all') {
                          return { opportunities: [], total_scored: 0, returned: 0 }
                }
                const qs = new URLSearchParams()
                qs.set('min_score', String(minScore))
                qs.set('limit', '500')
                qs.set('skip_readiness_check', '1')
                // Honor the min-match slider as a HARD floor: strict mode tells
                // the backend not to relax the threshold to "show something".
                // Nothing below `minScore` may appear. (Mirrors DiscoverGrants.)
                qs.set('strict', '1')
                qs.set('allow_relax', '0')
                qs.set('relax', '0')
                // The backend's zero-result recovery checks `no_fallback`; without
                // it, it relaxes the threshold and wastes work the UI then discards.
                qs.set('no_fallback', '1')
                const fromIntent =
                  Array.isArray(parsedSearchTerms) && parsedSearchTerms.length > 0
                    ? parsedSearchTerms.map((t) => String(t).toLowerCase().trim()).filter(Boolean)
                    : null
                // Split multi-word manual queries into individual terms so they use
                // OR (q_terms) semantics rather than matching one long literal phrase.
                const manual = searchQuery?.trim()
                  ? searchQuery.trim().toLowerCase().split(/\s+/).filter(Boolean)
                  : []
                const terms = fromIntent && fromIntent.length > 0 ? fromIntent : manual
                if (terms.length === 1) {
                  qs.set('q', terms[0])
                } else if (terms.length > 1) {
                  for (const t of terms) {
                    qs.append('q_terms', t)
                  }
                }
                if (intentPrimaryCategory) {
                  qs.set('primary_category', String(intentPrimaryCategory))
                }
                if (Array.isArray(intentExcludedCategories) && intentExcludedCategories.length > 0) {
                  qs.set('excluded_categories', intentExcludedCategories.join(','))
                }
                if (freeTextNeed.trim()) {
                  qs.set('need_text', freeTextNeed.trim())
                }
                return await apiFetch(`/api/matching/profile/${selectedProfileId}/opportunities?${qs.toString()}`)
        },
        enabled: Boolean(selectedProfileId) && selectedProfileId !== 'all',
        staleTime: 60_000,
  })

  useEffect(() => {
        // Only react to a needs-search that was explicitly initiated. When scoring
        // settles, reset the flag deterministically and scroll to results if the
        // anchor is mounted; otherwise just clear the flag (no silent surprise
        // scroll on unrelated refetches and no scroll when results are absent).
        if (isScoring || !isSearchingNeeds) return
        setIsSearchingNeeds(false)
        const anchor = document.getElementById("match-results")
        if (anchor) {
                anchor.scrollIntoView({ behavior: "smooth" })
        }
  }, [isScoring, isSearchingNeeds])

  const scoredOpportunities = useMemo(() => {
        const payload = scoredResponse?.data ?? scoredResponse ?? {}
              const rows = payload?.opportunities ?? []
                    return Array.isArray(rows) ? rows : []
  }, [scoredResponse])

  // Feature A: backend returns discovery_pending:true when this profile has
  // never had discovery run \u2014 show a run-discovery prompt instead of an empty
  // list. Feature B: score_histogram drives the guidance band (graceful when
  // absent on older responses).
  const discoveryPending = useMemo(() => {
        const payload = scoredResponse?.data ?? scoredResponse ?? {}
        return Boolean(payload?.discovery_pending)
  }, [scoredResponse])
  const scoreHistogram = useMemo(() => {
        const payload = scoredResponse?.data ?? scoredResponse ?? {}
        const buckets = payload?.score_histogram
        return Array.isArray(buckets) ? buckets : []
  }, [scoredResponse])

  // Architecture P1: high-value profile fields that, if filled, would unlock or
  // improve this profile's matches. Present in both the discovery_pending and
  // the normal response. Surfaced as encouraging prompts, never a gate.
  const profileFieldPrompts = useMemo(() => {
        const payload = scoredResponse?.data ?? scoredResponse ?? {}
        const prompts = payload?.profile_field_prompts
        return Array.isArray(prompts) ? prompts : []
  }, [scoredResponse])

  const promotionSummary = useMemo(() => {
        const payload = scoredResponse?.data ?? scoredResponse ?? {}
        const summary = payload?.promotion_summary
        return summary && typeof summary === 'object' ? summary : null
  }, [scoredResponse])

  const { data: profileFundingSourcesResponse, isLoading: isProfileFundingSourcesLoading } = useQuery({
        queryKey: ['smart-profile-funding-sources', selectedProfileId],
        queryFn: () => listProfileFundingSources(selectedProfileId, { minScore: 0 }),
        enabled: Boolean(selectedProfileId) && selectedProfileId !== 'all',
        staleTime: 60_000,
  })

  const profileFundingSources = useMemo(() => {
        const payload = profileFundingSourcesResponse?.data ?? profileFundingSourcesResponse ?? {}
        const rows = Array.isArray(payload.sources) ? payload.sources : []
        return rows
          .filter((source) => {
            const decision = String(source?.match_decision || '').toLowerCase()
            return source?.is_directory || decision === 'accept' || decision === 'review'
          })
          .sort((a, b) => Number(b?.match_score ?? 0) - Number(a?.match_score ?? 0))
  }, [profileFundingSourcesResponse])

  const filteredOpportunities = useMemo(() => {
        // Defense in depth: even if any backend path leaks a sub-threshold row,
        // the UI honors the slider as a HARD floor \u2014 nothing below minScore shows.
        const floor = Math.min(MIN_SCORE_SLIDER_MAX, Math.max(0, Number(minScore) || 0))
        return [...scoredOpportunities]
          .filter((o) => {
            const score = Number(o.match_score ?? o.match ?? -Infinity)
            return Number.isFinite(score) && score >= floor
          })
          .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
  }, [scoredOpportunities, minScore])

  const topMatches = filteredOpportunities.filter(o => (o.match_score ?? 0) >= STRONG_MATCH_SCORE)
    const goodMatches = filteredOpportunities.filter(o => (o.match_score ?? 0) >= GOOD_MATCH_SCORE && (o.match_score ?? 0) < STRONG_MATCH_SCORE)
    const allQualified = filteredOpportunities
    const recordedQualifiedCount = Number.isFinite(Number(promotionSummary?.qualified))
      ? Number(promotionSummary.qualified)
      : allQualified.length
    const morePlacesToLook = Number.isFinite(Number(promotionSummary?.more_places_to_look))
      ? Number(promotionSummary.more_places_to_look)
      : profileFundingSources.filter((source) => source?.is_directory).length
    const recordedRejectionReasons = Object.entries(promotionSummary?.reasons || {})
      .filter(([, count]) => Number(count) > 0)
      .sort((a, b) => Number(b[1]) - Number(a[1]))

  const handleOpenOpp = (opp) => { setSelectedOpp(opp) }

  const handleOpenLink = () => {
        const url = selectedOpp?.application_url ?? selectedOpp?.source_url ?? selectedOpp?.url ?? null
        if (!url || typeof url !== 'string') {
                toast({ title: 'No application link available', description: 'This opportunity does not include a valid URL yet.', variant: 'destructive' })
                return
        }
        let parsedUrl
        try {
                parsedUrl = new URL(url)
        } catch {
                toast({ title: 'Invalid application URL', description: 'The stored URL is malformed and cannot be opened.', variant: 'destructive' })
                return
        }
        if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
                toast({ title: 'Unsafe application URL', description: 'Only http and https links can be opened.', variant: 'destructive' })
                return
        }
        window.open(url, '_blank', 'noopener,noreferrer')
  }

  return (
        <div className="p-6 md:p-8">
              <div className="max-w-7xl mx-auto space-y-6">
                      <div>
                                <h1 className="text-3xl font-bold text-foreground flex items-center gap-2">
                                            <Sparkles className="w-8 h-8" /> Smart Matcher
                                </h1>
                                <p className="text-slate-600 mt-2">
                                            AI-powered opportunity matching based on your profile
                                </p>
                      </div>
              
                      <Card>
                                <CardHeader>
                                            <CardTitle>Match Configuration</CardTitle>
                                            <CardDescription>Select a profile and adjust matching criteria</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                            <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50/80 p-4">
                                              <Label className="text-slate-800">Describe what you need (free text)</Label>
                                              <p className="text-xs text-slate-600">
                                                Plain language is fine — for example bereavement travel, a passenger van, rent help, or medical equipment.
                                                We turn this into search terms and match against your profile (recall over strict keyword overlap).
                                              </p>
                                              <Textarea
                                                placeholder='e.g. "Help me find funding for an airplane ticket for bereavement" or "I need a 15 passenger van for our nonprofit"'
                                                value={freeTextNeed}
                                                onChange={(e) => setFreeTextNeed(e.target.value)}
                                                rows={3}
                                                className="resize-y bg-white"
                                              />
                                              <div className="flex flex-wrap items-center gap-2">
                                                <Button
                                                  type="button"
                                                  size="sm"
                                                  onClick={() => {
                                                    // Prompt instead of silently doing nothing when no profile is chosen.
                                                    if (!selectedProfileId || selectedProfileId === "all") {
                                                      toast({
                                                        variant: "destructive",
                                                        title: "Select a profile first",
                                                        description: "Choose a profile so we can match your request against it.",
                                                      })
                                                      return
                                                    }
                                                    interpretMutation.mutate()
                                                  }}
                                                  disabled={interpretMutation.isPending || !freeTextNeed.trim()}
                                                >
                                                  {interpretMutation.isPending ? (
                                                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                                  ) : (
                                                    <Sparkles className="w-4 h-4 mr-2" />
                                                  )}
                                                  Understand &amp; search
                                                </Button>
                                                {intentSummary ? (
                                                  <span className="text-xs text-slate-600 max-w-xl">{intentSummary}</span>
                                                ) : null}
                                              </div>
                                            </div>
                                            <div>
                                                          <Label>Profile</Label>
                                                          <ProfileSelect
                                                                            value={selectedProfileId}
                                                                            onValueChange={setSelectedProfileId}
                                                                            placeholder="Select a profile to match..."
                                                                          />
                                            </div>
                                            {/* Profile summary card */}
                                            {selectedProfile && selectedProfileId && selectedProfileId !== 'all' && (
                                              <Alert className="bg-blue-50 border-blue-200">
                                                <User className="h-4 w-4 text-blue-600" />
                                                <AlertDescription className="text-blue-800">
                                                  <span className="font-semibold">{selectedProfile.display_name || selectedProfile.name || 'Unnamed profile'}</span>
                                                  {(selectedProfile.primary_type || selectedProfile.applicant_type) && (
                                                    <Badge variant="outline" className="ml-2 text-xs border-blue-300 text-blue-700">
                                                      {(selectedProfile.primary_type || selectedProfile.applicant_type).replace(/_/g, ' ')}
                                                    </Badge>
                                                  )}
                                                  {selectedProfile.state && (
                                                    <span className="ml-2 inline-flex items-center gap-1 text-xs text-blue-600">
                                                      <MapPin className="w-3 h-3" />
                                                      {[selectedProfile.city, selectedProfile.state].filter(Boolean).join(', ')}
                                                    </span>
                                                  )}
                                                </AlertDescription>
                                              </Alert>
                                            )}
                                            <div className="grid md:grid-cols-2 gap-4">
                                                          <div>
                                                                          <Label>Search keywords (optional override)</Label>
                                                                          <div className="relative">
                                                                                            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                                                                                            <Input
                                                                                                                  placeholder="Single phrase filter, or edit after Understand & search..."
                                                                                                                  value={searchQuery}
                                                                                                                  onChange={(e) => {
                                                                                                                    setSearchQuery(e.target.value)
                                                                                                                    setParsedSearchTerms(null)
                                                                                                                    setIntentSummary("")
                                                                                                                  }}
                                                                                                                  className="pl-10"
                                                                                                                />
                                                                          </div>
                                                                          {parsedSearchTerms && parsedSearchTerms.length > 1 ? (
                                                                            <p className="text-xs text-slate-500 mt-1">
                                                                              Matching opportunities that mention any of:{" "}
                                                                              {parsedSearchTerms.slice(0, 8).join(" \u00b7 ")}
                                                                              {parsedSearchTerms.length > 8 ? " ..." : ""}
                                                                            </p>
                                                                          ) : null}
                                                          </div>
                                                          <div>
                                                                          <Label>Minimum match score</Label>
                                                                          {/* Feature B: data-driven, color-coded guidance band (data-point scale, 0..30+). */}
                                                                          <MatchScoreGuidanceBand histogram={scoreHistogram} max={MIN_SCORE_SLIDER_MAX} value={minScore} />
                                                                          <div className="flex items-center gap-2">
                                                                                            <SlidersHorizontal className="w-4 h-4 text-slate-400" />
                                                                                            <input
                                                                                                                  type="range" min="0" max={MIN_SCORE_SLIDER_MAX} step="1"
                                                                                                                  value={Math.min(MIN_SCORE_SLIDER_MAX, minScore)}
                                                                                                                  onChange={(e) => setMinScore(Number(e.target.value))}
                                                                                                                  className="flex-1"
                                                                                                                />
                                                                                            <span className="text-sm font-medium whitespace-nowrap text-right">Score &ge; {minScore} &middot; {minScoreBandLabel(minScore)}</span>
                                                                          </div>
                                                          </div>
                                            </div>
                                  {selectedProfileId && selectedProfileId !== 'all' && (
                        <div className="flex items-center justify-between gap-4">
                          <div className="text-xs text-slate-600">
                            {isScoring
                              ? 'Scoring opportunities using full profile data...'
                              : `Showing ${filteredOpportunities.length} server-scored match${filteredOpportunities.length === 1 ? '' : 'es'}${profileFundingSources.length ? `; ${profileFundingSources.length} Crawler OS profile source${profileFundingSources.length === 1 ? '' : 's'} saved` : ''}`}
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => discoverAllMutation.mutate()}
                            disabled={discoverAllMutation.isPending}
                            className="shrink-0 border-emerald-300 text-emerald-700 hover:bg-emerald-50"
                          >
                            {discoverAllMutation.isPending ? (
                              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            ) : (
                              <Zap className="w-4 h-4 mr-2" />
                            )}
                            {discoverAllMutation.isPending ? 'Starting Crawler OS...' : 'Run Crawler OS'}
                          </Button>
                        </div>
                                            )}
                                </CardContent>
                      </Card>
              
                {/* ----------------------------------------------------------------- */}
                {/* Search by Profile Needs \u2013 inferred needs checklist              */}
                {/* ----------------------------------------------------------------- */}
                {selectedProfileId && selectedProfileId !== 'all' && (
                    <Card>
                                <CardHeader className="pb-3">
                                              <CardTitle className="flex items-center gap-2 text-lg">
                                                              <Target className="w-5 h-5 text-blue-600" />
                                                              Search by Profile Needs
                                              </CardTitle>
                                              <CardDescription>
                                                              Select inferred needs to build a search query, or add your own.
                                              </CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-3">
                                  {isSuggestionsLoading ? (
                                      <div className="space-y-2">
                                          {[1, 2, 3].map((n) => (
                                              <div key={n} className="h-6 bg-slate-100 rounded animate-pulse" />
                                          ))}
                                      </div>
                                  ) : inferredNeeds.length === 0 && needsState.customItems.length === 0 ? (
                                      <p className="text-sm text-slate-500 italic">No inferred needs for this profile.</p>
                                  ) : (
                                      <>
                                          {inferredNeeds.map((suggestion) => {
                                              const isNeedChecked = !!needsState.checked[suggestion._key]
                                              const reasonText = Array.isArray(suggestion.reasons)
                                                  ? humanizeMatchReason(suggestion.reasons[0])
                                                  : ''
                                              return (
                                              <div key={suggestion._key}>
                                                <div className="flex items-center gap-3">
                                                  <Checkbox
                                                      id={`need-${suggestion._key}`}
                                                      checked={isNeedChecked}
                                                      onCheckedChange={() => toggleNeed(suggestion._key)}
                                                  />
                                                  <label
                                                      htmlFor={`need-${suggestion._key}`}
                                                      className={`flex-1 text-sm cursor-pointer select-none ${isNeedChecked ? "font-medium text-blue-900" : "text-slate-700"}`}
                                                  >
                                                      {suggestion.name}
                                                  </label>
                                                  {isNeedChecked && (
                                                      <Badge variant="secondary" className="text-xs border-blue-200 bg-blue-50 text-blue-700">
                                                          Selected
                                                      </Badge>
                                                  )}
                                                  {suggestion.category && (
                                                      <Badge variant="outline" className="text-xs capitalize">
                                                          {suggestion.category.replace(/_/g, " ")}
                                                      </Badge>
                                                  )}
                                                </div>
                                                {reasonText && (
                                                  <p className="ml-10 mt-0.5 text-xs text-slate-500 leading-snug">{reasonText}</p>
                                                )}
                                              </div>
                                              )
                                          })}
                                          {needsState.customItems.map((item) => (
                                              <div key={item.id} className="flex items-center gap-3 group">
                                                  <Checkbox
                                                      id={`need-${item.id}`}
                                                      checked={!!needsState.checked[item.id]}
                                                      onCheckedChange={() => toggleNeed(item.id)}
                                                  />
                                                  <label
                                                      htmlFor={`need-${item.id}`}
                                                      className={`flex-1 text-sm cursor-pointer select-none ${needsState.checked[item.id] ? "font-medium text-blue-900" : "text-slate-700"}`}
                                                  >
                                                      {item.name}
                                                  </label>
                                                  {needsState.checked[item.id] && (
                                                      <Badge variant="secondary" className="text-xs border-blue-200 bg-blue-50 text-blue-700">
                                                          Selected
                                                      </Badge>
                                                  )}
                                                  <button
                                                      type="button"
                                                      onClick={() => removeCustomNeed(item.id)}
                                                      className="opacity-0 group-hover:opacity-100 transition-opacity text-slate-400 hover:text-red-500"
                                                      title="Remove custom need"
                                                  >
                                                      <X className="w-4 h-4" />
                                                  </button>
                                              </div>
                                          ))}
                                      </>
                                  )}

                                  {/* Add custom need */}
                                  <div className="flex items-center gap-2 pt-2 border-t border-slate-100">
                                      <Plus className="w-4 h-4 text-slate-400 shrink-0" />
                                      <Input
                                          placeholder="Add a custom need..."
                                          value={newNeedText}
                                          onChange={(e) => setNewNeedText(e.target.value)}
                                          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCustomNeed() } }}
                                          className="h-8 text-sm"
                                      />
                                      <Button size="sm" variant="outline" onClick={addCustomNeed} disabled={!newNeedText.trim()}>
                                          Add
                                      </Button>
                                  </div>

                                  {/* Search button */}
                                  <div className="pt-2">
                                      <Button
                                          type="button"
                                          className="w-full"
                                          onClick={handleSearchNeeds}
                                          disabled={
                                              isSearchingNeeds ||
                                              ![...inferredNeeds.map((s) => s._key), ...needsState.customItems.map((i) => i.id)]
                                                  .some((id) => needsState.checked[id])
                                          }
                                      >
                                          {isSearchingNeeds ? (
                                              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                          ) : (
                                              <Search className="w-4 h-4 mr-2" />
                                          )}
                                          Search Selected Needs
                                      </Button>
                                  </div>
                                </CardContent>
                    </Card>
                )}

                {/* ----------------------------------------------------------------- */}
                {/* Profile Readiness — dynamic gaps from real profile data           */}
                {/* ----------------------------------------------------------------- */}
                {selectedProfileId && selectedProfileId !== 'all' && (
                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="flex items-center gap-2 text-lg">
                        <CheckSquare className="w-5 h-5 text-emerald-600" />
                        Profile Readiness
                        <Badge variant="outline" className="ml-auto text-sm">
                          {matchingGaps.completed}/{matchingGaps.total_items} complete
                        </Badge>
                      </CardTitle>
                      <CardDescription>
                        {matchingGaps.gaps.length > 0
                          ? "These items are missing from your profile and affect match quality. Click any item to fill it in."
                          : "Your profile has all the key data points for strong matches."
                        }
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {isGapsLoading ? (
                        <div className="space-y-2">
                          {[1, 2, 3].map((n) => (
                            <div key={n} className="h-10 bg-slate-100 rounded animate-pulse" />
                          ))}
                        </div>
                      ) : matchingGaps.gaps.length === 0 ? (
                        <Alert className="bg-emerald-50 border-emerald-200">
                          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                          <AlertDescription className="text-emerald-800">
                            All profile data points are filled in. Your profile is well-configured for matching.
                          </AlertDescription>
                        </Alert>
                      ) : (
                        <div className="space-y-2">
                          {matchingGaps.gaps.map((gap) => (
                            <div key={gap.id} className="group">
                              {gap.section_key ? (
                                <Link
                                  to={createPageUrl("ProfileDetail", { id: selectedProfileId, section: gap.section_key })}
                                  className="flex items-start gap-3 p-3 rounded-lg border border-slate-200 hover:border-blue-300 hover:bg-blue-50/50 transition-colors"
                                >
                                  <AlertTriangle className="w-4 h-4 mt-0.5 text-amber-500 shrink-0" />
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                      <span className="text-sm font-medium text-slate-900">{gap.label}</span>
                                      <Badge variant="outline" className={`text-xs ${IMPACT_COLORS[gap.impact] || ''}`}>
                                        {gap.impact}
                                      </Badge>
                                    </div>
                                    <p className="text-xs text-slate-500 mt-0.5 leading-snug">{gap.description}</p>
                                  </div>
                                  <ArrowRight className="w-4 h-4 mt-0.5 text-slate-400 group-hover:text-blue-500 shrink-0" />
                                </Link>
                              ) : (
                                <div className="flex items-start gap-3 p-3 rounded-lg border border-slate-200">
                                  <AlertTriangle className="w-4 h-4 mt-0.5 text-amber-500 shrink-0" />
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                      <span className="text-sm font-medium text-slate-900">{gap.label}</span>
                                      <Badge variant="outline" className={`text-xs ${IMPACT_COLORS[gap.impact] || ''}`}>
                                        {gap.impact}
                                      </Badge>
                                    </div>
                                    <p className="text-xs text-slate-500 mt-0.5 leading-snug">{gap.description}</p>
                                  </div>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                )}

                {/* ----------------------------------------------------------------- */}
                {/* What You Need for Success — real-world next steps                 */}
                {/* ----------------------------------------------------------------- */}
                {selectedProfileId && selectedProfileId !== 'all' && matchingGaps.success_steps.length > 0 && (
                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="flex items-center gap-2 text-lg">
                        <Lightbulb className="w-5 h-5 text-amber-500" />
                        What You Need for Success
                      </CardTitle>
                      <CardDescription>
                        Based on your goals and profile type, here are real-world steps to prepare for funding.
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-2">
                        {matchingGaps.success_steps.map((step, idx) => {
                          // Deep-link to the profile section this step actually
                          // fills. `profile_section` comes from
                          // successStepActions.enrichSuccessStep, which resolves
                          // it PER STEP (ACTION_PATTERNS) with a per-category
                          // fallback — deliberately finer than a category->section
                          // map, which would send every legal/compliance/
                          // governance/insurance/operations/safety step to the
                          // same place.
                          //
                          // Why this is worth wiring at all: match_score here is
                          // matched profile data points over total, so a card
                          // that lands the user on the exact unfilled section is
                          // on the product's own chain — better profile, better
                          // need determination, better sources. A step with no
                          // section (an external filing, a document upload) stays
                          // a plain row rather than a link that goes nowhere.
                          const target = step.profile_section
                          const body = (
                            <>
                              <div className="w-6 h-6 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center text-xs font-bold shrink-0">
                                {idx + 1}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-medium text-slate-900">{step.label}</span>
                                  <Badge variant="outline" className="text-xs capitalize">
                                    {step.category?.replace(/_/g, ' ')}
                                  </Badge>
                                </div>
                                {step.why && (
                                  <p className="text-xs text-slate-500 mt-0.5 leading-snug">{step.why}</p>
                                )}
                              </div>
                              {target && (
                                <ArrowRight className="w-4 h-4 mt-0.5 text-slate-400 group-hover:text-amber-600 shrink-0" />
                              )}
                            </>
                          )
                          const shell = "flex items-start gap-3 p-3 rounded-lg border border-slate-200 bg-amber-50/30"
                          return target ? (
                            <Link
                              key={idx}
                              to={createPageUrl("ProfileDetail", { id: selectedProfileId, section: target })}
                              className={`${shell} group transition-colors hover:bg-amber-50 hover:border-amber-300`}
                              aria-label={`${step.label} — open the ${String(target).replace(/_/g, ' ')} section of your profile`}
                            >
                              {body}
                            </Link>
                          ) : (
                            <div key={idx} className={shell}>{body}</div>
                          )
                        })}
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* ----------------------------------------------------------------- */}
                {/* Match Results                                                     */}
                {/* ----------------------------------------------------------------- */}
                {!selectedProfileId || selectedProfileId === 'all' ? (
                    <Card>
                      <CardContent className="p-12 text-center">
                        <Star className="w-16 h-16 mx-auto text-slate-300 mb-4" />
                        <h3 className="text-xl font-semibold text-slate-900 mb-2">Select a Profile</h3>
                        <p className="text-slate-600">Choose a profile above to see matched opportunities</p>
                      </CardContent>
                    </Card>
                  ) : discoveryPending && !isScoring ? (
                    /* Feature A: discovery has never run for this profile. */
                    <Card className="border-blue-200 bg-blue-50/50">
                      <CardContent className="p-12 text-center space-y-4">
                        <Sparkles className="w-12 h-12 mx-auto text-blue-500" />
                        <h3 className="text-xl font-semibold text-slate-900">Run discovery to see funding matches</h3>
                        <p className="text-slate-600 max-w-md mx-auto">
                          We haven&apos;t searched for funding for this profile yet. Run discovery to find grants, scholarships, benefits, and local programs matched to it.
                        </p>
                        <Button
                          onClick={() => discoverAllMutation.mutate()}
                          disabled={discoverAllMutation.isPending}
                          className="border-emerald-300 text-emerald-700 bg-white hover:bg-emerald-50"
                          variant="outline"
                        >
                          {discoverAllMutation.isPending ? (
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          ) : (
                            <Zap className="w-4 h-4 mr-2" />
                          )}
                          {discoverAllMutation.isPending ? 'Starting Crawler OS...' : 'Run discovery'}
                        </Button>
                        {/* Architecture P1: show what to complete now so the
                            first discovery returns better results. */}
                        {!improvePromptsDismissed && (
                          <div className="text-left max-w-xl mx-auto pt-2">
                            <ImproveMatchesCard
                              prompts={profileFieldPrompts}
                              profileId={selectedProfileId}
                              variant="prominent"
                              onDismiss={() => setImprovePromptsDismissed(true)}
                            />
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  ) : (
                    <>
                      {/* Architecture P1: compact "Improve your matches" banner above results. */}
                      {!improvePromptsDismissed && (
                        <ImproveMatchesCard
                          prompts={profileFieldPrompts}
                          profileId={selectedProfileId}
                          variant="banner"
                          onDismiss={() => setImprovePromptsDismissed(true)}
                        />
                      )}
                      <div id="match-results" className={`grid gap-4 ${morePlacesToLook > 0 ? "md:grid-cols-4" : "md:grid-cols-3"}`}>
                        <Card>
                          <CardHeader className="pb-2">
                            <CardTitle className="text-sm font-medium text-slate-600 flex items-center gap-2">
                              <Award className="w-4 h-4" /> Top Matches
                            </CardTitle>
                          </CardHeader>
                          <CardContent>
                            <div className="text-2xl font-bold">{topMatches.length}</div>
                            <p className="text-xs text-slate-600 mt-1">Score {STRONG_MATCH_SCORE}+ &middot; Best matches</p>
                          </CardContent>
                        </Card>
                        <Card>
                          <CardHeader className="pb-2">
                            <CardTitle className="text-sm font-medium text-slate-600 flex items-center gap-2">
                              <TrendingUp className="w-4 h-4" /> Good Matches
                            </CardTitle>
                          </CardHeader>
                          <CardContent>
                            <div className="text-2xl font-bold">{goodMatches.length}</div>
                            <p className="text-xs text-slate-600 mt-1">Score {GOOD_MATCH_SCORE}&ndash;{STRONG_MATCH_SCORE - 1}</p>
                          </CardContent>
                        </Card>
                        <Card>
                          <CardHeader className="pb-2">
                            <CardTitle className="text-sm font-medium text-slate-600 flex items-center gap-2">
                              <Filter className="w-4 h-4" /> All Qualified
                            </CardTitle>
                          </CardHeader>
                          <CardContent>
                            <div className="text-2xl font-bold">{recordedQualifiedCount}</div>
                            <p className="text-xs text-slate-600 mt-1">Recorded live admissions</p>
                            {recordedRejectionReasons.length > 0 && (
                              <p className="text-xs text-slate-500 mt-1">
                                Why others were held: {recordedRejectionReasons.slice(0, 2).map(([reason, count]) => `${count} ${reason.replace(/_/g, ' ')}`).join(', ')}
                              </p>
                            )}
                          </CardContent>
                        </Card>
                        {morePlacesToLook > 0 && (
                          <Card className="border-emerald-200 bg-emerald-50/40">
                            <CardHeader className="pb-2">
                              <CardTitle className="text-sm font-medium text-emerald-800 flex items-center gap-2">
                                <FolderOpen className="w-4 h-4" /> More places to look
                              </CardTitle>
                            </CardHeader>
                            <CardContent>
                              <div className="text-2xl font-bold text-emerald-900">{morePlacesToLook}</div>
                              <p className="text-xs text-emerald-800 mt-1">REVIEW-tier locators, not failed qualifications</p>
                              <Button asChild variant="link" className="h-auto p-0 text-xs text-emerald-800">
                                <Link to={createPageUrl("ProfileDetail", { id: selectedProfileId, tab: "pipeline", focus: "profile-funding-sources" })}>
                                  Open Crawler OS list
                                  <ArrowRight className="ml-1 h-3 w-3" />
                                </Link>
                              </Button>
                            </CardContent>
                          </Card>
                        )}
                      </div>

                      <Tabs defaultValue={topMatches.length > 0 ? "top" : "all"} className="space-y-4">
                        <TabsList>
                          <TabsTrigger value="top">Top Matches ({topMatches.length})</TabsTrigger>
                          <TabsTrigger value="all">All Matches ({filteredOpportunities.length})</TabsTrigger>
                        </TabsList>

                        <TabsContent value="top" className="space-y-4">
                          {topMatches.length > 0 ? (
                            <div className="space-y-3">
                              {topMatches.map((opp) => (
                                <Card key={opp.id} className="border-2 hover:border-blue-200 transition-colors">
                                  <CardContent className="p-4">
                                    <div className="flex items-start justify-between gap-4">
                                      <div className="flex-1">
                                        <div className="flex items-center gap-2 mb-2">
                                          <h3 className="font-semibold text-slate-900">{opp.title}</h3>
                                          <Badge variant="default" className="bg-green-600">
                                            {scoreBadgeText(opp.match_score)}
                                          </Badge>
                                        </div>
                                        <p className="text-sm text-slate-600 mb-2 line-clamp-2">{opp.description}</p>
                                        <div className="flex flex-wrap gap-2 text-xs text-slate-500">
                                          {opp.sponsor && <span>{"\u2022"} {opp.sponsor}</span>}
                                          {opp.state && <span>{"\u2022"} {opp.state}</span>}
                                          {opp.deadline && <span>{"\u2022"} Due: {opp.deadline}</span>}
                                        </div>
                                        {opp.match_reasons && opp.match_reasons.length > 0 && (
                                          <div className="mt-2 flex flex-wrap gap-1">
                                            {opp.match_reasons.slice(0, 6).map((reason, i) => {
                                              const text = humanizeMatchReason(reason)
                                              return text ? (
                                                <Badge key={i} variant="secondary" className="text-xs">{text}</Badge>
                                              ) : null
                                            })}
                                          </div>
                                        )}
                                      </div>
                                      <Button size="sm" onClick={() => handleOpenOpp(opp)}>View</Button>
                                    </div>
                                  </CardContent>
                                </Card>
                              ))}
                            </div>
                          ) : (
                            <Card>
                              <CardContent className="p-12 text-center">
                                <p className="text-slate-600">No top matches found. Try adjusting your criteria or check the All Matches tab.</p>
                              </CardContent>
                            </Card>
                          )}
                        </TabsContent>

                        <TabsContent value="all" className="space-y-4">
                          {filteredOpportunities.length > 0 ? (
                            <div className="space-y-3">
                              {filteredOpportunities.map((opp) => (
                                <Card key={opp.id} className="hover:border-slate-300 transition-colors">
                                  <CardContent className="p-4">
                                    <div className="flex items-start justify-between gap-4">
                                      <div className="flex-1">
                                        <div className="flex items-center gap-2 mb-2">
                                          <h3 className="font-semibold text-slate-900">{opp.title}</h3>
                                          <Badge variant={(opp.match_score ?? 0) >= STRONG_MATCH_SCORE ? "default" : "secondary"}>
                                            {scoreBadgeText(opp.match_score)}
                                          </Badge>
                                        </div>
                                        <p className="text-sm text-slate-600 mb-2 line-clamp-2">{opp.description}</p>
                                        <div className="flex flex-wrap gap-2 text-xs text-slate-500">
                                          {opp.sponsor && <span>{"\u2022"} {opp.sponsor}</span>}
                                          {opp.state && <span>{"\u2022"} {opp.state}</span>}
                                          {opp.deadline && <span>{"\u2022"} Due: {opp.deadline}</span>}
                                        </div>
                                      </div>
                                      <Button size="sm" variant="outline" onClick={() => handleOpenOpp(opp)}>View</Button>
                                    </div>
                                  </CardContent>
                                </Card>
                              ))}
                            </div>
                          ) : (
                            <Card>
                              <CardContent className="p-6 md:p-10 text-center">
                                <div className="space-y-4">
                                  {profileFundingSources.length > 0 || isProfileFundingSourcesLoading ? (
                                    <CrawlerOsSourcePreview
                                      sources={profileFundingSources}
                                      profileId={selectedProfileId}
                                      isLoading={isProfileFundingSourcesLoading}
                                      onRunDiscovery={() => discoverAllMutation.mutate()}
                                      isRunning={discoverAllMutation.isPending}
                                    />
                                  ) : (
                                    <>
                                      <p className="text-slate-600">
                                        No server-scored matches found at the current score and keyword settings.
                                      </p>
                                      <div className="flex flex-wrap justify-center gap-2">
                                        <Button
                                          type="button"
                                          variant="outline"
                                          onClick={() => {
                                            setMinScore(0)
                                            setSearchQuery("")
                                            setParsedSearchTerms(null)
                                            setIntentSummary("")
                                            queryClient.invalidateQueries({ queryKey: ["smart-matcher"] })
                                          }}
                                        >
                                          Clear filters and show broad matches
                                        </Button>
                                        <Button
                                          type="button"
                                          onClick={() => discoverAllMutation.mutate()}
                                          disabled={discoverAllMutation.isPending}
                                        >
                                          {discoverAllMutation.isPending ? (
                                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                          ) : (
                                            <Zap className="w-4 h-4 mr-2" />
                                          )}
                                          Run full discovery
                                        </Button>
                                      </div>
                                    </>
                                  )}
                                  {matchingGaps.gaps.length > 0 && (
                                    <Alert className="bg-amber-50 border-amber-200 text-left">
                                      <AlertDescription className="text-amber-800 text-sm">
                                        <span className="font-semibold">Profile tip:</span> Your profile is missing {matchingGaps.gaps.length} data point{matchingGaps.gaps.length === 1 ? '' : 's'} that affect match quality.
                                        Scroll up to the Profile Readiness section and click any item to fix it.
                                      </AlertDescription>
                                    </Alert>
                                  )}
                                </div>
                              </CardContent>
                            </Card>
                          )}
                        </TabsContent>
                      </Tabs>
                    </>
                  )}

                <Dialog open={Boolean(selectedOpp)} onOpenChange={(open) => !open && setSelectedOpp(null)}>
                  <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
                    <DialogHeader>
                      <DialogTitle>{selectedOpp?.title ?? 'Opportunity'}</DialogTitle>
                      <DialogDescription>
                        {(selectedOpp?.sponsor || selectedOpp?.state || selectedOpp?.deadline)
                          ? [
                              selectedOpp?.sponsor ? `Sponsor: ${selectedOpp.sponsor}` : null,
                              selectedOpp?.state ? `State: ${selectedOpp.state}` : null,
                              selectedOpp?.deadline ? `Deadline: ${selectedOpp.deadline}` : null,
                            ].filter(Boolean).join(' \u2022 ')
                          : 'Details'}
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4">
                      {selectedOpp?.description && (
                        <div className="text-sm text-slate-700 whitespace-pre-wrap">{selectedOpp.description}</div>
                      )}
                      {Array.isArray(selectedOpp?.match_reasons) && selectedOpp.match_reasons.length > 0 && (
                        <div className="space-y-2">
                          <div className="text-sm font-semibold text-slate-900">Why this matched</div>
                          <div className="flex flex-wrap gap-1">
                            {selectedOpp.match_reasons.map((reason, idx) => {
                              const text = humanizeMatchReason(reason)
                              return text ? (
                                <Badge key={idx} variant="secondary" className="text-xs">{text}</Badge>
                              ) : null
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setSelectedOpp(null)}>Close</Button>
                      <Button onClick={handleOpenLink}>Open link</Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>
        </div>
      )
}
