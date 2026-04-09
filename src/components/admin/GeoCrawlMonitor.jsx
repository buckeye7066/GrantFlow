import React, { useEffect, useMemo, useRef, useState } from "react"
import { AlertCircle, Loader2, PauseCircle, PlayCircle } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { apiFetch } from "@/api/client"
import { createPageUrl } from "@/utils"
import { Link } from "react-router-dom"

const LS_LAST_RUN_ID = "gf_geo_crawl_last_run_id"

async function fetchRun(runId) {
  return apiFetch(`/api/geo-crawl/runs/${encodeURIComponent(runId)}`)
}

async function fetchEvents(runId, afterId) {
  const params = new URLSearchParams()
  if (afterId) params.set("after_id", String(afterId))
  params.set("limit", "200")
  const query = params.toString() ? `?${params.toString()}` : ""
  return apiFetch(`/api/geo-crawl/runs/${encodeURIComponent(runId)}/events${query}`)
}

function statusBadge(status) {
  const s = String(status || "").toLowerCase()
  if (s === "running") return "bg-blue-100 text-blue-700"
  if (s === "complete") return "bg-emerald-100 text-emerald-700"
  if (s === "failed") return "bg-red-100 text-red-700"
  if (s === "paused") return "bg-amber-100 text-amber-700"
  return "bg-slate-100 text-slate-700"
}

function isNotFoundError(err) {
  if (!err) return false
  if (err.status === 404) return true
  const msg = String(err.message || err.details?.message || "")
  return /not\s+found|404/i.test(msg)
}

export default function GeoCrawlMonitor({ runId: runIdProp, onStaleRun }) {
  const [runId, setRunId] = useState(runIdProp || "")
  const [loading, setLoading] = useState(false)
  const [run, setRun] = useState(null)
  const [events, setEvents] = useState([])
  const [lastEventId, setLastEventId] = useState(0)
  const [error, setError] = useState("")
  /** When true, run/events are missing server-side — stop polling to avoid 404 spam. */
  const [suspendPolling, setSuspendPolling] = useState(false)

  const tailRef = useRef(null)

  useEffect(() => {
    if (runIdProp) {
      setRunId(runIdProp)
      setSuspendPolling(false)
      setError("")
      try {
        window.localStorage.setItem(LS_LAST_RUN_ID, runIdProp)
      } catch {
        // ignore
      }
      return
    }
    try {
      const saved = window.localStorage.getItem(LS_LAST_RUN_ID)
      if (saved) setRunId(saved)
    } catch {
      // ignore
    }
  }, [runIdProp])

  useEffect(() => {
    if (!runId) return
    let mounted = true
    setLoading(true)
    setError("")
    Promise.all([fetchRun(runId), fetchEvents(runId, 0)])
      .then(([runRes, evRes]) => {
        if (!mounted) return
        setRun(runRes?.run ?? null)
        const nextEvents = Array.isArray(evRes?.events) ? evRes.events : []
        setEvents(nextEvents.slice(-200))
        setLastEventId(Number(evRes?.last_event_id ?? (nextEvents.length ? nextEvents[nextEvents.length - 1].id : 0)) || 0)
      })
      .catch((err) => {
        if (!mounted) return
        if (isNotFoundError(err)) {
          setSuspendPolling(true)
          setError(
            "This run is no longer in the database (for example after a reset, different environment, or an old saved link). Start a new geo crawl or dismiss the monitor.",
          )
          return
        }
        setError(err?.message || "Unable to load geo crawl run.")
      })
      .finally(() => mounted && setLoading(false))
    return () => {
      mounted = false
    }
  }, [runId])

  useEffect(() => {
    if (!runId || suspendPolling) return
    let mounted = true
    const id = window.setInterval(async () => {
      try {
        const [runRes, evRes] = await Promise.all([fetchRun(runId), fetchEvents(runId, lastEventId)])
        if (!mounted) return
        const nextRun = runRes?.run ?? null
        setRun(nextRun)
        const nextEvents = Array.isArray(evRes?.events) ? evRes.events : []
        if (nextEvents.length) {
          setEvents((prev) => [...prev, ...nextEvents].slice(-200))
          setLastEventId(Number(evRes?.last_event_id ?? nextEvents[nextEvents.length - 1].id) || lastEventId)
          // Auto-scroll to bottom
          setTimeout(() => {
            tailRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
          }, 0)
        }
      } catch (err) {
        if (!mounted) return
        if (isNotFoundError(err)) {
          setSuspendPolling(true)
          setError(
            "This run is no longer in the database (for example after a reset, different environment, or an old saved link). Start a new geo crawl or dismiss the monitor.",
          )
        }
      }
    }, 1500)
    return () => {
      mounted = false
      window.clearInterval(id)
    }
  }, [runId, lastEventId, suspendPolling])

  const header = useMemo(() => {
    if (!run) return null
    return {
      status: run.status,
      state: run.state,
      zip: run.current_zip,
      county: run.current_county,
      source: run.current_source,
      processed: run.processed_zip_count,
      found: run.found_opportunity_count,
      heartbeat: run.last_heartbeat_at,
    }
  }, [run])

  return (
    <Card className="border border-slate-200 bg-white/80 shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">GeoCrawl Monitor</CardTitle>
            <p className="text-xs text-slate-500 mt-1">Live, DB-backed progress (safe to refresh).</p>
          </div>
          {header?.status ? (
            <Badge className={`text-xs capitalize ${statusBadge(header.status)}`}>{String(header.status)}</Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-xs text-slate-600">
            <div>
              <span className="font-semibold">Run:</span> {runId || "—"}
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              <span>
                <span className="font-semibold">State:</span> {header?.state || "—"}
              </span>
              <span>
                <span className="font-semibold">ZIP:</span> {header?.zip || "—"}
              </span>
              <span>
                <span className="font-semibold">County:</span> {header?.county || "—"}
              </span>
              <span>
                <span className="font-semibold">Source:</span> {header?.source || "—"}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <Badge variant="outline" className="text-xs">
              Processed ZIPs: {Number(header?.processed || 0).toLocaleString("en-US")}
            </Badge>
            <Badge variant="outline" className="text-xs">
              New links saved: {Number(header?.found || 0).toLocaleString("en-US")}
            </Badge>
            {runId ? (
              <Button asChild size="sm" variant="secondary" className="h-8">
                <Link to={createPageUrl("FundingOpportunities", { geo_run_id: runId })}>View opportunities</Link>
              </Button>
            ) : null}
          </div>
        </div>

        {error ? (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-2 min-w-0">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
            {suspendPolling ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="shrink-0 border-red-300 text-red-800 hover:bg-red-100"
                onClick={() => {
                  try {
                    window.localStorage.removeItem(LS_LAST_RUN_ID)
                  } catch {
                    // ignore
                  }
                  onStaleRun?.()
                }}
              >
                Dismiss monitor
              </Button>
            ) : null}
          </div>
        ) : null}

        {loading && !run ? (
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : null}

        <div className="rounded-lg border border-slate-200 bg-slate-50">
          <div className="flex items-center justify-between px-3 py-2 border-b border-slate-200">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-600">Event log (tail)</div>
            <div className="text-[11px] text-slate-500">{events.length ? `${events.length} shown` : "No events yet"}</div>
          </div>
          <ScrollArea className="h-[280px]">
            <div className="px-3 py-2 space-y-2 text-xs">
              {events.map((ev) => (
                <div key={ev.id} className="flex items-start gap-2">
                  <span className="shrink-0 text-[10px] text-slate-400 tabular-nums">{String(ev.id).padStart(6, "0")}</span>
                  <span className="shrink-0">
                    <Badge
                      variant="outline"
                      className={`text-[10px] uppercase tracking-wide ${
                        ev.level === "error"
                          ? "border-red-200 text-red-700"
                          : ev.level === "warn"
                            ? "border-amber-200 text-amber-700"
                            : "border-slate-200 text-slate-600"
                      }`}
                    >
                      {ev.level || "info"}
                    </Badge>
                  </span>
                  <div className="min-w-0">
                    <div className="text-slate-800 break-words">
                      {ev.message || "—"}
                      {Number(ev.found_count_delta || 0) > 0 ? (
                        <span className="ml-2 text-emerald-700 font-semibold">{`+${ev.found_count_delta}`}</span>
                      ) : null}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {[ev.state, ev.zip, ev.county, ev.source].filter(Boolean).join(" • ") || "—"}
                    </div>
                  </div>
                </div>
              ))}
              <div ref={tailRef} />
            </div>
          </ScrollArea>
        </div>
      </CardContent>
    </Card>
  )
}

