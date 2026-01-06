import React, { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  Building,
  CalendarDays,
  DollarSign,
  ExternalLink,
  FileText,
  Filter,
  Layers,
  Loader2,
  MapPin,
  Printer,
  Shield,
  ShieldAlert,
  ShieldCheck,
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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { useToast } from "@/components/ui/use-toast"
import { listOpportunities, listOpportunitySources, listOpportunityStates } from "@/api/opportunities"
import { listProfiles, getProfile } from "@/api/profiles"
import { createCrawlerJob, fetchCrawlerStatus } from "@/api/crawlers"
import { createGrant } from "@/api/grants"
import { createDocument } from "@/api/documents"
import { cn } from "@/lib/utils"

const NOT_AVAILABLE = 'N/A'

function formatDeadline(deadline, deadlineType) {
  if (!deadline) {
    return deadlineType === "rolling" ? "Rolling deadline" : "Deadline TBD"
  }
  try {
    return format(new Date(deadline), "PPP")
  } catch {
    return deadline
  }
}

function formatAmount(min, max) {
  if (!min && !max) return "Varies"
  if (min && max && min !== max) {
    return `$${min.toLocaleString()} – $${max.toLocaleString()}`
  }
  const amount = (min ?? max ?? 0).toLocaleString()
  return `$${amount}`
}

function buildOpportunitySummary(opportunity, profile, match) {
  const lines = []
  const safeTitle = opportunity.title || "Funding opportunity"
  lines.push(`${safeTitle}`)
  lines.push(`Source: ${opportunity.source || "Crawler"}`)
  if (opportunity.sponsor) {
    lines.push(`Sponsor: ${opportunity.sponsor}`)
  }
  if (profile?.display_name) {
    lines.push(`Profile: ${profile.display_name}`)
  }
  if (opportunity.is_national) {
    lines.push("Coverage: National")
  } else if (opportunity.state) {
    lines.push(`Primary state: ${opportunity.state}`)
  }
  if (Array.isArray(opportunity.regions) && opportunity.regions.length) {
    lines.push(`Regions: ${opportunity.regions.join(", ")}`)
  }
  const amountText = formatAmount(opportunity.amount_min, opportunity.amount_max)
  lines.push(`Funding amount: ${amountText}`)
  if (opportunity.deadline) {
    lines.push(`Deadline: ${opportunity.deadline}`)
  } else if (opportunity.deadline_type) {
    lines.push(`Deadline type: ${opportunity.deadline_type}`)
  }
  if (match?.score != null) {
    lines.push(`Match score: ${match.score}%`)
  }
  if (Array.isArray(match?.reasons) && match.reasons.length) {
    lines.push("")
    lines.push("Top match reasons:")
    match.reasons.slice(0, 5).forEach((reason, index) => {
      lines.push(`  ${index + 1}. ${reason}`)
    })
  }
  if (opportunity.description) {
    lines.push("")
    lines.push("Description:")
    lines.push(opportunity.description)
  }
  if (Array.isArray(opportunity.eligibility_bullets) && opportunity.eligibility_bullets.length) {
    lines.push("")
    lines.push("Eligibility highlights:")
    opportunity.eligibility_bullets.slice(0, 8).forEach((item, index) => {
      lines.push(`  • ${item}`)
    })
  }
  if (opportunity.application_url) {
    lines.push("")
    lines.push(`Application URL: ${opportunity.application_url}`)
  }
  return lines.join("\n")
}

function computeProfileSignals(profile) {
  if (!profile) return { tags: new Set(), strings: [] }
  const tagSet = new Set((profile.tags ?? []).map((tag) => tag.toLowerCase()))
  const strings = []

  const sections = profile.sections ?? []
  sections.forEach((section) => {
    if (!section?.data) return
    Object.entries(section.data).forEach(([key, value]) => {
      if (typeof value === "string" && value.trim()) {
        strings.push(value.toLowerCase())
      } else if (Array.isArray(value)) {
        value.forEach((entry) => {
          if (typeof entry === "string") strings.push(entry.toLowerCase())
        })
      } else if (value === true) {
        tagSet.add(key.replace(/_/g, " ").toLowerCase())
      }
    })
  })

  return { tags: tagSet, strings }
}

function scoreOpportunity(opportunity, profileDetail) {
  if (!profileDetail) {
    return { score: 0, reasons: ["Select a profile to see a match score"], overlap: [] }
  }

  const { tags, strings } = computeProfileSignals(profileDetail)

  let score = 45
  const reasons = []
  const overlap = []

  if (opportunity.is_national) {
    score += 10
    reasons.push("National coverage")
  }

  const profileLocation =
    profileDetail.sections?.find((section) => section.section_key === "location_focus")?.data?.geographic_focus ?? null
  const profileState =
    profileDetail.sections?.find((section) => section.section_key === "basic_information")?.data?.state ?? null

  if (opportunity.state && profileState && opportunity.state.toLowerCase() === profileState.toLowerCase()) {
    score += 15
    reasons.push(`Matches profile state (${profileState})`)
  } else if (
    opportunity.state &&
    profileLocation &&
    profileLocation.toLowerCase().includes(opportunity.state.toLowerCase())
  ) {
    score += 10
    reasons.push(`Covered in profile location focus (${opportunity.state})`)
  }

  const keywordOverlap = []
  ;(opportunity.keywords ?? []).forEach((keyword) => {
    const normalized = keyword.toLowerCase()
    if (tags.has(normalized) || strings.some((str) => str.includes(normalized))) {
      keywordOverlap.push(keyword)
    }
  })

  if (keywordOverlap.length) {
    score += 15
    overlap.push(...keywordOverlap)
    reasons.push(`Matches profile focus: ${keywordOverlap.slice(0, 3).join(", ")}`)
  }

  const categoryOverlap = []
  ;(opportunity.categories ?? []).forEach((category) => {
    const normalized = category.toLowerCase()
    if (tags.has(normalized) || strings.some((str) => str.includes(normalized))) {
      categoryOverlap.push(category)
    }
  })

  if (categoryOverlap.length) {
    score += 10
    overlap.push(...categoryOverlap)
    reasons.push(`Relevant categories: ${categoryOverlap.slice(0, 2).join(", ")}`)
  }

  if (opportunity.deadline_type === "rolling") {
    score += 5
    reasons.push("Rolling deadline – flexible submission window")
  } else if (opportunity.deadline) {
    const timeToDeadline = formatDistanceToNowStrict(new Date(opportunity.deadline), { addSuffix: true })
    reasons.push(`Deadline ${timeToDeadline}`)
  }

  return {
    score: Math.min(100, Math.round(score)),
    reasons,
    overlap,
  }
}

function OpportunityCard({ opportunity, onSelect, match, onAddToPipeline, isAddingToPipeline, canAddToPipeline }) {
  const matchScore = match?.score ?? 0
  const complianceStatus = opportunity.compliance_status ?? "unknown"
  const complianceReasons = Array.isArray(opportunity.compliance_reasons)
    ? opportunity.compliance_reasons
    : []
  const reviewReasons = complianceReasons.length
    ? complianceReasons
    : ["Match or repayment requirements detected. Review the terms before proceeding."]
  const isCompliant = complianceStatus === "compliant"
  const isReview = complianceStatus === "requires_review"
  const complianceBadgeClass = isCompliant
    ? "bg-emerald-100 text-emerald-700 border-emerald-200"
    : isReview
    ? "bg-rose-100 text-rose-700 border-rose-200"
    : "bg-slate-100 text-slate-600 border-slate-200"
  const complianceBadgeText = isCompliant
    ? "Grant funds"
    : isReview
    ? "Review terms"
    : "Funding review"
  const opportunityTypeLabel = opportunity.opportunity_type || "Funding Opportunity"

  // Get match color based on score
  const getMatchColor = (score) => {
    if (score >= 80) return "text-emerald-600 bg-emerald-50 border-emerald-200"
    if (score >= 60) return "text-blue-600 bg-blue-50 border-blue-200"
    if (score >= 40) return "text-amber-600 bg-amber-50 border-amber-200"
    return "text-slate-600 bg-slate-50 border-slate-200"
  }

  const handleQuickAdd = async (event) => {
    event.stopPropagation()
    if (onAddToPipeline) {
      await onAddToPipeline(opportunity)
    }
  }

  return (
    <Card
      className="transition hover:shadow-lg border border-slate-200 bg-white/80 backdrop-blur cursor-pointer flex flex-col group"
      onClick={() => onSelect(opportunity)}
    >
      <CardHeader className="pb-3 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <Badge variant="outline" className="uppercase text-[11px] tracking-wide text-slate-500">
            {opportunity.source || "Uncategorized"}
          </Badge>
          <div className="flex items-center gap-2">
            {opportunity.opportunity_type ? (
              <Badge variant="outline" className="text-xs uppercase tracking-wide text-slate-500">
                {opportunityTypeLabel}
              </Badge>
            ) : null}
            <Badge className={cn("text-xs border", complianceBadgeClass)}>{complianceBadgeText}</Badge>
          </div>
        </div>
        <h3 className="text-lg font-semibold text-slate-900 line-clamp-2 group-hover:text-blue-700 transition-colors">
          {opportunity.title}
        </h3>
        {/* Funding Source / Sponsor */}
        <div className="flex items-center gap-2 text-sm text-slate-700 font-medium">
          <Building className="w-4 h-4 text-blue-500" />
          {opportunity.sponsor || "Sponsor pending"}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 flex-1">
        {/* Key Details Grid */}
        <div className="grid grid-cols-2 gap-2 text-sm text-slate-600">
          <div className="flex items-center gap-2">
            <MapPin className="w-4 h-4 text-slate-400" />
            <span className="truncate">{opportunity.is_national ? "National" : opportunity.state || "Location varies"}</span>
          </div>
          <div className="flex items-center gap-2">
            <DollarSign className="w-4 h-4 text-emerald-500" />
            <span className="font-medium text-emerald-700">{formatAmount(opportunity.amount_min, opportunity.amount_max)}</span>
          </div>
          <div className="flex items-center gap-2 col-span-2">
            <CalendarDays className="w-4 h-4 text-amber-500" />
            <span>{formatDeadline(opportunity.deadline, opportunity.deadline_type)}</span>
          </div>
        </div>

        {/* Synopsis / Description */}
        <p className="text-sm text-slate-600 line-clamp-2">{opportunity.description || "Summary coming soon."}</p>

        {/* Contact Info - Application URL */}
        {opportunity.application_url && (
          <div className="flex items-center gap-2 text-xs text-blue-600">
            <ExternalLink className="w-3 h-3" />
            <a 
              href={opportunity.application_url} 
              target="_blank" 
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="hover:underline truncate"
            >
              Apply / Contact
            </a>
          </div>
        )}

        {/* Match Score - Prominently displayed */}
        {match ? (
          <div className={cn("rounded-lg border p-3 space-y-2", getMatchColor(matchScore))}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Target className="w-4 h-4" />
                <span className="text-sm font-semibold uppercase tracking-wide">Match Score</span>
              </div>
              <span className="text-2xl font-bold">{matchScore}%</span>
            </div>
            <Progress value={matchScore} className="h-2" />
            {match.reasons && match.reasons.length > 0 && (
              <p className="text-xs opacity-80 line-clamp-1">{match.reasons[0]}</p>
            )}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-slate-200 p-3 text-xs text-slate-500 text-center">
            <Target className="w-4 h-4 mx-auto mb-1 opacity-50" />
            Select a profile to see match score
          </div>
        )}

        {isReview ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50/70 p-2 text-xs text-rose-700">
            {reviewReasons[0] || "Review matching or repayment requirements before proceeding."}
          </div>
        ) : null}
      </CardContent>
      <CardFooter className="px-6 pb-4 gap-2">
        <Button
          variant="outline"
          className="flex-1"
          onClick={(event) => {
            event.stopPropagation()
            onSelect(opportunity)
          }}
        >
          View Details
        </Button>
        <Button
          variant="default"
          className="flex-1"
          disabled={!canAddToPipeline || isAddingToPipeline}
          onClick={handleQuickAdd}
        >
          {isAddingToPipeline ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <>
              <Sparkles className="w-4 h-4 mr-1" />
              Add to Pipeline
            </>
          )}
        </Button>
      </CardFooter>
    </Card>
  )
}

function OpportunityDetail({
  opportunity,
  open,
  onClose,
  match,
  onAddToPipeline,
  isAddingToPipeline = false,
  canAddToPipeline = false,
  selectedProfileName,
  onSaveDocument,
  isSavingDocument = false,
  canSaveDocument = false,
  onPrintOpportunity,
}) {
  if (!opportunity) return null
  const matchScore = typeof match?.score === "number" ? match.score : null
  const serverReasons = Array.isArray(opportunity.match_reasons) ? opportunity.match_reasons : []
  const reasonList = match?.reasons?.length ? match.reasons : serverReasons
  const showMatchInsights = matchScore !== null || reasonList.length > 0
  const complianceStatus = opportunity.compliance_status ?? "unknown"
  const complianceReasons = Array.isArray(opportunity.compliance_reasons)
    ? opportunity.compliance_reasons
    : []
  const isCompliant = complianceStatus === "compliant"
  const isReview = complianceStatus === "requires_review"
  const FundingIcon = isReview ? ShieldAlert : isCompliant ? ShieldCheck : Shield
  const reviewReasons = complianceReasons.length
    ? complianceReasons
    : ["Match or repayment requirements detected. Review the terms before proceeding."]
  const fundingCardClasses = isCompliant
    ? "rounded-xl border border-emerald-200 bg-emerald-50/70 p-4 space-y-2"
    : isReview
    ? "rounded-xl border border-rose-200 bg-rose-50/70 p-4 space-y-2"
    : "rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2"
  const fundingTitleClasses = isCompliant
    ? "font-semibold text-emerald-900 flex items-center gap-2"
    : isReview
    ? "font-semibold text-rose-900 flex items-center gap-2"
    : "font-semibold text-slate-800 flex items-center gap-2"
  const handleAddClick = async () => {
    if (!onAddToPipeline) return
    try {
      await onAddToPipeline(opportunity)
    } catch {
      // Errors are surfaced via toast in the caller.
    }
  }

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
        <ScrollArea className="max-h-[65vh] pr-2 space-y-6">
          <section className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm text-slate-600">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2">
                <p className="font-semibold text-slate-800 flex items-center gap-2">
                  <MapPin className="w-4 h-4 text-slate-400" />
                  Geography
                </p>
                <p>{opportunity.is_national ? "National coverage" : opportunity.state || "Varies"}</p>
                {opportunity.regions?.length ? (
                  <div className="flex flex-wrap gap-1">
                    {opportunity.regions.map((region) => (
                      <Badge key={region} variant="outline" className="text-xs">
                        {region}
                      </Badge>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2">
                <p className="font-semibold text-slate-800 flex items-center gap-2">
                  <DollarSign className="w-4 h-4 text-slate-400" />
                  Funding
                </p>
                <p>{formatAmount(opportunity.amount_min, opportunity.amount_max)}</p>
                {opportunity.deadline ? (
                  <p className="text-xs text-slate-500">
                    Deadline {formatDeadline(opportunity.deadline, opportunity.deadline_type)}
                  </p>
                ) : (
                  <p className="text-xs text-slate-500 capitalize">{opportunity.deadline_type || "Deadline TBD"}</p>
                )}
              </div>
              <div className={fundingCardClasses}>
                <p className={fundingTitleClasses}>
                  <FundingIcon className="w-4 h-4" />
                  Funding terms
                </p>
                {isCompliant ? (
                  <>
                    <p className="text-sm text-emerald-800">
                      {complianceReasons[0] || "Grant funds only — no match funds or repayment required."}
                    </p>
                    <Badge className="bg-emerald-600 text-white w-fit">Compliant</Badge>
                  </>
                ) : isReview ? (
                  <>
                    <p className="text-sm text-rose-700">Review the following before proceeding:</p>
                    <ul className="list-disc list-inside space-y-1 text-xs text-rose-700">
                      {reviewReasons.map((reason, index) => (
                        <li key={`${reason}-${index}`}>{reason}</li>
                      ))}
                    </ul>
                    <Badge variant="destructive" className="w-fit">
                      Requires review
                    </Badge>
                  </>
                ) : (
                  <>
                    <p className="text-sm text-slate-700">
                      Funding terms have not been classified. Confirm repayment or match requirements before proceeding.
                    </p>
                    <Badge variant="outline" className="w-fit text-slate-600">
                      Review pending
                    </Badge>
                  </>
                )}
              </div>
            </div>
            {showMatchInsights ? (
              <div className="rounded-xl border border-blue-200 bg-blue-50/70 p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-blue-900 flex items-center gap-2">
                    <Target className="w-4 h-4" />
                    Match Score
                  </p>
                  {matchScore !== null ? <Badge className="bg-blue-600 text-white">{matchScore}%</Badge> : null}
                </div>
                {matchScore !== null ? <Progress value={matchScore} className="h-2" /> : null}
                <ul className="list-disc list-inside text-xs text-blue-800 space-y-1">
                  {reasonList.length > 0 ? (
                    reasonList.map((reason, index) => <li key={`${reason}-${index}`}>{reason}</li>)
                  ) : (
                    <li>No explicit match reasons provided.</li>
                  )}
                </ul>
              </div>
            ) : null}
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-900 uppercase tracking-wide">Opportunity Overview</h3>
            <p className="text-sm leading-relaxed text-slate-700 whitespace-pre-line">
              {opportunity.description || "Summary coming soon."}
            </p>
          </section>

          {opportunity.eligibility_bullets?.length ? (
            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-slate-900 uppercase tracking-wide">Eligibility</h3>
              <ul className="space-y-2 text-sm text-slate-700 list-disc list-inside">
                {opportunity.eligibility_bullets.map((bullet, index) => (
                  <li key={`${bullet}-${index}`}>{bullet}</li>
                ))}
              </ul>
            </section>
          ) : null}

          {opportunity.application_url ? (
            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-slate-900 uppercase tracking-wide">Application Portal</h3>
              <Button
                variant="default"
                className="gap-2"
                onClick={() => window.open(opportunity.application_url, "_blank", "noopener,noreferrer")}
              >
                Visit Portal
                <ExternalLink className="w-4 h-4" />
              </Button>
            </section>
          ) : null}
        </ScrollArea>
        <div className="pt-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-slate-500">
            {canAddToPipeline
              ? `Grant will be added to ${selectedProfileName ?? "the selected profile"}'s pipeline.`
              : "Select a profile to enable pipeline creation."}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
            <Button variant="outline" size="sm" onClick={onClose}>
              Close
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onPrintOpportunity?.(opportunity)}
              disabled={!onPrintOpportunity}
            >
              <Printer className="w-4 h-4 mr-2" />
              Print summary
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onSaveDocument?.(opportunity)}
              disabled={!canSaveDocument || isSavingDocument || !onSaveDocument}
            >
              {isSavingDocument ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Saving…
                </>
              ) : (
                <>
                  <FileText className="w-4 h-4 mr-2" />
                  Save to documents
                </>
              )}
            </Button>
            <Button
              variant="default"
              size="sm"
              disabled={!canAddToPipeline || isAddingToPipeline}
              onClick={handleAddClick}
            >
              {isAddingToPipeline ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Add to pipeline
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default function FundingOpportunities() {
  const { toast } = useToast()
  const [filters, setFilters] = useState({
    search: "",
    state: "all",
    source: "all",
    nationalOnly: false,
    profileId: "all",
    compliance: "grant_only",
  })
  const [selectedOpportunity, setSelectedOpportunity] = useState(null)
  const [addingOpportunityId, setAddingOpportunityId] = useState(null)
  const [savingOpportunityId, setSavingOpportunityId] = useState(null)

  const opportunitiesQuery = useQuery({
    queryKey: ["opportunities", filters],
    queryFn: () =>
      listOpportunities({
        search: filters.search || undefined,
        state: filters.state !== "all" ? filters.state : undefined,
        source: filters.source !== "all" ? filters.source : undefined,
        is_national: filters.nationalOnly ? "true" : undefined,
        compliance: filters.compliance,
        limit: 50,
      }),
  })

  const sourcesQuery = useQuery({
    queryKey: ["opportunity-sources", filters.compliance],
    queryFn: () => listOpportunitySources({ compliance: filters.compliance }),
  })

  const statesQuery = useQuery({
    queryKey: ["opportunity-states", filters.compliance],
    queryFn: () => listOpportunityStates({ compliance: filters.compliance }),
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

  // Auto-discovery status polling
  const autoDiscoveryQuery = useQuery({
    queryKey: ["auto-discovery-status", filters.profileId],
    queryFn: () => fetchCrawlerStatus(filters.profileId),
    refetchInterval: (data) => {
      // Poll every 5s if crawlers are running
      if (data?.running > 0) return 5000
      // Stop polling after completion
      return false
    },
    enabled: Boolean(filters.profileId) && filters.profileId !== "all",
  })

  const opportunitiesResponse = opportunitiesQuery.data ?? null
  const opportunities = opportunitiesResponse?.data ?? []
  const totalResults = typeof opportunitiesResponse?.total === "number" ? opportunitiesResponse.total : opportunities.length
  const selectedProfile = selectedProfileQuery.data ?? null
  const autoDiscoveryStatus = autoDiscoveryQuery.data ?? null
  const complianceMessage =
    filters.compliance === "grant_only"
      ? "Grant funds only — excluding loans and match requirements."
      : "Including opportunities that may require matching funds or repayment."

  const organizedOpportunities = useMemo(() => {
    if (!opportunities.length) {
      return opportunities
    }

    const isComprehensiveFocus =
      filters.source === "comprehensive_crawler" ||
      (filters.source === "all" && opportunities.every((opp) => opp.source === "comprehensive_crawler"))

    if (!isComprehensiveFocus) {
      return opportunities
    }

    const groupOrder = []
    const groupedByZip = new Map()

    const getZipKey = (opportunity) => {
      if (!opportunity) return null
      const sourceId = typeof opportunity.source_id === "string" ? opportunity.source_id : ""
      const sourceMatch = sourceId.match(/^(\d{5})/)
      if (sourceMatch) return sourceMatch[1]

      if (typeof opportunity.title === "string") {
        const titleMatch = opportunity.title.match(/ZIP\s*(\d{5})/i)
        if (titleMatch) return titleMatch[1]
      }

      return null
    }

    const getTemplateOrder = (opportunity) => {
      const sourceId = typeof opportunity.source_id === "string" ? opportunity.source_id : ""
      const parts = sourceId.split("-")
      const candidate = parts[parts.length - 1]
      const parsed = Number.parseInt(candidate, 10)
      return Number.isFinite(parsed) ? parsed : 0
    }

    opportunities.forEach((opportunity) => {
      const zipKey = getZipKey(opportunity) ?? `zip-${groupOrder.length}`
      if (!groupedByZip.has(zipKey)) {
        groupedByZip.set(zipKey, [])
        groupOrder.push(zipKey)
      }
      groupedByZip.get(zipKey).push(opportunity)
    })

    const ordered = []
    groupOrder.forEach((zipKey) => {
      const group = groupedByZip.get(zipKey) ?? []
      group
        .slice()
        .sort((a, b) => getTemplateOrder(a) - getTemplateOrder(b))
        .forEach((item) => ordered.push(item))
    })

    return ordered
  }, [opportunities, filters.source])

  const opportunitiesWithMatch = useMemo(() => {
    if (!organizedOpportunities.length) return []
    return organizedOpportunities.map((opp) => {
      if (!filters.profileId || filters.profileId === "all") {
        return { opportunity: opp, match: null }
      }
      const computedMatch = scoreOpportunity(opp, selectedProfile)
      const serverReasons = Array.isArray(opp.match_reasons) ? opp.match_reasons : []
      const reasons = computedMatch.reasons?.length ? computedMatch.reasons : serverReasons
      return {
        opportunity: opp,
        match: {
          ...computedMatch,
          reasons,
        },
      }
    })
  }, [organizedOpportunities, filters.profileId, selectedProfile])

  const handleAddToPipeline = async (opportunity) => {
    if (!selectedProfile || !filters.profileId || filters.profileId === "all") {
      toast({
        variant: "destructive",
        title: "Select a profile first",
        description: "Choose a profile to determine which pipeline should receive this opportunity.",
      })
      return
    }

    if (!selectedProfile.organization_id) {
      toast({
        variant: "destructive",
        title: "Missing organization",
        description: "This profile is not linked to an organization yet. Assign one before adding grants to the pipeline.",
      })
      return
    }

    setAddingOpportunityId(opportunity.id)
    try {
      const computedMatch = scoreOpportunity(opportunity, selectedProfile)
      const serverReasons = Array.isArray(opportunity.match_reasons) ? opportunity.match_reasons : []
      const preferredReasons =
        Array.isArray(computedMatch.reasons) && computedMatch.reasons.length > 0
          ? computedMatch.reasons
          : serverReasons
      const normalizedReasons = Array.from(
        new Set(preferredReasons.filter(Boolean).map((reason) => String(reason))),
      )

      const notesSegments = [
        `Imported from Funding Opportunities (${opportunity.source || "crawler"}).`,
      ]
      if (normalizedReasons.length) {
        notesSegments.push(`Match rationale: ${normalizedReasons.slice(0, 3).join("; ")}`)
      }
      if (opportunity.description) {
        notesSegments.push(opportunity.description)
      }
      const combinedNotes = notesSegments.join("\n\n")
      const payload = {
        funding_opportunity_id: opportunity.id,
        organization_id: selectedProfile.organization_id,
        title: opportunity.title || "Untitled opportunity",
        funder: opportunity.sponsor ?? null,
        status: "interested",
        deadline: opportunity.deadline || null,
        match_score: Number.isFinite(computedMatch?.score) ? computedMatch.score : null,
        match_reasons: normalizedReasons,
        notes: combinedNotes.length > 2000 ? `${combinedNotes.slice(0, 1997)}…` : combinedNotes,
        application_url: opportunity.application_url ?? null,
      }

      const normalizedAmounts = [opportunity.amount_max, opportunity.amount_min]
        .map((value) => (value === null || value === undefined ? null : Number(value)))
        .filter((value) => Number.isFinite(value) && value > 0)
      if (normalizedAmounts.length > 0) {
        payload.amount_requested = normalizedAmounts[0]
      }

      const created = await createGrant(payload)

      toast({
        title: "Added to pipeline",
        description: `${
          opportunity.title
        } is now in the pipeline for ${selectedProfile.display_name || "the selected profile"}.`,
      })

      setSelectedOpportunity(null)
      return created
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Unable to add to pipeline",
        description: error instanceof Error ? error.message : "Try again in a moment.",
      })
      throw error
    } finally {
      setAddingOpportunityId(null)
    }
  }

  const handleSaveOpportunityDocument = async (opportunity) => {
    if (!selectedProfile || !filters.profileId || filters.profileId === "all") {
      toast({
        variant: "destructive",
        title: "Select a profile first",
        description: "Choose a profile so we know where to store this opportunity summary.",
      })
      return
    }

    setSavingOpportunityId(opportunity.id)
    try {
      const match = scoreOpportunity(opportunity, selectedProfile)
      const summary = buildOpportunitySummary(opportunity, selectedProfile, match)
      const timestamp = new Date().toLocaleString()
      await createDocument({
        profile_id: selectedProfile.id,
        organization_id: selectedProfile.organization_id ?? null,
        name: `${opportunity.title || "Funding opportunity"} summary`,
        type: "funding_opportunity",
        extracted_text: summary,
        ai_summary: opportunity.description ?? null,
        processing_status: "completed",
        status: "final",
        notes: `Saved from Funding Opportunities on ${timestamp}`,
      })

      toast({
        title: "Saved to documents",
        description: "The summary is now available in the Documents library.",
      })
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Unable to save summary",
        description: error instanceof Error ? error.message : "Try again shortly.",
      })
    } finally {
      setSavingOpportunityId(null)
    }
  }

  const handlePrintOpportunity = (opportunity) => {
    if (!selectedProfile || !filters.profileId || filters.profileId === "all") {
      toast({
        variant: "destructive",
        title: "Select a profile first",
        description: "Choose a profile before printing the opportunity summary.",
      })
      return
    }
    const match = scoreOpportunity(opportunity, selectedProfile)
    const summary = buildOpportunitySummary(opportunity, selectedProfile, match)
    const printWindow = window.open("", "_blank", "noopener,noreferrer")
    if (!printWindow) {
      toast({
        variant: "destructive",
        title: "Unable to open print window",
        description: "Allow pop-ups for GrantFlow to print summaries.",
      })
      return
    }
    const safeTitle = (opportunity.title || "Funding opportunity").replace(/[<>]/g, "")
    const safeContent = summary
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")

    printWindow.document.write(`
      <html>
        <head>
          <title>${safeTitle}</title>
          <style>
            body { font-family: Arial, Helvetica, sans-serif; padding: 24px; line-height: 1.6; color: #111827; }
            h1 { font-size: 20px; margin-bottom: 16px; }
            pre { white-space: pre-wrap; word-wrap: break-word; font-size: 14px; }
          </style>
        </head>
        <body>
          <h1>${safeTitle}</h1>
          <pre>${safeContent}</pre>
        </body>
      </html>
    `)
    printWindow.document.close()
    printWindow.focus()
    printWindow.print()
  }

  const handleRequestComprehensiveSweep = async () => {
    try {
      const job = await createCrawlerJob({ type: "comprehensive" })
      toast({
        title: "Crawler dispatched",
        description: `Comprehensive sweep queued (job ${job.id.slice(0, 8)}…). Results will populate automatically.`,
      })
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Unable to queue sweep",
        description: error instanceof Error ? error.message : "Try again in a moment.",
      })
    }
  }

  const isLoading = opportunitiesQuery.isLoading || profilesQuery.isLoading
  const hasResults = opportunitiesWithMatch.length > 0

  return (
    <div className="p-6 md:p-8 space-y-8">
      <header className="space-y-6">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700 uppercase tracking-wide">
              <Layers className="w-3 h-3" />
              Opportunity Observatory
            </div>
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900">Funding Opportunities</h1>
            <p className="text-sm md:text-base text-slate-600 max-w-3xl">
              Aggregated grants, scholarships, endowments, and benefits sourced from local crawlers, national feeds, and
              partner portals. Filter by geography and source, then let AI score how well each opportunity matches your
              profiles.
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white/70 backdrop-blur p-4 shadow-sm space-y-2 text-sm text-slate-600 max-w-md">
            <p className="font-semibold text-slate-900 flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-amber-500" />
              Crawler coverage highlights
            </p>
            <ul className="list-disc list-inside space-y-1 text-xs">
              <li>Local crawler: 50-mile radius of profile zip codes (and student campus ZIPs).</li>
              <li>Scholarship crawler: FAFSA, Common App, and campus portals.</li>
              <li>Comprehensive crawler: 44k+ US ZIP searches, minimum 3 results per ZIP.</li>
              <li>Default view surfaces grant funds only. Adjust the Funding terms filter to review programs with match or repayment requirements.</li>
            </ul>
          </div>
        </div>

        {/* Auto-discovery status banner */}
        {autoDiscoveryStatus && autoDiscoveryStatus.total > 0 && (
          <Alert className="border-blue-200 bg-blue-50">
            <Sparkles className="w-4 h-4 text-blue-600" />
            <AlertDescription>
              {autoDiscoveryStatus.running > 0 ? (
                <>Discovering opportunities across {autoDiscoveryStatus.running} sources...</>
              ) : (
                <>Auto-discovery complete! {autoDiscoveryStatus.completed} crawler{autoDiscoveryStatus.completed === 1 ? '' : 's'} finished. Refresh to see new opportunities.</>
              )}
            </AlertDescription>
          </Alert>
        )}

        <Card className="border border-slate-200 bg-white/80 backdrop-blur shadow-sm">
          <CardContent className="pt-6 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-6 gap-4 items-end">
              <div className="md:col-span-2 space-y-2">
                <Label htmlFor="search" className="text-xs uppercase tracking-wide text-slate-500 flex items-center gap-2">
                  <Filter className="w-3 h-3" />
                  Search opportunities
                </Label>
                <Input
                  id="search"
                  placeholder="Search by title, sponsor, description"
                  value={filters.search}
                  onChange={(event) => setFilters((prev) => ({ ...prev, search: event.target.value }))}
                />
              </div>

              <div className="space-y-2">
                <Label className="text-xs uppercase tracking-wide text-slate-500">Source</Label>
                <Select
                  value={filters.source}
                  onValueChange={(value) => setFilters((prev) => ({ ...prev, source: value }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="All sources" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All sources</SelectItem>
                    {sourcesQuery.data?.map((source) => (
                      <SelectItem key={source.source || "unknown"} value={source.source || "unknown"}>
                        {source.source || "Unnamed source"} ({source.count})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
                      <SelectItem key={state.state || "unknown"} value={state.state || "unknown"}>
                        {state.state || NOT_AVAILABLE} ({state.count})
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

              <div className="space-y-2">
                <Label className="text-xs uppercase tracking-wide text-slate-500">Funding terms</Label>
                <Select
                  value={filters.compliance}
                  onValueChange={(value) => setFilters((prev) => ({ ...prev, compliance: value }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Grant funds only" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="grant_only">Grant funds only</SelectItem>
                    <SelectItem value="all">Include review-required</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-slate-100 pt-4">
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <Switch
                    id="national-switch"
                    checked={filters.nationalOnly}
                    onCheckedChange={(checked) => setFilters((prev) => ({ ...prev, nationalOnly: checked }))}
                  />
                  <Label htmlFor="national-switch" className="text-sm text-slate-600">
                    National funding only
                  </Label>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setFilters({
                      search: "",
                      state: "all",
                      source: "all",
                      nationalOnly: false,
                      profileId: "",
                      compliance: "grant_only",
                    })
                  }
                >
                  Reset filters
                </Button>
              </div>
              <p className="text-xs text-slate-500">
                Showing {totalResults} opportunity{totalResults === 1 ? "" : "ies"}. {complianceMessage}
              </p>
            </div>
          </CardContent>
        </Card>
      </header>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {Array.from({ length: 6 }).map((_, index) => (
            <Card key={`skeleton-${index}`} className="border border-slate-200 bg-white/60 backdrop-blur">
              <CardHeader className="space-y-2">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-6 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
              </CardHeader>
              <CardContent className="space-y-3">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-2/3" />
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-2 w-full" />
              </CardContent>
              <CardFooter>
                <Skeleton className="h-10 w-full" />
              </CardFooter>
            </Card>
          ))}
        </div>
      ) : hasResults ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {opportunitiesWithMatch.map(({ opportunity, match }) => (
            <OpportunityCard
              key={opportunity.id}
              opportunity={opportunity}
              onSelect={setSelectedOpportunity}
              match={match}
              onAddToPipeline={handleAddToPipeline}
              isAddingToPipeline={addingOpportunityId === opportunity.id}
              canAddToPipeline={Boolean(
                selectedProfile &&
                selectedProfile.organization_id &&
                filters.profileId &&
                filters.profileId !== "all"
              )}
            />
          ))}
        </div>
      ) : (
        <Card className="border border-slate-200 bg-white/70 backdrop-blur">
          <CardContent className="p-12 text-center space-y-4">
            <Layers className="w-12 h-12 mx-auto text-slate-300" />
            <h3 className="text-xl font-semibold text-slate-900">No opportunities found</h3>
            <p className="text-sm text-slate-600">
              Adjust your filters or ensure the crawlers have ingested the latest sources. A minimum of three opportunities per
              ZIP will appear once the comprehensive crawler finishes its sweep.
            </p>
            <Button variant="outline" onClick={handleRequestComprehensiveSweep}>
              Trigger crawler sweep
            </Button>
          </CardContent>
        </Card>
      )}

      <OpportunityDetail
        opportunity={selectedOpportunity}
        open={Boolean(selectedOpportunity)}
        onClose={() => setSelectedOpportunity(null)}
        match={
          selectedOpportunity && filters.profileId
            ? scoreOpportunity(selectedOpportunity, selectedProfile)
            : null
        }
        onAddToPipeline={handleAddToPipeline}
        isAddingToPipeline={
          Boolean(selectedOpportunity) && addingOpportunityId === selectedOpportunity.id
        }
        canAddToPipeline={
          Boolean(
            selectedProfile &&
              selectedProfile.organization_id &&
              filters.profileId &&
              filters.profileId !== "all",
          )
        }
        selectedProfileName={selectedProfile?.display_name}
        onSaveDocument={handleSaveOpportunityDocument}
        isSavingDocument={
          Boolean(selectedOpportunity) && savingOpportunityId === selectedOpportunity.id
        }
        canSaveDocument={Boolean(selectedProfile && filters.profileId && filters.profileId !== "all")}
        onPrintOpportunity={handlePrintOpportunity}
      />
    </div>
  )
}
