import React, { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  Activity,
  Clock,
  MapPin,
  Search,
  Sparkles,
  Target,
  TrendingUp,
  Zap,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
} from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { getCrawlerJob } from "@/api/crawlers"
import { cn } from "@/lib/utils"
import { formatDistanceToNow } from "date-fns"

const JOB_TYPE_ICONS = {
  local: MapPin,
  scholarship: Target,
  comprehensive: Search,
  item_search: Sparkles,
  avatar_lookup: Activity,
  document_ingest: Activity,
  pipeline_automation: Zap,
  profile_enrichment: TrendingUp,
}

const JOB_TYPE_LABELS = {
  local: "Local 25-mile Sweep",
  scholarship: "Scholarship Intelligence",
  comprehensive: "Nationwide Crawl",
  item_search: "Item Funding Search",
  avatar_lookup: "AI Avatar Lookup",
  document_ingest: "Document Enrichment",
  pipeline_automation: "Pipeline Automation",
  profile_enrichment: "Profile Enrichment",
}

function formatDuration(seconds) {
  if (typeof seconds !== "number" || Number.isNaN(seconds) || seconds <= 0) return "—"
  const totalSeconds = Math.round(seconds)
  const mins = Math.floor(totalSeconds / 60)
  const secs = totalSeconds % 60
  if (mins === 0) return `${secs}s`
  if (mins < 60) return `${mins}m ${secs}s`
  const hours = Math.floor(mins / 60)
  const remainingMins = mins % 60
  return `${hours}h ${remainingMins}m`
}

function estimateProgress(job) {
  // Estimate progress based on job type and available metadata
  if (!job || job.status !== "running") return 0

  const meta = job.result_meta || {}
  const params = job.parameters || {}

  // For comprehensive crawls, use ZIPs processed
  if (job.type === "comprehensive" && meta.zipsProcessed && meta.totalZips) {
    return Math.min(95, Math.round((meta.zipsProcessed / meta.totalZips) * 100))
  }

  // For local crawls, estimate based on time elapsed (assume 30-60 seconds)
  if (job.type === "local") {
    const elapsed = job.started_at ? (Date.now() - new Date(job.started_at).getTime()) / 1000 : 0
    const estimated = Math.min(90, (elapsed / 45) * 100)
    return Math.round(estimated)
  }

  // For other jobs, estimate based on elapsed time (assume 60-120 seconds)
  const elapsed = job.started_at ? (Date.now() - new Date(job.started_at).getTime()) / 1000 : 0
  const estimated = Math.min(90, (elapsed / 90) * 100)
  return Math.round(estimated)
}

function getJobStatusMessage(job) {
  if (!job) return "Initializing..."

  const meta = job.result_meta || {}
  const params = job.parameters || {}

  switch (job.type) {
    case "comprehensive":
      if (meta.currentZip) {
        return `Searching ZIP ${meta.currentZip}...`
      }
      if (meta.zipsProcessed) {
        return `Processed ${meta.zipsProcessed} ZIP codes`
      }
      return "Querying nationwide data sources..."

    case "local":
      if (meta.currentLocation) {
        return `Searching ${meta.currentLocation}...`
      }
      if (params.zip_list) {
        const zips = Array.isArray(params.zip_list) ? params.zip_list : [params.zip_list]
        return `Searching ${zips.length} location${zips.length > 1 ? "s" : ""}...`
      }
      return "Querying local funding sources..."

    case "scholarship":
      return "Analyzing scholarship databases..."

    case "item_search": {
      const item = params.item || meta.item
      if (item) {
        return `Searching for "${item}" funding...`
      }
      return "Querying item-specific grants..."
    }

    case "profile_enrichment": {
      const sections = params.sections || []
      if (sections.length > 0) {
        return `Enriching ${sections.length} profile section${sections.length > 1 ? "s" : ""}...`
      }
      return "Analyzing profile data..."
    }

    case "pipeline_automation":
      return "Processing grant pipeline..."

    case "document_ingest":
      return "Extracting document data..."

    default:
      return "Processing job..."
  }
}

function RecentDiscoveries({ job }) {
  const meta = job?.result_meta || {}
  const discoveries = meta.opportunities || []

  if (discoveries.length === 0) {
    return (
      <div className="text-sm text-slate-500 text-center py-8">
        No opportunities discovered yet. Check back in a moment...
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {discoveries.slice(0, 5).map((opp, index) => (
        <div
          key={index}
          className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm"
        >
          <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-sm text-slate-900 line-clamp-1">
              {opp.title || "Untitled opportunity"}
            </p>
            <div className="flex items-center gap-2 mt-1 text-xs text-slate-600">
              {opp.sponsor && <span className="truncate">{opp.sponsor}</span>}
              {opp.inserted && (
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                  New
                </Badge>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

export default function CrawlerProgressMeter({ jobId, onClose }) {
  const [isMinimized, setIsMinimized] = useState(false)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)

  const jobQuery = useQuery({
    queryKey: ["crawler-job-progress", jobId],
    queryFn: () => getCrawlerJob(jobId),
    refetchInterval: (query) => {
      // TanStack Query v5 passes the Query object; v4 passes raw data.
      // Normalise to raw data for both versions.
      const data = query?.state?.data ?? query
      if (data?.status === "running") {
        return 2000 // Poll every 2 seconds when running
      }
      return false // Stop polling when completed/failed
    },
    enabled: Boolean(jobId),
  })

  const job = jobQuery.data

  // Update elapsed time counter
  useEffect(() => {
    if (!job || job.status !== "running" || !job.started_at) return

    const interval = setInterval(() => {
      const elapsed = (Date.now() - new Date(job.started_at).getTime()) / 1000
      setElapsedSeconds(Math.floor(elapsed))
    }, 1000)

    return () => clearInterval(interval)
  }, [job])

  if (jobQuery.isError) {
    return (
      <Card className="border-2 border-red-300 bg-red-50 shadow">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-red-700 flex items-center gap-2">
            <Activity className="h-4 w-4" />
            Unable to load crawler status
          </CardTitle>
          <CardDescription className="text-xs text-red-600">
            {jobQuery.error?.message || "Could not reach the server. The job may still be running."}
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  if (!job) {
    return (
      <Card className="border-2 border-blue-300 bg-blue-50 shadow animate-pulse">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-blue-700 flex items-center gap-2">
            <Activity className="h-4 w-4 animate-spin" />
            Starting crawler job...
          </CardTitle>
        </CardHeader>
      </Card>
    )
  }

  if (job.status === "completed" || job.status === "failed") {
    const Icon = JOB_TYPE_ICONS[job.type] || Activity
    const label = JOB_TYPE_LABELS[job.type] || job.type
    const meta = job.result_meta || {}
    const inserted = meta.inserted || 0
    const evaluated = meta.evaluated || 0
    const isError = job.status === "failed"
    return (
      <Card className={cn("border-2 shadow-lg", isError ? "border-red-400 bg-red-50" : "border-emerald-500 bg-emerald-50")}>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className={cn("flex h-10 w-10 items-center justify-center rounded-full", isError ? "bg-red-500" : "bg-emerald-600")}>
                <Icon className="h-5 w-5 text-white" />
              </div>
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  {label}
                  <Badge className={isError ? "bg-red-500 text-white text-xs" : "bg-emerald-600 text-white text-xs"}>
                    {isError ? "Failed" : "Complete"}
                  </Badge>
                </CardTitle>
                <CardDescription className="text-xs">
                  {isError
                    ? (meta.error || job.error || "Job failed — check server logs for details")
                    : `Finished: ${inserted} opportunit${inserted === 1 ? "y" : "ies"} added, ${evaluated} records evaluated`}
                </CardDescription>
              </div>
            </div>
            {onClose && (
              <Button variant="ghost" size="sm" onClick={onClose}>
                Dismiss
              </Button>
            )}
          </div>
          <Progress value={isError ? 100 : 100} className={cn("h-2 mt-2", isError ? "[&>div]:bg-red-500" : "[&>div]:bg-emerald-500")} />
        </CardHeader>
      </Card>
    )
  }

  if (job.status !== "running") {
    return null
  }

  const Icon = JOB_TYPE_ICONS[job.type] || Activity
  const label = JOB_TYPE_LABELS[job.type] || job.type
  const progress = estimateProgress(job)
  const statusMessage = getJobStatusMessage(job)
  const meta = job.result_meta || {}
  const params = job.parameters || {}

  const inserted = meta.inserted || 0
  const evaluated = meta.evaluated || 0

  if (isMinimized) {
    return (
      <Card className="border-2 border-blue-500 bg-gradient-to-r from-blue-50 to-cyan-50 shadow-lg">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-blue-600 to-cyan-600">
                <Icon className="h-5 w-5 text-white animate-pulse" />
              </div>
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  {label}
                  <Badge className="bg-blue-600 text-white text-xs">Running</Badge>
                </CardTitle>
                <CardDescription className="text-xs">{statusMessage}</CardDescription>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setIsMinimized(false)}>
                <ChevronDown className="h-4 w-4" />
              </Button>
              {onClose && (
                <Button variant="ghost" size="sm" onClick={onClose}>
                  Hide
                </Button>
              )}
            </div>
          </div>
          <Progress value={progress} className="h-2 mt-2" />
        </CardHeader>
      </Card>
    )
  }

  return (
    <Card className="border-2 border-blue-500 bg-gradient-to-r from-blue-50 to-cyan-50 shadow-lg">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-blue-600 to-cyan-600">
              <Icon className="h-5 w-5 text-white animate-pulse" />
            </div>
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                Live Crawler Progress
                <Badge className="bg-blue-600 text-white text-xs">Running</Badge>
              </CardTitle>
              <CardDescription className="text-xs">{label}</CardDescription>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setIsMinimized(true)}>
              <ChevronUp className="h-4 w-4" />
            </Button>
            {onClose && (
              <Button variant="ghost" size="sm" onClick={onClose}>
                Hide
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Current Status */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="font-semibold text-slate-700">Current Status</span>
            <span className="text-slate-600">{progress}% estimated</span>
          </div>
          <Progress value={progress} className="h-3" />
          <p className="text-sm text-slate-600 flex items-center gap-2">
            <Activity className="h-4 w-4 text-blue-600 animate-pulse" />
            {statusMessage}
          </p>
        </div>

        <Separator />

        {/* Live Statistics */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-wide text-slate-500">Opportunities Found</p>
            <p className="text-2xl font-bold text-slate-900">{inserted}</p>
          </div>
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-wide text-slate-500">Records Evaluated</p>
            <p className="text-2xl font-bold text-slate-900">{evaluated || "—"}</p>
          </div>
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-wide text-slate-500">Elapsed Time</p>
            <p className="text-lg font-semibold text-slate-900">{formatDuration(elapsedSeconds)}</p>
          </div>
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-wide text-slate-500">Search Rate</p>
            <p className="text-lg font-semibold text-slate-900">
              {meta.zipsProcessed && elapsedSeconds > 0
                ? `~${Math.round((meta.zipsProcessed / elapsedSeconds) * 60)} ZIPs/min`
                : "Calculating..."}
            </p>
          </div>
        </div>

        <Separator />

        {/* Job Details */}
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-wide text-slate-500 font-semibold">Job Details</p>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <span className="text-slate-500">Job ID:</span>
              <p className="font-mono text-xs text-slate-700">
                {(() => { const s = String(job.id ?? ""); return s.length > 16 ? s.slice(0, 16) + "…" : s; })()}
              </p>
            </div>
            <div>
              <span className="text-slate-500">Profile:</span>
              <p className="text-slate-700">{job.profile_id || "Organization"}</p>
            </div>
            <div>
              <span className="text-slate-500">Started:</span>
              <p className="text-slate-700">
                {job.started_at
                  ? formatDistanceToNow(new Date(job.started_at), { addSuffix: true })
                  : "—"}
              </p>
            </div>
            <div>
              <span className="text-slate-500">Type:</span>
              <p className="text-slate-700 capitalize">{job.type.replace(/_/g, " ")}</p>
            </div>
          </div>
        </div>

        {/* Recent Discoveries Feed */}
        {job.type !== "pipeline_automation" &&
          job.type !== "document_ingest" &&
          job.type !== "profile_enrichment" && (
            <>
              <Separator />
              <div className="space-y-2">
                <p className="text-xs uppercase tracking-wide text-slate-500 font-semibold">
                  Recent Discoveries
                </p>
                <ScrollArea className="h-[200px]">
                  <RecentDiscoveries job={job} />
                </ScrollArea>
              </div>
            </>
          )}
      </CardContent>
    </Card>
  )
}
