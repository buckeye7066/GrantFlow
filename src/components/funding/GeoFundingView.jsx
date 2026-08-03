import React, { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Loader2,
  MapPin,
  Target,
} from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { getGeoSummary, getGeoScored } from "@/api/opportunities"
import { formatReasonList } from "@/utils/reasonText"
import { scoreToMatchTier, fitPercent } from "@/lib/matchDisplayThresholds"

const STATE_NAMES = {
  AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",
  CO:"Colorado",CT:"Connecticut",DE:"Delaware",FL:"Florida",GA:"Georgia",
  HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",
  KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",MA:"Massachusetts",
  MI:"Michigan",MN:"Minnesota",MS:"Mississippi",MO:"Missouri",MT:"Montana",
  NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",NJ:"New Jersey",NM:"New Mexico",
  NY:"New York",NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",
  OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",
  SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",
  VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming",
  DC:"District of Columbia",
}

// Bands come from the canonical scoreToMatchTier — never inline cutoffs (the
// old 75/50/25 ladder was on the retired need-anchored scale).
const SCORE_BADGE_TIER_CLASSES = {
  excellent: "bg-emerald-100 text-emerald-800 border-emerald-200",
  good: "bg-blue-100 text-blue-800 border-blue-200",
  fair: "bg-amber-100 text-amber-800 border-amber-200",
  potential: "bg-amber-100 text-amber-800 border-amber-200",
  low: "bg-slate-100 text-slate-600 border-slate-200",
}

function scoreBadgeColor(score) {
  return SCORE_BADGE_TIER_CLASSES[scoreToMatchTier(score)]
}

function ScoreBadge({ score }) {
  if (score === null) return null
  return (
    <span className={cn(
      "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold tabular-nums",
      scoreBadgeColor(score),
    )}>
      <Target className="w-3 h-3" />
      {fitPercent(score)}%
    </span>
  )
}

function OpportunityRow({ opp, showScore }) {
  const amount = opp.amount_min || opp.amount_max
    ? `$${(opp.amount_min || opp.amount_max || 0).toLocaleString()}${opp.amount_max && opp.amount_min && opp.amount_max !== opp.amount_min ? ` – $${opp.amount_max.toLocaleString()}` : ""}`
    : null

  const url = opp.application_url || opp.source_url || opp.url
  const deadlineText = opp.deadline
    ? new Date(opp.deadline).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : opp.deadline_type === "rolling" ? "Rolling" : null

  return (
    <div className="flex items-start gap-3 py-3 px-4 border-b border-slate-100 last:border-b-0 hover:bg-slate-50/50 transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <h4 className="text-sm font-medium text-slate-900 truncate max-w-[500px]">
            {opp.title || "Untitled opportunity"}
          </h4>
          {showScore && <ScoreBadge score={opp.match_score} />}
        </div>
        <div className="flex items-center gap-3 mt-1 text-xs text-slate-500">
          {opp.sponsor && <span>{opp.sponsor}</span>}
          {amount && <span className="text-emerald-700 font-medium">{amount}</span>}
          {deadlineText && <span>Due: {deadlineText}</span>}
          {opp.geo_source && (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0">
              {opp.geo_source}
            </Badge>
          )}
        </div>
        {opp.match_reasons?.length > 0 && showScore && (() => {
          const lines = formatReasonList(opp.match_reasons).slice(0, 3)
          return lines.length > 0 ? (
            <div className="mt-1 text-[11px] text-slate-400 truncate max-w-lg">
              {lines.join(" · ")}
            </div>
          ) : null
        })()}
      </div>
      {url && (
        <a
          href={opp.application_url || opp.source_url || opp.url}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 text-blue-600 hover:text-blue-800 p-1"
          title={opp.application_url ? "Open application" : "View source (application link unavailable)"}
        >
          <ExternalLink className="w-4 h-4" />
        </a>
      )}
    </div>
  )
}

function ZipSection({ zip, county, count, state, profileId, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen || false)

  const scoredQuery = useQuery({
    queryKey: ["geo-scored", state, zip, profileId],
    queryFn: () => getGeoScored({
      state,
      geo_zip: zip,
      profile_id: profileId || undefined,
      limit: 200,
    }),
    enabled: open,
    staleTime: 60_000,
  })

  const opportunities = scoredQuery.data?.data ?? []
  const totalFound = scoredQuery.data?.total ?? scoredQuery.data?.total_found ?? null
  const showScore = Boolean(profileId && profileId !== "all")

  return (
    <div className="border-b border-slate-100 last:border-b-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-slate-50 transition-colors"
      >
        {open ? (
          <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
        )}
        <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0" />
        <span className="text-sm font-medium text-slate-800">{zip}</span>
        {county && <span className="text-xs text-slate-400">{county}</span>}
        <Badge variant="secondary" className="ml-auto text-xs">
          {count} {count === 1 ? "source" : "sources"}
        </Badge>
      </button>

      {open && (
        <div className="bg-white">
          {scoredQuery.isLoading ? (
            <div className="flex items-center gap-2 px-6 py-4 text-sm text-slate-500">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading opportunities…
            </div>
          ) : scoredQuery.isError ? (
            <div className="px-6 py-4 text-sm text-red-500">
              Failed to load opportunities for this zip code. Please try again.
            </div>
          ) : opportunities.length === 0 ? (
            <div className="px-6 py-4 text-sm text-slate-400">
              {showScore
                ? totalFound !== null && totalFound > 0
                  ? `${totalFound} ${totalFound === 1 ? "opportunity" : "opportunities"} found but none matched your profile. Adding details like housing needs, income, military status, or disabilities to your profile often unlocks more results.`
                  : "No matches found for your profile in this zip code. Adding details like housing needs, income, military status, or disabilities to your profile often unlocks more results."
                : "No opportunities indexed for this zip code yet."}
            </div>
          ) : (
            <div className="ml-6 border-l border-slate-200">
              {opportunities.map((opp) => (
                <OpportunityRow
                  key={opp.id}
                  opp={opp}
                  showScore={showScore}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function StateSection({ stateEntry, profileId, maxOpportunityCount }) {
  const [open, setOpen] = useState(false)
  const { state, opportunity_count, zips } = stateEntry
  const stateName = STATE_NAMES[state] || state
  const progressMax = maxOpportunityCount > 0 ? maxOpportunityCount : 50

  return (
    <Card className="border border-slate-200 shadow-sm overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-5 py-3.5 text-left hover:bg-slate-50/80 transition-colors"
      >
        {open ? (
          <ChevronDown className="w-5 h-5 text-slate-400 shrink-0" />
        ) : (
          <ChevronRight className="w-5 h-5 text-slate-400 shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-base font-semibold text-slate-900">{stateName}</span>
            <span className="text-xs font-mono text-slate-400">{state}</span>
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            {zips.length} {zips.length === 1 ? "zip code" : "zip codes"} ·{" "}
            {opportunity_count.toLocaleString()} funding {opportunity_count === 1 ? "source" : "sources"}
          </div>
        </div>
        <div className="shrink-0 w-20">
          <Progress value={Math.min(100, (opportunity_count / progressMax) * 100)} className="h-1.5" />
        </div>
      </button>

      {open && (
        <CardContent className="p-0 border-t border-slate-100">
          {zips.map((z) => (
            <ZipSection
              key={`${state}-${z.zip}`}
              zip={z.zip}
              county={z.county}
              count={z.opportunity_count}
              state={state}
              profileId={profileId}
              defaultOpen={zips.length === 1}
            />
          ))}
        </CardContent>
      )}
    </Card>
  )
}

export default function GeoFundingView({ profileId }) {
  const summaryQuery = useQuery({
    queryKey: ["geo-summary"],
    queryFn: getGeoSummary,
    staleTime: 30_000,
  })

  const summary = summaryQuery.data
  const states = summary?.states ?? []
  const maxOpportunityCount = states.length > 0
    ? Math.max(...states.map((s) => s.opportunity_count || 0), 1)
    : 1

  if (summaryQuery.isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-16 w-full rounded-lg" />
        ))}
      </div>
    )
  }

  if (summaryQuery.isError) {
    return (
      <Card className="border border-dashed border-red-300 bg-red-50">
        <CardContent className="py-12 text-center">
          <p className="text-sm text-red-600">
            Unable to load geographic funding data. Please refresh or contact support.
          </p>
        </CardContent>
      </Card>
    )
  }

  if (states.length === 0) {
    return (
      <Card className="border border-dashed border-slate-300 bg-slate-50">
        <CardContent className="py-12 text-center">
          <MapPin className="w-10 h-10 text-slate-300 mx-auto mb-3" />
          <h3 className="text-lg font-semibold text-slate-700 mb-1">No geographic data yet</h3>
          <p className="text-sm text-slate-500 max-w-md mx-auto">
            Run a Geo Crawl from the Admin panel to discover funding sources by zip code.
            Results will appear here grouped by state and zip.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-slate-600">
          <span className="font-semibold text-slate-900">{summary.total_opportunities?.toLocaleString()}</span>{" "}
          funding sources across{" "}
          <span className="font-semibold text-slate-900">{summary.total_zips?.toLocaleString()}</span>{" "}
          zip codes in{" "}
          <span className="font-semibold text-slate-900">{summary.total_states}</span> states
        </p>
        {profileId && profileId !== "all" && (
          <Badge variant="outline" className="text-xs gap-1">
            <Target className="w-3 h-3" />
            Scoring against profile
          </Badge>
        )}
      </div>
      {states.map((s) => (
        <StateSection key={s.state} stateEntry={s} profileId={profileId} maxOpportunityCount={maxOpportunityCount} />
      ))}
    </div>
  )
}
