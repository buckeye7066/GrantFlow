import React, { useMemo, useState, useCallback } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import {
  AlertTriangle,
  Bookmark,
  Building,
  CalendarDays,
  CheckCircle2,
  DollarSign,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  FileText,
  Filter,
  Globe,
  Layers,
  Loader2,
  MapPin,
  Printer,
  Save,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Target,
  Trash2,
  X,
} from "lucide-react"
import { format } from "date-fns"
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { useToast } from "@/components/ui/use-toast"
import { listOpportunities, listOpportunitySources, listOpportunityStates } from "@/api/opportunities"
import { listProfiles, getProfile } from "@/api/profiles"
import { createCrawlerJob, fetchCrawlerStatus } from "@/api/crawlers"
import { createGrant } from "@/api/grants"
import { createDocument } from "@/api/documents"
import { apiFetch } from "@/api/client"
import { cn } from "@/lib/utils"
import { formatAddress, createPageUrl } from "@/utils"
import { formatReasonText } from "@/utils/reasonText"
import { env } from "@/config/env.js"
import GeoFundingView from "@/components/funding/GeoFundingView"
import OpportunitySourceTrace from "@/components/funding/OpportunitySourceTrace"
import ZeroResultGuidance from "@/components/funding/ZeroResultGuidance"
import { useSavedSearches, useViewHistory, useHiddenGrants, exportGrantAsPDF, parseBooleanQuery } from "@/hooks/useGrantTools"

const NOT_AVAILABLE = 'N/A'

// Safely parse a URL hostname, falling back to the raw string when the value
// is not a valid absolute URL (crawler data can contain relative paths/garbage).
function safeHostname(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return ""
  try {
    return new URL(rawUrl).hostname
  } catch {
    return rawUrl
  }
}

const STATE_CODES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
  "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
  "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC",
])

const STATE_NAME_TO_CODE = new Map([
  ["alabama","AL"],["alaska","AK"],["arizona","AZ"],["arkansas","AR"],["california","CA"],
  ["colorado","CO"],["connecticut","CT"],["delaware","DE"],["florida","FL"],["georgia","GA"],
  ["hawaii","HI"],["idaho","ID"],["illinois","IL"],["indiana","IN"],["iowa","IA"],
  ["kansas","KS"],["kentucky","KY"],["louisiana","LA"],["maine","ME"],["maryland","MD"],
  ["massachusetts","MA"],["michigan","MI"],["minnesota","MN"],["mississippi","MS"],["missouri","MO"],
  ["montana","MT"],["nebraska","NE"],["nevada","NV"],["new hampshire","NH"],["new jersey","NJ"],
  ["new mexico","NM"],["new york","NY"],["north carolina","NC"],["north dakota","ND"],["ohio","OH"],
  ["oklahoma","OK"],["oregon","OR"],["pennsylvania","PA"],["rhode island","RI"],["south carolina","SC"],
  ["south dakota","SD"],["tennessee","TN"],["texas","TX"],["utah","UT"],["vermont","VT"],
  ["virginia","VA"],["washington","WA"],["west virginia","WV"],["wisconsin","WI"],["wyoming","WY"],
  ["district of columbia","DC"],
])

function deriveStateFromText(text) {
  if (!text || typeof text !== "string") return null
  const trimmed = text.trim()
  if (!trimmed) return null

  const zipStateMatch = trimmed.match(/\b([A-Za-z]{2})\s+\d{5}\b/)
  if (zipStateMatch) {
    const code = zipStateMatch[1].toUpperCase()
    if (STATE_CODES.has(code)) return code
  }

  const codeMatches = trimmed.toUpperCase().match(/\b([A-Z]{2})\b/g) ?? []
  for (const candidate of codeMatches) {
    if (STATE_CODES.has(candidate)) return candidate
  }

  const lower = trimmed.toLowerCase()
  for (const [name, code] of STATE_NAME_TO_CODE.entries()) {
    if (lower.includes(name)) return code
  }

  return null
}

function deriveStateFromProfile(profileDetail) {
  if (!profileDetail) return null
  const sections = Array.isArray(profileDetail.sections) ? profileDetail.sections : []
  const basic = sections.find((s) => s?.section_key === "basic_information")?.data ?? null
  const location = sections.find((s) => s?.section_key === "location_focus")?.data ?? null

  const candidates = [
    basic?.state,
    basic?.address_state,
    basic?.address,
    location?.state,
    location?.primary_state,
    location?.geographic_focus,
  ]

  for (const entry of candidates) {
    const state = deriveStateFromText(entry)
    if (state) return state
  }

  return null
}

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
  const hasMin = min !== null && min !== undefined
  const hasMax = max !== null && max !== undefined
  if (!hasMin && !hasMax) return "Varies"
  if (hasMin && hasMax && min !== max) {
    return `$${min.toLocaleString()} – $${max.toLocaleString()}`
  }
  const amount = (hasMin ? min : hasMax ? max : 0).toLocaleString()
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
  if (typeof match?.score === "number") {
    lines.push(`Match score: ${match.score}%`)
  }
  if (Array.isArray(match?.reasons) && match.reasons.length) {
    lines.push("")
    lines.push("Top match reasons:")
    match.reasons.slice(0, 5).forEach((reason, index) => {
      const text = formatReasonText(reason)
      if (text) lines.push(`  ${index + 1}. ${text}`)
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

// Match score for an opportunity. This intentionally does NOT compute a score
// in the browser — the backend scores each opportunity server-side from the real
// profile (GET /api/opportunities?profile_id=...) and returns match_score /
// match_reasons. A client-side score would be a fabricated number that diverges
// from the matcher the rest of the app trusts. When the backend hasn't scored a
// row (e.g. no profile selected yet), we show no match % rather than inventing one.
function scoreOpportunity(opportunity, profileDetail) {
  if (!profileDetail) {
    return { score: null, reasons: ["Select a profile to see a match score"], overlap: [] }
  }

  const backendScore = Number(opportunity?.match_score)
  if (Number.isFinite(backendScore)) {
    const reasons = Array.isArray(opportunity?.match_reasons) ? opportunity.match_reasons : []
    return { score: Math.max(0, Math.min(100, Math.round(backendScore))), reasons, overlap: [] }
  }

  // Backend returned no score for this row — do not fabricate one.
  return { score: null, reasons: [], overlap: [] }
}

function OpportunityCard({
  opportunity,
  onSelect,
  match,
  onAddToPipeline,
  isAddingToPipeline,
  canAddToPipeline,
  profiles = [],
  selectedProfileId,
  onSelectProfileId,
  viewed = false,
  onHide,
  onUnhide,
  isGrantHidden = false,
}) {
  const matchScore = typeof match?.score === "number" ? match.score : null
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
  const hasUrl = Boolean(opportunity.source_url || opportunity.application_url)
  const recordOrigin = opportunity.record_origin || "live_crawl"
  const isSynthetic = recordOrigin === "synthetic"
  
  // Get type badge styling and label
  const getTypeBadge = (type) => {
    switch(type) {
      case 'OPPORTUNITY':
        return { 
          label: 'Open Grant', 
          className: 'bg-green-100 text-green-700 border-green-300' 
        }
      case 'PROGRAM':
        return { 
          label: 'Standing Program', 
          className: 'bg-blue-100 text-blue-700 border-blue-300' 
        }
      case 'DIRECTORY':
        return { 
          label: 'Resource Directory', 
          className: 'bg-gray-100 text-gray-700 border-gray-300' 
        }
      default:
        return { 
          label: 'Unverified', 
          className: 'bg-amber-100 text-amber-700 border-amber-300' 
        }
    }
  }
  
  const typeBadge = getTypeBadge(opportunity.type)

  // Get match color based on score. Guard against non-numeric input.
  const getMatchColor = (score) => {
    if (typeof score !== "number" || !Number.isFinite(score)) {
      return "text-slate-600 bg-slate-50 border-slate-200"
    }
    if (score >= 80) return "text-emerald-600 bg-emerald-50 border-emerald-200"
    if (score >= 60) return "text-blue-600 bg-blue-50 border-blue-200"
    if (score >= 40) return "text-amber-600 bg-amber-50 border-amber-200"
    return "text-slate-600 bg-slate-50 border-slate-200"
  }

  const handleQuickAdd = async (event) => {
    event.stopPropagation()
    if (onAddToPipeline) {
      try {
        await onAddToPipeline(opportunity)
      } catch {
        // Errors are surfaced via toast in the caller.
      }
    }
  }

  return (
    <Card
      className="transition hover:shadow-lg border border-slate-200 bg-white/80 backdrop-blur cursor-pointer flex flex-col group"
      onClick={() => onSelect(opportunity)}
    >
      <CardHeader className="pb-3 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="uppercase text-[11px] tracking-wide text-slate-500">
              {opportunity.source || "Uncategorized"}
            </Badge>
            {/* Type Badge (OPPORTUNITY/PROGRAM/DIRECTORY) */}
            {opportunity.type && (
              <Badge className={cn("text-xs border font-semibold uppercase tracking-wider", typeBadge.className)}>
                {typeBadge.label}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            {opportunity.opportunity_type ? (
              <Badge variant="outline" className="text-xs uppercase tracking-wide text-slate-500">
                {opportunityTypeLabel}
              </Badge>
            ) : null}
            <Badge className={cn("text-xs border", complianceBadgeClass)}>{complianceBadgeText}</Badge>
          </div>
        </div>
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-lg font-semibold text-slate-900 line-clamp-2 group-hover:text-blue-700 transition-colors flex-1">
            {opportunity.title}
          </h3>
          <div className="flex items-center gap-1 shrink-0">
            {viewed && (
              <span className="inline-flex items-center gap-1 text-[10px] text-slate-400" title="Previously viewed">
                <Eye className="w-3 h-3" />
              </span>
            )}
            {isGrantHidden ? (
              <button
                className="p-1 rounded hover:bg-slate-100 text-slate-400 hover:text-blue-600"
                title="Unhide this grant"
                onClick={(e) => { e.stopPropagation(); onUnhide?.(opportunity.id) }}
              >
                <Eye className="w-3.5 h-3.5" />
              </button>
            ) : (
              <button
                className="p-1 rounded hover:bg-slate-100 text-slate-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                title="Hide this grant"
                onClick={(e) => { e.stopPropagation(); onHide?.(opportunity.id) }}
              >
                <EyeOff className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
        {/* Trust indicator */}
        {opportunity.last_verified_at ? (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-emerald-100 text-emerald-800 border border-emerald-200">
            <CheckCircle2 className="w-3 h-3" />
            Verified
          </span>
        ) : isSynthetic || !hasUrl ? (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800 border border-amber-200">
            <AlertTriangle className="w-3 h-3" />
            Review source
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-700 border border-slate-200">
            <Layers className="w-3 h-3" />
            Live source
          </span>
        )}
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
        <p className="text-sm text-slate-600 line-clamp-2">{opportunity.description || "No summary available yet."}</p>

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

        {/* Match Score - shown only when the backend actually scored this row */}
        {match && matchScore !== null ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className={cn("rounded-lg border p-3 space-y-2 cursor-help", getMatchColor(matchScore))}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Target className="w-4 h-4" />
                      <span className="text-sm font-semibold uppercase tracking-wide">Match Score</span>
                    </div>
                    <span className="text-2xl font-bold">{matchScore}%</span>
                  </div>
                  <Progress value={matchScore} className="h-2" />
                  {match.reasons && match.reasons.length > 0 && (
                    <p className="text-xs opacity-80 line-clamp-1">{match.reasons[0]} {match.reasons.length > 1 && `+${match.reasons.length - 1} more`}</p>
                  )}
                </div>
              </TooltipTrigger>
              <TooltipContent className="max-w-sm p-3">
                <div className="space-y-2">
                  <p className="font-semibold text-sm">Match Reasons:</p>
                  <ul className="text-xs space-y-1">
                    {match.reasons && match.reasons.map((reason, idx) => {
                      const text = formatReasonText(reason)
                      return text ? (
                        <li key={idx} className="flex items-start gap-2">
                          <CheckCircle2 className="w-3 h-3 mt-0.5 flex-shrink-0 text-green-600" />
                          <span>{text}</span>
                        </li>
                      ) : null
                    })}
                  </ul>
                </div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          <div className="rounded-lg border border-dashed border-slate-200 p-3 text-xs text-slate-500">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Target className="w-4 h-4 opacity-50" />
                <span>Select a profile to see match score</span>
              </div>
              {Array.isArray(profiles) && profiles.length > 0 && typeof onSelectProfileId === "function" ? (
                <div
                  className="min-w-[180px]"
                  onClick={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <Select
                    value={selectedProfileId || "all"}
                    onValueChange={(value) => onSelectProfileId(value)}
                  >
                    <SelectTrigger className="h-8 bg-white text-slate-900 border-slate-300">
                      <SelectValue placeholder="Select profile" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All profiles</SelectItem>
                      {profiles.map((profile) => (
                        <SelectItem key={profile.id} value={profile.id}>
                          {profile.display_name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
            </div>
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
  onCreateVNext,
  isCreatingVNext = false,
  canCreateVNext = false,
  selectedProfileName,
  profiles = [],
  selectedProfileId,
  onSelectProfileId,
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

  const handleCreateVNextClick = async () => {
    if (!onCreateVNext) return
    try {
      await onCreateVNext(opportunity)
    } catch {
      // surfaced in caller
    }
  }

  const hasUrl = Boolean(opportunity.source_url || opportunity.application_url)
  const recordOrigin = opportunity.record_origin || "live_crawl"
  const isSynthetic = recordOrigin === "synthetic"
  let contactInfo = null
  if (opportunity.contact_info) {
    try {
      contactInfo =
        typeof opportunity.contact_info === "string" ? JSON.parse(opportunity.contact_info) : opportunity.contact_info
    } catch {
      contactInfo = null
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader className="space-y-2">
          <DialogTitle className="text-2xl font-semibold text-slate-900">{opportunity.title}</DialogTitle>
          {/* Trust indicator in detail view */}
          {opportunity.last_verified_at ? (
            <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-emerald-100 text-emerald-800 border border-emerald-200 w-fit">
              <CheckCircle2 className="w-3 h-3" />
              Verified
            </div>
          ) : isSynthetic || !hasUrl ? (
            <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800 border border-amber-200 w-fit">
              <AlertTriangle className="w-3 h-3" />
              Review source
            </div>
          ) : (
            <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-700 border border-slate-200 w-fit">
              <Layers className="w-3 h-3" />
              Live source
            </div>
          )}
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
                      {reviewReasons.map((reason, index) => {
                        const text = formatReasonText(reason)
                        return text ? <li key={`${text}-${index}`}>{text}</li> : null
                      })}
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
              
              {/* Evidence URL and Verification */}
              {(opportunity.evidence_url || opportunity.last_verified_at) && (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2 col-span-1 sm:col-span-2">
                  <p className="font-semibold text-slate-800 flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-green-600" />
                    Verification
                  </p>
                  {opportunity.evidence_url && (
                    <div className="flex items-center gap-2 text-xs text-blue-600">
                      <ExternalLink className="w-3 h-3" />
                      <a 
                        href={opportunity.evidence_url} 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="hover:underline truncate"
                      >
                        Evidence URL: {safeHostname(opportunity.evidence_url)}
                      </a>
                    </div>
                  )}
                  {opportunity.last_verified_at && (
                    <p className="text-xs text-slate-600">
                      Verified on {formatDeadline(opportunity.last_verified_at)}
                    </p>
                  )}
                </div>
              )}

              {/* Contact info */}
              {(contactInfo || opportunity.application_url || opportunity.source_url) && (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2 col-span-1 sm:col-span-2">
                  <p className="font-semibold text-slate-800 flex items-center gap-2">
                    <ExternalLink className="w-4 h-4 text-blue-600" />
                    Contact & links
                  </p>
                  {contactInfo?.name ? <p className="text-sm text-slate-700">{contactInfo.name}</p> : null}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                    {contactInfo?.email ? (
                      <a className="text-blue-600 hover:underline truncate" href={`mailto:${contactInfo.email}`}>
                        Email: {contactInfo.email}
                      </a>
                    ) : null}
                    {contactInfo?.phone ? (
                      <a className="text-blue-600 hover:underline truncate" href={`tel:${contactInfo.phone}`}>
                        Phone: {contactInfo.phone}
                      </a>
                    ) : null}
                    {contactInfo?.website ? (
                      <a
                        className="text-blue-600 hover:underline truncate"
                        href={contactInfo.website}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Website: {contactInfo.website}
                      </a>
                    ) : null}
                    {opportunity.application_url ? (
                      <a
                        className="text-blue-600 hover:underline truncate"
                        href={opportunity.application_url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Application: {safeHostname(opportunity.application_url)}
                      </a>
                    ) : null}
                    {!opportunity.application_url && opportunity.source_url ? (
                      <a
                        className="text-blue-600 hover:underline truncate"
                        href={opportunity.source_url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Source: {safeHostname(opportunity.source_url)}
                      </a>
                    ) : null}
                  </div>
                  {contactInfo?.address ? (
                    <p className="text-xs text-slate-600 whitespace-pre-line">
                      {formatAddress(contactInfo.address)}
                    </p>
                  ) : null}
                </div>
              )}
            </div>
            <OpportunitySourceTrace
              opportunity={opportunity}
              match={match}
              profileName={selectedProfileName}
            />
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
                    reasonList.map((reason, index) => {
                      const text = formatReasonText(reason)
                      return text ? <li key={`${text}-${index}`}>{text}</li> : null
                    })
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
              {opportunity.description || "No summary available yet."}
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
          <div className="flex flex-col gap-2">
            <p className="text-xs text-slate-500">
              {canAddToPipeline
                ? `Grant will be added to ${selectedProfileName ?? "the selected profile"}'s pipeline.`
                : "Select a profile to enable pipeline creation."}
            </p>
            {Array.isArray(profiles) && profiles.length > 0 && typeof onSelectProfileId === "function" ? (
              <div className="max-w-xs">
                <Label className="text-[11px] uppercase tracking-wide text-slate-500">Profile</Label>
                <div className="mt-1">
                  <Select
                    value={selectedProfileId || "all"}
                    onValueChange={(value) => onSelectProfileId(value)}
                  >
                    <SelectTrigger className="h-9 bg-white text-slate-900 border-slate-300">
                      <SelectValue placeholder="Select profile" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All profiles</SelectItem>
                      {profiles.map((profile) => (
                        <SelectItem key={profile.id} value={profile.id}>
                          {profile.display_name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            ) : null}
          </div>
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
              variant="outline"
              size="sm"
              onClick={() => exportGrantAsPDF(opportunity)}
            >
              <Download className="w-4 h-4 mr-2" />
              Export PDF
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
            {env.shouldersVnext ? (
              <Button
                variant="outline"
                size="sm"
                disabled={!canCreateVNext || isCreatingVNext || !onCreateVNext}
                onClick={handleCreateVNextClick}
              >
                {isCreatingVNext ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                vNext: Create application
              </Button>
            ) : null}
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
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const geoRunIdFromUrl = String(searchParams.get("geo_run_id") || searchParams.get("run_id") || "").trim()

  const [filters, setFilters] = useState(() => ({
    search: "",
    state: "all",
    source: "all",
    nationalOnly: false,
    profileId: "all",
    compliance: "grant_only",
    geo_run_id: geoRunIdFromUrl || "",
  }))
  const [selectedOpportunity, setSelectedOpportunity] = useState(null)
  const [addingOpportunityId, setAddingOpportunityId] = useState(null)
  const [savingOpportunityId, setSavingOpportunityId] = useState(null)
  const [creatingVNextOpportunityId, setCreatingVNextOpportunityId] = useState(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [viewMode, setViewMode] = useState("list") // "list" | "geo"
  const [showHidden, setShowHidden] = useState(false)
  const [showSavedSearches, setShowSavedSearches] = useState(false)
  const ITEMS_PER_PAGE = 50

  // GrantWatch-beating tools
  const { savedSearches, saveSearch, deleteSearch } = useSavedSearches()
  const { viewHistory, recordView, isViewed } = useViewHistory()
  const { hiddenCount, hideGrant, unhideGrant, unhideAll, isHidden } = useHiddenGrants()

  React.useEffect(() => {
    // Keep filter in sync with URL (so monitor->opportunities deep-links work).
    if (geoRunIdFromUrl && geoRunIdFromUrl !== filters.geo_run_id) {
      setFilters((prev) => ({ ...prev, geo_run_id: geoRunIdFromUrl }))
      return
    }
    if (!geoRunIdFromUrl && filters.geo_run_id) {
      setFilters((prev) => ({ ...prev, geo_run_id: "" }))
    }
  }, [geoRunIdFromUrl, filters.geo_run_id])

  const opportunitiesQuery = useQuery({
    queryKey: ["opportunities", filters, currentPage],
    queryFn: () =>
      listOpportunities({
        search: filters.search || undefined,
        state: filters.state !== "all" ? filters.state : undefined,
        source: filters.source !== "all" ? filters.source : undefined,
        is_national: filters.nationalOnly ? "true" : undefined,
        compliance: filters.compliance,
        geo_run_id: filters.geo_run_id || undefined,
        // Pass the selected profile so the backend scores each opportunity
        // server-side (returns match_score/match_reasons). Without this the page
        // has no real score to show.
        profile_id: filters.profileId || undefined,
        limit: ITEMS_PER_PAGE,
        offset: (currentPage - 1) * ITEMS_PER_PAGE,
      }),
    // Live refresh when viewing a GeoCrawl run (new rows arrive incrementally).
    refetchInterval: filters.geo_run_id ? 3000 : false,
  })
  
  // Reset to page 1 when filters that affect the result set change.
  // Depend on specific fields (not the whole filters object identity) so URL
  // sync / geo_run_id changes don't trigger redundant page resets.
  React.useEffect(() => {
    setCurrentPage(1)
  }, [
    filters.search,
    filters.state,
    filters.source,
    filters.nationalOnly,
    filters.profileId,
    filters.compliance,
    filters.geo_run_id,
  ])

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
  const profiles = Array.isArray(profilesQuery.data) ? profilesQuery.data : []

  const selectedProfileQuery = useQuery({
    queryKey: ["profile-detail", filters.profileId],
    queryFn: () => getProfile(filters.profileId),
    enabled: Boolean(filters.profileId) && filters.profileId !== "all",
  })

  // Auto-discovery status polling
  const autoDiscoveryQuery = useQuery({
    queryKey: ["auto-discovery-status", filters.profileId],
    queryFn: () => fetchCrawlerStatus(filters.profileId),
    // React Query v5: refetchInterval receives the Query object, not data.
    refetchInterval: (query) => {
      // Poll every 5s if crawlers are running
      if (query?.state?.data?.running > 0) return 5000
      // Stop polling after completion
      return false
    },
    enabled: Boolean(filters.profileId) && filters.profileId !== "all",
  })

  const opportunitiesResponse = opportunitiesQuery.data ?? null
  const opportunities = opportunitiesResponse?.data ?? []
  const effectiveCompliance = opportunitiesResponse?.compliance_effective ?? filters.compliance
  const fallbackApplied = Boolean(opportunitiesResponse?.fallback_applied)
  const totalResults = typeof opportunitiesResponse?.total === "number" ? opportunitiesResponse.total : opportunities.length
  const selectedProfile = selectedProfileQuery.data ?? null
  const autoDiscoveryStatus = autoDiscoveryQuery.data ?? null
  const complianceMessage =
    effectiveCompliance === "grant_only"
      ? "Grant funds only — loans excluded; opportunities with match/repayment terms are flagged for review."
      : "Including loans and opportunities that may require matching funds or repayment."

  const clearGeoRunFilter = () => {
    setFilters((prev) => ({ ...prev, geo_run_id: "" }))
    const next = new URLSearchParams(searchParams)
    next.delete("geo_run_id")
    next.delete("run_id")
    setSearchParams(next, { replace: true })
  }

  const resetFundingFilters = () => {
    const profileId = filters.profileId && filters.profileId !== "all" ? filters.profileId : "all"
    setFilters({
      search: "",
      state: "all",
      source: "all",
      nationalOnly: false,
      profileId,
      compliance: "grant_only",
      geo_run_id: "",
    })
    const next = new URLSearchParams(searchParams)
    next.delete("geo_run_id")
    next.delete("run_id")
    setSearchParams(next, { replace: true })
  }

  // When a profile is selected, default the state filter based on their address/geographic focus.
  React.useEffect(() => {
    if (!selectedProfile) return
    if (filters.profileId === "all") return
    if (filters.state !== "all") return
    const derived = deriveStateFromProfile(selectedProfile)
    if (!derived) return
    setFilters((prev) => ({ ...prev, state: derived }))
  }, [selectedProfile, filters.profileId, filters.state])

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

    const getStateKey = (opportunity) =>
      (opportunity?.state && String(opportunity.state).trim()) || (opportunity?.is_national ? "National" : null) || ""

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

    // Group by state → zip: sort so catalog displays state first, then zip within state
    ordered.sort((a, b) => {
      const stateA = getStateKey(a)
      const stateB = getStateKey(b)
      if (stateA !== stateB) return (stateA || "").localeCompare(stateB || "", undefined, { sensitivity: "base" })
      const zipA = getZipKey(a) ?? ""
      const zipB = getZipKey(b) ?? ""
      return zipA.localeCompare(zipB, undefined, { numeric: true })
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

  // Pagination calculations (Server-side). Clamp to at least 1 to avoid 0/NaN.
  const totalPages = Math.max(1, Math.ceil((Number(totalResults) || 0) / ITEMS_PER_PAGE))

  // Apply client-side filters: hide dismissed grants + boolean search
  const booleanFilter = useMemo(() => parseBooleanQuery(filters.search), [filters.search])
  // Compute once whether the search uses boolean operators (constant per search).
  const usesBooleanOperators = useMemo(
    () => /\b(AND|OR|NOT)\b/.test(filters.search),
    [filters.search],
  )
  const paginatedOpportunities = useMemo(() => {
    return opportunitiesWithMatch.filter(({ opportunity }) => {
      // Hidden grants filter
      if (!showHidden && isHidden(opportunity.id)) return false
      // Boolean search (client-side refinement on top of server search)
      if (usesBooleanOperators) {
        const text = [opportunity.title, opportunity.description, opportunity.sponsor].filter(Boolean).join(" ")
        if (!booleanFilter(text)) return false
      }
      return true
    })
  }, [opportunitiesWithMatch, showHidden, isHidden, usesBooleanOperators, booleanFilter])

  const handleAddToPipeline = async (opportunity) => {
    if (!selectedProfile || !filters.profileId || filters.profileId === "all") {
      toast({
        variant: "destructive",
        title: "Select a profile first",
        description: "Choose a profile to determine which pipeline should receive this opportunity.",
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

      // IMPORTANT: use apiFetch so Authorization + refresh are applied (prevents 401s).
      const created = await apiFetch("/api/grants/from-opportunity", {
        method: "POST",
        headers: {
          // Scope the request to the selected profile (helps with profile-scoped sessions).
          "X-Profile-Id": selectedProfile.id,
        },
        body: JSON.stringify({
          opportunity_id: opportunity.id || null,
          profile_id: selectedProfile.id,
          organization_id: selectedProfile.organization_id || null,
          match_score: Number.isFinite(computedMatch?.score) ? computedMatch.score : null,
          match_reasons: normalizedReasons,
          // Include full opportunity data for synthetic opportunities
          opportunity_data: {
            title: opportunity.title,
            sponsor: opportunity.sponsor || opportunity.funder,
            deadline: opportunity.deadline,
            url: opportunity.url || opportunity.application_url,
            awardMin: opportunity.amount_min ?? null,
            awardMax: opportunity.amount_max ?? null,
            descriptionMd: opportunity.description,
            eligibilityBullets: opportunity.eligibility_bullets || [],
            source: opportunity.source || "database",
          },
        }),
      })

      toast({
        title: "Added to pipeline",
        description: `${
          opportunity.title
        } is now in the pipeline for ${selectedProfile.display_name || "the selected profile"}.`,
      })

      setSelectedOpportunity(null)
      return created
    } catch (error) {
      // Extract error code for better user messaging
      const errorCode = error?.errorCode || error?.error || 'unknown_error'
      let description = 'Try again in a moment.'
      
      if (errorCode === 'profile_not_found') {
        description = 'The selected profile was not found. Please refresh the page.'
      } else if (errorCode === 'opportunity_expired') {
        description = 'This opportunity has expired and cannot be added.'
      } else if (errorCode === 'opportunity_not_found') {
        description = 'The opportunity could not be found. It may have been removed.'
      } else if (error instanceof Error && error.message) {
        description = error.message
      }
      
      toast({
        variant: "destructive",
        title: "Unable to add to pipeline",
        description,
      })
      throw error
    } finally {
      setAddingOpportunityId(null)
    }
  }

  const handleCreateVNextApplication = async (opportunity) => {
    if (!env.shouldersVnext) return
    if (!selectedProfile || !filters.profileId || filters.profileId === "all") {
      toast({
        variant: "destructive",
        title: "Select a profile first",
        description: "Choose a single profile to create a vNext application.",
      })
      return
    }

    setCreatingVNextOpportunityId(opportunity.id)
    try {
      const created = await apiFetch("/api/vnext/applications", {
        method: "POST",
        headers: {
          "X-Profile-Id": selectedProfile.id,
        },
        body: JSON.stringify({
          profile_id: selectedProfile.id,
          opportunity_id: opportunity.id,
        }),
      })

      if (!created?.id) throw new Error("Create failed (missing id)")

      toast({
        title: "vNext application created",
        description: "Opening vNext application view.",
      })
      setSelectedOpportunity(null)
      navigate(`/VNextApplication?id=${encodeURIComponent(created.id)}`)
      return created
    } catch (error) {
      const msg = error?.details?.error?.message || error?.details?.message || error?.message || "Create failed"
      toast({
        variant: "destructive",
        title: "vNext create failed",
        description: String(msg),
      })
      throw error
    } finally {
      setCreatingVNextOpportunityId(null)
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
    // No "noopener" — it makes window.open() return null, so the document.write
    // below never runs and the print tab opens blank. Same-origin content we own.
    const printWindow = window.open("", "_blank")
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

  const handleSelectOpportunity = useCallback((opp) => {
    setSelectedOpportunity(opp)
    if (opp) recordView(opp)
  }, [recordView])

  const isLoading = opportunitiesQuery.isLoading || profilesQuery.isLoading
  const hasResults = paginatedOpportunities.length > 0

  return (
    <div className="p-6 md:p-8 space-y-8">
      <header className="space-y-6">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700 uppercase tracking-wide">
              <Layers className="w-3 h-3" />
              Funding Catalog
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
              <li>Local crawler: 25-mile radius of profile zip codes (and student campus ZIPs).</li>
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

        {/* GeoCrawl run filter banner */}
        {filters.geo_run_id ? (
          <Alert className="border-emerald-200 bg-emerald-50">
            <Sparkles className="w-4 h-4 text-emerald-700" />
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-emerald-900">
                Viewing live results for GeoCrawl run{" "}
                <span className="font-semibold">{String(filters.geo_run_id).slice(0, 8)}…</span>
              </span>
              <Button size="sm" variant="outline" onClick={clearGeoRunFilter}>
                Clear run filter
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

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
                  placeholder="Search (supports AND / OR / NOT)"
                  value={filters.search}
                  onChange={(event) => setFilters((prev) => ({ ...prev, search: event.target.value }))}
                />
                {usesBooleanOperators && (
                  <p className="text-[10px] text-blue-600 mt-1">Boolean mode active</p>
                )}
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
                  <SelectItem value="all">Include loans & review-required</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-slate-100 pt-4">
              <div className="flex items-center gap-3">
                <div className="inline-flex items-center rounded-lg border border-slate-200 p-0.5">
                  <button
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                      viewMode === "list"
                        ? "bg-slate-900 text-white shadow-sm"
                        : "text-slate-600 hover:text-slate-900 hover:bg-slate-100",
                    )}
                    onClick={() => setViewMode("list")}
                  >
                    <Layers className="w-3.5 h-3.5" />
                    List
                  </button>
                  <button
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                      viewMode === "geo"
                        ? "bg-slate-900 text-white shadow-sm"
                        : "text-slate-600 hover:text-slate-900 hover:bg-slate-100",
                    )}
                    onClick={() => setViewMode("geo")}
                  >
                    <Globe className="w-3.5 h-3.5" />
                    Browse by Zip
                  </button>
                </div>
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
                  onClick={resetFundingFilters}
                >
                  Reset filters
                </Button>
                <div className="border-l border-slate-200 h-5 mx-1" />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const name = prompt("Name this search filter:")
                    if (name?.trim()) {
                      saveSearch(name.trim(), filters)
                      toast({ title: "Search saved", description: `"${name.trim()}" saved to your search library.` })
                    }
                  }}
                >
                  <Save className="w-3.5 h-3.5 mr-1" />
                  Save Search
                </Button>
                <Button
                  variant={showSavedSearches ? "default" : "outline"}
                  size="sm"
                  onClick={() => setShowSavedSearches((v) => !v)}
                >
                  <Bookmark className="w-3.5 h-3.5 mr-1" />
                  Saved ({savedSearches.length})
                </Button>
                {hiddenCount > 0 && (
                  <Button
                    variant={showHidden ? "default" : "outline"}
                    size="sm"
                    onClick={() => setShowHidden((v) => !v)}
                  >
                    <EyeOff className="w-3.5 h-3.5 mr-1" />
                    Hidden ({hiddenCount})
                  </Button>
                )}
              </div>
              <p className="text-[12px] text-slate-500">
                Showing {Number(totalResults || 0).toLocaleString()} opportunity
                {Number(totalResults || 0) === 1 ? "" : "ies"}. {complianceMessage}
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Saved Searches Panel */}
        {showSavedSearches && (
          <Card className="border border-blue-200 bg-blue-50/50">
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                  <Bookmark className="w-4 h-4 text-blue-600" />
                  Saved Searches
                </h3>
                <Button variant="ghost" size="sm" onClick={() => setShowSavedSearches(false)}>
                  <X className="w-4 h-4" />
                </Button>
              </div>
              {savedSearches.length === 0 ? (
                <p className="text-xs text-slate-500 italic py-2">No saved searches yet. Use "Save Search" to bookmark your current filters.</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                  {savedSearches.map((ss) => (
                    <div key={ss.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white p-2">
                      <button
                        className="flex-1 text-left text-sm text-slate-800 hover:text-blue-700 font-medium truncate"
                        onClick={() => {
                          setFilters(ss.filters)
                          setShowSavedSearches(false)
                          toast({ title: "Search loaded", description: `Loaded "${ss.name}"` })
                        }}
                      >
                        {ss.name}
                      </button>
                      <span className="text-[10px] text-slate-400 shrink-0">
                        {new Date(ss.savedAt).toLocaleDateString()}
                      </span>
                      <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-slate-400 hover:text-red-600" onClick={() => deleteSearch(ss.id)}>
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </header>

      {viewMode === "geo" ? (
        <GeoFundingView
          profileId={filters.profileId !== "all" ? filters.profileId : null}
        />
      ) : (
      <>
      {fallbackApplied ? (
        <Alert className="border-amber-200 bg-amber-50/70">
          <AlertTitle className="text-amber-900">No grant-only results for these filters</AlertTitle>
          <AlertDescription className="text-amber-800">
            GrantFlow widened the view to include opportunities that may require match funds or repayment so you still have
            actionable results. Switch the Funding terms filter to “Include review-required” to make this explicit.
          </AlertDescription>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="default"
              onClick={() => setFilters((prev) => ({ ...prev, compliance: "all" }))}
            >
              Include review-required
            </Button>
            <Button
              variant="outline"
              onClick={() => setFilters((prev) => ({ ...prev, compliance: "grant_only" }))}
            >
              Keep grant-only filter
            </Button>
          </div>
        </Alert>
      ) : null}

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
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
            {paginatedOpportunities.map(({ opportunity, match }) => (
              <OpportunityCard
                key={opportunity.id}
                opportunity={opportunity}
                onSelect={handleSelectOpportunity}
                match={match}
                onAddToPipeline={handleAddToPipeline}
                isAddingToPipeline={addingOpportunityId === opportunity.id}
                canAddToPipeline={Boolean(
                  selectedProfile &&
                  filters.profileId &&
                  filters.profileId !== "all"
                )}
                viewed={isViewed(opportunity.id)}
                onHide={hideGrant}
                onUnhide={unhideGrant}
                isGrantHidden={isHidden(opportunity.id)}
                profiles={profiles}
                selectedProfileId={filters.profileId}
                onSelectProfileId={(value) => setFilters((prev) => ({ ...prev, profileId: value }))}
              />
            ))}
          </div>
          
          {/* Pagination Controls */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 mt-8 pb-8">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentPage(1)}
                disabled={currentPage === 1}
              >
                First
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage === 1}
              >
                Previous
              </Button>
              
              <div className="flex items-center gap-1 mx-2">
                {/* Show page numbers */}
                {Array.from({ length: Math.min(7, totalPages) }, (_, i) => {
                  let pageNum
                  if (totalPages <= 7) {
                    pageNum = i + 1
                  } else if (currentPage <= 4) {
                    pageNum = i + 1
                  } else if (currentPage >= totalPages - 3) {
                    pageNum = totalPages - 6 + i
                  } else {
                    pageNum = currentPage - 3 + i
                  }
                  return (
                    <Button
                      key={pageNum}
                      variant={currentPage === pageNum ? "default" : "outline"}
                      size="sm"
                      className="w-10"
                      onClick={() => setCurrentPage(pageNum)}
                    >
                      {pageNum}
                    </Button>
                  )
                })}
              </div>
              
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
              >
                Next
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentPage(totalPages)}
                disabled={currentPage === totalPages}
              >
                Last
              </Button>
              
              <span className="text-sm text-slate-500 ml-4">
                Page {currentPage} of {totalPages} ({Number(totalResults || 0).toLocaleString()} total)
              </span>
            </div>
          )}
        </>
      ) : (
        <Card className="border border-slate-200 bg-white/70 backdrop-blur">
          <CardContent className="p-6 sm:p-10">
            <ZeroResultGuidance
              title="No opportunities passed the current view"
              description={
                opportunitiesResponse?.data?.length === 0 && opportunitiesResponse?.total === 0
                  ? "GrantFlow did not find stored funding rows for this exact view. That is a search state, not a final answer."
                  : "The current filters narrowed the list to zero visible results. Use the next moves below to widen carefully without ignoring the rules."
              }
              facts={[
                { label: "Profile", value: filters.profileId && filters.profileId !== "all" ? selectedProfile?.display_name || "Selected" : "Not selected" },
                { label: "Funding terms", value: filters.compliance === "grant_only" ? "Grant-only" : "Including review-required" },
                { label: "Hidden by trust", value: String(opportunitiesResponse?.trust_dropped ?? 0) },
              ]}
              actions={[
                {
                  kind: "profile",
                  label: filters.profileId && filters.profileId !== "all" ? "Review profile details" : "Select or complete a profile",
                  description: "Profile fields guide crawler choice and match explanations.",
                  href: createPageUrl("MyProfiles"),
                },
                {
                  kind: "filters",
                  label: "Reset filters",
                  description: "Clear source, state, search text, and run filters.",
                  onClick: resetFundingFilters,
                },
                {
                  kind: "discovery",
                  label: "Run profile discovery",
                  description: "Search live sources for this profile instead of only the stored catalog.",
                  href: createPageUrl("DiscoverGrants", filters.profileId && filters.profileId !== "all" ? { profile_id: filters.profileId } : undefined),
                  variant: "default",
                },
                {
                  kind: "review",
                  label: "Include review-required",
                  description: "Show rows that may require match funds or repayment for manual review.",
                  onClick: () => setFilters((prev) => ({ ...prev, compliance: "all" })),
                  disabled: filters.compliance === "all",
                },
                {
                  kind: "crawler",
                  label: "Browse by ZIP",
                  description: "Switch to the geographic funding view for local programs.",
                  onClick: () => setViewMode("geo"),
                },
              ]}
            />
          </CardContent>
        </Card>
      )}
      </>
      )}

      <OpportunityDetail
        opportunity={selectedOpportunity}
        open={Boolean(selectedOpportunity)}
        onClose={() => handleSelectOpportunity(null)}
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
              filters.profileId &&
              filters.profileId !== "all",
          )
        }
        onCreateVNext={handleCreateVNextApplication}
        isCreatingVNext={
          Boolean(selectedOpportunity) &&
          creatingVNextOpportunityId === selectedOpportunity.id
        }
        canCreateVNext={Boolean(selectedProfile && filters.profileId && filters.profileId !== "all")}
        selectedProfileName={selectedProfile?.display_name}
        profiles={profiles}
        selectedProfileId={filters.profileId}
        onSelectProfileId={(value) => setFilters((prev) => ({ ...prev, profileId: value }))}
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
