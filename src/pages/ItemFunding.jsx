import React, { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  Boxes,
  ClipboardList,
  DollarSign,
  ExternalLink,
  Filter,
  Layers,
  Loader2,
  MapPin,
  Shield,
  ShoppingCart,
  Sparkles,
  Target,
} from "lucide-react"
import { format } from "date-fns"
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { useToast } from "@/components/ui/use-toast"
import { listOpportunities, listOpportunityStates } from "@/api/opportunities"
import ProfileSelect from "@/components/shared/ProfileSelect"
import { getItemSuggestions } from "@/api/items"
import NeedsDiscoveryPanel from "@/components/ai/NeedsDiscoveryPanel"

const NOT_AVAILABLE = 'N/A'
import { listProfiles, getProfile } from "@/api/profiles"
import { searchSpecificNeed } from "@/api/crawlers"
import { cn } from "@/lib/utils"
import { useAuthStore } from "@/stores/authStore"
import { useTierEntitlements } from "@/hooks/useTierEntitlements"
import { formatReasonText } from "@/utils/reasonText"
import { createPageUrl } from "@/utils"
import OpportunitySourceTrace from "@/components/funding/OpportunitySourceTrace"
import ZeroResultGuidance from "@/components/funding/ZeroResultGuidance"

// Human-readable labels for the applicant type the backend detected from the
// selected profile. This is what makes the search visibly profile-aware: the
// user can see WHO we are searching as (which drives the funder categories).
const APPLICANT_TYPE_LABELS = {
  nonprofit: "Nonprofit / organization",
  school: "School / educator",
  business: "Small business",
  individual: "Individual",
}

function safeArray(value) {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function formatAmount(min, max) {
  const minNum = toNumberOrNull(min)
  const maxNum = toNumberOrNull(max)
  if (minNum === null && maxNum === null) return "Varies"
  if (minNum !== null && maxNum !== null && minNum !== maxNum) {
    return `$${minNum.toLocaleString()} \u2013 $${maxNum.toLocaleString()}`
  }
  const amount = (minNum ?? maxNum ?? 0).toLocaleString()
  return `$${amount}`
}

function formatDeadline(deadline, type) {
  if (!deadline) return type === "rolling" ? "Rolling deadline" : "Deadline TBD"
  try {
    const parsed = new Date(deadline)
    if (Number.isNaN(parsed.getTime())) {
      throw new Error("Invalid date value")
    }
    return format(parsed, "PPP")
  } catch (error) {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("Failed to parse deadline:", deadline, error)
    }
    return typeof deadline === "string" ? deadline : "Deadline TBD"
  }
}

function computeProfileSignals(profile) {
  if (!profile) return { tags: new Set(), strings: [] }
  const tags = new Set((profile.tags ?? []).map((tag) => tag.toLowerCase()))
  const strings = []

  ;(profile.sections ?? []).forEach((section) => {
    Object.entries(section.data ?? {}).forEach(([key, value]) => {
      if (typeof value === "boolean" && value) {
        tags.add(key.toLowerCase().replace(/_/g, " "))
      } else if (typeof value === "string" && value.trim()) {
        strings.push(value.toLowerCase())
      } else if (Array.isArray(value)) {
        value.forEach((entry) => {
          if (typeof entry === "string") strings.push(entry.toLowerCase())
        })
      }
    })
  })

  return { tags, strings }
}

function scoreItemMatch(opportunity, itemQuery, profileDetail) {
  const normalizedQuery = itemQuery.toLowerCase().trim()
  const queryTokens = normalizedQuery.split(/\s+/).filter(Boolean)
  const description = (opportunity.description || "").toLowerCase()
  const title = (opportunity.title || "").toLowerCase()

  let score = 40
  const reasons = []
  const overlap = []

  if (queryTokens.some((token) => title.includes(token))) {
    score += 20
    reasons.push("Item appears in title")
  }
  if (queryTokens.some((token) => description.includes(token))) {
    score += 15
    reasons.push("Item keywords appear in description")
  }

  if (opportunity.categories?.some((category) => /equipment|capital|vehicle|transport/i.test(category))) {
    score += 10
    reasons.push("Categorised as equipment/capital funding")
  }

  if (profileDetail) {
    const { tags, strings } = computeProfileSignals(profileDetail)
    const matchedTokens = queryTokens.filter(
      (token) => tags.has(token) || strings.some((entry) => entry.includes(token)),
    )
    if (matchedTokens.length) {
      score += 10
      overlap.push(...matchedTokens)
      reasons.push(`Profile mentions: ${matchedTokens.slice(0, 3).join(", ")}`)
    }
  }

  if (opportunity.deadline_type === "rolling") {
    score += 5
    reasons.push("Rolling deadline suitable for procurement")
  }

  const isNonRepayable =
    !opportunity.requires_match &&
    (opportunity.opportunity_type ? !/loan|debt|matching/i.test(opportunity.opportunity_type) : true) &&
    (opportunity.match_percentage === null || opportunity.match_percentage === undefined)

  if (!isNonRepayable) {
    score = Math.max(10, score - 25)
    reasons.push("This opportunity requires match funding or repayment")
  } else {
    reasons.push("Compliant: no match requirement, no loans")
  }

  return {
    score: Math.min(100, Math.round(score)),
    reasons,
    overlap,
    disqualified: !isNonRepayable,
  }
}

function ItemResultCard({ opportunity, match, onSelect }) {
  return (
    <Card
      className={cn(
        "border border-slate-200 bg-white/80 backdrop-blur hover:shadow-lg transition cursor-pointer flex flex-col",
        match?.disqualified ? "opacity-60" : "",
      )}
      onClick={() => onSelect(opportunity)}
    >
      <CardHeader className="pb-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Badge variant="outline" className="uppercase text-[11px] tracking-wide text-slate-500">
            {opportunity.source || "Crawler"}
          </Badge>
          <Badge variant={match?.disqualified ? "destructive" : "secondary"} className="text-xs">
            {match?.disqualified ? "Match required / loan" : opportunity.opportunity_type || "Grant"}
          </Badge>
        </div>
        <h3 className="text-lg font-semibold text-slate-900 line-clamp-2">{opportunity.title}</h3>
        <p className="text-sm text-slate-600 flex items-center gap-2">
          <MapPin className="w-4 h-4 text-slate-400" />
          {opportunity.is_national ? "National" : opportunity.state || "Location varies"}
        </p>
      </CardHeader>
      <CardContent className="space-y-3 flex-1">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm text-slate-600">
          <div className="flex items-center gap-2">
            <DollarSign className="w-4 h-4 text-slate-400" />
            <span>{formatAmount(opportunity.amount_min, opportunity.amount_max)}</span>
          </div>
          <div className="flex items-center gap-2">
            <ClipboardList className="w-4 h-4 text-slate-400" />
            <span>{formatDeadline(opportunity.deadline, opportunity.deadline_type)}</span>
          </div>
        </div>
        <p className="text-sm text-slate-600 line-clamp-3">{opportunity.description || "No summary available yet."}</p>
        {match ? (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs text-slate-500">
              <span className="uppercase font-semibold tracking-wide">Item match score</span>
              <span>{match.score}%</span>
            </div>
            <Progress value={match.score} className="h-2" />
            {match.disqualified ? (
              <p className="text-xs text-red-600">Requires matching funds or repayment.</p>
            ) : null}
          </div>
        ) : (
          <div className="rounded-md bg-slate-50 border border-dashed border-slate-200 p-2 text-xs text-slate-500">
            Enter the item and select a profile to generate a match score.
          </div>
        )}
      </CardContent>
      <CardFooter className="px-6 pb-4">
        <Button variant="outline" className="w-full" onClick={() => onSelect(opportunity)}>
          Inspect opportunity
        </Button>
      </CardFooter>
    </Card>
  )
}

function ItemResultDetail({ opportunity, match, open, onClose, profileName }) {
  if (!opportunity) return null
  const detailReasons =
    match?.reasons?.length > 0
      ? match.reasons
      : Array.isArray(opportunity.match_reasons)
      ? opportunity.match_reasons
      : []
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader className="space-y-2">
          <DialogTitle className="text-2xl font-semibold text-slate-900">{opportunity.title}</DialogTitle>
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Layers className="w-4 h-4" />
            <span>{opportunity.source || "Crawler"}</span>
            <span className="mx-2">{"\u2022"}</span>
            <span>{opportunity.sponsor || "Sponsor pending"}</span>
          </div>
        </DialogHeader>
        <ScrollArea className="max-h-[65vh] space-y-5 pr-2">
          <section className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm text-slate-600">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2">
              <p className="font-semibold text-slate-800 flex items-center gap-2">
                <MapPin className="w-4 h-4 text-slate-400" />
                Geography
              </p>
              <p>{opportunity.is_national ? "National coverage" : opportunity.state || "Varies"}</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2">
              <p className="font-semibold flex items-center gap-2 text-slate-800">
                <DollarSign className="w-4 h-4 text-slate-400" />
                Funding
              </p>
              <p>{formatAmount(opportunity.amount_min, opportunity.amount_max)}</p>
              <p className="text-xs text-slate-500 capitalize">
                {formatDeadline(opportunity.deadline, opportunity.deadline_type)}
              </p>
            </div>
          </section>

          <OpportunitySourceTrace
            opportunity={opportunity}
            match={match}
            profileName={profileName}
          />

          {match ? (
            <section className="rounded-xl border border-blue-200 bg-blue-50/80 p-4 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-blue-900 flex items-center gap-2">
                  <Target className="w-4 h-4" />
                  Item Match Score
                </p>
                <Badge className={match.disqualified ? "bg-red-600 text-white" : "bg-blue-600 text-white"}>
                  {match.score}%
                </Badge>
              </div>
              <Progress value={match.score} className="h-2" />
              <ul className="list-disc list-inside text-xs text-blue-900 space-y-1">
                {detailReasons.length > 0 ? (
                  detailReasons.map((reason, index) => {
                    const text = formatReasonText(reason)
                    return text ? <li key={`${text}-${index}`}>{text}</li> : null
                  })
                ) : (
                  <li>No explicit match reasons provided.</li>
                )}
              </ul>
            </section>
          ) : null}

          <section className="space-y-3">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-900">Overview</h3>
            <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-line">
              {opportunity.description || "No summary available yet."}
            </p>
          </section>

          {opportunity.eligibility_bullets?.length ? (
            <section className="space-y-3">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-900">Eligibility</h3>
              <ul className="list-disc list-inside text-sm text-slate-700 space-y-2">
                {opportunity.eligibility_bullets.map((bullet, index) => (
                  <li key={`${bullet}-${index}`}>{bullet}</li>
                ))}
              </ul>
            </section>
          ) : null}

          {opportunity.application_url ? (
            <section className="space-y-2">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-900">
                {opportunity.record_origin === "web_search" ? "Source Page (verify before applying)" : "Application Portal"}
              </h3>
              <Button
                variant="default"
                className="gap-2"
                onClick={() => window.open(opportunity.application_url, "_blank", "noopener,noreferrer")}
              >
                {opportunity.record_origin === "web_search" ? "Visit source" : "Visit portal"}
                <ExternalLink className="w-4 h-4" />
              </Button>
            </section>
          ) : null}
        </ScrollArea>
        <div className="pt-2 flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default function ItemFunding() {
  const { toast } = useToast()
  const user = useAuthStore((state) => state.user)
  const isAdmin = Boolean(user?.is_admin || user?.role === "admin" || user?.id === "admin")
  const [filters, setFilters] = useState({
    item: "",
    state: "all",
    includeNational: true,
    profileId: "all",
  })
  const [includeDisqualified, setIncludeDisqualified] = useState(false)
  const [selectedOpportunity, setSelectedOpportunity] = useState(null)
  const [submittedItem, setSubmittedItem] = useState("")
  // Live-search options: the "deeper sweep" action lowers the need-match floor,
  // the "donation or gift programs" action flips the web-query variant. Both
  // re-run the SAME live endpoint (the old item_search/item_gift_search crawler
  // jobs were retired with the legacy crawlers and no longer exist server-side).
  const [liveOptions, setLiveOptions] = useState({ minMatchScore: 15, variant: "funding" })

  const statesQuery = useQuery({
    queryKey: ["opportunity-states"],
    queryFn: () => listOpportunityStates(),
    staleTime: 5 * 60_000,
  })

  const profilesQuery = useQuery({
    queryKey: ["profiles"],
    queryFn: listProfiles,
    staleTime: 60_000,
  })

  const selectedProfileQuery = useQuery({
    queryKey: ["profile-detail", filters.profileId],
    queryFn: () => getProfile(filters.profileId),
    enabled: Boolean(filters.profileId) && filters.profileId !== "all",
  })

  const suggestionsQuery = useQuery({
    queryKey: ["item-suggestions", filters.profileId],
    queryFn: () => getItemSuggestions({ profileId: filters.profileId, limit: 10 }),
    enabled: Boolean(filters.profileId) && filters.profileId !== "all",
  })

  const opportunitiesQuery = useQuery({
    queryKey: ["item-funding", submittedItem, filters.state, filters.includeNational],
    queryFn: () =>
      listOpportunities({
        search: submittedItem || undefined,
        state: filters.state !== "all" ? filters.state : undefined,
        is_national: filters.includeNational ? undefined : "false",
        limit: 50,
      }),
    enabled: submittedItem.trim().length > 0,
  })

  // Live web + curated search via /specific-need (only when profile selected)
  const liveSearchQuery = useQuery({
    queryKey: ["item-live-search", submittedItem, filters.profileId, liveOptions.minMatchScore, liveOptions.variant],
    queryFn: () =>
      searchSpecificNeed({
        profileId: filters.profileId,
        needText: submittedItem,
        minMatchScore: liveOptions.minMatchScore,
        maxResults: 40,
        variant: liveOptions.variant,
      }),
    enabled: submittedItem.trim().length > 0 && Boolean(filters.profileId) && filters.profileId !== "all",
    retry: 1,
    staleTime: 5 * 60 * 1000,
  })

  const selectedProfile = selectedProfileQuery.data ?? null
  const itemEntitlements = useTierEntitlements(
    filters.profileId && filters.profileId !== "all" ? filters.profileId : null,
  )
  const selectedTier = itemEntitlements.tier ?? selectedProfile?.billing?.tier ?? null
  const canItemFunding = itemEntitlements.capabilities.itemFunding
  const hasSelectedProfile = Boolean(filters.profileId && filters.profileId !== "all")
  const opportunitiesResponse = opportunitiesQuery.data ?? null
  const opportunities = opportunitiesResponse?.data ?? []

  // Live search results from specific-need endpoint
  const liveResults = liveSearchQuery.data?.opportunities ?? []
  const liveWebCount = liveSearchQuery.data?.web_search_results ?? 0
  // Honest web-lane telemetry: distinguish "searched the web, found nothing"
  // from "live web search unavailable/disabled on the server".
  const webSearchAttempted = liveSearchQuery.data?.web_search?.attempted ?? false
  const liveSearchPartial = Boolean(liveSearchQuery.data?.timed_out)
  // Applicant type detected from the selected profile (drives profile-aware funder picks)
  const applicantType = liveSearchQuery.data?.applicant_type ?? null
  const applicantTypeLabel = APPLICANT_TYPE_LABELS[applicantType] ?? null

  const scoredResults = useMemo(() => {
    if (!submittedItem) return []
    const seenUrls = new Set()
    const merged = []

    // Live results first (already scored by backend)
    for (const opp of liveResults) {
      const urlKey = (opp.url || opp.application_url || '').toLowerCase().replace(/\/$/, '')
      if (urlKey && seenUrls.has(urlKey)) continue
      if (urlKey) seenUrls.add(urlKey)
      const isNationalValue =
        opp.is_national === undefined || opp.is_national === null ? false : Boolean(opp.is_national)
      merged.push({
        opportunity: {
          id: opp.id,
          title: opp.title,
          description: opp.description,
          url: opp.url || opp.application_url,
          application_url: opp.application_url || opp.url,
          source: opp.result_source === 'web_search' ? 'Live web search' : opp.source || opp.result_source || 'Live Search',
          categories: opp.categories || [],
          match_reasons: opp.need_match?.matchedTerms || opp.match_reasons || [],
          amount_min: toNumberOrNull(opp.amount_min),
          amount_max: toNumberOrNull(opp.amount_max),
          deadline: opp.deadline,
          deadline_type: opp.deadline_type || 'rolling',
          state: opp.state,
          is_national: isNationalValue,
          opportunity_type: opp.opportunity_type || opp.type || 'program',
          sponsor: opp.sponsor || opp.source,
          record_origin: opp.record_origin || null,
        },
        match: {
          score: opp.combined_score || opp.match_score || 50,
          reasons: [
            ...(opp.need_match?.matchedTerms || []),
            opp.result_source === 'web_search' ? 'Found via live web search' :
            opp.result_source === 'item_catalog' ? 'Known item source' :
            'Matched from curated data',
          ],
          overlap: [],
          disqualified: false,
        },
      })
    }

    // Static DB results (deduped against live)
    for (const opp of opportunities) {
      const urlKey = (opp.url || opp.application_url || opp.source_url || '').toLowerCase().replace(/\/$/, '')
      if (urlKey && seenUrls.has(urlKey)) continue
      if (urlKey) seenUrls.add(urlKey)
      const match = scoreItemMatch(opp, submittedItem, selectedProfile)
      const reasons =
        match.reasons?.length > 0
          ? match.reasons
          : Array.isArray(opp.match_reasons)
          ? opp.match_reasons
          : []
      merged.push({
        opportunity: opp,
        match: { ...match, reasons },
      })
    }

    return merged.sort((a, b) => b.match.score - a.match.score)
  }, [liveResults, opportunities, submittedItem, selectedProfile])

  const results = useMemo(() => {
    if (!scoredResults.length) return []
    return includeDisqualified ? scoredResults : scoredResults.filter(({ match }) => !match.disqualified)
  }, [includeDisqualified, scoredResults])

  const disqualifiedCount = useMemo(
    () => scoredResults.filter(({ match }) => match?.disqualified).length,
    [scoredResults],
  )

  // Look up the stored match for the selected opportunity so the detail dialog
  // mirrors the score/reasons shown on the card (including backend live scores).
  const selectedMatch = useMemo(() => {
    if (!selectedOpportunity || !submittedItem) return null
    const matchKey = (value) => (value || "").toLowerCase().replace(/\/$/, "")
    const selUrl = matchKey(selectedOpportunity.url || selectedOpportunity.application_url || selectedOpportunity.source_url)
    const found = scoredResults.find(({ opportunity }) => {
      if (selectedOpportunity.id && opportunity.id && opportunity.id === selectedOpportunity.id) return true
      const oppUrl = matchKey(opportunity.url || opportunity.application_url || opportunity.source_url)
      return Boolean(selUrl) && oppUrl === selUrl
    })
    if (found) return found.match
    return scoreItemMatch(selectedOpportunity, submittedItem, selectedProfile)
  }, [selectedOpportunity, submittedItem, scoredResults, selectedProfile])

  const isLoading = (opportunitiesQuery.isLoading || liveSearchQuery.isLoading) && submittedItem

  const handleSearch = () => {
    if (!filters.item.trim()) {
      toast({
        variant: "destructive",
        title: "Enter an item or equipment name",
        description: "For example: \u201C15 passenger van\u201D, \u201Cindustrial refrigerator\u201D, or \u201CSTEM laptops\u201D.",
      })
      return
    }
    setLiveOptions({ minMatchScore: 15, variant: "funding" })
    setSubmittedItem(filters.item.trim())
  }

  const applySuggestedItem = (name) => {
    const next = String(name || "").trim()
    if (!next) return
    setFilters((prev) => ({ ...prev, item: next }))
    setLiveOptions({ minMatchScore: 15, variant: "funding" })
    setSubmittedItem(next)
  }

  const handleReset = () => {
    setFilters({
      item: "",
      state: "all",
      includeNational: true,
      profileId: "all",
    })
    setLiveOptions({ minMatchScore: 15, variant: "funding" })
    setSubmittedItem("")
  }

  // Validate the profile id before sending it to the backend. We only accept
  // a real selected profile (not the "all" sentinel) that is a plain string.
  const getValidatedProfileId = () => {
    const pid = filters.profileId
    if (typeof pid !== "string") return null
    const trimmed = pid.trim()
    if (!trimmed || trimmed === "all") return null
    return trimmed
  }

  // Guard shared by the two deeper-search actions. Returns true when a live
  // search can run (item entered + profile selected + tier allows item funding).
  const canRunDeeperSearch = (contextLabel) => {
    if (!submittedItem) {
      toast({
        variant: "destructive",
        title: "Search for an item first",
        description: `Enter the item or equipment name before ${contextLabel}.`,
      })
      return false
    }
    if (!getValidatedProfileId()) {
      toast({
        variant: "destructive",
        title: "Select a profile first",
        description: "Deeper item searches run against a specific profile. Choose a profile, then retry.",
      })
      return false
    }
    if (!canItemFunding) {
      toast({
        variant: "destructive",
        title: "Tier upgrade required",
        description: "Item funding is not enabled for this profile\u2019s billing tier.",
      })
      return false
    }
    return true
  }

  // The old item_search / item_gift_search crawler jobs were retired with the
  // legacy crawlers (the backend rejects those job types), so these actions now
  // re-run the LIVE specific-need search with different knobs instead of
  // pretending to queue a job that would never run.
  const handleRequestItemCrawler = () => {
    if (!canRunDeeperSearch("running a deeper sweep")) return
    setLiveOptions((prev) => ({ ...prev, minMatchScore: 5 }))
    toast({
      title: "Deeper live search running",
      description: `Searching more sources for ${submittedItem} with a lower match floor.`,
    })
  }

  const handleRequestItemGiftCrawler = () => {
    if (!canRunDeeperSearch("searching donation/gift programs")) return
    setLiveOptions((prev) => ({ ...prev, variant: "gift" }))
    toast({
      title: "Searching donation and gift programs",
      description: `Looking for organizations that donate or provide ${submittedItem} directly.`,
    })
  }

  return (
    <div className="p-6 md:p-8 space-y-8">
      <header className="space-y-6">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 uppercase tracking-wide">
              <Boxes className="w-3 h-3" />
              Item Funding Scanner
            </div>
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900">Find funding for a specific item</h1>
            <p className="text-sm md:text-base text-slate-600 max-w-3xl">
              Tell us exactly what you need and we will search curated databases AND the live web to find grants, donations,
              and programs that fund it. Works for anything: vehicles, equipment, training classes, adaptive devices, scholarships,
              license fees, and more. Select a profile to unlock real-time web search.
            </p>
          </div>
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50/80 p-4 shadow-sm space-y-2 text-sm text-emerald-800 max-w-md">
            <p className="font-semibold text-emerald-900 flex items-center gap-2">
              <Shield className="w-4 h-4" />
              Grant-only guardrails
            </p>
            <ul className="list-disc list-inside space-y-1 text-xs">
              <li>Loans, lease-to-own offers, and match-required programs are hidden by default (toggle &ldquo;Show match/loan results&rdquo; to review them).</li>
              <li>Curated matches come from your profile&apos;s verified crawler results, re-ranked for this exact item.</li>
              <li>Live web results are labeled as leads &mdash; real pages found right now; always verify the source before applying.</li>
            </ul>
          </div>
        </div>

        <Card className="border border-slate-200 bg-white/80 backdrop-blur shadow-sm">
          <CardContent className="pt-6 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
              <div className="md:col-span-2 space-y-2">
                <Label htmlFor="item-query" className="text-xs uppercase tracking-wide text-slate-500 flex items-center gap-2">
                  <Filter className="w-3 h-3" />
                  Item or equipment
                </Label>
                <Input
                  id="item-query"
                  placeholder='e.g. "15 passenger van"'
                  value={filters.item}
                  onChange={(event) => setFilters((prev) => ({ ...prev, item: event.target.value }))}
                />
                {filters.profileId && filters.profileId !== "all" && suggestionsQuery.data?.suggestions?.length ? (
                  <div className="flex flex-wrap gap-2 pt-2">
                    <span className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold mr-1">
                      Suggested
                    </span>
                    {suggestionsQuery.data.suggestions.slice(0, 6).map((sugg) => (
                      <Button
                        key={sugg.name}
                        type="button"
                        variant="secondary"
                        className="h-7 px-3 text-xs"
                        onClick={() => applySuggestedItem(sugg.name)}
                      >
                        {sugg.name}
                      </Button>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="space-y-2">
                <Label className="text-xs uppercase tracking-wide text-slate-500">State</Label>
                <Select
                  value={filters.state}
                  onValueChange={(value) => setFilters((prev) => ({ ...prev, state: value }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="All states" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All states</SelectItem>
                    {statesQuery.data?.map((state) => (
                      <SelectItem key={state.state || NOT_AVAILABLE} value={state.state || NOT_AVAILABLE}>
                        {state.state || NOT_AVAILABLE} ({state.count})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label className="text-xs uppercase tracking-wide text-slate-500">Profile</Label>
                <ProfileSelect
                  value={filters.profileId}
                  onValueChange={(value) => setFilters((prev) => ({ ...prev, profileId: value }))}
                  showAllOption={true}
                  placeholder="Select profile"
                />
                {filters.profileId && filters.profileId !== "all" && selectedProfileQuery.isLoading ? (
                  <p className="text-[11px] text-slate-400">Loading profile signals...</p>
                ) : null}
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-slate-100 pt-4">
              <div className="flex flex-col md:flex-row md:items-center md:gap-6 gap-3">
                <div className="flex items-center gap-2">
                  <Switch
                    id="national-only"
                    checked={filters.includeNational}
                    onCheckedChange={(checked) => setFilters((prev) => ({ ...prev, includeNational: checked }))}
                  />
                  <Label htmlFor="national-only" className="text-sm text-slate-600">
                    Include national programs
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    id="include-disqualified"
                    checked={includeDisqualified}
                    onCheckedChange={(checked) => setIncludeDisqualified(Boolean(checked))}
                  />
                  <Label htmlFor="include-disqualified" className="text-sm text-slate-600">
                    Show match/loan results
                  </Label>
                </div>
                <Button variant="default" className="gap-2" onClick={handleSearch}>
                  <ShoppingCart className="w-4 h-4" />
                  Find funding
                </Button>
                <Button variant="ghost" size="sm" onClick={handleReset}>
                  Reset
                </Button>
              </div>
              {submittedItem ? (
                <div className="text-xs text-slate-500 space-y-1 text-right">
                  <p>
                    Showing {results.length} result{results.length === 1 ? "" : "s"} for{" "}
                    <span className="font-semibold text-slate-700">{submittedItem}</span>
                    {liveWebCount > 0 ? (
                      <span className="text-emerald-600 ml-1">({liveWebCount} from live web search)</span>
                    ) : null}
                    {liveSearchQuery.isLoading ? (
                      <span className="text-blue-500 ml-1 inline-flex items-center gap-1">
                        <Loader2 className="w-3 h-3 animate-spin" /> searching web...
                      </span>
                    ) : null}
                    {liveSearchQuery.isSuccess && hasSelectedProfile && !webSearchAttempted ? (
                      <span className="text-amber-600 ml-1">(live web search unavailable)</span>
                    ) : null}
                    {liveSearchPartial ? (
                      <span className="text-amber-600 ml-1">(deep crawl still running &mdash; check back shortly)</span>
                    ) : null}
                  </p>
                  {hasSelectedProfile && applicantTypeLabel ? (
                    <p className="inline-flex items-center gap-1 text-slate-500">
                      <Target className="w-3 h-3 text-emerald-500" />
                      Searching as <span className="font-semibold text-slate-700">{applicantTypeLabel}</span>{" "}
                      - funders matched to this profile
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>
      </header>

      {/* AI Needs Discovery \u2014 only shows when a profile is selected */}
      {hasSelectedProfile && (
        <NeedsDiscoveryPanel
          profileId={filters.profileId}
          onSearchItem={(searchText) => {
            setFilters((prev) => ({ ...prev, item: searchText }))
            setLiveOptions({ minMatchScore: 15, variant: "funding" })
            setSubmittedItem(searchText)
          }}
        />
      )}

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {Array.from({ length: 6 }).map((_, index) => (
            <Card key={`item-skeleton-${index}`} className="border border-slate-200 bg-white/60 backdrop-blur">
              <CardHeader className="space-y-2">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-6 w-3/4" />
              </CardHeader>
              <CardContent className="space-y-3">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-2/3" />
                <Skeleton className="h-3 w-1/2" />
                <Skeleton className="h-20 w-full" />
              </CardContent>
              <CardFooter>
                <Skeleton className="h-10 w-full" />
              </CardFooter>
            </Card>
          ))}
        </div>
      ) : submittedItem && results.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {results.map(({ opportunity, match }, index) => (
            <ItemResultCard
              key={opportunity.id || opportunity.url || opportunity.application_url || `${opportunity.title}-${index}`}
              opportunity={opportunity}
              match={match}
              onSelect={setSelectedOpportunity}
            />
          ))}
        </div>
      ) : submittedItem ? (
        <Card className="border border-slate-200 bg-white/70 backdrop-blur">
          <CardContent className="p-6 sm:p-10">
            <ZeroResultGuidance
              title={`No clean item funding found for "${submittedItem}"`}
              description={
                !hasSelectedProfile
                  ? "Select a profile to unlock profile-aware live web search and item-specific crawler jobs."
                  : "GrantFlow searched the stored catalog and live item sources, but nothing met the current rules and filters."
              }
              facts={[
                { label: "Profile", value: hasSelectedProfile ? selectedProfile?.display_name || "Selected" : "Not selected" },
                { label: "Excluded review rows", value: String(disqualifiedCount) },
                { label: "Live web rows", value: String(liveWebCount || 0) },
                {
                  label: "Live web search",
                  value: !hasSelectedProfile ? "Needs a profile" : webSearchAttempted ? "Searched" : "Unavailable",
                },
              ]}
              actions={[
                {
                  kind: "profile",
                  label: hasSelectedProfile ? "Review profile details" : "Select a profile",
                  description: "Item funding works best when GrantFlow knows who needs the item and where.",
                  href: createPageUrl("MyProfiles"),
                },
                {
                  kind: "review",
                  label: "Show match/loan results",
                  description: "Review excluded rows without treating them as compliant funding.",
                  onClick: () => setIncludeDisqualified(true),
                  disabled: includeDisqualified || disqualifiedCount === 0,
                },
                {
                  kind: "crawler",
                  label: "Run a deeper live search",
                  description: "Lower the match floor and re-search curated sources plus the live web for this exact item.",
                  onClick: handleRequestItemCrawler,
                  disabled: !hasSelectedProfile || liveSearchQuery.isLoading,
                  variant: hasSelectedProfile ? "default" : "outline",
                },
                {
                  kind: "crawler",
                  label: "Find donation or gift programs",
                  description: "Search the live web for organizations that donate or provide the item directly.",
                  onClick: handleRequestItemGiftCrawler,
                  disabled: !hasSelectedProfile || liveSearchQuery.isLoading,
                },
                {
                  kind: "reset",
                  label: "Try broader words",
                  description: "Clear the search so you can try equipment, vehicle, tuition, supplies, or assistance.",
                  onClick: handleReset,
                },
              ]}
            />
          </CardContent>
        </Card>
      ) : (
        <Card className="border border-slate-200 bg-white/70 backdrop-blur">
          <CardContent className="p-12 text-center space-y-4">
            <Sparkles className="w-12 h-12 mx-auto text-slate-300" />
            <h3 className="text-xl font-semibold text-slate-900">Search for a specific item or equipment</h3>
            <p className="text-sm text-slate-600">
              Enter exactly what you&rsquo;re looking for and we&rsquo;ll surface grants, endowments, and programs that can fund it &ndash; no
              loans by default, and match-required programs are flagged and hidden unless you opt in.
            </p>
          </CardContent>
        </Card>
      )}

      <ItemResultDetail
        opportunity={selectedOpportunity}
        match={selectedMatch}
        open={Boolean(selectedOpportunity)}
        onClose={() => setSelectedOpportunity(null)}
        profileName={selectedProfile?.display_name}
      />
    </div>
  )
}
