import React, { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  AlertTriangle,
  Bot,
  FileText,
  Globe2,
  GraduationCap,
  History,
  Loader2,
  MapPin,
  RefreshCw,
  School,
  ShoppingCart,
  Sparkles,
  UserCircle2,
  Workflow,
  Zap,
  XCircle,
} from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"
import { format, formatDistanceToNow } from "date-fns"
import { useToast } from "@/components/ui/use-toast"
import {
  listCrawlerJobs,
  createCrawlerJob,
  listCrawlerMetrics,
  getCrawlerJob,
  retryCrawlerJob,
  cancelCrawlerJob,
} from "@/api/crawlers"
import { listProfiles, getProfile } from "@/api/profiles"
import { useAuthStore } from "@/stores/authStore"
import { useTierEntitlements } from "@/hooks/useTierEntitlements"
import { cn } from "@/lib/utils"
import { getAnyaProfileTasks, updateAnyaTask } from "@/lib/anyaClient"
import PipelineAutomationPanel from "@/components/pipeline/PipelineAutomationPanel"
import CrawlerProgressMeter from "@/components/automation/CrawlerProgressMeter"
import { SECTION_METADATA } from "@/config/sectionMetadata"
import { getApplicableSectionKeys } from "@/utils/profileCompletion"
import { formatReasonText } from "@/utils/reasonText"
import { isSupersededCrawlerType } from "../../shared/supersededCrawlerTypes.js"

/**
 * Safely build a Date and validate it. Returns a valid Date instance or null
 * when the input is missing or unparseable, so callers can avoid passing
 * Invalid Date values to date-fns helpers (which throw RangeError).
 */
function parseValidDate(value) {
  if (value === null || value === undefined) return null
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d
}

/**
 * Safe wrapper around date-fns formatDistanceToNow. Returns `fallback` when the
 * input date is missing or invalid instead of throwing.
 */
function safeDistanceToNow(value, fallback = null) {
  const d = parseValidDate(value)
  if (!d) return fallback
  return formatDistanceToNow(d, { addSuffix: true })
}

/**
 * Safe wrapper around date-fns format. Returns `fallback` when the input date
 * is missing or invalid instead of throwing.
 */
function safeFormat(value, pattern, fallback = "") {
  const d = parseValidDate(value)
  if (!d) return fallback
  return format(d, pattern)
}

// Only REAL automations get panel tiles/labels. Retired discovery crawlers
// (local, scholarship, comprehensive, item_search, …) are handled by the
// Crawler OS (Robert) and must never surface in the Automation Control Center.
// The canonical retired list lives in shared/supersededCrawlerTypes.js.
const JOB_LABELS = {
  portal_check: "Portal award check",
  avatar_lookup: "AI avatar lookup",
  document_ingest: "Document enrichment",
  pipeline_automation: "Pipeline automation",
  profile_enrichment: "Profile enrichment",
  anya_match_scout: "Anya match scout",
  national_zip_scan: "National ZIP scan",
}

// Job types with a registered handler in crawlerDispatcher.js's HANDLERS map —
// a job created for any other type just sits queued forever (no worker will
// ever pick it up). national_zip_scan is documented as a "real" automation in
// shared/supersededCrawlerTypes.js but was never wired to a dispatcher
// handler, so it is deliberately EXCLUDED here: a manual-trigger button for it
// would create the exact class of permanently-stuck job this panel exists to
// surface, not fix.
const DISPATCHABLE_JOB_TYPES = new Set([
  "avatar_lookup",
  "document_ingest",
  "pipeline_automation",
  "profile_enrichment",
  "anya_match_scout",
  "portal_check",
])

const STATUS_VARIANTS = {
  queued: "bg-slate-100 text-slate-700",
  running: "bg-blue-100 text-blue-700",
  completed: "bg-emerald-100 text-emerald-700",
  // `partial` is a virtual status: backend stores status='completed' with
  // result_meta.partial=true so existing query consumers stay correct, and the
  // UI promotes that combination to its own pill so operators see at a glance
  // that the run produced real data but did not finish every input.
  partial: "bg-amber-100 text-amber-800",
  failed: "bg-red-100 text-red-700",
  cancelled: "bg-amber-100 text-amber-700",
}

/**
 * Returns the effective (UI-facing) status for a job. Promotes
 * `completed` → `partial` when the backend recorded a partial-completion run
 * (worker died / withTimeout aborted after real, durable progress was flushed
 * to result_meta). Falls back to the raw `status` field for everything else.
 * Returns null when no job is provided so callers can detect missing data.
 */
function getEffectiveJobStatus(job) {
  if (!job) return null
  const meta =
    job.result_meta && typeof job.result_meta === "object" ? job.result_meta : null
  if (job.status === "completed" && meta?.partial === true) return "partial"
  return job.status ?? null
}

/**
 * True when the user should see a Retry / Resume action for this job. Covers
 * the canonical retry surface (failed / cancelled) AND partial runs, which
 * are stored as status=completed but represent an unfinished crawl whose
 * remaining states should be picked up via the same retry endpoint (the
 * route already preserves resume:true + geo_run_id in the new queued job).
 */
function canRetryOrResume(job) {
  if (!job) return false
  const effective = getEffectiveJobStatus(job)
  return effective === "failed" || effective === "cancelled" || effective === "partial"
}

/**
 * Label for the retry / resume button. Partial runs read more naturally as
 * "Resume" because the retry endpoint will continue from the next un-crawled
 * state rather than re-running everything.
 */
function retryButtonLabel(job) {
  return getEffectiveJobStatus(job) === "partial" ? "Resume" : "Retry"
}

const METRIC_TYPE_ORDER = Object.keys(JOB_LABELS)

const JOB_ICON_MAP = {
  portal_check: School,
  local: MapPin,
  scholarship: GraduationCap,
  comprehensive: Globe2,
  item_search: ShoppingCart,
  document_ingest: FileText,
  pipeline_automation: Workflow,
  profile_enrichment: Sparkles,
  avatar_lookup: UserCircle2,
  anya_match_scout: Bot,
  national_zip_scan: MapPin,
}

function getJobLabel(job) {
  if (!job) return "Crawler"
  if (job.type !== "comprehensive") {
    return JOB_LABELS[job.type] ?? job.type
  }

  const params = job.parameters ?? {}
  const meta = job.result_meta ?? {}
  const mode = String(params?.mode ?? meta?.mode ?? "").toLowerCase()
  return mode === "geo" ? "Geo Crawl" : "Comprehensive match"
}

function getJobIcon(job) {
  const type = job?.type
  return JOB_ICON_MAP[type] ?? Globe2
}

function formatNumber(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return null
  return value.toLocaleString("en-US")
}

function formatDuration(seconds) {
  if (typeof seconds !== "number" || Number.isNaN(seconds) || seconds <= 0) return "—"
  const totalSeconds = Math.round(seconds)
  const mins = Math.floor(totalSeconds / 60)
  const secs = totalSeconds % 60
  if (mins === 0) return `${secs}s`
  if (mins < 60) return `${mins}m ${secs.toString().padStart(2, "0")}s`
  const hours = Math.floor(mins / 60)
  const remainingMins = mins % 60
  return `${hours}h ${remainingMins}m`
}

function deriveZipFromProfile(profileDetail) {
  const sections = Array.isArray(profileDetail?.sections) ? profileDetail.sections : []
  const basic = sections.find((s) => s?.section_key === "basic_information")?.data ?? null
  const housing = sections.find((s) => s?.section_key === "housing")?.data ?? null
  const location = sections.find((s) => s?.section_key === "location_focus")?.data ?? null

  const candidates = [
    basic?.zip, basic?.zip_code, basic?.postal_code,
    housing?.zip, housing?.zip_code,
    location?.zip, location?.zip_code,
  ]

  for (const v of candidates) {
    if (typeof v !== "string") continue
    const m = v.trim().match(/\b(\d{5})\b/)
    if (m) return m[1]
  }
  return null
}

function summarizeJob(job) {
  if (!job) return null
  const meta = job.result_meta ?? {}

  let summary = null

  switch (job.type) {
    case "local": {
      const inserted = formatNumber(meta.inserted ?? job.result_count)
      const evaluated = formatNumber(meta.evaluated)
      const radius = formatNumber(meta.radius)
      const parts = []
      if (inserted) parts.push(`Saved ${inserted} local matches`)
      if (evaluated) parts.push(`evaluated ${evaluated}`)
      if (radius) parts.push(`within ${radius} miles`)
      summary = parts.length > 0 ? parts.join(" • ") : null
      break
    }
    case "scholarship": {
      const inserted = formatNumber(meta.inserted ?? job.result_count)
      const evaluated = formatNumber(meta.evaluated)
      if (!inserted && !evaluated) {
        summary = null
      } else {
        summary = [inserted ? `Saved ${inserted} scholarships` : null, evaluated ? `evaluated ${evaluated}` : null]
          .filter(Boolean)
          .join(" • ")
      }
      break
    }
    case "comprehensive": {
      const inserted = formatNumber(meta.inserted ?? job.result_count)
      const zips = formatNumber(meta.zipsProcessed)
      const evaluated = formatNumber(meta.evaluated)
      const parts = []
      if (inserted) parts.push(`Saved ${inserted} nationwide opportunities`)
      if (zips) parts.push(`across ${zips} ZIPs`)
      if (evaluated) parts.push(`evaluated ${evaluated}`)
      summary = parts.length > 0 ? parts.join(" • ") : null
      break
    }
    case "item_search": {
      const inserted = formatNumber(meta.inserted ?? job.result_count)
      const evaluated = formatNumber(meta.evaluated)
      const item =
        typeof meta.item === "string"
          ? meta.item
          : job.parameters?.item
          ? String(job.parameters.item)
          : null
      const parts = []
      if (inserted) parts.push(`Saved ${inserted} item matches`)
      if (evaluated) parts.push(`evaluated ${evaluated}`)
      if (item) parts.push(`for “${item}”`)
      summary = parts.length > 0 ? parts.join(" • ") : null
      break
    }
    case "document_ingest": {
      if (typeof meta.summary === "string" && meta.summary.trim()) {
        summary = meta.summary.length > 200 ? `${meta.summary.slice(0, 200)}…` : meta.summary
        break
      }
      const rawTotal =
        typeof meta.total_sections_updated === "number"
          ? meta.total_sections_updated
          : Array.isArray(meta.sections_updated)
          ? meta.sections_updated.length
          : null
      if (typeof rawTotal === "number" && rawTotal > 0) {
        const display = formatNumber(rawTotal)
        summary = `Extracted data into ${display} section${rawTotal === 1 ? "" : "s"}`
      }
      break
    }
    case "pipeline_automation": {
      const advancedRaw =
        typeof meta.advanced === "number" ? meta.advanced : Number(meta.advanced)
      const handoffsRaw =
        typeof meta.handoffs === "number" ? meta.handoffs : Number(meta.handoffs)
      const advanced = formatNumber(
        Number.isFinite(advancedRaw) ? advancedRaw : NaN,
      )
      const handoffs = formatNumber(
        Number.isFinite(handoffsRaw) ? handoffsRaw : NaN,
      )
      const parts = []
      if (advanced) parts.push(`Advanced ${advanced} grant${advancedRaw === 1 ? "" : "s"}`)
      if (handoffs) parts.push(`${handoffs} handoff${handoffsRaw === 1 ? "" : "s"}`)
      summary = parts.length > 0 ? parts.join(" • ") : null
      break
    }
    case "profile_enrichment": {
      const sections = Array.isArray(meta.sections) ? meta.sections.length : null
      if (!sections) {
        summary = null
      } else {
        const display = formatNumber(sections)
        summary = `Updated ${display} profile section${sections === 1 ? "" : "s"}`
      }
      break
    }
    case "avatar_lookup":
      summary = "Generated AI avatar"
      break
    case "portal_check": {
      const inserted = formatNumber(meta.inserted ?? job.result_count)
      const evaluated = formatNumber(meta.evaluated)
      const parts = []
      if (inserted) parts.push(`Synced ${inserted} award notification${meta.inserted === 1 ? "" : "s"}`)
      if (evaluated) parts.push(`checked ${evaluated} portal${meta.evaluated === 1 ? "" : "s"}`)
      summary = parts.length > 0 ? parts.join(" • ") : "Checked award portals"
      break
    }
    default: {
      const rawCount = Number(job.result_count)
      const resultCount = formatNumber(Number.isFinite(rawCount) ? rawCount : NaN)
      summary = resultCount ? `Processed ${resultCount} record${rawCount === 1 ? "" : "s"}` : null
      break
    }
  }

  if (summary && typeof meta.duration_seconds === "number") {
    const formattedDuration = formatDuration(meta.duration_seconds)
    if (formattedDuration && formattedDuration !== "—") {
      summary = `${summary} • Duration ${formattedDuration}`
    }
  }

  return summary
}

function describeJobParameters(job) {
  const params = job?.parameters
  if (!params) return null

  if (typeof params.item === "string" && params.item.trim()) {
    return `Item: ${params.item}`
  }

  if (Array.isArray(params.zip_list) && params.zip_list.length > 0) {
    const display = params.zip_list.slice(0, 4).join(", ")
    const extra = params.zip_list.length > 4 ? ` +${params.zip_list.length - 4}` : ""
    return `ZIPs: ${display}${extra}`
  }

  if (typeof params.zip_list === "string" && params.zip_list.trim()) {
    const segments = params.zip_list.split(",").map((segment) => segment.trim())
    const display = segments.slice(0, 4).join(", ")
    const extra = segments.length > 4 ? ` +${segments.length - 4}` : ""
    return `ZIPs: ${display}${extra}`
  }

  if (Array.isArray(params.sections) && params.sections.length > 0) {
    return `Sections: ${params.sections.join(", ")}`
  }

  if (typeof params.prompt === "string" && params.prompt.trim()) {
    const prompt = params.prompt.length > 60 ? `${params.prompt.slice(0, 60)}…` : params.prompt
    return `Prompt: ${prompt}`
  }

  if (typeof params.radius_miles === "number") {
    return `Radius: ${params.radius_miles} miles`
  }

  if (typeof params.limit_per_zip === "number") {
    return `Limit per ZIP: ${params.limit_per_zip}`
  }

  return null
}

function OverallMetricsCard({ overall, generatedAt, isLoading, onOpenQueue }) {
  const running = overall?.running ?? 0
  const queued = overall?.queued ?? 0
  const failed = overall?.failed ?? 0
  const completed = overall?.completed ?? 0
  const cancelled = overall?.cancelled ?? 0
  const totalRetries = overall?.total_retries ?? 0
  const retryJobs = overall?.jobs_with_retries ?? 0
  const recentRetryJobs = overall?.recent_retry_jobs ?? 0
  const topOverallFailure =
    Array.isArray(overall?.failure_reasons) && overall.failure_reasons.length > 0
      ? overall.failure_reasons[0]
      : null
  const avgDuration = overall?.average_duration_seconds ?? null
  const lastActivity = safeDistanceToNow(overall?.last_activity)
  const lastRetryText = safeDistanceToNow(overall?.last_retry_at)
  const isActive = running > 0 || queued > 0
  const isClickable = typeof onOpenQueue === "function"
  const generatedText = safeDistanceToNow(generatedAt, "moments ago")

  return (
    <Card
      className={cn(
        "border border-slate-200 bg-white/80 shadow-sm",
        isClickable ? "cursor-pointer hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-500/40" : null,
      )}
      onClick={isClickable ? onOpenQueue : undefined}
      onKeyDown={
        isClickable
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                onOpenQueue()
              }
            }
          : undefined
      }
      role={isClickable ? "button" : undefined}
      tabIndex={isClickable ? 0 : undefined}
      aria-label={isClickable ? "Open automation queue" : undefined}
    >
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Zap className="h-5 w-5 text-blue-600" />
            Automation health
          </CardTitle>
          <Badge
            className={cn(
              "text-xs uppercase tracking-wide",
              isActive ? "bg-blue-100 text-blue-700" : "bg-slate-100 text-slate-700",
            )}
          >
            {isActive ? "Active" : "Idle"}
          </Badge>
        </div>
        <CardDescription>
          {isLoading ? "Refreshing metrics…" : lastActivity ? `Last activity ${lastActivity}` : "No runs yet"}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-4 text-sm text-slate-600">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">Running</p>
          <p className="text-lg font-semibold text-slate-900">{formatNumber(running) ?? "0"}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">Queued</p>
          <p className="text-lg font-semibold text-slate-900">{formatNumber(queued) ?? "0"}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">Completed</p>
          <p className="text-lg font-semibold text-slate-900">{formatNumber(completed) ?? "0"}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">Failed</p>
          <p className="text-lg font-semibold text-slate-900">{formatNumber(failed) ?? "0"}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">Cancelled</p>
          <p className="text-lg font-semibold text-slate-900">{formatNumber(cancelled) ?? "0"}</p>
        </div>
        <div className="col-span-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-500">
          <span>
            Retries: <span className="font-semibold text-slate-800">{formatNumber(totalRetries) ?? "0"}</span>
          </span>
          <span>
            Jobs retried: <span className="font-semibold text-slate-800">{formatNumber(retryJobs) ?? "0"}</span>
          </span>
          {recentRetryJobs ? (
            <span>
              Last 7 days:{" "}
              <span className="font-semibold text-slate-800">{formatNumber(recentRetryJobs) ?? "0"}</span>
            </span>
          ) : null}
          {lastRetryText ? <span>Last retry {lastRetryText}</span> : null}
        </div>
        <div className="col-span-2 flex items-center justify-between text-xs text-slate-500">
          <span>
            Generated {generatedText ?? "moments ago"}
          </span>
          <div className="flex items-center gap-3">
            {avgDuration ? (
              <span className="text-slate-500">
                Avg duration: <span className="font-semibold text-slate-800">{formatDuration(avgDuration)}</span>
              </span>
            ) : null}
            {isLoading ? (
              <span className="flex items-center gap-1 text-slate-400">
                <Loader2 className="h-3 w-3 animate-spin" /> updating
              </span>
            ) : null}
          </div>
        </div>
        {topOverallFailure ? (
          <div className="col-span-2 rounded-md border border-amber-200 bg-amber-50/70 p-3 text-xs text-amber-900">
            <p className="font-semibold text-amber-900">Top recent failure</p>
            <p className="mt-1">
              {topOverallFailure.message}{" "}
              <span className="text-amber-700">
                ({formatNumber(topOverallFailure.count) ?? topOverallFailure.count} occurrence
                {topOverallFailure.count === 1 ? "" : "s"})
              </span>
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

function RecentActivityChart({ activity }) {
  if (!Array.isArray(activity) || activity.length === 0) {
    return null
  }

  const totals = activity.map(
    (entry) => (entry?.completed ?? 0) + (entry?.failed ?? 0),
  )
  const max = totals.reduce((m, v) => Math.max(m, v), 1)

  return (
    <div className="space-y-1">
      <div className="flex h-16 items-end gap-1">
        {activity.map((entry, entryIndex) => {
          const total = (entry?.completed ?? 0) + (entry?.failed ?? 0)
          const height = total > 0 ? Math.max(4, Math.round((total / max) * 56)) : 4
          const completedRatio = total > 0 ? (entry?.completed ?? 0) / total : 0
          let completedHeight = Math.round(height * completedRatio)
          let failedHeight = height - completedHeight

          if (completedHeight > 0 && completedHeight < 2) {
            completedHeight = 2
            failedHeight = Math.max(0, height - completedHeight)
          }
          if (failedHeight > 0 && failedHeight < 2) {
            failedHeight = 2
            completedHeight = Math.max(0, height - failedHeight)
          }

          // Guard: when there were runs but rounding zeroed both segments,
          // force the dominant segment to a minimum height so a nonzero day
          // never renders as the slate "zero" bar.
          if (total > 0 && completedHeight === 0 && failedHeight === 0) {
            if ((entry?.completed ?? 0) >= (entry?.failed ?? 0)) {
              completedHeight = Math.max(2, height)
            } else {
              failedHeight = Math.max(2, height)
            }
          }

          const dayLabel = safeFormat(entry?.date, "EEE", "—")
          const tooltip = `${dayLabel} • ${entry?.completed ?? 0} completed${
            entry?.failed ? `, ${entry.failed} failed` : ""
          }`
          const key = entry?.date ?? `activity-${entryIndex}`

          return (
            <div key={key} className="flex flex-1 flex-col items-center gap-1">
              <div className="flex w-full flex-col justify-end" title={tooltip} aria-label={tooltip}>
                {completedHeight > 0 ? (
                  <div
                    className="w-full rounded-t-sm bg-emerald-400"
                    style={{ height: `${completedHeight}px` }}
                  />
                ) : null}
                {failedHeight > 0 ? (
                  <div
                    className={cn(
                      "w-full bg-red-300",
                      completedHeight === 0 ? "rounded-t-sm" : "",
                      "rounded-b-sm",
                    )}
                    style={{ height: `${failedHeight}px` }}
                  />
                ) : null}
                {total === 0 ? (
                  <div className="w-full rounded-sm bg-slate-200" style={{ height: `${height}px` }} />
                ) : null}
              </div>
            </div>
          )
        })}
      </div>
      <div className="grid grid-cols-7 gap-1 text-[10px] uppercase tracking-wide text-slate-400">
        {activity.map((entry, entryIndex) => (
          <span key={`${entry?.date ?? entryIndex}-label`} className="text-center">
            {safeFormat(entry?.date, "EEE", "—")}
          </span>
        ))}
      </div>
    </div>
  )
}

function MetricCard({ metric, onInspect, inspectionState, isLoading, onRun, isRunning, runDisabledReason }) {
  const Icon = JOB_ICON_MAP[metric.type] ?? Bot
  const label = JOB_LABELS[metric.type] ?? metric.type

  if (isLoading) {
    return (
      <Card className="border border-slate-200 bg-white/60 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base text-slate-600">
            <Icon className="h-5 w-5 text-slate-400 animate-pulse" />
            {label}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-2 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
          Loading metrics…
        </CardContent>
      </Card>
    )
  }

  const counts = metric.counts ?? {}
  const completed = counts.completed ?? 0
  const running = counts.running ?? 0
  const queued = counts.queued ?? 0
  const failed = counts.failed ?? 0
  const cancelled = counts.cancelled ?? 0
  const retryStats = metric.retry_stats ?? {}
  const totalRetries = retryStats.total_retries ?? 0
  const jobsWithRetries = retryStats.jobs_with_retries ?? 0
  const recentRetryJobs = retryStats.recent_retry_jobs ?? 0
  const lastRetryAtText = safeDistanceToNow(retryStats.last_retry_at)
  const topFailureReason =
    Array.isArray(metric.failure_reasons) && metric.failure_reasons.length > 0
      ? metric.failure_reasons[0]
      : null
  const averageDuration = metric.average_duration_seconds ?? null
  const lastJob = metric.last_job ?? null
  const summary = lastJob?.summary ?? metric.last_summary ?? "Awaiting first run"
  const lastCompletedAt = lastJob?.completed_at
  const lastRunDistance = safeDistanceToNow(lastCompletedAt)
  const lastRunText = lastRunDistance ? `Last run ${lastRunDistance}` : "Awaiting first run"
  const hasAttention = failed > 0
  const isActive = running > 0 || queued > 0
  const isInspecting =
    inspectionState?.isLoading && inspectionState.jobId && inspectionState.jobId === lastJob?.id
  const recentActivity = Array.isArray(metric.recent_activity) ? metric.recent_activity : null
  const recentTotals = recentActivity
    ? recentActivity.reduce(
        (acc, entry) => ({
          completed: acc.completed + (entry?.completed ?? 0),
          failed: acc.failed + (entry?.failed ?? 0),
        }),
        { completed: 0, failed: 0 },
      )
    : { completed: 0, failed: 0 }
  const recentRunSum = recentTotals.completed + recentTotals.failed
  const isClickable = typeof onInspect === "function" && Boolean(lastJob?.id)

  return (
    <Card
      className={cn(
        "border border-slate-200 bg-white/80 shadow-sm",
        isClickable ? "cursor-pointer hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-500/40" : null,
      )}
      onClick={isClickable ? () => { if (lastJob?.id) onInspect(lastJob.id) } : undefined}
      onKeyDown={
        isClickable
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                if (lastJob?.id) onInspect(lastJob.id)
              }
            }
          : undefined
      }
      role={isClickable ? "button" : undefined}
      tabIndex={isClickable ? 0 : undefined}
      aria-label={isClickable ? `Inspect latest ${label} job` : undefined}
    >
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Icon className="h-5 w-5 text-blue-600" />
            {label}
          </CardTitle>
          <Badge
            className={cn(
              "text-xs uppercase tracking-wide",
              hasAttention
                ? "bg-red-100 text-red-700"
                : isActive
                ? "bg-blue-100 text-blue-700"
                : "bg-slate-100 text-slate-600",
            )}
          >
            {hasAttention ? "Attention" : isActive ? "Running" : "Idle"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-slate-700 min-h-[40px]">{summary}</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs text-slate-600">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-slate-500">Completed</p>
            <p className="text-base font-semibold text-slate-900">{formatNumber(completed) ?? "0"}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wide text-slate-500">Running</p>
            <p className="text-base font-semibold text-slate-900">{formatNumber(running) ?? "0"}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wide text-slate-500">Queued</p>
            <p className="text-base font-semibold text-slate-900">{formatNumber(queued) ?? "0"}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wide text-slate-500">Failed</p>
            <p className="text-base font-semibold text-slate-900">{formatNumber(failed) ?? "0"}</p>
          </div>
          <div className="sm:col-span-2">
            <p className="text-[11px] uppercase tracking-wide text-slate-500">Cancelled</p>
            <p className="text-base font-semibold text-slate-900">{formatNumber(cancelled) ?? "0"}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-500">
          <span>
            Retries: <span className="font-semibold text-slate-800">{formatNumber(totalRetries) ?? "0"}</span>
          </span>
          <span>
            Jobs retried:{" "}
            <span className="font-semibold text-slate-800">{formatNumber(jobsWithRetries) ?? "0"}</span>
          </span>
          {recentRetryJobs ? (
            <span>
              Last 7 days:{" "}
              <span className="font-semibold text-slate-800">{formatNumber(recentRetryJobs) ?? "0"}</span>
            </span>
          ) : null}
          {lastRetryAtText ? <span>Last retry {lastRetryAtText}</span> : null}
        </div>
        {topFailureReason ? (
          <div className="rounded-md border border-amber-200 bg-amber-50/70 p-2 text-xs text-amber-900">
            <p className="font-semibold text-amber-900">Top failure</p>
            <p className="mt-1">
              {topFailureReason.message}{" "}
              <span className="text-amber-700">
                ({formatNumber(topFailureReason.count) ?? topFailureReason.count})
              </span>
            </p>
          </div>
        ) : null}
        <div className="text-xs text-slate-500">
          Avg duration:{" "}
          <span className="font-semibold text-slate-800">
            {averageDuration ? formatDuration(averageDuration) : "—"}
          </span>
        </div>
        {recentActivity ? (
          <div className="space-y-2">
            <div className="text-[11px] uppercase tracking-wide text-slate-500">
              Last 7 days · {formatNumber(recentRunSum) ?? "0"} run{recentRunSum === 1 ? "" : "s"}
              {recentTotals.failed
                ? ` • ${formatNumber(recentTotals.failed)} failed`
                : ""}
            </div>
            <RecentActivityChart activity={recentActivity} />
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-3 text-xs text-slate-500">
          <span>{lastRunText}</span>
          <div className="flex items-center gap-2">
            {typeof onRun === "function" ? (
              <Button
                variant="default"
                size="sm"
                onClick={(event) => {
                  event.stopPropagation()
                  onRun()
                }}
                disabled={Boolean(runDisabledReason) || isRunning}
                title={runDisabledReason || undefined}
                className="flex items-center gap-2"
              >
                {isRunning ? <Loader2 className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3" />}
                {isRunning ? "Running…" : "Run now"}
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              onClick={(event) => {
                event.stopPropagation()
                if (lastJob?.id) onInspect(lastJob.id)
              }}
              disabled={!lastJob}
              className="flex items-center gap-2"
            >
              {isInspecting ? <Loader2 className="h-3 w-3 animate-spin" /> : <History className="h-3 w-3" />}
              Inspect
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function LiveQueueCard({
  runningJobs,
  recentFailures,
  onInspect,
  onRetry,
  onCancel,
  retryingJobId,
  cancellingJobId,
  onOpenQueue,
}) {
  const hasRunning = Array.isArray(runningJobs) && runningJobs.length > 0
  const hasFailures = Array.isArray(recentFailures) && recentFailures.length > 0
  const isClickable = typeof onInspect === "function" && (hasRunning || hasFailures || typeof onOpenQueue === "function")
  const openDefault = () => {
    const firstJob = (hasRunning ? runningJobs?.[0] : null) ?? (hasFailures ? recentFailures?.[0] : null)
    if (firstJob?.id && typeof onInspect === "function") {
      onInspect(firstJob.id)
      return
    }
    if (typeof onOpenQueue === "function") {
      onOpenQueue()
    }
  }

  const renderJobRow = (job) => {
    const summary = summarizeJob(job)
    const parameters = describeJobParameters(job)
    const createdText = safeDistanceToNow(job.created_at)
    const lastRetryText = safeDistanceToNow(job.last_retry_at)
    const jobIdText = job.id !== undefined && job.id !== null ? String(job.id) : ""

    return (
      <li
        key={job.id}
        className="flex flex-col gap-1 rounded-md border border-slate-200/80 bg-white/80 px-3 py-2"
      >
        <div className="flex items-center justify-between gap-3">
          <JobTypeBadge job={job} />
          {(() => {
            const effective = getEffectiveJobStatus(job) ?? "queued"
            return (
              <Badge className={cn("text-[10px] uppercase tracking-wide", STATUS_VARIANTS[effective] ?? STATUS_VARIANTS.queued)}>
                {effective.replace(/_/g, " ")}
              </Badge>
            )
          })()}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
          <span className="font-mono text-[10px] text-slate-400">{jobIdText.slice(0, 10)}…</span>
          {createdText ? <span>Queued {createdText}</span> : null}
          {job.profile_id ? <span>Profile {job.profile_id}</span> : null}
          {job.retried_from_job_id ? (
            <span className="text-slate-400">
              Retry of {String(job.retried_from_job_id).slice(0, 8)}…
            </span>
          ) : null}
          {typeof job.retry_count === "number" && job.retry_count > 0 ? (
            <span className="text-slate-400">Attempts: {job.retry_count}</span>
          ) : null}
          {lastRetryText ? <span className="text-slate-400">Last retry {lastRetryText}</span> : null}
        </div>
        {summary ? <p className="text-xs text-slate-700">{summary}</p> : null}
        {parameters ? <p className="text-[11px] text-slate-500">{parameters}</p> : null}
        <div className="flex justify-end gap-2">
          {typeof onCancel === "function" && job.status === "queued" ? (
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
              onClick={(event) => {
                event.stopPropagation()
                onCancel(job.id)
              }}
              disabled={cancellingJobId === job.id}
            >
              {cancellingJobId === job.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <XCircle className="h-3 w-3" />}
              {cancellingJobId === job.id ? "Cancelling…" : "Cancel"}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className="text-xs"
            onClick={(event) => {
              event.stopPropagation()
              onInspect(job.id)
            }}
          >
            View job
          </Button>
        </div>
      </li>
    )
  }

  const renderFailureRow = (job) => {
    const summary = summarizeJob(job)
    const parameters = describeJobParameters(job)
    const failedText = safeDistanceToNow(job.completed_at)
    const lastRetryText = safeDistanceToNow(job.last_retry_at)
    const jobIdText = job.id !== undefined && job.id !== null ? String(job.id) : ""

    return (
      <li
        key={job.id}
        className="flex flex-col gap-1 rounded-md border border-red-200/70 bg-red-50 px-3 py-2"
      >
        <div className="flex items-center justify-between gap-3">
          <JobTypeBadge job={job} />
          <Badge className="text-[10px] uppercase tracking-wide bg-red-100 text-red-700">Failed</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-red-600">
          <span className="font-mono text-[10px] text-red-400">{jobIdText.slice(0, 10)}…</span>
          {failedText ? <span>Failed {failedText}</span> : null}
          {job.retried_from_job_id ? (
            <span className="text-red-400">
              Retry of {String(job.retried_from_job_id).slice(0, 8)}…
            </span>
          ) : null}
          {typeof job.retry_count === "number" && job.retry_count > 0 ? (
            <span className="text-red-400">Attempts: {job.retry_count}</span>
          ) : null}
          {lastRetryText ? <span className="text-red-400">Last retry {lastRetryText}</span> : null}
        </div>
        {summary ? <p className="text-xs text-red-700">{summary}</p> : null}
        {parameters ? <p className="text-[11px] text-red-600">{parameters}</p> : null}
        {job.error ? (
          <p className="text-[11px] text-red-500 line-clamp-2" title={job.error}>
            {job.error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            className="text-xs"
            onClick={(event) => {
              event.stopPropagation()
              onInspect(job.id)
            }}
          >
            Inspect failure
          </Button>
          {typeof onRetry === "function" ? (
            <Button
              variant="destructive"
              size="sm"
              className="text-xs gap-2"
              onClick={(event) => {
                event.stopPropagation()
                onRetry(job.id)
              }}
              disabled={retryingJobId === job.id}
            >
              {retryingJobId === job.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              {retryingJobId === job.id ? "Retrying…" : "Retry"}
            </Button>
          ) : null}
        </div>
      </li>
    )
  }

  return (
    <Card
      className={cn(
        "border border-slate-200 bg-white/80 shadow-sm md:col-span-2 xl:col-span-1",
        isClickable ? "cursor-pointer hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-500/40" : null,
      )}
      onClick={isClickable ? openDefault : undefined}
      onKeyDown={
        isClickable
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                openDefault()
              }
            }
          : undefined
      }
      role={isClickable ? "button" : undefined}
      tabIndex={isClickable ? 0 : undefined}
      aria-label={isClickable ? "Open live queue details" : undefined}
    >
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Loader2 className="h-5 w-5 text-blue-600" />
          Live queue & failures
        </CardTitle>
        <CardDescription>
          Monitor active automation jobs and review the most recent failures for follow-up.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500 mb-2">
            Running & queued
          </p>
          {hasRunning ? (
            <ul className="space-y-2">
              {runningJobs.slice(0, 6).map(renderJobRow)}
            </ul>
          ) : (
            <p className="text-sm text-slate-500">All clear. No jobs are running right now.</p>
          )}
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500 mb-2">
            Recent failures
          </p>
          {hasFailures ? (
            <ul className="space-y-2">
              {recentFailures.slice(0, 4).map(renderFailureRow)}
            </ul>
          ) : (
            <p className="text-sm text-slate-500">No failures in the last few runs.</p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function JobStatusBadge({ status, job }) {
  const effective = job ? getEffectiveJobStatus(job) : status
  if (!effective) return null
  const variant = STATUS_VARIANTS[effective] ?? STATUS_VARIANTS.queued
  return (
    <Badge className={cn("text-xs capitalize", variant)}>
      {effective.replace(/_/g, " ")}
    </Badge>
  )
}

function JobTypeBadge({ job }) {
  const label = getJobLabel(job)
  return (
    <Badge variant="outline" className="text-xs uppercase tracking-wide text-slate-600">
      {label}
    </Badge>
  )
}

function JobDetailsDialog({ job, onOpenChange, onRetry, retrying, onCancel, cancelling, onInspectJob }) {
  if (!job) return null

  const lineage = job.lineage ?? null
  const ancestorAttempts = Array.isArray(lineage?.ancestors) ? lineage.ancestors : []
  const descendantAttempts = Array.isArray(lineage?.descendants) ? lineage.descendants : []
  const attemptTimeline = [...ancestorAttempts, job, ...descendantAttempts]

  return (
    <Dialog open={Boolean(job)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <Sparkles className="h-5 w-5 text-blue-600" />
            Automation job details
          </DialogTitle>
          <DialogDescription>
            View status, parameters, and results for this automation job.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm text-slate-700">
          <div className="flex justify-end gap-2">
            {job.status === "queued" && typeof onCancel === "function" ? (
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => onCancel(job.id)}
                disabled={cancelling}
              >
                {cancelling ? <Loader2 className="h-3 w-3 animate-spin" /> : <XCircle className="h-3 w-3" />}
                {cancelling ? "Cancelling…" : "Cancel job"}
              </Button>
            ) : null}
            {canRetryOrResume(job) && typeof onRetry === "function" ? (
              <Button
                variant={getEffectiveJobStatus(job) === "partial" ? "default" : "destructive"}
                size="sm"
                className="gap-2"
                onClick={() => onRetry(job.id)}
                disabled={retrying}
                title={
                  getEffectiveJobStatus(job) === "partial"
                    ? "Continue this partial run from the next un-crawled state"
                    : undefined
                }
              >
                {retrying ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                {retrying
                  ? `${retryButtonLabel(job)}ing…`
                  : `${retryButtonLabel(job)} job`}
              </Button>
            ) : null}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <span className="text-xs uppercase tracking-wide text-slate-500">Job ID</span>
              <p className="font-mono text-xs text-slate-600 mt-1">{job.id}</p>
            </div>
            {job.retried_from_job_id ? (
              <div>
                <span className="text-xs uppercase tracking-wide text-slate-500">Retry of</span>
                <div className="flex items-center gap-2 mt-1">
                  <p className="font-mono text-xs text-slate-600">
                    {String(job.retried_from_job_id)}
                  </p>
                  {typeof onInspectJob === "function" ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      className="text-xs"
                      onClick={() => onInspectJob(String(job.retried_from_job_id))}
                    >
                      Inspect parent
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}
            <div className="flex items-center gap-2">
              <span className="text-xs uppercase tracking-wide text-slate-500">Type</span>
              <JobTypeBadge job={job} />
            </div>
            <div>
              <span className="text-xs uppercase tracking-wide text-slate-500">Profile ID</span>
              <p className="font-mono text-xs text-slate-600 mt-1">{job.profile_id ?? "—"}</p>
            </div>
            <div>
              <span className="text-xs uppercase tracking-wide text-slate-500">Organization ID</span>
              <p className="font-mono text-xs text-slate-600 mt-1">{job.organization_id ?? "—"}</p>
            </div>
            <div>
              <span className="text-xs uppercase tracking-wide text-slate-500">Requested by</span>
              <p className="text-xs text-slate-700 mt-1">{job.requested_by ?? "system"}</p>
            </div>
            <div>
              <span className="text-xs uppercase tracking-wide text-slate-500">Retry count</span>
              <p className="font-mono text-xs text-slate-600 mt-1">
                {typeof job.retry_count === "number" ? job.retry_count : 0}
              </p>
            </div>
            <div>
              <span className="text-xs uppercase tracking-wide text-slate-500">Last retry</span>
              <p className="text-xs text-slate-600 mt-1">
                {safeDistanceToNow(job.last_retry_at, "—")}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs uppercase tracking-wide text-slate-500">Status</span>
              <JobStatusBadge job={job} />
            </div>
          </div>

          <Separator />

          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 text-xs text-slate-600">
            <div>
              <span className="block uppercase tracking-wide text-slate-500">Created</span>
              <p className="mt-1">{job.created_at ?? "—"}</p>
            </div>
            <div>
              <span className="block uppercase tracking-wide text-slate-500">Started</span>
              <p className="mt-1">{job.started_at ?? "—"}</p>
            </div>
            <div>
              <span className="block uppercase tracking-wide text-slate-500">Completed</span>
              <p className="mt-1">{job.completed_at ?? "—"}</p>
            </div>
            <div>
              <span className="block uppercase tracking-wide text-slate-500">Duration</span>
              <p className="mt-1">
                {formatDuration(
                  typeof job.result_meta?.duration_seconds === "number"
                    ? job.result_meta.duration_seconds
                    : typeof job.duration_seconds === "number"
                    ? job.duration_seconds
                    : null,
                )}
              </p>
            </div>
          </div>

          <Separator />

          <div>
            <span className="text-xs uppercase tracking-wide text-slate-500">Parameters</span>
            <ScrollArea className="mt-2 max-h-48 rounded-md border border-slate-200 bg-slate-50 p-2">
              <pre className="text-xs text-slate-700 whitespace-pre-wrap">
                {JSON.stringify(job.parameters ?? {}, null, 2)}
              </pre>
            </ScrollArea>
          </div>

          <Separator />

          <div>
            <span className="text-xs uppercase tracking-wide text-slate-500">
              Retry history{typeof lineage?.attempts === "number" ? ` · ${lineage.attempts} attempt${lineage.attempts === 1 ? "" : "s"}` : ""}
            </span>
            {attemptTimeline.length <= 1 ? (
              <p className="mt-2 text-xs text-slate-500">No retry attempts recorded.</p>
            ) : (
              <ol className="mt-2 space-y-3">
                {attemptTimeline.map((attempt, index) => {
                  const isCurrent = attempt.id === job.id
                  const attemptNumber = index + 1
                  const queuedText = safeDistanceToNow(attempt.created_at)
                  const completedText = safeDistanceToNow(attempt.completed_at)
                  const resultCount =
                    typeof attempt.result_count === "number"
                      ? attempt.result_count
                      : typeof attempt.result_meta?.inserted === "number"
                      ? attempt.result_meta.inserted
                      : null

                  return (
                    <li
                      key={`${attempt.id}-attempt`}
                      className={cn(
                        "rounded-md border px-3 py-2 text-xs transition",
                        isCurrent
                          ? "border-blue-200 bg-blue-50/70 text-blue-900"
                          : "border-slate-200 bg-white text-slate-600",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Badge
                            className={cn(
                              "text-[10px] uppercase tracking-wide",
                              isCurrent ? "bg-blue-600 text-white" : "bg-slate-200 text-slate-700",
                            )}
                          >
                            Attempt {attemptNumber}
                          </Badge>
                          <JobStatusBadge job={attempt} />
                          {isCurrent ? <span className="text-[11px] font-semibold">(current)</span> : null}
                        </div>
                        {isCurrent ? null : typeof onInspectJob === "function" ? (
                          <Button
                            variant="ghost"
                            size="xs"
                            className="text-[11px]"
                            onClick={() => onInspectJob(String(attempt.id))}
                          >
                            Inspect
                          </Button>
                        ) : null}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                        {queuedText ? <span>Queued {queuedText}</span> : null}
                        {completedText ? <span>Completed {completedText}</span> : null}
                        {typeof attempt.retry_count === "number" && attempt.retry_count > 0 ? (
                          <span>{attempt.retry_count} retries triggered</span>
                        ) : null}
                        {attempt.last_retry_at ? (
                          <span>
                            Last retry{" "}
                            {safeDistanceToNow(attempt.last_retry_at, "—")}
                          </span>
                        ) : null}
                        {resultCount !== null ? <span>Result count {formatNumber(resultCount)}</span> : null}
                      </div>
                      {attempt.error ? (
                        <p className="mt-2 text-[11px] text-red-600">Error: {attempt.error}</p>
                      ) : null}
                    </li>
                  )
                })}
              </ol>
            )}
          </div>

          {job.result_meta ? (
            <div className="space-y-3">
              <div className="space-y-1 text-xs text-slate-600">
                {typeof job.result_meta.evaluated === "number" ? (
                  <p>
                    Evaluated{" "}
                    <span className="font-semibold text-slate-800">{job.result_meta.evaluated}</span>{" "}
                    record{job.result_meta.evaluated === 1 ? "" : "s"}.
                  </p>
                ) : null}
                {typeof job.result_meta.inserted === "number" ? (
                  <p>
                    Inserted{" "}
                    <span className="font-semibold text-slate-800">{job.result_meta.inserted}</span>{" "}
                    opportunity{job.result_meta.inserted === 1 ? "" : "ies"}.
                  </p>
                ) : null}
                {typeof job.result_meta.handoffs === "number" ? (
                  <p>
                    Human handoffs required:{" "}
                    <span className="font-semibold text-slate-800">{job.result_meta.handoffs}</span>
                  </p>
                ) : null}
                {typeof job.result_meta.total_sections_updated === "number" ? (
                  <p>
                    Updated{" "}
                    <span className="font-semibold text-slate-800">
                      {job.result_meta.total_sections_updated}
                    </span>{" "}
                    section{job.result_meta.total_sections_updated === 1 ? "" : "s"} from the source document.
                  </p>
                ) : null}
              </div>

              {job.result_meta.summary ? (
                <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900">
                  <p className="font-semibold uppercase tracking-wide text-[11px] mb-1">Summary</p>
                  <p>{job.result_meta.summary}</p>
                </div>
              ) : null}

              <div className="grid gap-2 sm:grid-cols-2 text-xs text-slate-600">
                {job.result_meta.zip ? (
                  <div className="rounded-md border border-slate-200 bg-slate-50 p-2">
                    <p className="uppercase tracking-wide text-[11px] text-slate-500">ZIP</p>
                    <p className="font-semibold text-slate-800">{job.result_meta.zip}</p>
                  </div>
                ) : null}
                {job.result_meta.radius ? (
                  <div className="rounded-md border border-slate-200 bg-slate-50 p-2">
                    <p className="uppercase tracking-wide text-[11px] text-slate-500">Radius</p>
                    <p className="font-semibold text-slate-800">
                      {job.result_meta.radius} miles
                    </p>
                  </div>
                ) : null}
                {job.result_meta.item ? (
                  <div className="rounded-md border border-slate-200 bg-slate-50 p-2 sm:col-span-2">
                    <p className="uppercase tracking-wide text-[11px] text-slate-500">Item query</p>
                    <p className="font-semibold text-slate-800">{job.result_meta.item}</p>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {job.result_meta ? (
            <div className="space-y-3">
              {Array.isArray(job.result_meta.grants) && job.result_meta.grants.length > 0 ? (
                <div className="rounded-md border border-slate-200 bg-slate-50">
                  <div className="px-3 py-2 border-b border-slate-200 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Grant outcomes
                  </div>
                  <ScrollArea className="max-h-40">
                    <ul className="space-y-2 px-3 py-2 text-xs text-slate-700">
                      {job.result_meta.grants.map((entry) => (
                        <li key={entry.grant_id} className="border border-slate-200/60 rounded-md p-2 bg-white/80">
                          <p className="font-semibold text-slate-800">{entry.title ?? entry.grant_id}</p>
                          <p className="text-slate-600">
                            {entry.previous_status ?? "unknown"} → {entry.applied_status ?? "unchanged"}
                          </p>
                          {entry.handoff_required ? (
                            <p className="text-amber-700 flex items-center gap-1">
                              <AlertTriangle className="h-3 w-3" />
                              {entry.handoff_reason ?? "Manual review required"}
                            </p>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </ScrollArea>
                </div>
              ) : null}

              {Array.isArray(job.result_meta.opportunities) && job.result_meta.opportunities.length > 0 ? (
                <div className="rounded-md border border-slate-200 bg-slate-50">
                  <div className="px-3 py-2 border-b border-slate-200 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Opportunity matches
                  </div>
                  <ScrollArea className="max-h-56">
                    <ul className="space-y-2 px-3 py-2 text-xs text-slate-700">
                      {job.result_meta.opportunities.map((entry, index) => (
                        <li key={entry.title ?? index} className="border border-slate-200/60 rounded-md p-2 bg-white/80 space-y-1.5">
                          <div className="flex items-center justify-between gap-2">
                            <p className="font-semibold text-slate-800 leading-tight">
                              {entry.title ?? "Untitled opportunity"}
                            </p>
                            <Badge variant={entry.inserted ? "secondary" : "outline"} className="text-[10px] uppercase tracking-wide">
                              {entry.inserted ? "Saved" : "Existing"}
                            </Badge>
                          </div>
                          {entry.sponsor ? <p className="text-slate-600">Sponsor: {entry.sponsor}</p> : null}
                          {entry.deadline ? <p className="text-slate-600">Deadline: {entry.deadline}</p> : null}
                          {typeof entry.match_score === "number" ? (
                            <p className="text-slate-600">Match score: {entry.match_score}</p>
                          ) : null}
                          {Array.isArray(entry.match_reasons) && entry.match_reasons.length > 0 ? (
                            <div>
                              <p className="text-[10px] uppercase tracking-wide text-slate-400 mb-0.5">Match reasons (crawler-reported)</p>
                              <ul className="list-disc pl-4 text-slate-500 space-y-0.5">
                                {entry.match_reasons.slice(0, 4).map((reason, reasonIndex) => {
                                  const text = formatReasonText(reason)
                                  return text ? <li key={reasonIndex}>{text}</li> : null
                                })}
                                {entry.match_reasons.length > 4 ? (
                                  <li className="text-slate-400">+{entry.match_reasons.length - 4} more reason{entry.match_reasons.length - 4 === 1 ? "" : "s"}</li>
                                ) : null}
                              </ul>
                            </div>
                          ) : (
                            <p className="text-slate-400 text-[11px]">No match reasons recorded.</p>
                          )}
                        </li>
                      ))}
                    </ul>
                  </ScrollArea>
                </div>
              ) : null}

              {Array.isArray(job.result_meta.sections_updated) && job.result_meta.sections_updated.length > 0 ? (
                <div className="rounded-md border border-slate-200 bg-slate-50">
                  <div className="px-3 py-2 border-b border-slate-200 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Document ingestion updates
                  </div>
                  <div className="px-3 py-2 space-y-2 text-xs text-slate-700">
                    {job.result_meta.sections_updated.map((entry, index) => (
                      <div key={`${entry.section_key ?? index}`} className="border border-slate-200 rounded-md p-2 bg-white/80">
                        <p className="font-semibold text-slate-800">{entry.section_key?.replace(/_/g, " ") ?? "Unknown section"}</p>
                        {Array.isArray(entry.updated_fields) && entry.updated_fields.length > 0 ? (
                          <p className="text-slate-600">
                            Fields: <span className="text-slate-800">{entry.updated_fields.join(", ")}</span>
                          </p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <div>
                <span className="text-xs uppercase tracking-wide text-slate-500">Result payload</span>
                <ScrollArea className="mt-2 max-h-48 rounded-md border border-slate-200 bg-slate-50 p-2">
                  <pre className="text-xs text-slate-700 whitespace-pre-wrap">
                    {JSON.stringify(job.result_meta, null, 2)}
                  </pre>
                </ScrollArea>
              </div>
            </div>
          ) : null}

          {job.error ? (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5" />
              <span>{job.error}</span>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function QuickActionCard({ icon: Icon, title, description, onClick, disabled, loading }) {
  return (
    <Card className="border border-slate-200 bg-white/80 shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="h-5 w-5 text-blue-600" />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <Button onClick={onClick} disabled={disabled || loading} className="w-full bg-blue-600 hover:bg-blue-700 gap-2">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
          {loading ? "Queuing…" : "Run now"}
        </Button>
      </CardContent>
    </Card>
  )
}

function AutomationTasksPanel({
  tasks,
  isLoading,
  isFetching,
  onToggleTask,
  updatingTaskId,
  isUpdating,
  onRefresh,
  profileName,
}) {
  const hasTasks = Array.isArray(tasks) && tasks.length > 0

  return (
    <Card className="border border-slate-200 bg-white/80 shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <History className="h-5 w-5 text-blue-600" />
              AI follow-ups
            </CardTitle>
            <CardDescription>
              {profileName
                ? `Tasks captured by Anya for ${profileName}.`
                : "Tasks captured by Anya for this profile."}
            </CardDescription>
          </div>
          <Button variant="ghost" size="sm" className="gap-2 text-xs" onClick={onRefresh} disabled={isFetching}>
            {isFetching ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
            Loading tasks…
          </div>
        ) : hasTasks ? (
          <div className="space-y-3">
            {tasks.map((task) => {
              const isCompleted = task.status === "completed"
              const isInProgress = task.status === "in_progress"
              const isUpdatingTask = isUpdating && updatingTaskId === task.id
              const dueDate = task.due_date ? parseValidDate(`${task.due_date}T00:00:00`) : null
              const createdAt = parseValidDate(task.created_at)
              const dueDistance = dueDate ? formatDistanceToNow(dueDate, { addSuffix: true }) : null
              const isOverdue = dueDate ? dueDate.getTime() < new Date().setHours(0, 0, 0, 0) : false

              return (
                <div
                  key={task.id}
                  className="flex items-start gap-3 rounded-md border border-slate-200 bg-white px-3 py-2 shadow-sm"
                >
                  <Checkbox
                    id={`automation-task-${task.id}`}
                    checked={isCompleted}
                    disabled={isUpdating || isUpdatingTask}
                    onCheckedChange={(checked) => onToggleTask(task, checked === true)}
                    className="mt-1"
                  />
                  <div className="flex flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <label
                        htmlFor={`automation-task-${task.id}`}
                        className={cn(
                          "text-sm font-medium text-slate-800",
                          isCompleted && "line-through text-slate-400",
                        )}
                      >
                        {task.title}
                      </label>
                      {isInProgress ? (
                        <Badge variant="secondary" className="text-[10px] uppercase tracking-wide">
                          In progress
                        </Badge>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
                      {dueDistance ? (
                        <span className={cn(isOverdue ? "text-red-600 font-semibold" : undefined)}>
                          Due {dueDistance}
                        </span>
                      ) : (
                        <span className="text-slate-400">No due date</span>
                      )}
                      {createdAt ? (
                        <span>Logged {formatDistanceToNow(createdAt, { addSuffix: true })}</span>
                      ) : null}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="text-sm text-slate-500">
            No open follow-ups yet. Ask Anya in the dashboard to capture next steps during automation runs.
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export default function Automation() {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { user, activeProfileId } = useAuthStore((state) => ({
    user: state.user,
    activeProfileId: state.activeProfileId,
  }))

  const isAdmin = Boolean(user?.is_admin) || user?.role === "admin" || user?.id === "admin"
  const [jobTypeFilter, setJobTypeFilter] = useState("all")
  const [jobStatusFilter, setJobStatusFilter] = useState("all")
  const [profileFilter, setProfileFilter] = useState(isAdmin ? "all" : activeProfileId || "all")
  const [selectedProfile, setSelectedProfile] = useState(() => {
    try {
      const stored = localStorage.getItem('grantflow:automation-selected-profile')
      if (stored && stored !== 'none') return stored
    } catch { /* ignore */ }
    return activeProfileId || "none"
  })
  const [selectedJob, setSelectedJob] = useState(null)
  const [selectedSections, setSelectedSections] = useState(["basic_information"])
  const [enrichmentPrompt, setEnrichmentPrompt] = useState("")

  const profilesQuery = useQuery({
    queryKey: ["automation-profiles"],
    queryFn: () => listProfiles(),
    enabled: isAdmin,
  })

  // Admin UX: auto-select a real profile once available so job queueing doesn't send undefined profile_id.
  useEffect(() => {
    if (!isAdmin) return
    if (selectedProfile && selectedProfile !== "none") return

    const profiles = Array.isArray(profilesQuery.data) ? profilesQuery.data : []
    if (profiles.length === 0) return

    const preferred =
      activeProfileId && profiles.some((p) => p.id === activeProfileId)
        ? activeProfileId
        : profiles[0].id

    if (preferred) {
      setSelectedProfile(preferred)
    }
  }, [isAdmin, profilesQuery.data, selectedProfile, activeProfileId])

  // Persist "Run automations as profile" selection across sessions.
  useEffect(() => {
    if (!selectedProfile) return
    try {
      localStorage.setItem('grantflow:automation-selected-profile', selectedProfile)
    } catch { /* ignore */ }
  }, [selectedProfile])

  // If stored profile no longer exists (e.g., deleted), reset to a valid one.
  useEffect(() => {
    if (!isAdmin || !selectedProfile || selectedProfile === 'none') return
    const profiles = Array.isArray(profilesQuery.data) ? profilesQuery.data : []
    if (profiles.length === 0) return
    const exists = profiles.some((p) => p.id === selectedProfile)
    if (!exists) {
      const preferred = activeProfileId && profiles.some((p) => p.id === activeProfileId)
        ? activeProfileId
        : profiles[0].id
      setSelectedProfile(preferred)
    }
  }, [isAdmin, profilesQuery.data, selectedProfile, activeProfileId])

  const metricsQuery = useQuery({
    queryKey: ["crawler-metrics", isAdmin ? profileFilter : activeProfileId],
    queryFn: () =>
      listCrawlerMetrics(
        isAdmin
          ? {
              profile_id: profileFilter && profileFilter !== "all" ? profileFilter : undefined,
            }
          : {},
      ),
    // An idle/backgrounded tab must not keep spending the shared crawler request
    // budget. backend/middleware/apiRateLimitPolicy.js puts every /api/crawlers,
    // /api/anya, /api/matching and /api/ai call into ONE 'cost' bucket of 40
    // requests per 10 minutes per user, so two unconditional 30s polls on this
    // page were 40 requests / 10 min by themselves: a page left open exhausted
    // the budget and the operator's next real "Run now" POST came back 429 with
    // nobody touching anything. Metrics are a slow-moving rollup — 60s is
    // plenty, and a hidden tab polls not at all.
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  })

  const jobsQuery = useQuery({
    queryKey: ["crawler-jobs", jobTypeFilter, jobStatusFilter, profileFilter, isAdmin],
    queryFn: () =>
      listCrawlerJobs({
        type: jobTypeFilter !== "all" ? jobTypeFilter : undefined,
        status: jobStatusFilter !== "all" ? jobStatusFilter : undefined,
        profile_id: isAdmin && profileFilter && profileFilter !== "all" ? profileFilter : undefined,
        limit: 100,
      }),
    // Poll fast ONLY while there is something in flight to watch; otherwise fall
    // back to a slow refresh. Same budget reason as metricsQuery above, and it
    // matches the pattern already used by Documents.jsx / DataSources.jsx.
    refetchInterval: (query) => {
      const jobs = Array.isArray(query.state.data) ? query.state.data : []
      const active = jobs.some((job) => job?.status === "queued" || job?.status === "running")
      return active ? 30_000 : 120_000
    },
    refetchIntervalInBackground: false,
  })

  const profileDetailQuery = useQuery({
    queryKey: ["automation-profile-detail", isAdmin ? selectedProfile : activeProfileId],
    queryFn: () => getProfile(isAdmin ? selectedProfile : activeProfileId),
    enabled: Boolean(isAdmin ? (selectedProfile && selectedProfile !== "none") : activeProfileId),
  })

  // Centralized entitlement gate (admins bypass inside the hook).
  const automationEntitlements = useTierEntitlements(isAdmin ? (selectedProfile !== "none" ? selectedProfile : null) : activeProfileId)
  const tier = automationEntitlements.tier ?? profileDetailQuery.data?.billing?.tier ?? null
  const canPipelineAutomation = automationEntitlements.capabilities.pipelineAutomation
  const canItemFunding = automationEntitlements.capabilities.itemFunding
  const canDocumentAI = automationEntitlements.capabilities.documentAI

  const profileForTasks = isAdmin ? selectedProfile : activeProfileId

  const tasksQuery = useQuery({
    queryKey: ["anya-profile-tasks", profileForTasks],
    queryFn: () => getAnyaProfileTasks(profileForTasks, { status: "active" }),
    enabled: Boolean(profileForTasks),
    // /api/anya shares the same 40-per-10-minute 'cost' bucket as the crawler
    // endpoints; a hidden tab must not keep drawing from it.
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  })

  const sectionOptions = useMemo(
    () =>
      getApplicableSectionKeys(profileDetailQuery.data).map((key) => ({
        key,
        label: SECTION_METADATA[key]?.title ?? key.replace(/_/g, " "),
      })),
    [profileDetailQuery.data],
  )

  const createJobMutation = useMutation({
    mutationFn: (payload) => createCrawlerJob(payload),
    onSuccess: (job) => {
      toast({
        title: "Automation queued",
        description: job?.id
          ? `Job ${String(job.id).slice(0, 8)}… is running.`
          : "Crawler will start shortly.",
      })
      queryClient.invalidateQueries({ queryKey: ["crawler-jobs"] })
      queryClient.invalidateQueries({ queryKey: ["crawler-metrics"] })
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Unable to queue automation",
        description: error instanceof Error ? error.message : "Try again shortly.",
      })
    },
  })

  // jobDetailsMutation + handleInspectJob declared above retryJobMutation so
  // its onSuccess closure can call them without a temporal-dead-zone read.
  // Order matters: jobDetailsMutation -> handleInspectJob -> retryJobMutation.
  const jobDetailsMutation = useMutation({
    mutationFn: (jobId) => getCrawlerJob(jobId),
    onSuccess: (job) => {
      setSelectedJob(job)
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Unable to load job details",
        description: error instanceof Error ? error.message : "Please try again shortly.",
      })
    },
  })

  function handleInspectJob(jobOrId) {
    if (!jobOrId) return
    if (typeof jobOrId === "string") {
      jobDetailsMutation.mutate(jobOrId)
      return
    }
    setSelectedJob(jobOrId)
  }

  const retryJobMutation = useMutation({
    mutationFn: (jobId) => retryCrawlerJob(jobId),
    onSuccess: (newJob) => {
      toast({
        title: "Job retried",
        description: newJob?.id ? `Job ${String(newJob.id).slice(0, 8)}… requeued.` : "Retry queued.",
      })
      queryClient.invalidateQueries({ queryKey: ["crawler-jobs"] })
      queryClient.invalidateQueries({ queryKey: ["crawler-metrics"] })
      handleInspectJob(newJob)
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Unable to retry job",
        description: error instanceof Error ? error.message : "Please try again shortly.",
      })
    },
  })

  const cancelJobMutation = useMutation({
    mutationFn: ({ jobId, reason }) => cancelCrawlerJob(jobId, reason),
    onSuccess: (job) => {
      toast({
        title: "Job cancelled",
        description: job?.id
          ? `Job ${String(job.id).slice(0, 8)}… marked as cancelled.`
          : "Cancellation recorded.",
      })
      queryClient.invalidateQueries({ queryKey: ["crawler-jobs"] })
      queryClient.invalidateQueries({ queryKey: ["crawler-metrics"] })
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Unable to cancel job",
        description: error instanceof Error ? error.message : "Please try again shortly.",
      })
    },
  })

  const updateTaskMutation = useMutation({
    mutationFn: ({ sessionId, taskId, status }) => updateAnyaTask(sessionId, taskId, { status }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["anya-profile-tasks"] })
      toast({
        title: variables?.status === "completed" ? "Task completed" : "Task updated",
        description:
          variables?.status === "completed"
            ? "Marked as complete in Anya."
            : "Task status updated in Anya.",
      })
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Unable to update task",
        description: error instanceof Error ? error.message : "Please try again shortly.",
      })
    },
  })

  const selectedProfileEntity = useMemo(() => {
    if (!selectedProfile || selectedProfile === "none") return null
    if (!profilesQuery.data) return null
    return profilesQuery.data.find((profile) => profile.id === selectedProfile) ?? null
  }, [profilesQuery.data, selectedProfile])

  const selectedAdminProfileId =
    isAdmin && selectedProfile && selectedProfile !== "none" ? selectedProfile : null

  const handleQueueJob = (type, params = {}) => {
    const profileId = isAdmin ? selectedAdminProfileId : activeProfileId

    const requiresProfile =
      type !== "pipeline_automation" // pipeline automation can run org-wide; other crawlers need a profile context

    if (requiresProfile && !profileId) {
      toast({
        variant: "destructive",
        title: "Select a profile first",
        description: "Choose a profile before running this automation.",
      })
      return
    }

    const gateByType = {
      pipeline_automation: {
        allowed: canPipelineAutomation,
        message: automationEntitlements.upgradeMessage("enable_pipeline_automation"),
      },
      item_search: {
        allowed: canItemFunding,
        message: automationEntitlements.upgradeMessage("enable_item_funding"),
      },
      profile_enrichment: {
        allowed: canDocumentAI,
        message: automationEntitlements.upgradeMessage("enable_document_ai"),
      },
      avatar_lookup: {
        allowed: canDocumentAI,
        message: automationEntitlements.upgradeMessage("enable_document_ai"),
      },
      document_ingest: {
        allowed: canDocumentAI,
        message: automationEntitlements.upgradeMessage("enable_document_ai"),
      },
    }

    const gate = gateByType[type]
    if (gate && !gate.allowed) {
      toast({
        variant: "destructive",
        title: "Feature unavailable",
        description: gate.message,
      })
      return
    }

    // Local sweep requires a ZIP code to define the search radius
    if (type === "local" && !deriveZipFromProfile(profileDetailQuery.data)) {
      toast({
        variant: "destructive",
        title: "Missing ZIP code",
        description: "This profile needs a ZIP code (in Basic Information or Housing) to run a local sweep.",
      })
      return
    }

    createJobMutation.mutate({
      type,
      profile_id: profileId || null,
      parameters: params,
    })
  }

  // Mirrors handleQueueJob's own gates so a "Run now" button can be disabled
  // proactively (with an explanatory tooltip) instead of only failing via a
  // toast after the click. Returns null when the type is runnable right now.
  const getRunDisabledReason = (type) => {
    if (!DISPATCHABLE_JOB_TYPES.has(type)) {
      return "Not wired to a crawler-dispatcher handler yet — running it would just queue a job that never executes."
    }
    const profileId = isAdmin ? selectedAdminProfileId : activeProfileId
    const requiresProfile = type !== "pipeline_automation"
    if (requiresProfile && !profileId) {
      return "Select a profile first."
    }
    const tierGate = {
      pipeline_automation: { allowed: canPipelineAutomation, capability: "enable_pipeline_automation" },
      profile_enrichment: { allowed: canDocumentAI, capability: "enable_document_ai" },
      avatar_lookup: { allowed: canDocumentAI, capability: "enable_document_ai" },
      document_ingest: { allowed: canDocumentAI, capability: "enable_document_ai" },
    }[type]
    if (tierGate?.allowed === false) {
      return automationEntitlements.upgradeMessage(tierGate.capability)
    }
    return null
  }

  const handleRetryJob = (jobId) => {
    if (!jobId) return
    retryJobMutation.mutate(jobId)
  }

  const handleCancelJob = (jobId) => {
    if (!jobId) return
    let reason = ""
    if (typeof window !== "undefined") {
      const input = window.prompt("Add an optional cancellation reason:", "")
      if (input === null) return
      reason = input?.trim() ?? ""
    }
    cancelJobMutation.mutate({ jobId, reason })
  }

  const metricsLoading = metricsQuery.isLoading && !metricsQuery.data
  const metricsData = (metricsQuery.data?.types ?? []).filter(
    (metric) => !isSupersededCrawlerType(metric?.type),
  )
  const metricsForDisplay = metricsLoading ? METRIC_TYPE_ORDER.map((type) => ({ type })) : metricsData
  const overallMetrics = metricsQuery.data?.overall ?? null
  // Defensive: the backend already excludes retired types from every panel
  // query, but filter here too so a stale cache / older API can never surface
  // legacy jobs in the live queue or recent-failures panels.
  const runningJobs = (metricsQuery.data?.running_jobs ?? []).filter(
    (job) => !isSupersededCrawlerType(job?.type),
  )
  const recentFailures = (metricsQuery.data?.recent_failures ?? []).filter(
    (job) => !isSupersededCrawlerType(job?.type),
  )
  const inspectionState = {
    isLoading: jobDetailsMutation.isPending,
    jobId: jobDetailsMutation.variables ?? null,
  }

  const retryingJobId = retryJobMutation.isPending ? retryJobMutation.variables ?? null : null
  const cancellingJobId = cancelJobMutation.isPending ? cancelJobMutation.variables?.jobId ?? null : null

  const jobs = (jobsQuery.data ?? []).filter((job) => !isSupersededCrawlerType(job?.type))
  const hasJobs = jobs.length > 0
  const tasksForPanel = tasksQuery.data ?? []
  const automationProfileName =
    profileDetailQuery.data?.display_name ??
    profileDetailQuery.data?.name ??
    selectedProfileEntity?.name ??
    null
  const isUpdatingTask = updateTaskMutation.isPending
  const updatingTaskId =
    isUpdatingTask && updateTaskMutation.variables ? updateTaskMutation.variables.taskId : null

  const handleToggleTaskStatus = (task, checked) => {
    if (!task?.id || !task?.session_id) return
    const nextStatus = checked ? "completed" : "open"
    updateTaskMutation.mutate({
      sessionId: task.session_id,
      taskId: task.id,
      status: nextStatus,
    })
  }

  const handleOpenQueue = () => {
    if (typeof document === "undefined") return
    const el = document.getElementById("automation-queue")
    if (!el) return
    el.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  return (
    <div className="p-6 md:p-10 space-y-8">
      <header className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-3">
          <h1 className="text-3xl font-bold text-foreground flex items-center gap-2">
            <Bot className="h-8 w-8 text-blue-600" />
            Automation Control Center
          </h1>
          <p className="max-w-3xl text-sm text-slate-600">
            Launch AI crawlers, monitor job output, and advance grants with a single click. Automations respect profile
            permissions, match funding to demographics, and surface handoffs when human judgment is required.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" className="gap-2" onClick={() => jobsQuery.refetch()} disabled={jobsQuery.isFetching}>
            {jobsQuery.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Refresh jobs
          </Button>
        </div>
      </header>

      {isAdmin ? (
        <Card className="border border-slate-200 bg-white/80 shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <UserCircle2 className="h-4 w-4 text-blue-600" />
              Run automations as profile
            </CardTitle>
            <CardDescription>
              Choose which profile the crawlers should use. Most automations require a profile; “Org-wide” is only valid for pipeline automation.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <Select value={selectedProfile} onValueChange={setSelectedProfile}>
              <SelectTrigger className="max-w-[420px]">
                <SelectValue placeholder="Select profile" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Org-wide (pipeline automation only)</SelectItem>
                {(profilesQuery.data ?? []).map((profile) => (
                  <SelectItem key={profile.id} value={profile.id}>
                    {profile.display_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedProfile === "none" ? (
              <p className="text-xs text-amber-700">
                Select a specific profile to run crawlers like Local Sweep, Scholarship match, and Profile enrichment.
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <section className="grid gap-4 lg:grid-cols-3">
        <QuickActionCard
          icon={School}
          title="Portal award check"
          description="Proactively check financial aid and scholarship portals for new award notifications and sync them to the student's profile."
          onClick={() => handleQueueJob("portal_check", { check_type: "manual", max_portals: 20 })}
          disabled={!isAdmin && !activeProfileId}
          loading={createJobMutation.isPending && createJobMutation.variables?.type === "portal_check"}
        />
        <QuickActionCard
          icon={Sparkles}
          title="Profile enrichment"
          description="Refresh profile sections using AI and recent context."
          onClick={() =>
            handleQueueJob("profile_enrichment", {
              sections: selectedSections,
              prompt: enrichmentPrompt || undefined,
            })
          }
          disabled={selectedSections.length === 0 || (!isAdmin && !activeProfileId) || !canDocumentAI}
          loading={createJobMutation.isPending && createJobMutation.variables?.type === "profile_enrichment"}
        />
      </section>

      {/* Live Progress Meters for Running Jobs */}
      {runningJobs.length > 0 && (
        <section className="space-y-4">
          {runningJobs.slice(0, 3).map((job) => (
            <CrawlerProgressMeter key={job.id} jobId={job.id} />
          ))}
        </section>
      )}

      {profileForTasks ? (
        <AutomationTasksPanel
          tasks={tasksForPanel}
          isLoading={tasksQuery.isLoading && !tasksQuery.data}
          isFetching={tasksQuery.isFetching}
          onToggleTask={handleToggleTaskStatus}
          updatingTaskId={updatingTaskId}
          isUpdating={isUpdatingTask}
          onRefresh={() => tasksQuery.refetch()}
          profileName={automationProfileName}
        />
      ) : isAdmin ? (
        <Card className="border border-dashed border-slate-300 bg-slate-50/50 shadow-none">
          <CardHeader className="pb-2">
            <CardTitle className="text-base text-slate-700">Select a profile to view AI tasks</CardTitle>
            <CardDescription>
              Choose a profile above to surface Anya follow-ups alongside automation jobs.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        <OverallMetricsCard
          overall={overallMetrics}
          generatedAt={metricsQuery.data?.generated_at ?? null}
          isLoading={metricsQuery.isFetching}
          onOpenQueue={handleOpenQueue}
        />
        {metricsQuery.isError ? (
          <Card className="border border-red-200 bg-red-50 text-sm text-red-700 shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Metrics unavailable</CardTitle>
            </CardHeader>
            <CardContent>
              {metricsQuery.error instanceof Error
                ? metricsQuery.error.message
                : "Unable to load crawler metrics right now."}
            </CardContent>
          </Card>
        ) : null}
        {metricsForDisplay.map((metric) => (
          <MetricCard
            key={metric.type}
            metric={metric}
            onInspect={handleInspectJob}
            inspectionState={inspectionState}
            isLoading={metricsLoading && !metric.counts}
            onRun={metricsLoading ? undefined : () => handleQueueJob(metric.type)}
            isRunning={createJobMutation.isPending && createJobMutation.variables?.type === metric.type}
            runDisabledReason={metricsLoading ? null : getRunDisabledReason(metric.type)}
          />
        ))}
        <LiveQueueCard
          runningJobs={runningJobs}
          recentFailures={recentFailures}
          onInspect={handleInspectJob}
          onRetry={handleRetryJob}
          onCancel={handleCancelJob}
          retryingJobId={retryingJobId}
          cancellingJobId={cancellingJobId}
          onOpenQueue={handleOpenQueue}
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card id="automation-queue" className="border border-slate-200 bg-white/80 shadow-sm">
          <CardHeader className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <CardTitle className="text-lg">Automation queue</CardTitle>
              <CardDescription>Track crawlers, AI enrichment, and pipeline automation jobs.</CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Select value={jobTypeFilter} onValueChange={setJobTypeFilter}>
                <SelectTrigger className="w-[170px]">
                  <SelectValue placeholder="Filter by type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All types</SelectItem>
                  {Object.entries(JOB_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={jobStatusFilter} onValueChange={setJobStatusFilter}>
                <SelectTrigger className="w-[150px]">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  {Object.keys(STATUS_VARIANTS)
                    .filter((status) => status !== "partial")
                    .map((status) => (
                      <SelectItem key={status} value={status}>
                        {status.replace(/_/g, " ")}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              {isAdmin ? (
                <Select value={profileFilter} onValueChange={setProfileFilter}>
                  <SelectTrigger className="w-[220px]">
                    <SelectValue placeholder="Filter by profile" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All profiles</SelectItem>
                    {(profilesQuery.data ?? []).map((profile) => (
                      <SelectItem key={profile.id} value={profile.id}>
                        {profile.display_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {jobsQuery.isLoading ? (
              <div className="flex min-h-[300px] items-center justify-center text-sm text-slate-600">
                <Loader2 className="mr-2 h-4 w-4 animate-spin text-blue-600" />
                Loading jobs…
              </div>
            ) : !hasJobs ? (
              <div className="flex min-h-[300px] items-center justify-center text-sm text-slate-600">
                No automation jobs found for the selected filters.
              </div>
            ) : (
              <ScrollArea className="h-[360px]">
                <table className="w-full table-fixed border-collapse text-sm">
                  <thead className="bg-slate-50 text-slate-500 uppercase text-xs tracking-wide">
                    <tr>
                      <th className="px-4 py-3 text-left w-36">Job</th>
                      <th className="px-4 py-3 text-left w-36">Profile</th>
                      <th className="px-4 py-3 text-left w-24">Status</th>
                      <th className="px-4 py-3 text-left w-20">Results</th>
                      <th className="px-4 py-3 text-left w-40">Created</th>
                      <th className="px-4 py-3 text-left">Notes</th>
                      <th className="px-4 py-3 text-right w-24"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {jobs.map((job) => {
                      const jobSummary = summarizeJob(job)
                      const parameterSummary = describeJobParameters(job)
                      const jobIdText = job.id !== undefined && job.id !== null ? String(job.id) : ""
                      return (
                        <tr key={job.id} className="hover:bg-slate-50/60">
                          <td className="px-4 py-3">
                            <div className="flex flex-col gap-1">
                              <JobTypeBadge job={job} />
                              <span className="font-mono text-[11px] text-slate-500">{jobIdText.slice(0, 10)}…</span>
                              {job.retried_from_job_id ? (
                                <span className="text-[10px] uppercase tracking-wide text-slate-400">
                                  Retry of {String(job.retried_from_job_id).slice(0, 10)}…
                                </span>
                              ) : null}
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex flex-col gap-1 text-xs text-slate-600">
                              <span>{job.profile_id ?? "—"}</span>
                              <span className="text-[11px] text-slate-400">{job.organization_id ?? "org: n/a"}</span>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <JobStatusBadge job={job} />
                          </td>
                          <td className="px-4 py-3 text-xs text-slate-600">
                            {formatNumber(typeof job.result_count === "number" ? job.result_count : null) ?? "—"}
                          </td>
                          <td className="px-4 py-3 text-xs text-slate-600">
                            <div className="flex flex-col gap-1">
                              <span>{job.created_at ?? "—"}</span>
                              {job.started_at ? (
                                <span className="text-[11px] text-slate-400">Started {job.started_at}</span>
                              ) : null}
                              {job.last_retry_at ? (
                                <span className="text-[11px] text-slate-400">
                                  Last retry {safeDistanceToNow(job.last_retry_at, "—")}
                                </span>
                              ) : null}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-xs text-slate-600">
                            {job.error ? (
                              <span className="text-red-600">{job.error}</span>
                            ) : jobSummary || parameterSummary ? (
                              <div className="flex flex-col gap-1">
                                {jobSummary ? <span>{jobSummary}</span> : null}
                                {typeof job.retry_count === "number" && job.retry_count > 0 ? (
                                  <span className="text-[11px] text-slate-400">Retry attempts: {job.retry_count}</span>
                                ) : null}
                                {job.retried_from_job_id ? (
                                  <span className="text-[11px] text-slate-400">
                                    Retry of job {String(job.retried_from_job_id).slice(0, 10)}…
                                  </span>
                                ) : null}
                                {parameterSummary ? (
                                  <span className="text-[11px] text-slate-400">{parameterSummary}</span>
                                ) : null}
                              </div>
                            ) : (
                              <span className="text-slate-400">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <div className="flex justify-end gap-2">
                              {job.status === "queued" && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="text-xs"
                                  onClick={() => handleCancelJob(job.id)}
                                  disabled={cancellingJobId === job.id}
                                >
                                  {cancellingJobId === job.id ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : (
                                <XCircle className="h-3 w-3" />
                                  )}
                                  {cancellingJobId === job.id ? "Cancelling…" : "Cancel"}
                                </Button>
                              )}
                              {canRetryOrResume(job) && (
                                <Button
                                  variant={getEffectiveJobStatus(job) === "partial" ? "default" : "destructive"}
                                  size="sm"
                                  className="text-xs gap-2"
                                  onClick={() => handleRetryJob(job.id)}
                                  disabled={retryingJobId === job.id}
                                  title={
                                    getEffectiveJobStatus(job) === "partial"
                                      ? "Continue this partial run from the next un-crawled state"
                                      : undefined
                                  }
                                >
                                  {retryingJobId === job.id ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : (
                                    <RefreshCw className="h-3 w-3" />
                                  )}
                                  {retryingJobId === job.id
                                    ? `${retryButtonLabel(job)}ing…`
                                    : retryButtonLabel(job)}
                                </Button>
                              )}
                              <Button variant="outline" size="sm" onClick={() => handleInspectJob(job)}>
                                Inspect
                              </Button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </ScrollArea>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card className="border border-slate-200 bg-white/80 shadow-sm">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Bot className="h-4 w-4 text-blue-600" />
                Pipeline automation
              </CardTitle>
              <CardDescription>Advance grants, record AI reasoning, and capture human handoffs.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
                <PipelineAutomationPanel
                  organizationId={profileDetailQuery.data?.organization_id ?? selectedProfileEntity?.organization_id ?? null}
                  profileId={isAdmin ? (selectedProfile && selectedProfile !== "none" ? selectedProfile : undefined) : activeProfileId}
                  disabled={!canPipelineAutomation}
                  disabledReason="This profile’s tier does not include pipeline automation. Ask an admin to upgrade the tier in Admin → Billing."
                />
            </CardContent>
          </Card>

          <Card className="border border-slate-200 bg-white/80 shadow-sm">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-blue-600" />
                Profile enrichment
              </CardTitle>
              <CardDescription>Queue AI to enrich selected sections with structured data pulled from recent context.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2">
                <p className="text-xs uppercase tracking-wide text-slate-500">Target sections</p>
                <div className="flex flex-wrap gap-2">
                  {sectionOptions.map((section) => {
                    const isActive = selectedSections.includes(section.key)
                    return (
                      <Button
                        key={section.key}
                        variant={isActive ? "secondary" : "outline"}
                        size="sm"
                        className="text-xs"
                        onClick={() =>
                          setSelectedSections((prev) =>
                            isActive ? prev.filter((key) => key !== section.key) : [...prev, section.key],
                          )
                        }
                      >
                        {section.label}
                      </Button>
                    )
                  })}
                </div>
              </div>
              <div className="space-y-2">
                <p className="text-xs uppercase tracking-wide text-slate-500">Optional instructions</p>
                <Textarea
                  value={enrichmentPrompt}
                  onChange={(event) => setEnrichmentPrompt(event.target.value)}
                  placeholder="Highlight specific details to extract, e.g. “focus on medical licensing and board certifications.”"
                  rows={3}
                />
              </div>
              <Button
                className="w-full bg-blue-600 hover:bg-blue-700 gap-2"
                onClick={() =>
                  handleQueueJob("profile_enrichment", {
                    sections: selectedSections,
                    prompt: enrichmentPrompt || undefined,
                  })
                }
                disabled={selectedSections.length === 0 || (!isAdmin && !activeProfileId)}
              >
                {createJobMutation.isPending && createJobMutation.variables?.type === "profile_enrichment" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                Enrich profile
              </Button>
            </CardContent>
          </Card>
        </div>
      </section>

      <JobDetailsDialog
        job={selectedJob}
        onOpenChange={() => setSelectedJob(null)}
        onRetry={handleRetryJob}
        retrying={retryJobMutation.isPending && retryJobMutation.variables === selectedJob?.id}
        onCancel={handleCancelJob}
        cancelling={cancelJobMutation.isPending && cancelJobMutation.variables?.jobId === selectedJob?.id}
        onInspectJob={handleInspectJob}
      />
    </div>
  )
}
