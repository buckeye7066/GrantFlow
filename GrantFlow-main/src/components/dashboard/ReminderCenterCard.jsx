import React from "react"
import { useMutation } from "@tanstack/react-query"
import { Bell, BellRing, CalendarClock, FileSearch, Sparkles, Loader2 } from "lucide-react"
import { format, formatDistanceToNow } from "date-fns"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { parseDateSafe } from "@/components/shared/dateUtils"
import { cn } from "@/lib/utils"
import { generateReminderPlan } from "@/api/dashboard"

const STATUS_LABELS = {
  discovered: "Discovery",
  interested: "Interested",
  drafting: "Drafting",
  app_prep: "Prep",
  submission_ready: "Ready to Submit",
  submitted: "Submitted",
  awarded: "Awarded",
  rejected: "Closed",
}

function toTitleCase(value) {
  if (!value) return value
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function ReminderItem({
  icon: Icon,
  title,
  description,
  date,
  accent = "bg-blue-100 text-blue-700",
  statusLabel,
  context,
  daysRemaining,
}) {
  const dueParts = []
  if (date) {
    dueParts.push(`Due ${format(date, "PP")}`)
  }

  if (typeof daysRemaining === "number") {
    if (daysRemaining <= 0) {
      dueParts.push("Due today")
    } else if (daysRemaining === 1) {
      dueParts.push("In 1 day")
    } else {
      dueParts.push(`In ${daysRemaining} days`)
    }
  }

  const dueLine = dueParts.join(" • ")

  return (
    <div className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white/80 p-3 shadow-sm">
      <span className={cn("mt-1 flex h-9 w-9 items-center justify-center rounded-full", accent)}>
        <Icon className="h-4 w-4" />
      </span>
      <div className="flex-1 space-y-1">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-semibold text-slate-800">{title}</p>
          {statusLabel ? (
            <Badge variant="outline" className="text-xs">
              {statusLabel}
            </Badge>
          ) : null}
        </div>
        {description ? <p className="text-xs text-slate-500">{description}</p> : null}
        {context ? <p className="text-xs text-slate-400">{context}</p> : null}
        {dueLine ? <p className="text-xs font-medium text-blue-600">{dueLine}</p> : null}
      </div>
    </div>
  )
}

function ReminderSkeleton() {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white/60 p-3">
      <Skeleton className="h-9 w-9 rounded-full" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-3 w-1/3" />
        <Skeleton className="h-3 w-2/3" />
        <Skeleton className="h-3 w-1/4" />
      </div>
    </div>
  )
}

export default function ReminderCenterCard({
  urgentDeadlines = [],
  upcomingMilestones = [],
  isLoading = false,
  hasError = false,
}) {
  const planMutation = useMutation({
    mutationFn: generateReminderPlan,
  })

  const planData = planMutation.data?.plan
  const planGeneratedAt = planMutation.data?.generatedAt

  const handleGeneratePlan = () => {
    if (planMutation.isPending) return

    planMutation.mutate({
      urgentDeadlines: urgentDeadlines.slice(0, 6),
      upcomingMilestones: upcomingMilestones.slice(0, 6),
    })
  }

  const planGeneratedLabel =
    planGeneratedAt != null
      ? `Generated ${formatDistanceToNow(new Date(planGeneratedAt), { addSuffix: true })}`
      : null

  const enrichDeadline = (deadline) => {
    const parsed = parseDateSafe(deadline.deadline)
    const label = STATUS_LABELS[deadline.status] ?? toTitleCase(deadline.status)
    const contextParts = [deadline.organizationName, deadline.funder].filter(Boolean)

    return {
      id: `deadline-${deadline.id}`,
      title: deadline.title ?? deadline.name ?? "Grant deadline",
      description: deadline.funder ?? undefined,
      context: contextParts.length > 0 ? contextParts.join(" • ") : undefined,
      date: parsed,
      daysRemaining: deadline.daysRemaining ?? null,
      statusLabel: label,
      icon: BellRing,
      accent: "bg-amber-100 text-amber-700",
    }
  }

  const enrichMilestone = (milestone) => {
    const parsed = parseDateSafe(milestone.dueDate ?? milestone.due_date)
    const contextParts = [milestone.organizationName, milestone.grantTitle].filter(Boolean)

    return {
      id: `milestone-${milestone.id}`,
      title: milestone.title ?? "Milestone",
      description: milestone.description ?? undefined,
      context: contextParts.length > 0 ? contextParts.join(" • ") : undefined,
      date: parsed,
      daysRemaining: milestone.daysRemaining ?? null,
      statusLabel: milestone.type ? toTitleCase(milestone.type) : undefined,
      icon: CalendarClock,
      accent: "bg-emerald-100 text-emerald-700",
    }
  }

  const reminders = [
    ...urgentDeadlines.map(enrichDeadline),
    ...upcomingMilestones.map(enrichMilestone),
  ].slice(0, 5)

  return (
    <Card className="border-none shadow-none bg-gradient-to-br from-white/90 via-blue-50/70 to-white/60 backdrop-blur">
      <CardHeader className="pb-3 space-y-2">
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2 text-slate-900">
              <Bell className="h-4 w-4 text-blue-600" />
              Reminders & Nudges
            </CardTitle>
            <p className="text-xs text-slate-500 mt-1">
              Keep teams aligned on deadlines, compliance, and document readiness.
            </p>
            {hasError ? (
              <p className="text-xs text-amber-600 mt-2">
                Unable to sync latest reminders. Showing locally cached view.
              </p>
            ) : null}
          </div>
          <Button
            size="sm"
            variant="outline"
            className="gap-2"
            onClick={handleGeneratePlan}
            disabled={planMutation.isPending || (isLoading && !planData)}
          >
            {planMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Working…
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4" />
                Generate plan
              </>
            )}
          </Button>
        </div>
        {planGeneratedLabel ? (
          <p className="text-xs text-slate-400">{planGeneratedLabel}</p>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3">
        {planMutation.isError ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50/80 p-3 text-xs text-rose-700">
            {planMutation.error?.message ?? "Unable to generate an AI plan right now."}
          </div>
        ) : null}

        {isLoading ? (
          <>
            <ReminderSkeleton />
            <ReminderSkeleton />
            <ReminderSkeleton />
          </>
        ) : reminders.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 p-6 text-center">
            <FileSearch className="h-10 w-10 mx-auto text-slate-300 mb-3" />
            <p className="text-sm font-medium text-slate-700">No reminders yet</p>
            <p className="text-xs text-slate-500 mt-1">
              Assign milestones or track grants to see intelligent reminders here.
            </p>
            <Button size="sm" className="mt-4">
              Add a milestone
            </Button>
          </div>
        ) : (
          reminders.map((reminder) => <ReminderItem key={reminder.id} {...reminder} />)
        )}

        {planData ? (
          <div className="rounded-xl border border-blue-200 bg-blue-50/60 p-4 space-y-3">
            <p className="text-sm font-semibold text-blue-900">AI Action Plan</p>
            {planData.summary ? (
              <p className="text-sm text-slate-700 leading-relaxed">{planData.summary}</p>
            ) : null}

            {Array.isArray(planData.priority_actions) && planData.priority_actions.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-blue-900">
                  Priority Actions
                </p>
                <ul className="space-y-2">
                  {planData.priority_actions.map((action, index) => (
                    <li
                      key={`${action.title ?? "action"}-${index}`}
                      className="rounded-lg border border-white/60 bg-white/80 p-3 shadow-sm"
                    >
                      <p className="text-sm font-semibold text-slate-800">{action.title}</p>
                      {action.due ? (
                        <p className="text-xs text-blue-600 mt-1">Due {action.due}</p>
                      ) : null}
                      {action.type ? (
                        <p className="text-xs text-slate-400 mt-1">Type: {action.type}</p>
                      ) : null}
                      {action.notes ? (
                        <p className="text-xs text-slate-600 mt-2 leading-relaxed">{action.notes}</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {Array.isArray(planData.collaboration) && planData.collaboration.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-blue-900">
                  Collaboration
                </p>
                <ul className="space-y-2">
                  {planData.collaboration.map((item, index) => (
                    <li
                      key={`${item.title ?? "collab"}-${index}`}
                      className="rounded-lg border border-white/60 bg-white/70 p-3"
                    >
                      <p className="text-sm font-semibold text-slate-800">{item.title}</p>
                      {item.owner ? (
                        <p className="text-xs text-slate-500 mt-1">Owner: {item.owner}</p>
                      ) : null}
                      {item.notes ? (
                        <p className="text-xs text-slate-600 mt-2 leading-relaxed">{item.notes}</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {Array.isArray(planData.follow_up) && planData.follow_up.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-blue-900">
                  Follow Up
                </p>
                <ul className="space-y-2">
                  {planData.follow_up.map((item, index) => (
                    <li
                      key={`${item.title ?? "followup"}-${index}`}
                      className="rounded-lg border border-white/60 bg-white/60 p-3"
                    >
                      <p className="text-sm font-semibold text-slate-800">{item.title}</p>
                      {item.notes ? (
                        <p className="text-xs text-slate-600 mt-1 leading-relaxed">{item.notes}</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {Array.isArray(planData.ai_recommendations) && planData.ai_recommendations.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-blue-900">
                  AI Recommendations
                </p>
                <ul className="space-y-2 text-xs text-slate-600 leading-relaxed">
                  {planData.ai_recommendations.map((tip, index) => (
                    <li key={`tip-${index}`} className="rounded-md border border-white/50 bg-white/60 p-2">
                      {tip}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
