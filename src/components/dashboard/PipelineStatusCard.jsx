import React from "react"
import { ArrowRight, ClipboardList, CheckCircle2, Clock, Target, AlertTriangle } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { createPageUrl } from "@/utils"
import { Link } from "react-router-dom"

const statusOrder = [
  { key: "discovered", label: "Discovery", icon: Target, color: "bg-blue-100 text-blue-700" },
  { key: "interested", label: "Interested", icon: ClipboardList, color: "bg-indigo-100 text-indigo-700" },
  { key: "drafting", label: "Drafting", icon: Clock, color: "bg-amber-100 text-amber-700" },
  { key: "app_prep", label: "Prep", icon: ClipboardList, color: "bg-sky-100 text-sky-700" },
  { key: "submission_ready", label: "Ready to Submit", icon: ArrowRight, color: "bg-emerald-100 text-emerald-700" },
  { key: "submitted", label: "Submitted", icon: CheckCircle2, color: "bg-green-100 text-green-700" },
  { key: "awarded", label: "Awarded", icon: CheckCircle2, color: "bg-lime-100 text-lime-700" },
  { key: "rejected", label: "Closed", icon: AlertTriangle, color: "bg-rose-100 text-rose-700" },
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
    <Card className="h-full border-none shadow-none bg-gradient-to-br from-white/90 to-white/40 backdrop-blur-lg">
      <CardHeader className="pb-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-foreground text-lg font-semibold">Pipeline Focus</CardTitle>
            <p className="mt-1 text-sm text-foreground">
              {hasError
                ? "Unable to sync pipeline metrics. Showing default workflow guidance."
                : isLoading
                  ? "Syncing latest data…"
                  : `Tracking ${total} active opportunities across stages.`}
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
                className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white/70 p-3 shadow-sm"
              >
                <span className={`flex h-10 w-10 items-center justify-center rounded-full text-sm font-semibold ${status.color}`}>
                  <status.icon className="h-5 w-5" />
                </span>
                <div className="flex flex-col">
                  <span className="text-xs uppercase tracking-wide text-foreground">{status.label}</span>
                  <span className="text-lg font-semibold text-foreground">
                    {isLoading ? "…" : count}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
        <div className="rounded-xl border border-dashed border-slate-300 p-4 bg-slate-50/70">
          <h3 className="text-sm font-semibold text-foreground mb-2">Next recommended actions</h3>
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
