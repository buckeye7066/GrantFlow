import React from "react"
import { Link } from "react-router-dom"
import {
  ArrowRight,
  FileSearch,
  Kanban,
  Search,
  Sparkles,
  UserCheck,
} from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { createPageUrl } from "@/utils"

function profileRoute(activeProfileId, tab = null) {
  if (!activeProfileId) return createPageUrl("MyProfiles")
  return createPageUrl("ProfileDetail", {
    id: activeProfileId,
    ...(tab ? { tab } : {}),
  })
}

function profileScopedRoute(page, activeProfileId, params = {}) {
  if (!activeProfileId) return createPageUrl("MyProfiles")
  return createPageUrl(page, {
    profile_id: activeProfileId,
    ...params,
  })
}

function WorkflowButton({ icon: Icon, title, detail, to, tooltip, primary = false }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          asChild
          variant={primary ? "default" : "outline"}
          className={`h-auto w-full justify-start gap-3 whitespace-normal rounded-lg px-4 py-3 text-left ${
            primary
              ? "shadow-md shadow-blue-200"
              : "border-slate-200 bg-white text-slate-900 hover:border-blue-200 hover:bg-blue-50 hover:text-slate-950"
          }`}
        >
          <Link to={to}>
            <span
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md ${
                primary ? "bg-white text-primary" : "bg-slate-100 text-slate-700"
              }`}
            >
              <Icon className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold leading-tight">{title}</span>
              <span className={`mt-1 block text-xs leading-relaxed ${primary ? "text-primary-foreground" : "text-slate-600"}`}>
                {detail}
              </span>
            </span>
            <ArrowRight className="h-4 w-4 shrink-0" />
          </Link>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-xs leading-relaxed">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

export default function PipelineActionsCard({ activeProfileId = null, isSimplified = false }) {
  const hasProfile = Boolean(activeProfileId)
  const actions = isSimplified
    ? [
        {
          key: 'pipeline',
          title: 'Open pipeline',
          detail: hasProfile ? 'Choose one accepted source to work next.' : 'See when your first accepted source is ready.',
          tooltip: 'Open the profile-scoped funding pipeline.',
          icon: Kanban,
          to: createPageUrl('Pipeline'),
          primary: true,
        },
        {
          key: 'help',
          title: 'Ask Anya',
          detail: 'Get a plain-language next step.',
          tooltip: 'Open the Help Center and ask Anya about your profile or funding workflow.',
          icon: Sparkles,
          to: createPageUrl('Help'),
        },
      ]
    : hasProfile
    ? [
        {
          key: "facts",
          title: "Profile facts",
          detail: "Review what GrantFlow knows.",
          tooltip: "Open the selected profile. These facts feed matching, Anya, Hamilton, documents, and crawler searches.",
          icon: UserCheck,
          to: profileRoute(activeProfileId),
          primary: true,
        },
        {
          key: "documents",
          title: "Documents",
          detail: "Upload evidence and forms.",
          tooltip: "Open the document workspace for this profile so PDFs, screenshots, letters, and forms can be parsed and used.",
          icon: FileSearch,
          to: profileRoute(activeProfileId, "documents"),
        },
        {
          key: "anya",
          title: "Anya plan",
          detail: "Turn needs into a checklist.",
          tooltip: "Open the profile action plan. Anya can ask profile-specific questions and Hamilton can help with checklist items.",
          icon: Sparkles,
          to: profileRoute(activeProfileId, "action-plan"),
        },
        {
          key: "discover",
          title: "Find funding",
          detail: "Run a profile-specific search.",
          tooltip: "Open discovery with this profile selected. GrantFlow searches by profile facts, needs, location, and eligibility.",
          icon: Search,
          to: profileScopedRoute("DiscoverGrants", activeProfileId, { autorun: 1 }),
        },
        {
          key: "pipeline",
          title: "Pipeline",
          detail: "Track applications and portals.",
          tooltip: "Open the real pipeline board for this profile, including portal setup and automation status.",
          icon: Kanban,
          to: profileScopedRoute("Pipeline", activeProfileId),
        },
      ]
    : [
        {
          key: "profile",
          title: "Create or choose a profile",
          detail: "Funding starts with who we are helping.",
          tooltip: "GrantFlow needs a profile before it can search, plan, parse documents, or track applications correctly.",
          icon: UserCheck,
          to: createPageUrl("MyProfiles"),
          primary: true,
        },
      ]

  return (
    <Card className="border border-border/70 bg-card text-card-foreground shadow-none">
      <CardHeader>
        <div className="space-y-1">
          <div className="inline-flex w-fit items-center rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-semibold uppercase text-blue-800 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-200">
            <Sparkles className="mr-1 h-3 w-3" />
            Guided workflow
          </div>
          <CardTitle className="text-lg">{isSimplified ? 'Choose your next step' : 'Work in the right order'}</CardTitle>
          <CardDescription>
            {isSimplified
              ? 'These buttons open your funding workflow. They do not submit anything.'
              : 'These shortcuts open real GrantFlow workspaces. They do not start hidden background work.'}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <TooltipProvider delayDuration={150}>
          <div className={`grid gap-3 md:grid-cols-2 ${isSimplified ? '' : 'xl:grid-cols-5'}`}>
            {actions.map((action) => (
              <WorkflowButton key={action.key} {...action} />
            ))}
          </div>
        </TooltipProvider>
      </CardContent>
    </Card>
  )
}
