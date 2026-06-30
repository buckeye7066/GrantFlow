import React from "react"
import { ArrowRight, ClipboardList, CheckCircle2, Clock, Target, AlertTriangle } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { createPageUrl } from "@/utils"
import { Link } from "react-router-dom"

const statusOrder = [
  { key: "discovered", label: "Discovery", icon: Target, color: "bg-blue-500/15 text-blue-700 dark:bg-blue-500/20 dark:text-blue-200" },
  { key: "interested", label: "Interested", icon: ClipboardList, color: "bg-indigo-500/15 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-200" },
  { key: "drafting", label: "Drafting", icon: Clock, color: "bg-amber-500/15 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200" },
  { key: "app_prep", label: "Prep", icon: ClipboardList, color: "bg-sky-500/15 text-sky-800 dark:bg-sky-500/20 dark:text-sky-200" },
  { key: "submission_ready", label: "Ready to Submit", icon: ArrowRight, color: "bg-emerald-500/15 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200" },
  { key: "submitted", label: "Submitted", icon: CheckCircle2, color: "bg-green-500/15 text-green-800 dark:bg-green-500/20 dark:text-green-200" },
  { key: "awarded", label: "Awarded", icon: CheckCircle2, color: "bg-lime-500/15 text-lime-800 dark:bg-lime-500/20 dark:text-lime-200" },
  { key: "rejected", label: "Closed", icon: AlertTriangle, color: "bg-rose-500/15 text-rose-800 dark:bg-rose-500/20 dark:text-rose-200" },
]

function resolveCount(stats, key) {
  if (!stats) return 0
  const value = stats[key]
  if (value === undefined || value === null) return 0
  return value
}

export default function PipelineStatusCard({ stats = {}, isLoading, hasError = false }) {
  const total = statusOrder.reduce((sum, status) => sum + resolveCount(stats, status.key), 0)

  return (
    <Card className="h-full bg-card/80 text-card-foreground backdrop-blur-lg border border-border/70 shadow-none">
      <CardHeader className="pb-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-card-foreground text-lg font-semibold">Pipeline Focus</CardTitle>
            <p className="mt-1 text-sm text-foreground">
              {hasError
                ? "Unable to sync pipeline metrics. Showing default workflow guidance."
                : isLoading
                  ? "Syncing latest data…"
                  : `Tracking ${total} pipeline grants across stages.`}
            </p>
          </div>
          <Link to={createPageUrl("Pipeline")}>
            <Button size="sm" variant="secondary" className="gap-2">
              Open Pipeline
              <ArrowRight className="ml-1 h-3 w-3" />
            </Button>
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-2 gap-3">
          {statusOrder.map((status) => {
            const count = resolveCount(stats, status.key)
            return (
              <div
                key={status.key}
                className="flex items-center gap-3 rounded-xl border border-border bg-background/60 p-3 shadow-sm"
              >
                <span className={`flex h-10 w-10 items-center justify-center rounded-full text-sm font-semibold ${status.color}`}>
                  <status.icon className="h-5 w-5" />
                </span>
                <div className="flex flex-col">
                  <span className="text-xs uppercase tracking-wide text-foreground">{status.label}</span>
                  <span className="text-lg font-semibold text-card-foreground">
                    {isLoading ? "…" : count}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
        <div className="rounded-xl border border-dashed border-border p-4 bg-muted/30">
          <h3 className="text-sm font-semibold text-card-foreground mb-2">Next recommended actions</h3>
          <ul className="space-y-2 text-sm text-foreground">
            <li>• Review drafts due this week and assign final reviewers.</li>
            <li>• Nudge partners on outstanding documents for compliance checks.</li>
            <li>• Identify upcoming submissions to prep budgets and attachments.</li>
          </ul>
          <div className="mt-4 flex gap-3">
            <Button asChild size="sm">
              <Link to={createPageUrl("Pipeline")}>
                Manage Workflow
              </Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link to={createPageUrl("GrantDeadline")}>Schedule deadlines</Link>
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
