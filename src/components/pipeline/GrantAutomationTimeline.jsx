import React from "react"
import { useQuery } from "@tanstack/react-query"
import { format, formatDistanceToNow } from "date-fns"
import { getGrantAutomationEvents } from "@/api/grants"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Loader2, RefreshCw, Sparkles, AlertTriangle, ArrowRight, CheckCircle2 } from "lucide-react"

const STATUS_COLORS = {
  discovered: "bg-slate-100 text-slate-700",
  interested: "bg-blue-100 text-blue-700",
  drafting: "bg-purple-100 text-purple-700",
  app_prep: "bg-amber-100 text-amber-800",
  revision: "bg-orange-100 text-orange-700",
  submitted: "bg-emerald-100 text-emerald-700",
  under_review: "bg-indigo-100 text-indigo-700",
  awarded: "bg-green-200 text-green-800",
  rejected: "bg-red-100 text-red-700",
  closed: "bg-slate-200 text-slate-700",
  archived: "bg-slate-200 text-slate-700",
}

function StatusBadge({ status, label }) {
  if (!status) return null
  const variant = STATUS_COLORS[status] ?? "bg-slate-100 text-slate-700"
  return (
    <Badge className={`text-[10px] uppercase tracking-wide ${variant}`}>
      {label ?? status.replace(/_/g, " ")}
    </Badge>
  )
}

export default function GrantAutomationTimeline({ grantId }) {
  const {
    data: events = [],
    isLoading,
    error,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ["automation-events", grantId],
    queryFn: () => getGrantAutomationEvents(grantId, { limit: 50 }),
    enabled: Boolean(grantId),
  })

  if (!grantId) {
    return (
      <div className="text-sm text-slate-500">
        Select a grant to review its automation history.
      </div>
    )
  }

  const latest = events[0]

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-900">Automation history</p>
          {latest?.created_at ? (
            <p className="text-xs text-slate-500">
              Last updated{" "}
              {formatDistanceToNow(new Date(latest.created_at), {
                addSuffix: true,
              })}
            </p>
          ) : (
            <p className="text-xs text-slate-500">No AI activity recorded yet.</p>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          disabled={isFetching}
          className="gap-1"
        >
          {isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Refresh
        </Button>
      </div>

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white">
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
            Loading automation events…
          </div>
        </div>
      ) : error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          Unable to load automation history. {error.message}
        </div>
      ) : events.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600">
          AI has not touched this grant yet. Run automation to populate the timeline.
        </div>
      ) : (
        <ScrollArea className="h-[60vh] pr-4">
          <div className="space-y-4">
            {events.map((event, index) => {
              const createdAt = event.created_at ? new Date(event.created_at) : null
              const confidencePct =
                typeof event.confidence === "number"
  ? Number.isInteger(event.confidence) && event.confidence > 1
    ? Math.round(event.confidence)          // already a 0-100 integer
    : Math.round(event.confidence * 100)    // 0-1 float (including 1.0) → percentage
  : null
              const actions = Array.isArray(event.recommended_actions) ? event.recommended_actions : []
              const showDivider = index !== events.length - 1

              return (
                <div key={event.id ?? `${event.created_at}-${index}`} className="relative pl-4">
                  {showDivider && (
                    <span className="absolute left-1 top-2 h-full w-px bg-slate-200" aria-hidden="true" />
                  )}
                  <div className="flex items-center gap-2 text-xs text-slate-500">
                    <Sparkles className="h-3.5 w-3.5 text-blue-600" />
                    {createdAt ? (
                      <>
                        <span className="font-medium text-slate-700">
                          {format(createdAt, "MMM d, yyyy • h:mm a")}
                        </span>
                        <span>({formatDistanceToNow(createdAt, { addSuffix: true })})</span>
                      </>
                    ) : (
                      <span className="font-medium text-slate-700">AI automation</span>
                    )}
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <StatusBadge status={event.previous_status} label={`Prev • ${event.previous_status ?? "—"}`} />
                    {(event.previous_status || event.applied_status) && (
                      <ArrowRight className="h-3 w-3 text-slate-400" />
                    )}
                    <StatusBadge status={event.applied_status} label={`Now • ${event.applied_status ?? "—"}`} />
                    {event.suggested_status &&
                      event.suggested_status !== event.applied_status ? (
                      <StatusBadge status={event.suggested_status} label={`Suggested ${event.suggested_status}`} />
                    ) : null}
                    {confidencePct !== null ? (
                      <Badge variant="outline" className="text-[10px] font-medium uppercase tracking-wide">
                        Confidence {confidencePct}%
                      </Badge>
                    ) : null}
                    {event.handoff_required ? (
                      <Badge variant="destructive" className="text-[10px] uppercase tracking-wide">
                        <AlertTriangle className="mr-1 h-3 w-3" />
                        Handoff
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="text-[10px] uppercase tracking-wide">
                        <CheckCircle2 className="mr-1 h-3 w-3" />
                        Auto-advanced
                      </Badge>
                    )}
                  </div>

                  {event.ai_summary ? (
                    <p className="mt-2 text-sm leading-relaxed text-slate-700">{event.ai_summary}</p>
                  ) : null}

                  {event.handoff_required && event.handoff_reason ? (
                    <div className="mt-2 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                      <AlertTriangle className="h-4 w-4 shrink-0" />
                      <span>{event.handoff_reason}</span>
                    </div>
                  ) : null}

                  {actions.length > 0 ? (
                    <div className="mt-3 space-y-1 rounded-md border border-slate-200 bg-slate-50 p-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Recommended actions
                      </p>
                      <ul className="space-y-1.5">
                        {actions.map((action, idx) => (
                          <li key={idx} className="text-sm text-slate-600">
                            <span className="font-medium text-slate-700">{action.owner ?? "team"}:</span>{" "}
                            {action.description}
                            {typeof action.due_in_days === "number" ? (
                              <span className="text-xs text-slate-500"> (due in {action.due_in_days} days)</span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {showDivider ? <Separator className="mt-4" /> : null}
                </div>
              )
            })}
          </div>
        </ScrollArea>
      )}
    </div>
  )
}
