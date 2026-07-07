import React from "react"
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Database,
  ExternalLink,
  FileSearch,
  Globe2,
  ShieldCheck,
  Target,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { formatReasonText } from "@/utils/reasonText"

function safeArray(value) {
  if (!value) return []
  if (Array.isArray(value)) return value
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed)) return parsed
    } catch {
      return value ? [value] : []
    }
  }
  return [value]
}

function safeDate(value) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleString()
}

function safeHost(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return ""
  try {
    return new URL(rawUrl).hostname
  } catch {
    return rawUrl
  }
}

function labelize(value) {
  if (!value) return "Not recorded"
  return String(value).replace(/_/g, " ")
}

function TraceFact({ icon: Icon, label, value, tone = "slate" }) {
  const tones = {
    slate: "border-slate-200 bg-slate-50 text-slate-700",
    green: "border-emerald-200 bg-emerald-50 text-emerald-800",
    amber: "border-amber-200 bg-amber-50 text-amber-800",
    blue: "border-blue-200 bg-blue-50 text-blue-800",
    red: "border-rose-200 bg-rose-50 text-rose-800",
  }

  return (
    <div className={cn("rounded-md border px-3 py-2", tones[tone] ?? tones.slate)}>
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide opacity-80">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className="mt-1 text-sm font-medium capitalize">{value}</div>
    </div>
  )
}

function ReasonList({ reasons }) {
  const cleaned = safeArray(reasons)
    .map((reason) => formatReasonText(reason) || String(reason || "").trim())
    .filter(Boolean)

  if (cleaned.length === 0) {
    return <p className="text-sm text-slate-500">No detailed reasons were recorded.</p>
  }

  return (
    <ul className="space-y-1 text-sm text-slate-700">
      {cleaned.slice(0, 5).map((reason, index) => (
        <li key={`${reason}-${index}`} className="flex items-start gap-2">
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
          <span>{reason}</span>
        </li>
      ))}
    </ul>
  )
}

export default function OpportunitySourceTrace({ opportunity, match, profileName }) {
  if (!opportunity) return null

  const linkStatus = opportunity.link_status || "unverified"
  const trustTier = opportunity.trust_tier || opportunity.source_trust || "not classified"
  const recordOrigin = opportunity.record_origin || "not recorded"
  const complianceStatus = opportunity.compliance_status || "not classified"
  const realityStatus = opportunity.reality_status || (opportunity.trust_downgrade ? "downgraded" : "displayed")
  const verifiedAt = safeDate(opportunity.last_verified_at)
  const discoveredAt = safeDate(opportunity.discovered_at || opportunity.created_at || opportunity.updated_at)
  const matchScore = typeof match?.score === "number" ? match.score : null
  const traceReasons = [
    ...safeArray(opportunity.trust_reasons),
    ...safeArray(opportunity.reality_reasons),
  ]
  const complianceReasons = safeArray(opportunity.compliance_reasons)
  const matchReasons = match?.reasons?.length ? match.reasons : safeArray(opportunity.match_reasons)
  const linkTone = linkStatus === "ok" || linkStatus === "redirect" || linkStatus === "verified"
    ? "green"
    : linkStatus === "broken"
    ? "red"
    : "amber"
  const complianceTone = complianceStatus === "compliant"
    ? "green"
    : complianceStatus === "requires_review"
    ? "red"
    : "amber"

  const links = [
    { label: "Application", url: opportunity.application_url },
    { label: "Source", url: opportunity.source_url },
    { label: "Evidence", url: opportunity.evidence_url },
  ].filter((item, index, arr) => item.url && arr.findIndex((x) => x.url === item.url) === index)

  return (
    <section className="space-y-4 rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-900">
            <FileSearch className="h-4 w-4 text-blue-600" />
            Source Trace
          </h3>
          <p className="mt-1 text-sm text-slate-600">
            The record below shows what GrantFlow knows, what it checked, and which rules kept this opportunity visible.
          </p>
        </div>
        <Badge variant="outline" className="w-fit capitalize">
          {labelize(recordOrigin)}
        </Badge>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <TraceFact icon={Database} label="Found by" value={opportunity.source || recordOrigin} tone="blue" />
        <TraceFact icon={Globe2} label="Link status" value={labelize(linkStatus)} tone={linkTone} />
        <TraceFact icon={ShieldCheck} label="Rules check" value={labelize(complianceStatus)} tone={complianceTone} />
        <TraceFact icon={Clock3} label="Last checked" value={verifiedAt || discoveredAt || "Not recorded"} />
      </div>

      {links.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {links.map((item) => (
            <Button
              key={`${item.label}-${item.url}`}
              asChild
              variant="outline"
              size="sm"
              title={`Open ${item.label.toLowerCase()} link at ${safeHost(item.url)}`}
            >
              <a href={item.url} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="mr-2 h-3.5 w-3.5" />
                {item.label}: {safeHost(item.url)}
              </a>
            </Button>
          ))}
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>No direct application/source URL is stored. GrantFlow keeps this visible only as a review item.</span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Reality and trust
          </p>
          <p className="text-sm text-slate-700">
            Status: <span className="font-semibold capitalize">{labelize(realityStatus)}</span>
            {" "} - Tier: <span className="font-semibold capitalize">{labelize(trustTier)}</span>
          </p>
          <ReasonList reasons={traceReasons} />
        </div>
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Funding rules
          </p>
          <ReasonList reasons={complianceReasons} />
        </div>
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Profile use
          </p>
          {matchScore !== null ? (
            <p className="text-sm text-slate-700">
              Scored against <span className="font-semibold">{profileName || "the selected profile"}</span> with a match score of{" "}
              <span className="font-semibold">{matchScore}</span>.
            </p>
          ) : (
            <p className="text-sm text-slate-600">
              Select a profile to show profile-specific scoring. Empty profile fields are treated as questions, not penalties.
            </p>
          )}
          <ReasonList reasons={matchReasons} />
        </div>
      </div>
    </section>
  )
}
