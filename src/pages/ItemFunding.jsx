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
import { format, formatDistanceToNowStrict } from "date-fns"
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
import { listProfiles, getProfile } from "@/api/profiles"
import { createCrawlerJob } from "@/api/crawlers"
import { cn } from "@/lib/utils"

function safeArray(value) {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

function formatAmount(min, max) {
  if (!min && !max) return "Varies"
  if (min && max && min !== max) {
    return `$${min.toLocaleString()} – $${max.toLocaleString()}`
  }
  const amount = (min ?? max ?? 0).toLocaleString()
  return `$${amount}`
}

function formatDeadline(deadline, type) {
  if (!deadline) return type === "rolling" ? "Rolling deadline" : "Deadline TBD"
  try {
    return format(new Date(deadline), "PPP")
  } catch {
    return deadline
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
        <p className="text-sm text-slate-600 line-clamp-3">{opportunity.description || "Summary coming soon."}</p>
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

function ItemResultDetail({ opportunity, match, open, onClose }) {
  if (!opportunity) return null
  const detailReasons =
    match?.reasons?.length > 0
      ? match.reasons
      : Array.isArray(opportunity.match_reasons)
      ? opportunity.match_reasons
      : []
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader className="space-y-2">
          <DialogTitle className="text-2xl font-semibold text-slate-900">{opportunity.title}</DialogTitle>
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Layers className="w-4 h-4" />
            <span>{opportunity.source || "Crawler"}</span>
            <span className="mx-2">•</span>
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
                  detailReasons.map((reason, index) => <li key={`${reason}-${index}`}>{reason}</li>)
                ) : (
                  <li>No explicit match reasons provided.</li>
                )}
              </ul>
            </section>
          ) : null}

          <section className="space-y-3">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-900">Overview</h3>
            <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-line">
              {opportunity.description || "Summary coming soon."}
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
              <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-900">Application Portal</h3>
              <Button
                variant="default"
                className="gap-2"
                onClick={() => window.open(opportunity.application_url, "_blank", "noopener,noreferrer")}
              >
                Visit portal
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
  const [filters, setFilters] = useState({
    item: "",
    state: "all",
    includeNational: true,
    profileId: "all",
  })
  const [selectedOpportunity, setSelectedOpportunity] = useState(null)
  const [submittedItem, setSubmittedItem] = useState("")

  const statesQuery = useQuery({
    queryKey: ["opportunity-states"],
    queryFn: listOpportunityStates,
  })

  const profilesQuery = useQuery({
    queryKey: ["profiles"],
    queryFn: listProfiles,
  })

  const selectedProfileQuery = useQuery({
    queryKey: ["profile-detail", filters.profileId],
    queryFn: () => getProfile(filters.profileId),
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

  const selectedProfile = selectedProfileQuery.data ?? null
  const opportunitiesResponse = opportunitiesQuery.data ?? null
  const opportunities = opportunitiesResponse?.data ?? []
  const totalResults = typeof opportunitiesResponse?.total === "number" ? opportunitiesResponse.total : opportunities.length

  const results = useMemo(() => {
    const data = opportunities
    if (!submittedItem) return []

    return data
      .map((opportunity) => {
        const match = scoreItemMatch(opportunity, submittedItem, selectedProfile)
        const reasons =
          match.reasons?.length > 0
            ? match.reasons
            : Array.isArray(opportunity.match_reasons)
            ? opportunity.match_reasons
            : []
        return {
          opportunity,
          match: {
            ...match,
            reasons,
          },
        }
      })
      .filter(({ match }) => !match.disqualified)
      .sort((a, b) => b.match.score - a.match.score)
  }, [opportunities, submittedItem, selectedProfile])

  const isLoading = opportunitiesQuery.isLoading && submittedItem

  const handleSearch = () => {
    if (!filters.item.trim()) {
      toast({
        variant: "destructive",
        title: "Enter an item or equipment name",
        description: "For example: “15 passenger van”, “industrial refrigerator”, or “STEM laptops”.",
      })
      return
    }
    setSubmittedItem(filters.item.trim())
  }

  const handleReset = () => {
    setFilters({
      item: "",
      state: "all",
      includeNational: true,
      profileId: "",
    })
    setSubmittedItem("")
  }

  const handleRequestItemCrawler = async () => {
    if (!submittedItem) {
      toast({
        variant: "destructive",
        title: "Search for an item first",
        description: "Enter the item or equipment name before requesting a crawler sweep.",
      })
      return
    }

    try {
      const payload = {
        type: "item_search",
        parameters: {
          item: submittedItem,
          state: filters.state !== "all" ? filters.state : null,
          includeNational: filters.includeNational,
        },
      }

      if (filters.profileId) {
        payload.profile_id = filters.profileId
      }

      const job = await createCrawlerJob(payload)
      toast({
        title: "Item crawler queued",
        description: `We’ll search for ${submittedItem}. Job ${job.id.slice(0, 8)}… is running.`,
      })
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Unable to queue crawler",
        description: error instanceof Error ? error.message : "Try again shortly.",
      })
    }
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
              Search grants, scholarships, endowments, and local programs that underwrite tangible needs—vehicles, equipment,
              technology, lab gear, adaptive devices. Results exclude loans or matching requirements automatically.
            </p>
          </div>
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50/80 p-4 shadow-sm space-y-2 text-sm text-emerald-800 max-w-md">
            <p className="font-semibold text-emerald-900 flex items-center gap-2">
              <Shield className="w-4 h-4" />
              Grant-only guardrails
            </p>
            <ul className="list-disc list-inside space-y-1 text-xs">
              <li>Loans, lease-to-own offers, and match-required programs are removed before results reach the catalog.</li>
              <li>Local crawler searches within 50 miles (or the student&apos;s campus ZIP) for locality-specific aid.</li>
              <li>Scholarship and comprehensive crawlers augment the list with verified national gift-based funding.</li>
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
                      <SelectItem key={state.state || "N/A"} value={state.state || "N/A"}>
                        {state.state || "N/A"} ({state.count})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label className="text-xs uppercase tracking-wide text-slate-500">Profile</Label>
                <Select
                  value={filters.profileId}
                  onValueChange={(value) => setFilters((prev) => ({ ...prev, profileId: value }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select profile" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All profiles</SelectItem>
                    {profilesQuery.data?.map((profile) => (
                      <SelectItem key={profile.id} value={profile.id}>
                        {profile.display_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {filters.profileId && filters.profileId !== "all" && selectedProfileQuery.isLoading ? (
                  <p className="text-[11px] text-slate-400">Loading profile signals…</p>
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
                <Button variant="default" className="gap-2" onClick={handleSearch}>
                  <ShoppingCart className="w-4 h-4" />
                  Find funding
                </Button>
                <Button variant="ghost" size="sm" onClick={handleReset}>
                  Reset
                </Button>
              </div>
              {submittedItem ? (
                <p className="text-xs text-slate-500">
                  Showing {totalResults} grant{totalResults === 1 ? "" : "s"} for{" "}
                  <span className="font-semibold text-slate-700">{submittedItem}</span> (no match funds or repayment required)
                </p>
              ) : null}
            </div>
          </CardContent>
        </Card>
      </header>

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
          {results.map(({ opportunity, match }) => (
            <ItemResultCard
              key={opportunity.id}
              opportunity={opportunity}
              match={match}
              onSelect={setSelectedOpportunity}
            />
          ))}
        </div>
      ) : submittedItem ? (
        <Card className="border border-slate-200 bg-white/70 backdrop-blur">
          <CardContent className="p-12 text-center space-y-4">
            <ShoppingCart className="w-12 h-12 mx-auto text-slate-300" />
            <h3 className="text-xl font-semibold text-slate-900">No grant options yet</h3>
            <p className="text-sm text-slate-600">
              Trigger the item crawler to discover gift-based funding tied to this purchase. Fresh, non-repayable matches will
              appear once the job completes.
            </p>
            <Button variant="outline" onClick={handleRequestItemCrawler}>
              Request crawler sweep
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card className="border border-slate-200 bg-white/70 backdrop-blur">
          <CardContent className="p-12 text-center space-y-4">
            <Sparkles className="w-12 h-12 mx-auto text-slate-300" />
            <h3 className="text-xl font-semibold text-slate-900">Search for a specific item or equipment</h3>
            <p className="text-sm text-slate-600">
              Enter exactly what you’re looking for and we’ll surface grants, endowments, and programs that can fund it – no
              loans, no matching requirements.
            </p>
          </CardContent>
        </Card>
      )}

      <ItemResultDetail
        opportunity={selectedOpportunity}
        match={
          selectedOpportunity && submittedItem
            ? scoreItemMatch(selectedOpportunity, submittedItem, selectedProfile)
            : null
        }
        open={Boolean(selectedOpportunity)}
        onClose={() => setSelectedOpportunity(null)}
      />
    </div>
  )
}
