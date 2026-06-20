import React, { useMemo, useState, useCallback, useEffect, useRef } from "react"
import { Sparkles, Search, Filter, SlidersHorizontal, Star, TrendingUp, Award, Plus, X, CheckSquare, Target, Loader2, MapPin, User, Zap, ArrowRight, CheckCircle2, AlertTriangle, Lightbulb } from "lucide-react"
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
import { runSmartCrawler } from "@/api/crawlers"
import { interpretMatcherIntent, getMatchingGaps } from "@/api/matching"
import ProfileSelect from "@/components/shared/ProfileSelect"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useToast } from "@/components/ui/use-toast"
import { Link } from "react-router-dom"
import { createPageUrl } from "@/utils"
import { formatReasonText } from "@/utils/reasonText"

// ---------------------------------------------------------------------------
// Persistent needs helpers – stored in localStorage keyed per profile
// ---------------------------------------------------------------------------

const NEEDS_STORAGE_PREFIX = "grantflow:matcher-needs:"

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
    } catch { /* ignore quota errors */ }
}

// Impact badge colors for profile gaps
const IMPACT_COLORS = {
  critical: "bg-red-100 text-red-700 border-red-200",
  high: "bg-amber-100 text-amber-700 border-amber-200",
  medium: "bg-blue-100 text-blue-700 border-blue-200",
}

export default function SmartMatcher() {
    const [selectedProfileId, setSelectedProfileId] = useState("")
    const [searchQuery, setSearchQuery] = useState("")
    /** When set, catalog query uses OR across these terms (from “Understand & search”). */
    const [parsedSearchTerms, setParsedSearchTerms] = useState(null)
    const [intentSummary, setIntentSummary] = useState("")
    // Captured from interpretMatcherIntent so the catalog query can skip
    // SSI/SNAP/TANF when the user is searching for professional development /
    // continuing education funding (Smart Matcher spec §3, §4).
    const [intentPrimaryCategory, setIntentPrimaryCategory] = useState(null)
    const [intentExcludedCategories, setIntentExcludedCategories] = useState([])
    const [intentBrandedProgram, setIntentBrandedProgram] = useState(null)
    const [intentCredentials, setIntentCredentials] = useState([])
    const [freeTextNeed, setFreeTextNeed] = useState("")
    const [minScore, setMinScore] = useState(50)
    const [selectedOpp, setSelectedOpp] = useState(null)
    const { toast } = useToast()
    const queryClient = useQueryClient()
    const [isSearchingNeeds, setIsSearchingNeeds] = useState(false)
    // Tracks which profile we already auto-populated keywords for (avoids re-populating on re-render)
    const autoPopulatedProfileRef = useRef(null)

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

  // Load needs when profile changes
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
        const id = "need_custom_" + Date.now()
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
        return Array.isArray(suggestions) ? suggestions : []
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

  // -- Smart crawler mutation --
  const interpretMutation = useMutation({
    mutationFn: () => interpretMatcherIntent(freeTextNeed),
    onSuccess: (raw) => {
      const payload = raw?.data ?? raw ?? {}
      const terms = Array.isArray(payload.search_terms) ? payload.search_terms.filter(Boolean) : []
      if (terms.length === 0) {
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
      toast({
        title: "Could not interpret request",
        description: err?.message ?? "Try again or use keywords below.",
        variant: "destructive",
      })
    },
  })

  const crawlMutation = useMutation({
        mutationFn: () => runSmartCrawler({
        profileId: selectedProfileId,
        minMatchScore: minScore,
        state: selectedProfile?.state ?? undefined,
        city: selectedProfile?.city ?? undefined,
        applicantType: selectedProfile?.primary_type ?? selectedProfile?.applicant_type ?? undefined,
        primaryCategory: intentPrimaryCategory ?? undefined,
        intentTerms: Array.isArray(parsedSearchTerms) ? parsedSearchTerms : undefined,
}),
        onSuccess: (data) => {
                queryClient.invalidateQueries({ queryKey: ['smart-matcher'] })
                const count = data?.count ?? 0
                toast({
                        title: `Found ${count} new opportunit${count === 1 ? 'y' : 'ies'}`,
                        description: data?.sources_used?.length
                                ? `Sources: ${data.sources_used.join(', ')}`
                                : 'Matching results refreshed.',
                })
        },
        onError: (err) => {
                toast({ title: 'Crawl failed', description: err?.message ?? 'Unknown error', variant: 'destructive' })
        },
  })

  const handleSearchNeeds = useCallback(() => {
        const checkedInferred = inferredNeeds
                .filter((s) => needsState.checked[s.name])
                .map((s) => s.name)
        const checkedCustom = needsState.customItems
                .filter((i) => needsState.checked[i.id])
                .map((i) => i.name)
        const allChecked = [...checkedInferred, ...checkedCustom]
        if (allChecked.length === 0) return

        const query = allChecked.join(" ")
        setSearchQuery(query)
        setParsedSearchTerms(
          allChecked.map((t) => String(t).toLowerCase().trim()).filter(Boolean),
        )
        setIntentSummary("")
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
                const fromIntent =
                  Array.isArray(parsedSearchTerms) && parsedSearchTerms.length > 0
                    ? parsedSearchTerms.map((t) => String(t).toLowerCase().trim()).filter(Boolean)
                    : null
                const manual = searchQuery?.trim() ? [searchQuery.trim().toLowerCase()] : []
                const terms = fromIntent && fromIntent.length > 0 ? fromIntent : manual
                if (terms.length === 1) {
                  qs.set('q', terms[0])
                } else                 if (terms.length > 1) {
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
        if (!isScoring && isSearchingNeeds) {
                setIsSearchingNeeds(false)
                document.getElementById("match-results")?.scrollIntoView({ behavior: "smooth" })
        }
  }, [isScoring, isSearchingNeeds])

  const scoredOpportunities = useMemo(() => {
        const payload = scoredResponse?.data ?? scoredResponse ?? {}
              const rows = payload?.opportunities ?? []
                    return Array.isArray(rows) ? rows : []
  }, [scoredResponse])

  const filteredOpportunities = useMemo(() => {
        // Defense in depth: even if any backend path leaks a sub-threshold row,
        // the UI honors the slider as a HARD floor — nothing below minScore shows.
        const floor = Math.min(100, Math.max(0, Number(minScore) || 0))
        return [...scoredOpportunities]
          .filter((o) => {
            const score = Number(o.match_score ?? o.match ?? -Infinity)
            return Number.isFinite(score) && score >= floor
          })
          .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
  }, [scoredOpportunities, minScore])

  const topMatches = filteredOpportunities.filter(o => (o.match_score ?? 0) >= 85)
    const goodMatches = filteredOpportunities.filter(o => (o.match_score ?? 0) >= 70 && (o.match_score ?? 0) < 85)
    const allQualified = filteredOpportunities

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
                                <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-2">
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
                                                  onClick={() => interpretMutation.mutate()}
                                                  disabled={interpretMutation.isPending || !freeTextNeed.trim() || !selectedProfileId || selectedProfileId === "all"}
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
                                                                                                                  placeholder="Single phrase filter, or edit after “Understand & search”…"
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
                                                                              {parsedSearchTerms.slice(0, 8).join(" · ")}
                                                                              {parsedSearchTerms.length > 8 ? " …" : ""}
                                                                            </p>
                                                                          ) : null}
                                                          </div>
                                                          <div>
                                                                          <Label>Minimum match score</Label>
                                                                          <div className="flex items-center gap-2">
                                                                                            <SlidersHorizontal className="w-4 h-4 text-slate-400" />
                                                                                            <input
                                                                                                                  type="range" min="0" max="100"
                                                                                                                  value={minScore}
                                                                                                                  onChange={(e) => setMinScore(Number(e.target.value))}
                                                                                                                  className="flex-1"
                                                                                                                />
                                                                                            <span className="text-sm font-medium w-12 text-right">{minScore}%</span>
                                                                          </div>
                                                          </div>
                                            </div>
                                  {selectedProfileId && selectedProfileId !== 'all' && (
                        <div className="flex items-center justify-between gap-4">
                          <div className="text-xs text-slate-600">
                            {isScoring ? 'Scoring opportunities using full profile data\u2026' : `Showing ${filteredOpportunities.length} matches (server-scored)`}
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => crawlMutation.mutate()}
                            disabled={crawlMutation.isPending}
                            className="shrink-0 border-emerald-300 text-emerald-700 hover:bg-emerald-50"
                          >
                            {crawlMutation.isPending ? (
                              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            ) : (
                              <Zap className="w-4 h-4 mr-2" />
                            )}
                            {crawlMutation.isPending ? 'Finding funding…' : 'Find New Funding'}
                          </Button>
                        </div>
                                            )}
                                </CardContent>
                      </Card>
              
                {/* ----------------------------------------------------------------- */}
                {/* Search by Profile Needs – inferred needs checklist              */}
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
                                              const isNeedChecked = !!needsState.checked[suggestion.name]
                                              const reasonText = Array.isArray(suggestion.reasons)
                                                  ? formatReasonText(suggestion.reasons[0])
                                                  : ''
                                              return (
                                              <div key={suggestion.name}>
                                                <div className="flex items-center gap-3">
                                                  <Checkbox
                                                      id={`need-${suggestion.name}`}
                                                      checked={isNeedChecked}
                                                      onCheckedChange={() => toggleNeed(suggestion.name)}
                                                  />
                                                  <label
                                                      htmlFor={`need-${suggestion.name}`}
                                                      className={`flex-1 text-sm cursor-pointer select-none ${isNeedChecked ? "line-through text-slate-400" : "text-slate-700"}`}
                                                  >
                                                      {suggestion.name}
                                                  </label>
                                                  {suggestion.category && (
                                                      <Badge variant="outline" className="text-xs capitalize">
                                                          {suggestion.category.replace(/_/g, " ")}
                                                      </Badge>
                                                  )}
                                                </div>
                                                {reasonText && !isNeedChecked && (
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
                                                      className={`flex-1 text-sm cursor-pointer select-none ${needsState.checked[item.id] ? "line-through text-slate-400" : "text-slate-700"}`}
                                                  >
                                                      {item.name}
                                                  </label>
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
                                          placeholder="Add a custom need…"
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
                                              ![...inferredNeeds.map((s) => s.name), ...needsState.customItems.map((i) => i.id)]
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
                        {matchingGaps.success_steps.map((step, idx) => (
                          <div key={idx} className="flex items-start gap-3 p-3 rounded-lg border border-slate-200 bg-amber-50/30">
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
                          </div>
                        ))}
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
                  ) : (
                    <>
                      <div id="match-results" className="grid md:grid-cols-3 gap-4">
                        <Card>
                          <CardHeader className="pb-2">
                            <CardTitle className="text-sm font-medium text-slate-600 flex items-center gap-2">
                              <Award className="w-4 h-4" /> Top Matches
                            </CardTitle>
                          </CardHeader>
                          <CardContent>
                            <div className="text-2xl font-bold">{topMatches.length}</div>
                            <p className="text-xs text-slate-600 mt-1">85%+ match score</p>
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
                            <p className="text-xs text-slate-600 mt-1">70-84% match score</p>
                          </CardContent>
                        </Card>
                        <Card>
                          <CardHeader className="pb-2">
                            <CardTitle className="text-sm font-medium text-slate-600 flex items-center gap-2">
                              <Filter className="w-4 h-4" /> All Qualified
                            </CardTitle>
                          </CardHeader>
                          <CardContent>
                            <div className="text-2xl font-bold">{allQualified.length}</div>
                            <p className="text-xs text-slate-600 mt-1">{minScore}%+ match score</p>
                          </CardContent>
                        </Card>
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
                                            {opp.match_score ?? 0}% Match
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
                                              const text = formatReasonText(reason)
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
                                          <Badge variant={(opp.match_score ?? 0) >= 85 ? "default" : "secondary"}>
                                            {opp.match_score ?? 0}%
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
                              <CardContent className="p-12 text-center">
                                <div className="space-y-3">
                                  <p className="text-slate-600">No matches found. Try lowering the minimum score or adjusting keywords.</p>
                                  {matchingGaps.gaps.length > 0 && (
                                    <Alert className="bg-amber-50 border-amber-200">
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
                              const text = formatReasonText(reason)
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
