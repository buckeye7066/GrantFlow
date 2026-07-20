import React, { useRef, useEffect } from "react"
import { useSearchParams, useNavigate } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { syncTargetCollegesToApplications } from "@/utils/targetCollegesSync"
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Calendar,
  Check,
  ClipboardList,
  CreditCard,
  FileSearch,
  FolderOpen,
  GraduationCap,
  HeartPulse,
  KeyRound,
  Loader2,
  Palette,
  Printer,
  Radar,
  Search,
  Settings2,
  Sparkles,
  UserCheck,
} from "lucide-react"
import {
  getProfile,
  requestProfileSectionAI,
  upsertProfileSection,
  uploadProfileAvatar,
  requestProfileAvatarFromWebsite,
  updateProfile,
} from "@/api/profiles"
import { ingestDocument } from "@/api/documents"
import ProfileOverview from "@/components/profiles/ProfileOverview"
import ProfileSectionEditor from "@/components/profiles/ProfileSectionEditor"
import ApplicationEssaysCard from "@/components/profiles/ApplicationEssaysCard"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { useToast } from "@/components/ui/use-toast"
import { createPageUrl } from "@/utils"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useDashboardPreferences } from "@/contexts/DashboardPreferencesContext.jsx"
import { useAnyaPageAdapter } from "@/contexts/AnyaContext"
import { useSettingsStore } from "@/stores/settingsStore"
import { useAuthStore } from "@/stores/authStore"
import ProfileFilesPanel from "@/components/profiles/ProfileFilesPanel.jsx"
import ProfileAppliedFundingPrint from "@/components/profiles/ProfileAppliedFundingPrint.jsx"
import ProfileInfoPrint from "@/components/profiles/ProfileInfoPrint.jsx"
import PrintableProfileTodo from "@/components/profiles/PrintableProfileTodo.jsx"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import UniversityApplicationsSection from "@/components/profiles/UniversityApplicationsSection.jsx"
import StudentPortalsCard from "@/components/profiles/StudentPortalsCard.jsx"
import SavedLoginsCard from "@/components/profiles/SavedLoginsCard.jsx"
import PortalSessionsCard from "@/components/hamilton/PortalSessionsCard.jsx"
import PortalSyncCard from "@/components/hamilton/PortalSyncCard.jsx"
import ProfilePortalsCard from "@/components/hamilton/ProfilePortalsCard.jsx"
import HamiltonAutopilotConsentCard from "@/components/hamilton/HamiltonAutopilotConsentCard.jsx"
import HamiltonWorkPanel from "@/components/hamilton/HamiltonWorkPanel.jsx"
import ProfileFundingSourcesCard from "@/components/funding/ProfileFundingSourcesCard.jsx"
import OrgMembersCard from "@/components/profiles/OrgMembersCard.jsx"
import PortalAccessScheduleCard from "@/components/profiles/PortalAccessScheduleCard.jsx"
import CommittedCollegeWorkspace from "@/components/profiles/CommittedCollegeWorkspace.jsx"
import SchoolPortalLinkPanel from "@/components/profiles/SchoolPortalLinkPanel.jsx"
import HealthResourcesCard from "@/components/profiles/HealthResourcesCard.jsx"
import { SECTION_METADATA } from "@/config/sectionMetadata"
import { runProfileAvatarLookup } from "@/services/profileAvatarAI"
import { calculateProfileCompletion } from "@/utils/profileCompletion"
import { getWorkspaceStepStatus } from "@/utils/workspaceSteps"
import { deriveEmploymentStatusForSave, guardProfileSectionSuggestion } from "@/utils/profileSuggestionGuards"
import { formatFieldLabel } from "@/utils/fieldDisplay"
import { EDITABLE_SECTIONS } from "@/config/missingInfoTargets"

// Helper: safely turn a rejected item's reason into a human-friendly string.
function formatRejectReason(reason) {
  return String(reason || "unsupported").replace(/_/g, " ")
}

// The old "A cleaner path from facts to funding" flow guide duplicated the
// Workspace nav below it (owner: keep "Work the profile in order", delete the
// guide). Its one unique piece — the readiness chip — moved into the Workspace
// header as DeeperSearchChip and became a clickable explainer + launcher.
function DeeperSearchChip({ completionPct, nextEmptySectionTitle, onRunDeeperSearch, onCompleteProfile }) {
  const [open, setOpen] = React.useState(false)
  const ready = completionPct >= 80
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex w-fit cursor-pointer items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700 transition hover:border-blue-300 hover:bg-blue-50 hover:text-blue-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        aria-haspopup="dialog"
      >
        <Search className="h-3.5 w-3.5 text-blue-600" />
        {ready ? "Ready for deeper search" : "Build the profile signal"}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>What is a deeper search?</DialogTitle>
            <DialogDescription>
              A deeper search is a discovery run built around this profile specifically — not a generic keyword search.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm text-slate-700">
            <p>When you run it, GrantFlow:</p>
            <ul className="list-disc space-y-1.5 pl-5">
              <li>takes every fact on this profile — identity, location, eligibility, needs, education, and parsed documents;</li>
              <li>searches the curated funding catalog <span className="font-medium">and</span> the live web with queries written from those facts;</li>
              <li>scores every result against this profile and keeps only real, eligible matches;</li>
              <li>adds qualifying matches to the pipeline, where Anya and Hamilton can start working them.</li>
            </ul>
            <p className={ready ? "text-emerald-700" : "text-amber-700"}>
              {ready
                ? `This profile is ${completionPct}% complete — enough signal for a high-quality run.`
                : `This profile is ${completionPct}% complete. You can run a search now, but each fact you add sharpens the matches${nextEmptySectionTitle ? ` — start with ${nextEmptySectionTitle}` : ""}.`}
            </p>
          </div>
          <div className="flex flex-wrap justify-end gap-2 pt-2">
            {!ready && nextEmptySectionTitle && (
              <Button
                variant="outline"
                onClick={() => {
                  setOpen(false)
                  onCompleteProfile?.()
                }}
              >
                Fill in {nextEmptySectionTitle} first
              </Button>
            )}
            <Button
              onClick={() => {
                setOpen(false)
                onRunDeeperSearch?.()
              }}
            >
              <Search className="mr-2 h-4 w-4" />
              Run deeper search now
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function WorkspaceTabTrigger({
  icon: Icon,
  title,
  detail,
  tooltip,
  value,
  active = false,
  compact = false,
  // Workspace step state (from the shared getWorkspaceStepStatus selector).
  // `complete` = the underlying data proves this step is done → green + a large
  // white checkmark. `isNext` = the single next incomplete step → ring + "Next
  // step" badge, with the label pulsing (unless the user opts out of motion).
  complete = false,
  isNext = false,
  pulse = false,
}) {
  // Card fill: complete (green) wins over active (blue) wins over resting.
  // emerald-700 (not -600) so white/emerald-50 small label + detail text clear
  // the AA 4.5:1 body-contrast bar on the green fill.
  const fillClass = complete
    ? "border-emerald-600 bg-emerald-700 text-white shadow-sm data-[state=active]:border-emerald-400 data-[state=active]:bg-emerald-700 data-[state=active]:text-white"
    : active
      ? "border-blue-300 bg-blue-50 text-blue-950"
      : "border-slate-200 bg-white text-slate-800"

  // The next step always carries a static ring so reduced-motion users still
  // get the emphasis; the pulse (below) is an additive motion cue on top.
  const nextRingClass = isNext
    ? complete
      ? "ring-2 ring-emerald-300 ring-offset-2"
      : "ring-2 ring-blue-400 ring-offset-2"
    : ""

  // Solid darker-emerald chip so the WHITE checkmark hits a strong contrast
  // ratio (emerald-900 vs white ≈ 10:1), never a washed-out translucent green.
  const iconChipClass = complete
    ? "bg-emerald-900 text-white"
    : active
      ? "bg-blue-600 text-white"
      : "bg-slate-100 text-slate-700 group-hover:bg-blue-100 group-hover:text-blue-700"

  const detailClass = complete
    ? compact
      ? "mt-0.5 block text-[11px] leading-snug text-emerald-50"
      : "mt-1 block text-xs leading-relaxed text-emerald-50"
    : compact
      ? "mt-0.5 block text-[11px] leading-snug text-slate-600"
      : "mt-1 block text-xs leading-relaxed text-slate-600"

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <TabsTrigger
          value={value}
          data-step-complete={complete ? "true" : undefined}
          data-step-next={isNext ? "true" : undefined}
          aria-label={
            complete
              ? `${title} — done`
              : isNext
                ? `${title} — do this next`
                : title
          }
          className={`group relative h-auto w-full cursor-pointer whitespace-normal rounded-lg border text-left shadow-none transition hover:-translate-y-0.5 hover:shadow-sm focus-visible:ring-blue-500 data-[state=active]:shadow-none ${
            complete ? "" : "hover:border-blue-200 hover:bg-blue-50/70 hover:text-slate-950"
          } ${
            compact ? "items-start justify-start gap-2 px-3 py-2.5" : "items-start justify-start gap-3 px-4 py-3.5"
          } ${fillClass} ${nextRingClass}`}
        >
          <span
            className={`flex shrink-0 items-center justify-center rounded-md ${
              compact ? "h-8 w-8" : "h-10 w-10"
            } ${iconChipClass}`}
          >
            {complete ? (
              <Check className={compact ? "h-5 w-5" : "h-6 w-6"} strokeWidth={3} aria-hidden="true" />
            ) : (
              <Icon className={compact ? "h-4 w-4" : "h-5 w-5"} />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span
                className={`${
                  compact ? "block text-xs font-semibold leading-tight" : "block text-sm font-semibold leading-tight"
                } ${isNext && pulse ? "gf-step-next-label" : ""}`}
              >
                {title}
              </span>
              {isNext ? (
                <span className="inline-flex shrink-0 items-center rounded-full bg-blue-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                  Next step
                </span>
              ) : null}
              {complete ? (
                <span className="inline-flex shrink-0 items-center rounded-full bg-emerald-800 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                  Done
                </span>
              ) : null}
            </span>
            <span className={detailClass}>{detail}</span>
          </span>
          <ArrowRight
            className={`mt-1 shrink-0 transition group-hover:translate-x-0.5 ${
              complete ? "text-white/80" : active ? "text-blue-700" : "text-slate-400 group-hover:text-blue-600"
            } ${compact ? "h-3.5 w-3.5" : "h-4 w-4"}`}
          />
        </TabsTrigger>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-xs leading-relaxed">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

function ProfileWorkspaceNav({
  activeTab,
  isStudentProfile,
  isHealthProfile,
  completionPct,
  nextEmptySectionTitle,
  onRunDeeperSearch,
  onCompleteProfile,
  onOpenCoverageEvidence,
  stepStatus,
  pulseEnabled = true,
}) {
  // Map each primary tab to its shared step state (complete / next). Keyed by
  // the SAME selector Anya reads, so a green card and Anya's nudge can never
  // point at different "next steps".
  const stepByKey = new Map((stepStatus?.steps ?? []).map((step) => [step.key, step]))
  const primaryTabs = [
    {
      value: "profile",
      icon: UserCheck,
      title: "Profile facts",
      detail: "Identity, needs, eligibility, and location.",
      tooltip: "Review or edit the facts GrantFlow uses to search. Empty fields are allowed; known facts make searches more precise.",
    },
    {
      value: "documents",
      icon: FileSearch,
      title: "Documents",
      detail: "Uploads, parsed evidence, forms, and printouts.",
      tooltip: "Open documents so PDFs, screenshots, letters, bills, transcripts, and other files can support the profile.",
    },
    {
      value: "action-plan",
      icon: Sparkles,
      title: "Anya plan",
      detail: "Interview, checklist, and next practical steps.",
      tooltip: "Open the action plan Anya and Hamilton use to turn the profile into an exact project checklist.",
    },
    {
      value: "pipeline",
      icon: KeyRound,
      title: "Portals & pipeline",
      detail: "Logins, funding sources, and applications.",
      tooltip: "Open the profile's portal and pipeline workspace, including Hamilton login help and saved funding sources.",
    },
  ]

  const supportingTabs = [
    {
      value: "item-funding",
      icon: Search,
      title: "Item funding",
      detail: "Specific needs and purchases.",
      tooltip: "Search for funding tied to a specific item, tool, bill, program cost, or startup need.",
    },
    {
      value: "deadlines",
      icon: Calendar,
      title: "Deadlines",
      detail: "Dates to watch.",
      tooltip: "Open grant and application deadlines for this profile.",
    },
    {
      value: "monitoring",
      icon: ClipboardList,
      title: "Monitoring",
      detail: "Awards and compliance.",
      tooltip: "Track awarded grants, reporting, and compliance when this profile is linked to an organization.",
    },
    {
      value: "proposals",
      icon: FolderOpen,
      title: "Proposals & files",
      detail: "Drafts and source files.",
      tooltip: "Open proposals and the profile's working files.",
    },
    {
      value: "billing",
      icon: CreditCard,
      title: "Billing/access",
      detail: "Members and account status.",
      tooltip: "Open billing, members, and access details for this profile.",
    },
    {
      value: "personalization",
      icon: Settings2,
      title: "Comfort",
      detail: "Theme and readability.",
      tooltip: "Adjust color, contrast, text size, and motion preferences while working in this profile.",
    },
    isStudentProfile
      ? {
          value: "universities",
          icon: GraduationCap,
          title: "Student portals",
          detail: "Aid, awards, and work-study.",
          tooltip: "Open college portals, applications, financial aid, scholarship, and work-study support.",
        }
      : null,
    isHealthProfile
      ? {
          value: "health",
          icon: HeartPulse,
          title: "Health",
          detail: "Support and opt-in studies.",
          tooltip: "Open health and disability support. Studies remain opt-in and profile-relevant.",
        }
      : null,
  ].filter(Boolean)

  const activeOption = [...primaryTabs, ...supportingTabs].find((tab) => tab.value === activeTab) ?? primaryTabs[0]
  const ActiveIcon = activeOption.icon

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Workspace</p>
          <h2 className="text-lg font-semibold text-slate-900">Work the profile in order</h2>
          {stepStatus ? (
            <p className="mt-1 text-xs text-slate-600">
              <span className="font-medium text-emerald-700">
                {stepStatus.completedCount} of {stepStatus.totalCount} steps done
              </span>
              {stepStatus.allComplete ? (
                <span> — every step is complete.</span>
              ) : stepStatus.nextStep ? (
                <span>
                  {" "}
                  — next up:{" "}
                  <span className="font-semibold text-blue-700">{stepStatus.nextStep.title}</span>.
                </span>
              ) : null}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DeeperSearchChip
            completionPct={completionPct ?? 0}
            nextEmptySectionTitle={nextEmptySectionTitle}
            onRunDeeperSearch={onRunDeeperSearch}
            onCompleteProfile={onCompleteProfile}
          />
          {onOpenCoverageEvidence && (
            <button
              type="button"
              onClick={onOpenCoverageEvidence}
              className="inline-flex w-fit cursor-pointer items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700 transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              title="What we searched, what we missed, why each match survived, and what to answer next"
            >
              <Radar className="h-3.5 w-3.5 text-indigo-600" />
              Coverage &amp; evidence
            </button>
          )}
          <span className="inline-flex w-fit items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-800">
            <ActiveIcon className="h-3.5 w-3.5" />
            {activeOption.title}
          </span>
        </div>
      </div>
      <TooltipProvider delayDuration={150}>
        <TabsList
          aria-label="Main profile workflow"
          className="!grid h-auto w-full grid-cols-1 gap-3 bg-transparent p-0 sm:grid-cols-2 xl:grid-cols-4"
        >
          {primaryTabs.map((tab) => {
            const step = stepByKey.get(tab.value)
            return (
              <WorkspaceTabTrigger
                key={tab.value}
                {...tab}
                active={activeTab === tab.value}
                complete={Boolean(step?.complete)}
                isNext={Boolean(step?.isNext)}
                pulse={pulseEnabled}
              />
            )
          })}
        </TabsList>
        <div className="mt-4 border-t border-slate-200 pt-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">More profile tools</p>
          <TabsList
            aria-label="Additional profile tools"
            className="!grid h-auto w-full grid-cols-1 gap-2 bg-transparent p-0 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
          >
            {supportingTabs.map((tab) => (
              <WorkspaceTabTrigger key={tab.value} {...tab} active={activeTab === tab.value} compact />
            ))}
          </TabsList>
        </div>
      </TooltipProvider>
    </section>
  )
}

export function WorkAreaLinkCard({
  icon: Icon,
  title,
  detail,
  actionLabel,
  onOpen,
  disabledReason,
}) {
  const isInteractive = typeof onOpen === "function"
  const className = `group flex w-full items-start justify-between gap-4 rounded-lg border bg-white p-6 text-left shadow-sm transition ${
    isInteractive
      ? "cursor-pointer border-slate-200 hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
      : "border-slate-200 opacity-80"
  }`
  const content = (
    <>
      <div className="flex min-w-0 items-start gap-4">
        <span
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ${
            isInteractive ? "bg-blue-50 text-blue-600 group-hover:bg-blue-100" : "bg-slate-100 text-slate-500"
          }`}
        >
          <Icon className="h-5 w-5" />
        </span>
        <span className="min-w-0">
          <span className="block text-lg font-semibold text-slate-900">{title}</span>
          <span className="mt-1 block text-sm leading-relaxed text-slate-600">{detail}</span>
          {disabledReason ? (
            <span className="mt-3 block text-sm text-slate-500">{disabledReason}</span>
          ) : null}
        </span>
      </div>
      <span
        className={`mt-1 inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold ${
          isInteractive
            ? "border-blue-200 bg-blue-50 text-blue-700 group-hover:border-blue-300 group-hover:bg-blue-100"
            : "border-slate-200 bg-slate-50 text-slate-500"
        }`}
      >
        {actionLabel}
        {isInteractive ? (
          <ArrowRight className="h-3.5 w-3.5 transition group-hover:translate-x-0.5" />
        ) : null}
      </span>
    </>
  )

  if (!isInteractive) {
    return <div className={className}>{content}</div>
  }

  return (
    <button type="button" className={className} onClick={onOpen}>
      {content}
    </button>
  )
}

export default function ProfileDetail() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const rawProfileId = searchParams.get("id")
  const profileId = rawProfileId && String(rawProfileId).trim().length > 0 ? rawProfileId : null
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const user = useAuthStore((state) => state.user)
  const activeProfileId = useAuthStore((state) => state.activeProfileId)
  const isAdmin = Boolean(user?.is_admin || user?.id === "admin")
  const { state: dashboardPrefs, dispatch: preferencesDispatch } = useDashboardPreferences()
  const preferences = useSettingsStore((state) => state.preferences)
  const updatePreference = useSettingsStore((state) => state.updatePreference)
  const [appearanceOpen, setAppearanceOpen] = React.useState(false)
  const themeOptions = React.useMemo(
    () => [
      { value: "blue", label: "Blue Horizon", gradient: "bg-gradient-to-br from-blue-500 to-blue-600" },
      { value: "emerald", label: "Emerald Grove", gradient: "bg-gradient-to-br from-emerald-500 to-emerald-600" },
      { value: "violet", label: "Violet Focus", gradient: "bg-gradient-to-br from-violet-500 to-violet-600" },
      { value: "amber", label: "Amber Dawn", gradient: "bg-gradient-to-br from-amber-500 to-amber-600" },
    ],
    [],
  )
  const layoutOptions = React.useMemo(
    () => [
      { value: "expanded", label: "Expanded - 2 columns" },
      { value: "compact", label: "Compact - 3 columns" },
    ],
    [],
  )

  const {
    data: profile,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ["profile", profileId],
    queryFn: () => getProfile(profileId),
    enabled: Boolean(profileId),
  })

  const [editingSection, setEditingSection] = React.useState(null)
  const [savingSectionKey, setSavingSectionKey] = React.useState(null)
  const [aiLoadingKey, setAiLoadingKey] = React.useState(null)
  const canDeleteDocuments = Boolean(
    isAdmin ||
      (profile?.user_id && user?.id && String(profile.user_id) === String(user.id)) ||
      (activeProfileId && profileId && String(activeProfileId) === String(profileId)),
  )

  const upsertSectionMutation = useMutation({
    mutationFn: ({ sectionKey, values }) => upsertProfileSection(profileId, sectionKey, values),
    onSuccess: (response, variables) => {
      queryClient.invalidateQueries({ queryKey: ["profile", profileId] })
      queryClient.invalidateQueries({ queryKey: ["profiles"] })
      const rejected = Array.isArray(response?.rejected) ? response.rejected : []
      toast({
        title: rejected.length > 0 ? "Section saved with skipped fields" : "Section saved",
        description:
          rejected.length > 0
            ? rejected
                .slice(0, 3)
                .map((item) => `Skipped ${formatFieldLabel(variables?.sectionKey, item.key)}: ${formatRejectReason(item.reason)}`)
                .join("; ")
            : "Your updates are synced with the comprehensive application schema.",
      })
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : "Unable to save this section right now."
      toast({
        title: "Save failed",
        description: message,
        variant: "destructive",
      })
    },
  })

  const aiSuggestionMutation = useMutation({
    mutationFn: (sectionKey) => requestProfileSectionAI(profileId, sectionKey),
  })

  const uploadAvatarMutation = useMutation({
    mutationFn: ({ file }) => uploadProfileAvatar(profileId, file),
    onSuccess: () => {
      toast({
        title: "Profile photo updated",
        description: "The avatar has been uploaded successfully.",
      })
      queryClient.invalidateQueries({ queryKey: ["profile", profileId] })
      queryClient.invalidateQueries({ queryKey: ["documents", profileId] })
      queryClient.invalidateQueries({ queryKey: ["profile-project-readiness-plan", profileId] })
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : "We couldn't upload that photo."
      toast({
        title: "Upload failed",
        description: message,
        variant: "destructive",
      })
    },
  })

  const uploadDocumentMutation = useMutation({
    mutationFn: ({ file }) => {
      const formData = new FormData()
      formData.append("profile_id", profileId)
      formData.append("document", file)
      formData.append("name", file.name)
      return ingestDocument(formData)
    },
    onSuccess: () => {
      toast({
        title: "Document uploaded",
        description: "We'll parse the contents and sync profile-specific results shortly.",
      })
      queryClient.invalidateQueries({ queryKey: ["profile", profileId] })
      queryClient.invalidateQueries({ queryKey: ["documents", profileId] })
      queryClient.invalidateQueries({ queryKey: ["profile-project-readiness-plan", profileId] })
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : "Unable to upload this document."
      toast({
        title: "Upload failed",
        description: message,
        variant: "destructive",
      })
    },
  })

  const handleThemeChange = React.useCallback(
    (theme) => {
      // Accent color is owned by settingsStore (single source of truth) — write
      // only there; it applies the CSS vars and persists to the backend.
      updatePreference("accent_color", theme)

      toast({
        title: "Theme updated",
        description: "Your color theme preference has been saved.",
      })
    },
    [updatePreference, toast],
  )

  const handleLayoutChange = React.useCallback(
    (layout) => {
      // Update both local and backend preferences
      preferencesDispatch({ type: "SET_LAYOUT", layout })
      preferencesDispatch({
        type: "SET_LAYOUT_COLUMNS",
        columns: layout === "compact" ? 3 : 2,
      })
      updatePreference("dashboard_layout", layout === "compact" ? "grid" : "list")
      updatePreference("card_density", layout === "compact" ? "compact" : "comfortable")
      
      toast({
        title: "Layout updated",
        description: "Your layout preference has been saved.",
      })
    },
    [preferencesDispatch, updatePreference, toast],
  )

  const handleUploadDocument = React.useCallback(
    (file) => {
      if (!file) return
      uploadDocumentMutation.mutate({ file })
    },
    [uploadDocumentMutation],
  )

  const requestAvatarAIMutation = useMutation({
    mutationFn: async () => {
      const basic =
        profile?.sections?.find((section) => section.section_key === "basic_information")?.data ?? {}
      const websiteHint = basic?.website || profile?.website || null
      return runProfileAvatarLookup(profileId, { websiteHint })
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["profile", profileId] })
      if (result?.ok) {
        toast({
          title: "Picture found",
          description: "We saved a profile photo from the website or generated one with AI.",
        })
      } else {
        toast({
          title: "Picture not found",
          description: "We could not locate a usable photo. Try uploading one manually.",
          variant: "destructive",
        })
      }
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : "Unable to complete the AI avatar search."
      toast({
        title: "Request failed",
        description: message,
        variant: "destructive",
      })
    },
  })

  // ORG profiles: pull the avatar straight from the org's own website logo.
  // Deterministic + durable (stored as BYTEA). On failure we surface a clear
  // reason so the user can fall back to AI generation or manual upload.
  const requestAvatarFromWebsiteMutation = useMutation({
    mutationFn: async () => {
      const basic =
        profile?.sections?.find((section) => section.section_key === "basic_information")?.data ?? {}
      const website = basic?.website || profile?.website || null
      return requestProfileAvatarFromWebsite(profileId, { website })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["profile", profileId] })
      toast({
        title: "Logo applied",
        description: "We pulled the logo from the organization's website.",
      })
    },
    onError: (err) => {
      const reason = err?.details?.reason || err?.errorCode || null
      const description =
        reason === "no_website"
          ? "No website is on file. Add one in Basic Information, or upload a photo."
          : err?.details?.message ||
            (err instanceof Error ? err.message : "We could not find a usable logo on that website.")
      toast({
        title: "No logo found",
        description,
        variant: "destructive",
      })
    },
  })

  const renameProfileMutation = useMutation({
    mutationFn: (displayName) => updateProfile(profileId, { display_name: displayName }),
    onSuccess: (_response, displayName) => {
      // The rename only changes the display name; rather than force a full
      // refetch we patch the cached profile in place. We still mark the
      // profiles list as stale so it reflects the new name on next view.
      queryClient.setQueryData(["profile", profileId], (prev) =>
        prev ? { ...prev, display_name: displayName } : prev,
      )
      queryClient.invalidateQueries({ queryKey: ["profiles"] })
      toast({
        title: "Profile name updated",
        description: "The new name is saved and synced to Basic Information.",
      })
    },
    onError: (err) => {
      toast({
        title: "Rename failed",
        description: err instanceof Error ? err.message : "Unable to update the profile name right now.",
        variant: "destructive",
      })
    },
  })

  const handleRenameProfile = React.useCallback(
    async (displayName) => {
      await renameProfileMutation.mutateAsync(displayName)
    },
    [renameProfileMutation],
  )

  const handleOpenSection = React.useCallback((sectionKey, data = {}, focusField = null) => {
    let sectionData = data ?? {}
    if (sectionKey === "basic_information" && profile?.display_name) {
      const existingName = String(sectionData.full_name || "").trim()
      if (!existingName) {
        sectionData = { ...sectionData, full_name: profile.display_name }
      }
    }
    setEditingSection({
      key: sectionKey,
      data: sectionData,
      focusField: focusField || null,
    })
  }, [profile?.display_name])

  const handleCloseEditor = React.useCallback(() => {
    if (savingSectionKey) return
    setEditingSection(null)
  }, [savingSectionKey])

  const handleSaveSection = React.useCallback(
    async (values) => {
      if (!editingSection) return
      const { key } = editingSection
      try {
        setSavingSectionKey(key)
        const guarded = guardProfileSectionSuggestion(editingSection.data ?? {}, values, { sectionKey: key, profile })
        const guardedValues = deriveEmploymentStatusForSave(key, guarded.data, profile)
        // Only warn about fields that were genuinely DROPPED. Items carrying a
        // `routedTo` (alias normalization, household-evidence routing) were saved
        // to a canonical field, not skipped — surfacing them as "skipped" is the
        // misleading message users saw for ZIP / Profile category.
        const droppedFields = guarded.rejected.filter((item) => !item.routedTo)
        if (droppedFields.length > 0) {
          toast({
            title: "Skipped unsupported fields",
            description: droppedFields
              .slice(0, 3)
              .map((item) => `Skipped ${formatFieldLabel(key, item.key)}: ${formatRejectReason(item.reason)}`)
              .join("; "),
          })
        }
        await upsertSectionMutation.mutateAsync({ sectionKey: key, values: guardedValues })
        setEditingSection(null)
      } catch (err) {
        // Error toast handled in mutation onError
      } finally {
        setSavingSectionKey(null)
      }
    },
    [editingSection, profile, upsertSectionMutation, toast],
  )

  const handleAskSection = React.useCallback(
    async (sectionKey) => {
      if (!profile) return
      setAiLoadingKey(sectionKey)
      try {
        const existing =
          profile?.sections?.find((section) => section.section_key === sectionKey)?.data ?? {}
        const response = await aiSuggestionMutation.mutateAsync(sectionKey)
        const suggestion =
          response?.suggestion && typeof response.suggestion === "object" ? response.suggestion : {}

        if (!suggestion || Object.keys(suggestion).length === 0) {
          toast({
            title: "No updates suggested",
            description: "The AI assistant did not find new details for this section.",
          })
          return
        }

        const guarded = guardProfileSectionSuggestion(existing, suggestion, { sectionKey, profile })

        setEditingSection({
          key: sectionKey,
          data: guarded.data,
        })
        toast({
          title: "AI suggestion ready",
          description:
            guarded.rejected.length > 0
              ? "Review the proposed updates. Some AI toggles were held back or routed because the evidence was household-level."
              : "Review the proposed updates and save any changes you approve.",
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unable to fetch AI suggestion."
        toast({
          title: "AI request failed",
          description: message,
          variant: "destructive",
        })
      } finally {
        setAiLoadingKey(null)
      }
    },
    [profile, aiSuggestionMutation, toast],
  )

  const handleAskFromEditor = React.useCallback(async (currentValues = {}) => {
    if (!editingSection) return null
    try {
      const response = await aiSuggestionMutation.mutateAsync(editingSection.key)
      const suggestion = response?.suggestion ?? null
      if (!suggestion || typeof suggestion !== "object") return null
      const guarded = guardProfileSectionSuggestion(currentValues, suggestion, {
        sectionKey: editingSection.key,
        profile,
      })
      if (guarded.rejected.length > 0) {
        toast({
          title: "Skipped unsupported AI fields",
          description: guarded.rejected
            .slice(0, 3)
            .map((item) => `Skipped ${formatFieldLabel(editingSection.key, item.key)}: ${formatRejectReason(item.reason)}`)
            .join("; "),
        })
      }
      return guarded.data
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not fetch an AI suggestion."
      throw new Error(message)
    }
  }, [editingSection, aiSuggestionMutation, profile, toast])

  const handleInlineSaveField = React.useCallback(
    async (sectionKey, fieldKey, nextValue) => {
      if (!profileId) return
      if (!profile) return
      if (!sectionKey || !fieldKey) return

      const existing =
        profile?.sections?.find((section) => section.section_key === sectionKey)?.data ?? {}

      const nextData = deriveEmploymentStatusForSave(sectionKey, {
        ...(existing ?? {}),
        [fieldKey]: nextValue,
      }, profile)

      try {
        setSavingSectionKey(sectionKey)
        await upsertSectionMutation.mutateAsync({ sectionKey, values: nextData })
      } finally {
        setSavingSectionKey(null)
      }
    },
    [profileId, profile, upsertSectionMutation],
  )

  const handleUploadAvatar = React.useCallback(
    (file) => {
      if (!file) return
      uploadAvatarMutation.mutate({ file })
    },
    [uploadAvatarMutation],
  )

  const handleRequestAvatarAI = React.useCallback(() => {
    requestAvatarAIMutation.mutate()
  }, [requestAvatarAIMutation])

  const handleUseWebsiteLogo = React.useCallback(() => {
    requestAvatarFromWebsiteMutation.mutate()
  }, [requestAvatarFromWebsiteMutation])


  // IMPORTANT: All hooks must be called before any conditional returns (React rules of hooks).
  const [activeTab, setActiveTab] = React.useState("profile")
  // Pending scroll target - when set, we retry scrolling to the element via
  // requestAnimationFrame until it mounts (replaces the fragile fixed timeout).
  const [pendingScrollTarget, setPendingScrollTarget] = React.useState(null)
  // Deep-link support: ?tab=&section=&field= (emitted by MissingInfoChecklist /
  // HamiltonTaskDrawer / Profile Action Plan) lands the user on the right tab
  // and pops the matching section editor focused on the field to fill.
  const deepLinkHandled = useRef(null)
  const tabParam = searchParams.get("tab")
  const sectionParam = searchParams.get("section")
  const fieldParam = searchParams.get("field")
  const focusParam = searchParams.get("focus")
  React.useEffect(() => {
    if (!profile) return
    const token = `${tabParam || ""}|${sectionParam || ""}|${fieldParam || ""}|${focusParam || ""}`
    if (token === "|||" || deepLinkHandled.current === token) return
    deepLinkHandled.current = token
    if (tabParam) setActiveTab(tabParam)
    if (focusParam) setPendingScrollTarget(focusParam)
    // Only pop the section editor for sections that actually have one - for
    // documents / universities we just land on the tab.
    if (sectionParam && EDITABLE_SECTIONS.has(sectionParam)) {
      const existing =
        profile?.sections?.find((section) => section.section_key === sectionParam)?.data ?? {}
      handleOpenSection(sectionParam, existing, fieldParam)
    }
  }, [profile, tabParam, sectionParam, fieldParam, focusParam, handleOpenSection])

  React.useEffect(() => {
    if (!profileId) return
    try {
      window.localStorage.setItem("grantflow:last-profile-detail-id", String(profileId))
      window.localStorage.setItem("grantflow:discover-last-profile", String(profileId))
    } catch {
      // Best-effort profile memory; URL profile_id remains canonical.
    }
  }, [profileId])

  // Reliable scroll-into-view: keep retrying via rAF until the target element
  // exists in the DOM (the tab content may not be mounted on the same frame).
  React.useEffect(() => {
    if (!pendingScrollTarget) return
    let cancelled = false
    let attempts = 0
    const tryScroll = () => {
      if (cancelled) return
      const el = document.getElementById(pendingScrollTarget)
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" })
        setPendingScrollTarget(null)
        return
      }
      attempts += 1
      if (attempts > 60) {
        // ~1s worth of frames - give up quietly rather than spin forever.
        setPendingScrollTarget(null)
        return
      }
      window.requestAnimationFrame(tryScroll)
    }
    window.requestAnimationFrame(tryScroll)
    return () => {
      cancelled = true
    }
  }, [pendingScrollTarget, activeTab])

  // Switch the workspace to a tab AND scroll the workspace into view. The
  // Profile Flow cards live well above the Tabs, so a bare setActiveTab() looked
  // dead — the content changed below the fold with no visible feedback. Scrolling
  // to the workspace anchor (id="profile-workspace") gives the click an effect
  // and lands the user on the section they asked for. The rAF-based scroll effect
  // keyed on activeTab retries until the (possibly just-mounted) anchor exists.
  const goToWorkspaceTab = React.useCallback((tab) => {
    setActiveTab(tab)
    setPendingScrollTarget("profile-workspace")
  }, [])

  // Deep-link a "Hamilton needs you" item to where the owner fixes it. `where`
  // is a coarse tab hint from the profile-summary endpoint; portals + vault land
  // on the Pipeline tab and scroll to the Portals dashboard anchor. Every case
  // must scroll (via goToWorkspaceTab / a specific anchor) — a bare
  // setActiveTab() switches content below the fold with no visible feedback,
  // which reads as a dead click (the exact bug goToWorkspaceTab was added to fix
  // for the Profile Flow cards, but this handler predates it and missed it).
  const handleHamiltonNavigate = React.useCallback((where) => {
    switch (where) {
      case "pipeline":
        setActiveTab("pipeline")
        setPendingScrollTarget("portal-logins")
        break
      case "documents":
        goToWorkspaceTab("documents")
        break
      case "action-plan":
        goToWorkspaceTab("action-plan")
        break
      case "profile":
      default:
        goToWorkspaceTab("profile")
        break
    }
  }, [goToWorkspaceTab])

  const hasSyncedTargetColleges = useRef(false)
  const lastSyncedProfileId = useRef(null)
  const failedTargetCollegeSyncProfiles = useRef(new Set())
  const targetCollegeSyncInFlight = useRef(false)

  // Derived state - computed here (before early returns) using optional chaining so they are
  // safe when `profile` is still undefined (loading / error states).
  const canDocumentAI = isAdmin || Boolean(profile?.billing?.tier?.enable_document_ai)

  const primaryType = String(profile?.primary_type || "").toLowerCase()
  const basicInfo =
    profile?.sections?.find((section) => section.section_key === "basic_information")?.data ?? {}
  const profileTypeLabel = String(basicInfo?.profile_type || "").toLowerCase()

  const eduSection = profile?.sections?.find((s) => s.section_key === "education")?.data
  const highestLevel = String(eduSection?.highest_level || "").toLowerCase()
  const targetColleges = eduSection?.target_colleges
  const hasTargetColleges = Array.isArray(targetColleges)
    ? targetColleges.length > 0
    : typeof targetColleges === "string" && targetColleges.trim().length > 0

  const isStudentProfile =
    ["high_school_student", "college_student", "graduate_student"].includes(primaryType) ||
    profileTypeLabel.includes("student") ||
    highestLevel.includes("student") ||
    hasTargetColleges

  // Org-vs-individual: individuals (people, students, single medical/veteran/etc.)
  // keep the existing AI/upload flow. Everything else (nonprofit, church, school,
  // government, business...) is treated as an organization and is offered the
  // "Use website logo" option. We default UNKNOWN/blank types to individual so we
  // never surface an org-only control on a personal profile.
  const INDIVIDUAL_PRIMARY_TYPES = new Set([
    "individual",
    "individual_need",
    "family",
    "medical_need",
    "medical_assistance",
    "medical",
    "senior",
    "veteran",
    "disabled_adult",
    "student",
    "high_school_student",
    "college_student",
    "graduate_student",
  ])
  const isOrgProfile =
    !isStudentProfile &&
    primaryType.length > 0 &&
    !INDIVIDUAL_PRIMARY_TYPES.has(primaryType) &&
    !profileTypeLabel.includes("individual")
  const profileWebsite = String(basicInfo?.website || profile?.website || "").trim()
  const hasWebsiteOnFile = profileWebsite.length > 0
  const hasOrganizationId = Boolean(profile?.organization_id)

  const healthMedical =
    profile?.sections?.find((section) => section.section_key === "health_medical")?.data ?? {}

  const hasHealthSignals =
    Boolean(healthMedical?.chronic_illness) ||
    Boolean(healthMedical?.dialysis_patient) ||
    Boolean(healthMedical?.organ_transplant) ||
    Boolean(healthMedical?.hiv_aids) ||
    Boolean(healthMedical?.tbi_survivor) ||
    Boolean(healthMedical?.amputee) ||
    Boolean(healthMedical?.neurodivergent) ||
    Boolean(healthMedical?.mental_health_condition) ||
    Boolean(healthMedical?.wheelchair_user) ||
    Boolean(healthMedical?.visual_impairment) ||
    Boolean(healthMedical?.hearing_impairment) ||
    (Array.isArray(healthMedical?.disability_type) && healthMedical.disability_type.length > 0) ||
    (Array.isArray(healthMedical?.support_needs) && healthMedical.support_needs.length > 0) ||
    (Array.isArray(healthMedical?.conditions) && healthMedical.conditions.length > 0) ||
    Boolean(String(healthMedical?.notes || "").trim())

  // Personal/individual medical resources (copay assistance, clinical-trial
  // matching to "conditions in YOUR medical profile") only make sense for a
  // PERSON. An organization/nonprofit can have a disability flag captured on its
  // record (e.g. "serves people with disabilities"), but that must NOT surface
  // personal patient-assistance content as if the org itself were the patient.
  // So the Health tab is gated to non-org profiles even when health signals exist.
  const isHealthProfile =
    !isOrgProfile &&
    (primaryType.includes("health") ||
      primaryType.includes("patient") ||
      profileTypeLabel.includes("health") ||
      profileTypeLabel.includes("medical") ||
      hasHealthSignals)

  const studentState =
    basicInfo?.address?.state ??
    basicInfo?.state ??
    profile?.state ??
    ""

  const studentGender =
    basicInfo?.gender ??
    basicInfo?.sex ??
    profile?.gender ??
    ""

  const universitySectionData =
    profile?.sections?.find((section) => section.section_key === "university_applications")?.data ?? {}
  const universityApplications = Array.isArray(universitySectionData?.applications)
    ? universitySectionData.applications
    : []

  const handleSaveUniversityApplications = React.useCallback(
    async (nextApplications) => {
      try {
        setSavingSectionKey("university_applications")
        await upsertSectionMutation.mutateAsync({
          sectionKey: "university_applications",
          values: { applications: nextApplications },
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unable to save university applications."
        toast({
          title: "Save failed",
          description: message,
          variant: "destructive",
        })
      } finally {
        setSavingSectionKey(null)
      }
    },
    [upsertSectionMutation, toast],
  )

  const handleAskUniversityApplications = React.useCallback(
    async () => {
      setAiLoadingKey("university_applications")
      try {
        return await aiSuggestionMutation.mutateAsync("university_applications")
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unable to fetch AI suggestion."
        toast({
          title: "AI request failed",
          description: message,
          variant: "destructive",
        })
        return null
      } finally {
        setAiLoadingKey(null)
      }
    },
    [aiSuggestionMutation, toast],
  )

  // Toggle study consent through the same guard/derive path used by saves, and
  // read the freshest section data from the cache so we don't clobber concurrent
  // edits with a stale render snapshot.
  const handleToggleStudyConsent = React.useCallback(
    async (next) => {
      const latest = queryClient.getQueryData(["profile", profileId])
      const latestHealth =
        (latest?.sections?.find((section) => section.section_key === "health_medical")?.data) ??
        healthMedical ??
        {}
      const merged = { ...latestHealth, consent_for_studies: next }
      const guarded = guardProfileSectionSuggestion(latestHealth, merged, {
        sectionKey: "health_medical",
        profile,
      })
      const guardedValues = deriveEmploymentStatusForSave("health_medical", guarded.data, profile)
      try {
        await upsertSectionMutation.mutateAsync({
          sectionKey: "health_medical",
          values: guardedValues,
        })
      } catch (err) {
        // Error toast handled in mutation onError
      }
    },
    [queryClient, profileId, healthMedical, profile, upsertSectionMutation],
  )

  const profileCompletion = React.useMemo(() => calculateProfileCompletion(profile), [profile])
  const totalSections = profileCompletion.totalSections
  const completedSections = profileCompletion.completedSections
  const completionPct = profileCompletion.completionPct
  const nextEmptySection = profileCompletion.nextIncompleteSectionKey
  const nextEmptySectionTitle = nextEmptySection ? (SECTION_METADATA[nextEmptySection]?.title ?? nextEmptySection) : null

  // Ordered Workspace step status (green cards + which one pulses). Same shared
  // selector Anya reads, so the pulsing "next step" and Anya's guidance agree.
  const stepStatus = React.useMemo(() => getWorkspaceStepStatus(profile), [profile])
  // In-app motion opt-out (Comfort tab). The CSS pulse is also gated behind the
  // OS-level prefers-reduced-motion; this honors the app-level toggle too.
  const pulseEnabled = !preferences?.reduce_motion

  // Publish the SAME step status into Anya's page context, so when the user
  // asks Anya "what's next?" she names the exact step the card is pulsing.
  // Derived from the shared selector — a single source of truth for both.
  const anyaAdapterState = React.useMemo(() => {
    if (!profileId || !stepStatus) return null
    const nextStep = stepStatus.nextStep
    return {
      pageType: "profile-workspace",
      primaryEntityId: profileId,
      completion: {
        workspaceStepsCompleted: stepStatus.completedCount,
        workspaceStepsTotal: stepStatus.totalCount,
        allWorkspaceStepsComplete: stepStatus.allComplete,
        nextStepKey: stepStatus.nextStepKey,
        nextStepTitle: nextStep?.title ?? null,
        nextStepGuidance: nextStep?.anyaHint ?? null,
      },
      suggestedActions: nextStep
        ? [
            {
              type: "navigate",
              label: nextStep.actionLabel,
              payload: { path: createPageUrl("ProfileDetail", { id: profileId, tab: nextStep.tab }) },
            },
          ]
        : [],
    }
  }, [profileId, stepStatus])
  useAnyaPageAdapter(anyaAdapterState)

  // One-time sync: target_colleges -> university_applications (avoids duplicates, no infinite loop)
  useEffect(() => {
    if (!profileId || !profile) return
    if (failedTargetCollegeSyncProfiles.current.has(profileId)) return
    const pt = String(profile?.primary_type || "").toLowerCase()
    const bi = profile?.sections?.find((s) => s.section_key === "basic_information")?.data ?? {}
    const ptl = String(bi?.profile_type || "").toLowerCase()
    const eduData = profile?.sections?.find((s) => s.section_key === "education")?.data
    const hl = String(eduData?.highest_level || "").toLowerCase()
    const tc = eduData?.target_colleges
    const hasTc = Array.isArray(tc) ? tc.length > 0 : typeof tc === "string" && tc.trim().length > 0
    const isStudent = ["high_school_student", "college_student", "graduate_student"].includes(pt)
      || ptl.includes("student")
      || hl.includes("student")
      || hasTc
    if (!isStudent) return
    const usd = profile?.sections?.find((s) => s.section_key === "university_applications")?.data ?? {}
    const uniApps = Array.isArray(usd?.applications) ? usd.applications : []
    if (lastSyncedProfileId.current !== profileId) {
      hasSyncedTargetColleges.current = false
      lastSyncedProfileId.current = profileId
    }
    if (hasSyncedTargetColleges.current) return
    if (targetCollegeSyncInFlight.current) return
    const educationData = profile?.sections?.find((s) => s.section_key === "education")?.data ?? {}
    const { applications, addedCount } = syncTargetCollegesToApplications(educationData, uniApps)
    if (addedCount === 0) {
      // Nothing to add - treat as a completed (no-op) sync for this profile.
      hasSyncedTargetColleges.current = true
      return
    }
    // Mark in-flight (NOT "synced") so a transient failure can be retried this
    // session. The synced flag is only set after the save resolves successfully.
    targetCollegeSyncInFlight.current = true
    upsertSectionMutation
      .mutateAsync({
        sectionKey: "university_applications",
        values: { applications },
      })
      .then(() => {
        hasSyncedTargetColleges.current = true
      })
      .catch((err) => {
        // Transient failure: do NOT permanently blacklist. We leave the synced
        // flag false so the effect can retry on the next profile data change.
        const msg = err instanceof Error ? err.message : "Sync failed"
        console.error("[ProfileDetail] target_colleges sync save failed:", msg)
        toast({
          variant: "destructive",
          title: "Target colleges sync failed",
          description: msg,
        })
      })
      .finally(() => {
        targetCollegeSyncInFlight.current = false
      })
  }, [profileId, profile, upsertSectionMutation, toast])

  if (!profileId) {
    return (
      <div className="p-6 md:p-8">
        <div className="max-w-4xl mx-auto space-y-4">
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              No profile selected. Choose a profile from the Profiles page to view its details.
            </AlertDescription>
          </Alert>
          <Button onClick={() => navigate(createPageUrl("MyProfiles"))}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Profiles
          </Button>
        </div>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="flex min-h-[320px] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    )
  }

  if (isError || !profile) {
    let message = "The profile could not be loaded right now."
    if (error instanceof Error) {
      message = error.message
    } else if (error && typeof error === "object") {
      // Surface as much diagnostic context as we safely can without throwing.
      message =
        error.message ||
        error.statusText ||
        (typeof error.toString === "function" ? error.toString() : message)
    } else if (typeof error === "string" && error.trim()) {
      message = error
    }
    if (error) {
      // Log the full error object for debugging; the UI shows a friendly message.
      console.error("[ProfileDetail] failed to load profile", { profileId, error })
    }
    return (
      <div className="p-6 md:p-8">
        <div className="max-w-4xl mx-auto space-y-4">
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{message}</AlertDescription>
          </Alert>
          <div className="flex flex-wrap gap-3">
            <Button variant="outline" onClick={() => navigate(-1)}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Go Back
            </Button>
            <Button onClick={() => navigate(createPageUrl("MyProfiles"))}>View all profiles</Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 md:p-10">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">Profile</p>
            <h1 className="text-3xl font-bold text-slate-900">{profile.display_name}</h1>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button variant="outline" onClick={() => navigate(createPageUrl("MyProfiles"))}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Profiles
            </Button>
            {/* What is Hamilton working on for this profile + everywhere the
                owner must add info for him to finish. The panel deep-links each
                "needs you" item back to the right tab/anchor via onNavigate. */}
            <HamiltonWorkPanel profileId={profileId} onNavigate={handleHamiltonNavigate} />
            <Button variant="outline" onClick={() => setAppearanceOpen(true)}>
              <Palette className="w-4 h-4 mr-2" />
              Appearance
            </Button>
            {/*
              Print Profile Packet - opens /PrintProfilePacket?profile_id=<id>
              in a new tab. The packet renders profile summary, pipeline by
              stage, items that need human review (with the application_steps
              the pipeline_automation worker prepared), and a simple next-steps
              checklist. Backed by GET /api/profiles/:id/report-packet.
            */}
            <Button
              variant="outline"
              onClick={() =>
                window.open(
                  createPageUrl("PrintProfilePacket", { profile_id: profileId }),
                  "_blank",
                  "noopener,noreferrer",
                )
              }
            >
              <Printer className="w-4 h-4 mr-2" />
              Print Profile Packet
            </Button>
            {profile.organization_id && (
              // OrganizationProfile looks up by PROFILE id (profiles & orgs are the
              // same records via two UIs). Pass profile.id, not the stale
              // organization_id foreign key — that was the "Profile Not Found" link.
              <Button onClick={() => navigate(createPageUrl("OrganizationProfile", { id: profile.id }))}>
                View Linked Organization
              </Button>
            )}
          </div>
        </div>

        {/* Profile completeness progress bar */}
        <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium text-slate-700">
              {completedSections} of {totalSections} sections complete ({completionPct}%)
            </span>
            {completionPct === 100 && (
              <span className="text-emerald-600 font-medium text-xs">Profile complete</span>
            )}
          </div>
          <div className="w-full bg-gray-200 rounded h-2">
            <div
              className="h-2 rounded transition-all duration-300"
              style={{
                width: `${completionPct}%`,
                backgroundColor: completionPct >= 80 ? '#10b981' : completionPct >= 50 ? '#3b82f6' : '#f59e0b',
              }}
            />
          </div>
          {nextEmptySectionTitle && (
            <p className="text-xs text-slate-500">
              Fill in{' '}
              <button
                type="button"
                className="underline text-blue-600 hover:text-blue-800"
                onClick={() => handleOpenSection(nextEmptySection)}
              >
                {nextEmptySectionTitle}
              </button>{' '}
              to sharpen profile-specific searching.
            </p>
          )}
        </div>

        <Tabs id="profile-workspace" value={activeTab} onValueChange={setActiveTab} className="w-full scroll-mt-24">
          <ProfileWorkspaceNav
            activeTab={activeTab}
            isStudentProfile={isStudentProfile}
            isHealthProfile={isHealthProfile}
            completionPct={completionPct}
            nextEmptySectionTitle={nextEmptySectionTitle}
            stepStatus={stepStatus}
            pulseEnabled={pulseEnabled}
            onRunDeeperSearch={() => navigate(createPageUrl("DiscoverGrants", { profile_id: profileId, autorun: 1 }))}
            onOpenCoverageEvidence={() => navigate(createPageUrl("CoverageEvidence", { profile_id: profileId }))}
            onCompleteProfile={() => {
              if (nextEmptySection) {
                handleOpenSection(nextEmptySection)
                return
              }
              goToWorkspaceTab("profile")
            }}
          />

          <TabsContent value="profile" className="mt-6 space-y-6">
            <SchoolPortalLinkPanel profileId={profileId} />
            <ProfileOverview
              profile={profile}
              billing={profile.billing ?? null}
              onEditSection={handleOpenSection}
              onSaveField={handleInlineSaveField}
              onAskSection={handleAskSection}
              savingSectionKey={savingSectionKey}
              aiLoadingKey={aiLoadingKey}
              onUploadAvatar={handleUploadAvatar}
              onRequestAvatarAI={handleRequestAvatarAI}
              onUseWebsiteLogo={isOrgProfile ? handleUseWebsiteLogo : undefined}
              isOrgProfile={isOrgProfile}
              hasWebsiteOnFile={hasWebsiteOnFile}
              isUploadingAvatar={uploadAvatarMutation.isPending}
              isRequestingAvatar={requestAvatarAIMutation.isPending}
              isFetchingWebsiteLogo={requestAvatarFromWebsiteMutation.isPending}
              onUploadDocument={handleUploadDocument}
              isUploadingDocument={uploadDocumentMutation.isPending}
              fundsTotal={profile.pipeline_funds_total ?? 0}
              onNavigateToUniversities={isStudentProfile ? () => setActiveTab("universities") : undefined}
              onNavigateToPortals={() => {
                // The per-profile Portals dashboard (ProfilePortalsCard, Hamilton
                // sign-in + autopilot) lives in the Pipeline tab under #portal-logins.
                // Switch tabs, then scroll once the pipeline content has mounted
                // (handled by the rAF-based scroll effect keyed on activeTab).
                setActiveTab("pipeline")
                setPendingScrollTarget("portal-logins")
              }}
              onRenameProfile={handleRenameProfile}
              isRenamingProfile={renameProfileMutation.isPending}
            />
            {/* Application essays — the drafting-only prose Hamilton writes
                applications from. Surfaced as a dedicated, clearly-labeled card
                so the owner can "see and edit what Hamilton writes from". */}
            <ApplicationEssaysCard
              essays={profile?.sections?.find((section) => section.section_key === "essays")?.data ?? {}}
              onSaveField={handleInlineSaveField}
              isSaving={savingSectionKey === "essays"}
            />
          </TabsContent>

          <TabsContent value="pipeline" className="mt-6 space-y-6">
            {/* Portal access for Hamilton - pulled to the TOP of the tab and
                given a labelled anchor so the "Portal Logins" button on the
                Master Pipeline page (focus=portal-logins) can deep-link the
                user straight here. Previously these cards sat below the
                "Go to Pipeline" box and were easy to miss. */}
            <div id="portal-logins" className="scroll-mt-24 space-y-6">
              {/* The Portals dashboard IS the page: every portal that applies to
                  this profile (schools, funders, plus the right applications and
                  benefits for its type + state) is auto-listed. Green = ready,
                  red = click to log in once. No explainer clutter - the card
                  speaks for itself. Power-user manual entry lives under Advanced. */}
              <ProfileFundingSourcesCard profileId={profileId} />
              {/* One-time, profile-level consent: grant Hamilton standing
                  permission to use this profile's saved logins across every
                  portal (scope:'profile' authorization) instead of authorizing
                  each funding source. */}
              <HamiltonAutopilotConsentCard profileId={profileId} />
              <ProfilePortalsCard profileId={profileId} profileName={profile?.display_name || ""} />
              {/* The manual portal-host/URL entry forms are de-emphasized: kept
                  for power users under a disclosure, since the dashboard above is
                  now the primary way to set up portals. */}
              <details className="rounded-lg border border-slate-200 bg-slate-50/60 p-4">
                <summary className="cursor-pointer text-sm font-medium text-slate-700">
                  Advanced - add a portal manually
                </summary>
                <div className="mt-4 space-y-6">
                  {/* Saved portal logins - available for every profile type, since
                      Hamilton uses them to sign in to any grant/application portal she
                      automates from the pipeline. */}
                  <SavedLoginsCard profileId={profileId} />
                  {/* Saved portal SESSIONS (captured logins) - the self-serve "log in
                      from your phone or computer" capture flow + disclaimer. */}
                  <PortalSessionsCard profileId={profileId} />
                  {/* Two-way portal data sync - pull real data (test scores, aid
                      awards) into GrantFlow and push GrantFlow funding/awards back
                      into the portal, using the saved session above. Shows real
                      per-host run status. */}
                  <PortalSyncCard profileId={profileId} />
                </div>
              </details>
              <PortalAccessScheduleCard profileId={profileId} />
            </div>
            <WorkAreaLinkCard
              icon={KeyRound}
              title="Pipeline view"
              detail="View and manage grants in your pipeline for this profile."
              actionLabel="Open pipeline"
              onOpen={() => navigate(createPageUrl("Pipeline", { profile_id: profileId }))}
            />
          </TabsContent>

          <TabsContent value="item-funding" className="mt-6">
            <WorkAreaLinkCard
              icon={Search}
              title="Item funding"
              detail="Search for specific item funding opportunities."
              actionLabel="Open item funding"
              onOpen={() => navigate(createPageUrl("ItemFunding", { profile_id: profileId }))}
            />
          </TabsContent>

          <TabsContent value="deadlines" className="mt-6">
            <WorkAreaLinkCard
              icon={Calendar}
              title="Grant deadlines"
              detail="Track upcoming grant deadlines for this profile."
              actionLabel="Open deadlines"
              onOpen={() => navigate(createPageUrl("GrantDeadline", { profile_id: profileId }))}
            />
          </TabsContent>

          <TabsContent value="monitoring" className="mt-6">
            <WorkAreaLinkCard
              icon={ClipboardList}
              title="Grant monitoring"
              detail="Monitor awarded grants and compliance requirements."
              actionLabel={hasOrganizationId ? "Open monitoring" : "Unavailable"}
              onOpen={
                hasOrganizationId
                  ? () => navigate(createPageUrl("GrantMonitoring", { organization_id: profile.organization_id }))
                  : undefined
              }
              disabledReason={
                hasOrganizationId
                  ? undefined
                  : "Grant monitoring is available for organization profiles. Link this profile to an organization to track awarded grants and compliance."
              }
            />
          </TabsContent>

          <TabsContent value="proposals" className="mt-6">
            <div className="space-y-6">
              <WorkAreaLinkCard
                icon={FolderOpen}
                title="Proposals"
                detail="Manage grant proposals linked to this profile's organization."
                actionLabel={hasOrganizationId ? "Open proposals" : "Unavailable"}
                onOpen={
                  hasOrganizationId
                    ? () => navigate(createPageUrl("Proposals", { organization_id: profile.organization_id }))
                    : undefined
                }
                disabledReason={
                  hasOrganizationId
                    ? undefined
                    : "Proposals are tied to an organization. Link this profile to an organization to manage them."
                }
              />
              <div>
                <Button variant="outline" onClick={() => navigate(createPageUrl("Documents", { profile_id: profileId }))}>
                  View Document Library
                </Button>
              </div>

              <ProfileFilesPanel
                profileId={profileId}
                profileName={profile.display_name}
                canDocumentAI={canDocumentAI}
                canDeleteDocuments={canDeleteDocuments}
              />
            </div>
          </TabsContent>

          <TabsContent value="documents" className="mt-6">
            <div className="space-y-6">
              <ProfileFilesPanel
                profileId={profileId}
                profileName={profile.display_name}
                canDocumentAI={canDocumentAI}
                canDeleteDocuments={canDeleteDocuments}
              />
              <ProfileInfoPrint profile={profile} />
              <ProfileAppliedFundingPrint organizationId={profile.organization_id} profileName={profile.display_name} />
            </div>
          </TabsContent>

          <TabsContent value="action-plan" className="mt-6">
            <PrintableProfileTodo profileId={profileId} profileName={profile.display_name} />
          </TabsContent>

          <TabsContent value="billing" className="mt-6 space-y-6">
            <OrgMembersCard profileId={profileId} />
            <div className="rounded-lg border bg-white p-6">
              <h3 className="text-lg font-semibold mb-4">Billing</h3>
              {profile.billing ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium">Current Plan: {profile.billing.plan || 'Standard'}</p>
                      <p className="text-sm text-slate-600">
                        {profile.billing.is_pro_bono ? 'Pro Bono Account' : `$${profile.billing.monthly_rate || 0}/month`}
                      </p>
                    </div>
                    {hasOrganizationId ? null : (
                      <span className="text-sm text-slate-500">Link this profile to an organization to view full billing.</span>
                    )}
                  </div>
                  {profile.billing.is_pro_bono && (
                    <Alert>
                      <AlertDescription>
                        This is a pro bono account. Invoices will show $0 for tax record purposes.
                      </AlertDescription>
                    </Alert>
                  )}
                  <div className="mt-4">
                    <h4 className="font-medium mb-2">Recent Invoice</h4>
                    <p className="text-sm text-slate-600">
                      Amount: ${profile.billing.is_pro_bono ? '0.00' : (profile.billing.last_invoice_amount || '0.00')}
                    </p>
                    <p className="text-sm text-slate-600">
                      Date: {profile.billing.last_invoice_date || 'N/A'}
                    </p>
                  </div>
                </div>
              ) : (
                <p className="text-slate-600">No billing information available for this profile.</p>
              )}
              <div className="mt-6">
                <WorkAreaLinkCard
                  icon={CreditCard}
                  title="Full billing"
                  detail="Open billing, members, invoices, and access details for this profile's organization."
                  actionLabel={hasOrganizationId ? "Open billing" : "Unavailable"}
                  onOpen={
                    hasOrganizationId
                      ? () => navigate(createPageUrl("Billing", { organization_id: profile.organization_id }))
                      : undefined
                  }
                  disabledReason={
                    hasOrganizationId
                      ? undefined
                      : "Link this profile to an organization to view full billing."
                  }
                />
              </div>
            </div>
          </TabsContent>

          <TabsContent value="personalization" className="mt-6">
            <div className="grid gap-6 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>Theme & readability</CardTitle>
                  <CardDescription>Adjust color + font size. These apply immediately across the app.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="space-y-2">
                    <Label>Accent color</Label>
                    <div className="grid grid-cols-4 gap-3">
                      {[
                        { name: "blue", hex: "#3b82f6" },
                        { name: "purple", hex: "#a855f7" },
                        { name: "green", hex: "#22c55e" },
                        { name: "orange", hex: "#f97316" },
                        { name: "rose", hex: "#f43f5e" },
                        { name: "cyan", hex: "#06b6d4" },
                        { name: "amber", hex: "#f59e0b" },
                        { name: "pink", hex: "#ec4899" },
                      ].map((color) => (
                        <button
                          key={color.name}
                          type="button"
                          onClick={() => updatePreference("accent_color", color.name)}
                          className={`h-11 rounded-lg border-2 transition-transform hover:scale-[1.02] ${
                            preferences?.accent_color === color.name
                              ? "border-slate-900 ring-2 ring-slate-900"
                              : "border-slate-200"
                          }`}
                          style={{ backgroundColor: color.hex }}
                          aria-label={`Select ${color.name} accent color`}
                        />
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label>Font size</Label>
                    <Select
                      value={preferences?.font_size ?? ''}
                      onValueChange={(value) => updatePreference("font_size", value)}
                    >
                      <SelectTrigger className="w-48">
                        <SelectValue placeholder="Select font size" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="small">Small</SelectItem>
                        <SelectItem value="medium">Medium</SelectItem>
                        <SelectItem value="large">Large</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Comfort</CardTitle>
                  <CardDescription>Reduce motion, increase contrast, and tune density.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="space-y-2">
                    <Label>Card density</Label>
                    <Select
                      value={preferences?.card_density ?? ''}
                      onValueChange={(value) => updatePreference("card_density", value)}
                    >
                      <SelectTrigger className="w-56">
                        <SelectValue placeholder="Select density" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="compact">Compact</SelectItem>
                        <SelectItem value="comfortable">Comfortable</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="flex items-center justify-between gap-4">
                    <div className="space-y-0.5">
                      <Label>Reduce motion</Label>
                      <p className="text-sm text-slate-500">Less animation and movement.</p>
                    </div>
                    <Switch
                      checked={Boolean(preferences?.reduce_motion)}
                      onCheckedChange={(checked) => updatePreference("reduce_motion", checked)}
                    />
                  </div>

                  <div className="flex items-center justify-between gap-4">
                    <div className="space-y-0.5">
                      <Label>High contrast</Label>
                      <p className="text-sm text-slate-500">Sharper contrast for readability.</p>
                    </div>
                    <Switch
                      checked={Boolean(preferences?.high_contrast)}
                      onCheckedChange={(checked) => updatePreference("high_contrast", checked)}
                    />
                  </div>
                </CardContent>
              </Card>
            </div>

            <div className="mt-6 rounded-lg border bg-white p-4">
              <p className="text-sm text-slate-600">
                Tip: these settings are the same ones used on the main <strong>Settings</strong> page - this tab is just
                a quicker place to tweak them while you are working inside a profile.
              </p>
            </div>
          </TabsContent>

          {isStudentProfile ? (
            <TabsContent value="universities" className="mt-6">
              <div className="space-y-6">
                <SchoolPortalLinkPanel profileId={profileId} />
                <StudentPortalsCard state={studentState} profileId={profileId} applications={universityApplications} />
                <CommittedCollegeWorkspace profileId={profileId} applications={universityApplications} />
              <UniversityApplicationsSection
                applications={universityApplications}
                onSave={handleSaveUniversityApplications}
                saving={savingSectionKey === "university_applications"}
                onAskAI={handleAskUniversityApplications}
                aiLoading={aiLoadingKey === "university_applications"}
                studentGender={studentGender}
                profileId={profileId}
              />
              </div>
            </TabsContent>
          ) : null}

          {isHealthProfile ? (
            <TabsContent value="health" className="mt-6">
              <div className="space-y-6">
                <HealthResourcesCard
                  isOrganization={isOrgProfile}
                  profileId={profileId}
                  state={studentState}
                  conditions={healthMedical?.conditions}
                  supportNeeds={healthMedical?.support_needs}
                  consentForStudies={Boolean(healthMedical?.consent_for_studies)}
                  onEditHealth={() => handleOpenSection("health_medical", healthMedical)}
                  consentSaving={
                    upsertSectionMutation.isPending &&
                    upsertSectionMutation.variables?.sectionKey === "health_medical"
                  }
                  onToggleStudyConsent={handleToggleStudyConsent}
                />
              </div>
            </TabsContent>
          ) : null}
        </Tabs>
      </div>

      <ProfileSectionEditor
        open={Boolean(editingSection)}
        sectionKey={editingSection?.key}
        initialData={editingSection?.data ?? {}}
        focusField={editingSection?.focusField}
        profileId={profileId}
        profileType={profile?.primary_type}
        onClose={handleCloseEditor}
        onSave={handleSaveSection}
        isSaving={Boolean(savingSectionKey)}
        onAskAI={handleAskFromEditor}
      />

      <Dialog open={appearanceOpen} onOpenChange={setAppearanceOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Customize profile view</DialogTitle>
            <DialogDescription>
              Adjust the accent colors and section layout used across your GrantFlow workspace.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-6">
            <div className="space-y-2">
              <Label className="text-xs font-semibold uppercase tracking-wide text-slate-500">Color theme</Label>
              <RadioGroup
                value={preferences?.accent_color}
                onValueChange={handleThemeChange}
                className="grid gap-3 sm:grid-cols-2"
              >
                {themeOptions.map((option) => (
                  <Label
                    key={option.value}
                    htmlFor={`theme-${option.value}`}
                    className={`flex cursor-pointer items-center gap-3 rounded-xl border bg-white px-3 py-2 shadow-sm transition ${
                      preferences?.accent_color === option.value
                        ? "border-blue-500 ring-2 ring-blue-200"
                        : "border-slate-200 hover:border-slate-300"
                    }`}
                  >
                    <RadioGroupItem value={option.value} id={`theme-${option.value}`} />
                    <div className="flex items-center gap-3">
                      <span className={`h-8 w-8 rounded-full ${option.gradient}`} />
                      <span className="text-sm font-medium text-slate-700">{option.label}</span>
                    </div>
                  </Label>
                ))}
              </RadioGroup>
            </div>

            <div className="space-y-2">
              <Label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Section layout
              </Label>
              <RadioGroup
                value={dashboardPrefs.layoutStyle}
                onValueChange={handleLayoutChange}
                className="grid gap-2"
              >
                {layoutOptions.map((option) => (
                  <Label
                    key={option.value}
                    htmlFor={`layout-${option.value}`}
                    className={`flex cursor-pointer items-center gap-3 rounded-xl border bg-white px-3 py-2 shadow-sm transition ${
                      dashboardPrefs.layoutStyle === option.value
                        ? "border-blue-500 ring-2 ring-blue-200"
                        : "border-slate-200 hover:border-slate-300"
                    }`}
                  >
                    <RadioGroupItem value={option.value} id={`layout-${option.value}`} />
                    <span className="text-sm font-medium text-slate-700">{option.label}</span>
                  </Label>
                ))}
              </RadioGroup>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
