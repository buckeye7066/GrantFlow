import React from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { formatDistanceToNow } from "date-fns"
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { Loader2, Sparkles, RefreshCw, AlertTriangle, CheckCircle2, Clock, History, ListChecks, ChevronDown, ChevronRight } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { getAutomationSummary, runPipelineAutomation } from "@/api/grants"
import GrantAutomationTimeline from "@/components/pipeline/GrantAutomationTimeline"

function StatusBadge({ status }) {
  if (!status) return null
  const colors = {
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
  const variant = colors[status] ?? "bg-slate-100 text-slate-700"
  return (
    <Badge className={`text-xs capitalize ${variant}`}>
      {status.replace(/_/g, " ")}
    </Badge>
  )
}

export default function PipelineAutomationPanel({
  organizationId,
  profileId,
  disabled = false,
  disabledReason = null,
}) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const [selectedGrant, setSelectedGrant] = React.useState(null)
  const [expandedGrants, setExpandedGrants] = React.useState(new Set())

  const {
    data: summary = [],
    isLoading,
    isFetching,
    error,
  } = useQuery({
    queryKey: ["automation-summary", organizationId],
    queryFn: () => getAutomationSummary(organizationId),
    enabled: Boolean(organizationId),
    staleTime: 30_000,
  })

  const runAllMutation = useMutation({
    mutationFn: () =>
      runPipelineAutomation({
        profileId: profileId ?? undefined,
        organizationId,
      }),
    onSuccess: (job) => {
      toast({
        title: "Pipeline automation queued",
        description: job?.id
          ? `Job ${job.id.slice(0, 8)}… will advance grants and surface handoffs.`
          : "Pipeline automation will run shortly.",
      })
      queryClient.invalidateQueries({ queryKey: ["automation-summary", organizationId] })
      queryClient.invalidateQueries({ queryKey: ["crawler-jobs"] })
      queryClient.invalidateQueries({ queryKey: ["crawler-metrics"] })
    },
    onError: (mutationError) => {
      toast({
        variant: "destructive",
        title: "Unable to queue pipeline automation",
        description:
          mutationError instanceof Error ? mutationError.message : "Try again in a few moments.",
      })
    },
  })

  const runGrantMutation = useMutation({
    mutationFn: (grantId) =>
      runPipelineAutomation({
        grantId,
        profileId: profileId ?? undefined,
        organizationId,
      }),
    onSuccess: (job, grantId) => {
      toast({
        title: "Automation queued",
        description: job?.id
          ? `Grant ${grantId.slice(0, 8)}… will advance once AI finishes.`
          : "AI will review this grant shortly.",
      })
      queryClient.invalidateQueries({ queryKey: ["automation-summary", organizationId] })
      queryClient.invalidateQueries({ queryKey: ["crawler-jobs"] })
      queryClient.invalidateQueries({ queryKey: ["crawler-metrics"] })
    },
    onError: (mutationError) => {
      toast({
        variant: "destructive",
        title: "Automation failed to queue",
        description:
          mutationError instanceof Error ? mutationError.message : "Please retry in a moment.",
      })
    },
  })

  const toggleExpanded = React.useCallback((grantId) => {
    setExpandedGrants((prev) => {
      const next = new Set(prev)
      if (next.has(grantId)) next.delete(grantId)
      else next.add(grantId)
      return next
    })
  }, [])

  if (!organizationId) {
    return null
  }

  return (
    <>
      <Card className="border-blue-200 bg-gradient-to-br from-slate-50 to-blue-50">
      <CardHeader className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="w-4 h-4 text-blue-600" />
            AI Pipeline Automation
          </CardTitle>
          <CardDescription>
            GrantFlow advances grants automatically, and flags handoffs when a human needs to take
            over.
          </CardDescription>
        </div>
        {disabled ? (
          <Button
            disabled
            className="bg-slate-400 hover:bg-slate-400 cursor-not-allowed"
            title={disabledReason || "This feature is not available on your current tier."}
          >
            Upgrade required
          </Button>
        ) : (
        <Button
          onClick={() => runAllMutation.mutate()}
          disabled={runAllMutation.isPending || !summary || summary.length === 0}
          className="bg-blue-600 hover:bg-blue-700"
        >
          {runAllMutation.isPending ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Queuing…
            </>
          ) : (
            <>
              <RefreshCw className="w-4 h-4 mr-2" />
              Run for All Grants
            </>
          )}
        </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {disabled ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            {disabledReason || "Your billing tier does not include pipeline automation."}
          </div>
        ) : null}
        {error ? (
          <div className="p-4 border border-red-200 bg-red-50 rounded-md text-sm text-red-700">
            Unable to load automation status. {error.message}
          </div>
        ) : null}

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading automation summary…
          </div>
        ) : null}

        {!isLoading && summary.length === 0 ? (
          <div className="p-4 border border-dashed border-slate-300 rounded-md bg-white text-sm text-slate-600">
            No grants are currently tracked in this pipeline. Add a grant to enable automation.
          </div>
        ) : null}

        <div className="space-y-3">
          {summary.map((entry) => {
            const automation = entry.automation
            const isQueuedGrant = runGrantMutation.variables === entry.id && runGrantMutation.isPending

            return (
              <div
                key={entry.id}
                className="bg-white border border-slate-200 rounded-lg p-3 shadow-sm"
              >
                <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h4 className="font-semibold text-slate-900 text-sm">{entry.title}</h4>
                      <StatusBadge status={entry.status} />
                      {automation?.status && (
                        <StatusBadge status={automation.status} />
                      )}
                      {automation?.handoff_required ? (
                        <Badge variant="destructive" className="text-[10px] uppercase tracking-wide">
                          Handoff Needed
                        </Badge>
                      ) : null}
                      {isFetching && <Clock className="w-3 h-3 text-slate-400" />}
                    </div>
                    {automation?.summary ? (
                      <p className="text-xs text-slate-600 leading-snug">{automation.summary}</p>
                    ) : (
                      <p className="text-xs text-slate-500 italic">
                        AI has not reviewed this grant yet.
                      </p>
                    )}
                    <div className="flex items-center gap-2 text-[11px] text-slate-500 uppercase tracking-wide">
                      {automation?.processed_at ? (
                        <span>
                          Updated {formatDistanceToNow(new Date(automation.processed_at), { addSuffix: true })}
                        </span>
                      ) : null}
                      {automation?.handoff_required && automation.handoff_reason ? (
                        <>
                          <Separator orientation="vertical" className="h-3" />
                          <span className="flex items-center gap-1 text-red-600 font-medium normal-case">
                            <AlertTriangle className="w-3 h-3" />
                            {automation.handoff_reason}
                          </span>
                        </>
                      ) : null}

                      {/* Step-by-step application instructions */}
                      {automation?.handoff_required && automation?.recommended_actions ? (() => {
                        const data = automation.recommended_actions
                        const actions = Array.isArray(data) ? data : (Array.isArray(data?.actions) ? data.actions : [])
                        const appSteps = typeof data?.application_steps === 'string' ? data.application_steps : null
                        const isExpanded = expandedGrants.has(entry.id)

                        if (!actions.length && !appSteps) return null

                        return (
                          <div className="mt-2 space-y-2">
                            <button
                              type="button"
                              className="flex items-center gap-1.5 text-[11px] font-semibold text-blue-700 uppercase tracking-wide hover:text-blue-900 transition"
                              onClick={() => toggleExpanded(entry.id)}
                            >
                              {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                              <ListChecks className="w-3 h-3" />
                              How to complete this application
                            </button>
                            {isExpanded && (
                              <div className="rounded-md border border-blue-200 bg-blue-50/50 p-3 space-y-3">
                                {appSteps ? (
                                  <div className="text-xs text-slate-700 leading-relaxed whitespace-pre-wrap">{appSteps}</div>
                                ) : null}
                                {actions.length > 0 ? (
                                  <div className="space-y-1.5">
                                    {!appSteps && <div className="text-[11px] font-semibold text-slate-600">Next steps:</div>}
                                    {actions.map((action, idx) => (
                                      <div key={idx} className="flex items-start gap-2 text-xs text-slate-700">
                                        <span className="shrink-0 flex items-center justify-center w-5 h-5 rounded-full bg-blue-100 text-blue-700 text-[10px] font-bold">
                                          {action.step || idx + 1}
                                        </span>
                                        <div className="flex-1">
                                          <span>{action.description}</span>
                                          {action.owner && action.owner !== 'ai' ? (
                                            <Badge variant="outline" className="ml-2 text-[9px] uppercase">{action.owner}</Badge>
                                          ) : null}
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                ) : null}
                              </div>
                            )}
                          </div>
                        )
                      })() : null}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {automation?.handoff_required ? (
                      <Badge variant="outline" className="text-xs bg-amber-50 text-amber-700 border-amber-200">
                        <AlertTriangle className="w-3 h-3 mr-1" />
                        Action needed
                      </Badge>
                    ) : automation ? (
                      <Badge variant="secondary" className="text-xs bg-emerald-50 text-emerald-700 border-emerald-200">
                        <CheckCircle2 className="w-3 h-3 mr-1" />
                        On Track
                      </Badge>
                    ) : null}
          <Button
            variant="ghost"
            size="sm"
            className="text-xs"
            onClick={() => setSelectedGrant(entry)}
          >
            <History className="w-3 h-3 mr-1" />
            View history
          </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => runGrantMutation.mutate(entry.id)}
                      disabled={disabled || isQueuedGrant}
                    >
                      {isQueuedGrant ? (
                        <>
                          <Loader2 className="w-3 h-3 mr-2 animate-spin" />
                          Queuing
                        </>
                      ) : (
                        <>
                          <Sparkles className="w-3 h-3 mr-2" />
                          Run AI
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </CardContent>
      </Card>

      <Sheet open={Boolean(selectedGrant)} onOpenChange={(open) => !open && setSelectedGrant(null)}>
        <SheetContent side="right" className="w-full sm:max-w-xl overflow-hidden">
          <SheetHeader className="pb-2">
            <SheetTitle className="text-base">
              {selectedGrant?.title ?? "Automation history"}
            </SheetTitle>
            <SheetDescription>
              Review every AI-driven status change, confidence score, and required handoff for this grant.
            </SheetDescription>
          </SheetHeader>
          <div className="flex h-full flex-col gap-4">
            <GrantAutomationTimeline grantId={selectedGrant?.id} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
