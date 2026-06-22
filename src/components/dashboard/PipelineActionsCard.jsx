import React, { useState } from "react"
import { useNavigate } from "react-router-dom"
import {
  Play,
  PlayCircle,
  RefreshCcw,
  ShieldCheck,
  Sparkles,
  CircleCheck,
  Loader2,
} from "lucide-react"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useToast } from "@/components/ui/use-toast"
import { createPageUrl } from "@/utils"

const ACTIONS = [
  {
    key: "process_next",
    label: "Process next grant",
    description: "Review the highest-priority opportunity in your pipeline.",
    icon: PlayCircle,
  },
  {
    key: "process_all",
    label: "Process all queued",
    description: "Run matching, checklist generation, and AI prep for all pending grants.",
    icon: RefreshCcw,
  },
  {
    key: "auto_monitor",
    label: "Enable auto-monitoring",
    description: "Continuously monitor deadlines, portal updates, and compliance tasks.",
    icon: ShieldCheck,
  },
]

export default function PipelineActionsCard() {
  const { toast } = useToast()
  const [pendingAction, setPendingAction] = useState(null)
  const navigate = useNavigate()

  const handleAction = async (actionKey) => {
    setPendingAction(actionKey)

    toast({
      title: "Command queued",
      description: "We’re preparing the workflow run. This will take just a moment.",
    })

    // Placeholder async flow – replace with real API or workflow trigger
    await new Promise((resolve) => setTimeout(resolve, 1200))

    setPendingAction(null)
    toast({
      title: "Workflow dispatched",
      description: "A background job has been kicked off. Monitor progress from the Pipeline page.",
      action: {
        label: "View pipeline",
        onClick: () => {
          navigate(createPageUrl("Pipeline"))
        },
      },
    })
  }

  return (
    <Card className="border border-border/70 shadow-none bg-card text-card-foreground">
      <CardHeader className="pb-0">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="inline-flex items-center rounded-full border border-primary/20 bg-primary/10 text-primary px-3 py-1 text-xs font-semibold uppercase">
              <Sparkles className="w-3 h-3 mr-1" />
              AI Orchestrations
            </div>
            <h2 className="text-lg font-semibold text-card-foreground">Pipeline Command Center</h2>
            <p className="text-sm text-foreground max-w-md">
              Kick off automations that run behind the scenes. These flows coordinate AI
              matching, checklist generation, reminders, and deadline monitoring.
            </p>
          </div>
          <CircleCheck className="w-8 h-8 text-primary hidden md:block" />
        </div>
      </CardHeader>
      <CardContent className="pt-4 space-y-3">
        {ACTIONS.map((action) => (
          <div
            key={action.key}
            className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 rounded-xl border border-border bg-background/60 px-4 py-3"
          >
            <div className="flex items-start gap-3">
              <span className="p-2 rounded-lg bg-primary/15 text-primary">
                <action.icon className="w-4 h-4" />
              </span>
              <div>
                  <p className="text-sm font-semibold text-card-foreground">{action.label}</p>
                  <p className="text-xs text-foreground">{action.description}</p>
              </div>
            </div>
            <Button
              size="sm"
              className="whitespace-nowrap"
              onClick={() => handleAction(action.key)}
              disabled={pendingAction !== null}
            >
              {pendingAction === action.key ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
                  Working…
                </>
              ) : pendingAction ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
                  Queued
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5 mr-2" />
                  Run
                </>
              )}
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
