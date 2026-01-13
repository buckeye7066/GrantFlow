import React, { useEffect, useMemo, useState, useCallback } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Bot,
  Building2,
  CalendarDays,
  CheckCircle2,
  DollarSign,
  Edit,
  GraduationCap,
  Mail,
  Phone,
  Target,
  Trash2,
  Link as LinkIcon,
  Sparkles,
  Landmark,
  ShieldCheck,
  Layers,
} from "lucide-react"
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter } from "@/components/ui/alert-dialog"
import { useToast } from "@/components/ui/use-toast"
import UniversityApplicationForm from "./UniversityApplicationForm.jsx"

const STATUS_STYLES = {
  planning: { label: "Planning", className: "bg-slate-100 text-slate-700 border-slate-200" },
  interested: { label: "Interested", className: "bg-amber-100 text-amber-700 border-amber-200" },
  in_progress: { label: "In Progress", className: "bg-blue-100 text-blue-700 border-blue-200" },
  submitted: { label: "Submitted", className: "bg-indigo-100 text-indigo-700 border-indigo-200" },
  accepted: { label: "Accepted", className: "bg-emerald-100 text-emerald-700 border-emerald-200" },
  deferred: { label: "Deferred", className: "bg-purple-100 text-purple-700 border-purple-200" },
  waitlisted: { label: "Waitlisted", className: "bg-orange-100 text-orange-700 border-orange-200" },
  denied: { label: "Denied", className: "bg-rose-100 text-rose-700 border-rose-200" },
}

const PIPELINE_STATUS_BADGES = {
  planned: { label: "Planned", className: "bg-slate-100 text-slate-700 border-slate-200" },
  in_progress: { label: "In Progress", className: "bg-sky-100 text-sky-700 border-sky-200" },
  completed: { label: "Completed", className: "bg-emerald-100 text-emerald-700 border-emerald-200" },
  blocked: { label: "Blocked", className: "bg-rose-100 text-rose-700 border-rose-200" },
}

const PIPELINE_STATUS_SEQUENCE = ["planned", "in_progress", "completed", "planned"]

function generateId(prefix = "item") {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

function formatCurrency(value) {
  if (value === null || value === undefined || value === "") return "—"
  const number = Number(value)
  if (!Number.isFinite(number)) return "—"
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(number)
}

function formatPercent(value) {
  if (value === null || value === undefined || value === "") return "—"
  const number = Number(value)
  if (!Number.isFinite(number)) return "—"
  const percent = number > 1 && number <= 100 ? number : number * 100
  return `${percent.toFixed(0)}%`
}

function formatGpa(value) {
  if (value === null || value === undefined || value === "") return "—"
  const number = Number(value)
  if (!Number.isFinite(number)) return "—"
  return number.toFixed(2)
}

function formatDate(value) {
  if (!value) return "—"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "—"
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
}

function safeArray(value) {
  if (Array.isArray(value)) return value
  return []
}

function normaliseApplications(applications) {
  if (!Array.isArray(applications)) return []
  return applications.map((application) => ({
    ...application,
    id: application.id ?? generateId("application"),
    contacts: safeArray(application.contacts).map((contact) => ({
      id: contact.id ?? generateId("contact"),
      label: contact.label ?? "Contact",
      name: contact.name ?? "",
      title: contact.title ?? "",
      email: contact.email ?? "",
      phone: contact.phone ?? "",
      url: contact.url ?? "",
    })),
    financial_aid_pipeline: safeArray(application.financial_aid_pipeline).map((stage) => ({
      id: stage.id ?? generateId("stage"),
      label: stage.label ?? "",
      status: stage.status ?? "planned",
      due_date: stage.due_date ?? "",
      completed_at: stage.completed_at ?? "",
      notes: stage.notes ?? "",
    })),
    department_contacts: safeArray(application.department_contacts).map((entry) => ({
      id: entry.id ?? generateId("department"),
      area: entry.area ?? "",
      name: entry.name ?? "",
      title: entry.title ?? "",
      email: entry.email ?? "",
      phone: entry.phone ?? "",
      notes: entry.notes ?? "",
    })),
    interests: safeArray(application.interests),
    actions: {
      apply_url: application.actions?.apply_url ?? "",
      pay_fee_url: application.actions?.pay_fee_url ?? "",
      visit_url: application.actions?.visit_url ?? "",
    },
  }))
}

function mergeApplications(existing, suggested) {
  const normalisedExisting = normaliseApplications(existing)
  const existingMap = new Map(
    normalisedExisting.map((app) => [app.id, app])
  )

  suggested.forEach((incoming) => {
    const incomingNormalised = normaliseApplications([incoming])[0]
    if (!incomingNormalised) return

    const match =
      [...existingMap.values()].find((app) =>
        app.name && incomingNormalised.name
          ? app.name.toLowerCase() === incomingNormalised.name.toLowerCase()
          : false,
      ) ?? null

    if (match) {
      const merged = {
        ...match,
        ...incomingNormalised,
        contacts: mergeArrayById(match.contacts, incomingNormalised.contacts),
        financial_aid_pipeline: mergeArrayById(match.financial_aid_pipeline, incomingNormalised.financial_aid_pipeline),
        department_contacts: mergeArrayById(match.department_contacts, incomingNormalised.department_contacts),
        interests: mergeUniqueStrings(match.interests, incomingNormalised.interests),
      }
      existingMap.set(merged.id, merged)
    } else {
      existingMap.set(incomingNormalised.id, incomingNormalised)
    }
  })

  return [...existingMap.values()]
}

function mergeArrayById(existing = [], incoming = []) {
  if (existing.length === 0) return incoming
  const map = new Map(existing.map((item) => [item.id ?? generateId("item"), item]))
  incoming.forEach((item) => {
    if (!item) return
    const id = item.id ?? generateId("item")
    map.set(id, { ...map.get(id), ...item, id })
  })
  return [...map.values()]
}

function mergeUniqueStrings(existing = [], incoming = []) {
  const set = new Set()
  existing.forEach((value) => {
    if (typeof value === "string" && value.trim()) {
      set.add(value.trim())
    }
  })
  incoming.forEach((value) => {
    if (typeof value === "string" && value.trim()) {
      set.add(value.trim())
    }
  })
  return [...set]
}

function ExternalLinkButton({ href, children }) {
  if (!href) return null
  return (
    <Button asChild variant="outline" size="sm">
      <a href={href} target="_blank" rel="noopener noreferrer">
        <LinkIcon className="w-4 h-4 mr-2" />
        {children}
      </a>
    </Button>
  )
}

export default function UniversityApplicationsSection({
  applications = [],
  onSave,
  saving = false,
  onAskAI,
  aiLoading = false,
}) {
  const { toast } = useToast()
  const [localApplications, setLocalApplications] = useState(() => normaliseApplications(applications))
  const [isFormOpen, setIsFormOpen] = useState(false)
  const [formMode, setFormMode] = useState("create")
  const [selectedApplication, setSelectedApplication] = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [isPersisting, setIsPersisting] = useState(false)

  useEffect(() => {
    setLocalApplications(normaliseApplications(applications))
  }, [applications])

  const persistenceInFlight = saving || isPersisting

  const persistApplications = useCallback(
    async (nextApplications, successMessage) => {
      if (!onSave) return
      setIsPersisting(true)
      try {
        await onSave(nextApplications)
        toast({
          title: "University applications updated",
          description: successMessage ?? "Changes saved successfully.",
        })
      } catch (error) {
        console.error("Failed to save university applications", error)
        toast({
          variant: "destructive",
          title: "Unable to save changes",
          description:
            error instanceof Error ? error.message : "Please try again after checking your connection.",
        })
        // Revert optimistic changes
        setLocalApplications(normaliseApplications(applications))
      } finally {
        setIsPersisting(false)
      }
    },
    [applications, onSave, toast],
  )

  const handleAddApplication = () => {
    setFormMode("create")
    setSelectedApplication(null)
    setIsFormOpen(true)
  }

  const handleEditApplication = (application) => {
    setFormMode("edit")
    setSelectedApplication(application)
    setIsFormOpen(true)
  }

  const handleFormSubmit = async (applicationData) => {
    const nextApplications =
      formMode === "edit"
        ? localApplications.map((application) =>
            application.id === applicationData.id ? applicationData : application,
          )
        : [...localApplications, applicationData]

    setLocalApplications(nextApplications)
    await persistApplications(
      nextApplications,
      formMode === "edit" ? "Application details updated." : "Application added to the profile.",
    )
    setIsFormOpen(false)
  }

  const handleDeleteConfirmed = async () => {
    if (!deleteTarget) return
    const nextApplications = localApplications.filter((application) => application.id !== deleteTarget.id)
    setLocalApplications(nextApplications)
    await persistApplications(nextApplications, "Application removed.")
    setDeleteTarget(null)
  }

  const handleTogglePipelineStatus = async (applicationId, stageId) => {
    const nextApplications = localApplications.map((application) => {
      if (application.id !== applicationId) return application
      const updatedStages = application.financial_aid_pipeline.map((stage) => {
        if (stage.id !== stageId) return stage
        const currentIndex = PIPELINE_STATUS_SEQUENCE.indexOf(stage.status)
        const nextStatus =
          currentIndex === -1
            ? "planned"
            : PIPELINE_STATUS_SEQUENCE[(currentIndex + 1) % PIPELINE_STATUS_SEQUENCE.length]
        return { ...stage, status: nextStatus }
      })
      return { ...application, financial_aid_pipeline: updatedStages }
    })
    setLocalApplications(nextApplications)
    await persistApplications(nextApplications, "Updated pipeline progress.")
  }

  const handleAiAssist = async () => {
    if (!onAskAI) return
    setIsPersisting(true)
    try {
      const response = await onAskAI()
      const suggestion =
        response?.applications ??
        response?.suggestion?.applications ??
        response?.suggestion ??
        []
      if (!Array.isArray(suggestion) || suggestion.length === 0) {
        toast({
          title: "No AI updates found",
          description: "The assistant did not return any university data to merge.",
        })
        return
      }
      const merged = mergeApplications(localApplications, suggestion)
      setLocalApplications(merged)
      await persistApplications(merged, "AI suggestions merged into your university list.")
    } catch (error) {
      console.error("AI enrichment failed", error)
      toast({
        variant: "destructive",
        title: "AI enrichment failed",
        description:
          error instanceof Error ? error.message : "Unable to retrieve university insights right now.",
      })
    } finally {
      setIsPersisting(false)
    }
  }

  const summary = useMemo(() => {
    const total = localApplications.length
    const submitted = localApplications.filter((app) => app.status === "submitted").length
    const accepted = localApplications.filter((app) => app.status === "accepted").length
    const scholarships =
      localApplications.reduce((count, app) => {
        const pipeline = safeArray(app.financial_aid_pipeline)
        return (
          count +
          pipeline.filter((stage) =>
            stage.label?.toLowerCase().includes("scholarship") && stage.status === "completed",
          ).length
        )
      }, 0)
    return { total, submitted, accepted, scholarships }
  }, [localApplications])

  return (
    <Card className="mt-10 border-slate-200 shadow-sm">
      <CardHeader className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <CardTitle className="text-xl font-semibold text-slate-900 flex items-center gap-2">
            <GraduationCap className="w-5 h-5 text-indigo-600" />
            University Applications
          </CardTitle>
          <p className="text-sm text-slate-600 mt-1 max-w-2xl">
            Track admissions status, financial aid milestones, and key contacts for every school this
            student is pursuing. Mark financial aid pipeline steps as they’re completed to keep the team
            aligned.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mt-5">
            <SummaryPill icon={Building2} label="Schools Tracked" value={summary.total} accent="bg-slate-100 text-slate-700 border-slate-200" />
            <SummaryPill icon={CheckCircle2} label="Submitted" value={summary.submitted} accent="bg-indigo-100 text-indigo-700 border-indigo-200" />
            <SummaryPill icon={ShieldCheck} label="Accepted" value={summary.accepted} accent="bg-emerald-100 text-emerald-700 border-emerald-200" />
            <SummaryPill icon={Layers} label="Scholarship Wins" value={summary.scholarships} accent="bg-amber-100 text-amber-700 border-amber-200" />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {onAskAI ? (
            <Button
              type="button"
              variant="outline"
              onClick={handleAiAssist}
              disabled={persistenceInFlight || aiLoading}
            >
              {aiLoading || persistenceInFlight ? (
                <>
                  <Bot className="w-4 h-4 mr-2 animate-spin" />
                  Gathering insights…
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4 mr-2" />
                  Ask AI for new schools
                </>
              )}
            </Button>
          ) : null}
          <Button type="button" onClick={handleAddApplication} disabled={persistenceInFlight}>
            Add University
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {localApplications.length === 0 ? (
          <Alert>
            <AlertDescription>
              No universities have been added yet. Use <span className="font-semibold">Add University</span> to
              capture admissions details, upload decisions, and plan financial aid tasks.
            </AlertDescription>
          </Alert>
        ) : (
          <div className="space-y-6">
            {localApplications
              .slice()
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((application) => (
                <ApplicationCard
                  key={application.id}
                  application={application}
                  onEdit={() => handleEditApplication(application)}
                  onDelete={() => setDeleteTarget(application)}
                  onToggleStage={handleTogglePipelineStatus}
                />
              ))}
          </div>
        )}
      </CardContent>

      <UniversityApplicationForm
        open={isFormOpen}
        mode={formMode}
        initialValues={selectedApplication}
        onSubmit={handleFormSubmit}
        onClose={() => setIsFormOpen(false)}
        isSubmitting={persistenceInFlight}
      />

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove university from this profile?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove <span className="font-semibold">{deleteTarget?.name}</span> and all of its
              financial aid tracking data. Documents uploaded elsewhere will remain.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)} disabled={persistenceInFlight}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteConfirmed}
              disabled={persistenceInFlight}
            >
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

function SummaryPill({ icon: Icon, label, value, accent }) {
  return (
    <div className={`border rounded-xl px-4 py-3 flex items-center gap-3 ${accent}`}>
      <div className="p-2 bg-white/60 rounded-lg">
        <Icon className="w-4 h-4" />
      </div>
      <div>
        <p className="text-xs uppercase font-semibold tracking-wide">{label}</p>
        <p className="text-lg font-bold">{value}</p>
      </div>
    </div>
  )
}

function ApplicationCard({ application, onEdit, onDelete, onToggleStage }) {
  const statusStyle = STATUS_STYLES[application.status] ?? STATUS_STYLES.planning
  const pipeline = safeArray(application.financial_aid_pipeline)
  const contacts = safeArray(application.contacts)
  const departmentContacts = safeArray(application.department_contacts)
  const interests = safeArray(application.interests)

  return (
    <div className="border border-slate-200 rounded-xl shadow-sm bg-white">
      <div className="p-5 border-b border-slate-100 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="space-y-2">
          <div className="flex items-center gap-3 flex-wrap">
            <h3 className="text-lg font-semibold text-slate-900">{application.name}</h3>
            <Badge className={`uppercase tracking-wide ${statusStyle.className}`}>{statusStyle.label}</Badge>
            <Badge variant="outline" className="text-xs">
              {application.institution_type?.replace(/_/g, " ") ?? "Institution"}
            </Badge>
            {application.test_optional ? (
              <Badge variant="outline" className="bg-emerald-50 border-emerald-200 text-emerald-700">
                ✓ Test Optional
              </Badge>
            ) : null}
            {application.essay_required ? (
              <Badge variant="outline" className="bg-amber-50 border-amber-200 text-amber-700">
                Essay Required
              </Badge>
            ) : (
              <Badge variant="outline" className="bg-slate-50 border-slate-200 text-slate-600">
                No Essay
              </Badge>
            )}
            {application.rec_letters_required ? (
              <Badge variant="outline" className="bg-blue-50 border-blue-200 text-blue-700">
                {application.rec_letters_required} Rec Letters
              </Badge>
            ) : (
              <Badge variant="outline" className="bg-slate-50 border-slate-200 text-slate-600">
                No Rec Letters
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap gap-3 text-sm text-slate-600">
            <InlineStat icon={CalendarDays} label="App Deadline" value={formatDate(application.application_deadline)} />
            <InlineStat icon={CalendarDays} label="Aid Deadline" value={formatDate(application.financial_aid_deadline)} />
            <InlineStat icon={CalendarDays} label="Decision" value={formatDate(application.decision_release_date)} />
            <InlineStat icon={DollarSign} label="Application Fee" value={formatCurrency(application.application_fee)} />
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <ExternalLinkButton href={application.actions?.apply_url}>Apply</ExternalLinkButton>
          <ExternalLinkButton href={application.actions?.pay_fee_url}>Pay Fee</ExternalLinkButton>
          <ExternalLinkButton href={application.actions?.visit_url}>Visit</ExternalLinkButton>
          <Button variant="outline" size="icon" onClick={onEdit}>
            <Edit className="w-4 h-4" />
          </Button>
          <Button variant="outline" size="icon" onClick={onDelete}>
            <Trash2 className="w-4 h-4 text-rose-600" />
          </Button>
        </div>
      </div>

      <div className="p-5 grid gap-5 lg:grid-cols-12">
        <div className="lg:col-span-4 space-y-4">
          <h4 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
            <Landmark className="w-4 h-4 text-indigo-600" />
            Admissions Snapshot
          </h4>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <StatBox label="Acceptance Rate" value={formatPercent(application.acceptance_rate)} />
            <StatBox label="Avg GPA" value={formatGpa(application.avg_gpa)} />
            <StatBox label="SAT Range" value={application.sat_range || "—"} />
            <StatBox label="Tuition" value={formatCurrency(application.tuition)} />
            <StatBox label="FAFSA Code" value={application.fafsa_code || "—"} />
            <StatBox label="Application Type" value={application.application_type?.replace(/_/g, " ") ?? "—"} />
          </div>

          {interests.length > 0 ? (
            <div className="space-y-2">
              <h5 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Student Interests</h5>
              <div className="flex flex-wrap gap-2">
                {interests.map((interest) => (
                  <Badge key={interest} variant="outline">
                    {interest}
                  </Badge>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <div className="lg:col-span-4 space-y-4">
          <h4 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
            <Mail className="w-4 h-4 text-indigo-600" />
            University Contacts
          </h4>
          <div className="space-y-3">
            {contacts.length === 0 ? (
              <p className="text-sm text-slate-500">No contacts recorded yet.</p>
            ) : (
              contacts.map((contact) => (
                <div key={contact.id} className="border border-slate-100 rounded-lg p-3 space-y-1">
                  <p className="text-xs uppercase tracking-wide text-slate-500 font-semibold">{contact.label}</p>
                  {contact.name ? <p className="text-sm font-medium text-slate-800">{contact.name}</p> : null}
                  {contact.title ? <p className="text-xs text-slate-500">{contact.title}</p> : null}
                  {contact.email ? (
                    <p className="text-xs text-blue-600">
                      <a href={`mailto:${contact.email}`} className="hover:underline">
                        <Mail className="inline-block w-3 h-3 mr-1" />
                        {contact.email}
                      </a>
                    </p>
                  ) : null}
                  {contact.phone ? (
                    <p className="text-xs text-blue-600">
                      <a href={`tel:${contact.phone}`} className="hover:underline">
                        <Phone className="inline-block w-3 h-3 mr-1" />
                        {contact.phone}
                      </a>
                    </p>
                  ) : null}
                  {contact.url ? (
                    <p className="text-xs">
                      <a href={contact.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                        <LinkIcon className="inline-block w-3 h-3 mr-1" />
                        {contact.url}
                      </a>
                    </p>
                  ) : null}
                </div>
              ))
            )}
          </div>

          {departmentContacts.length > 0 ? (
            <div className="space-y-2">
              <h5 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Department & Program Leads
              </h5>
              <div className="space-y-2">
                {departmentContacts.map((contact) => (
                  <div key={contact.id} className="border border-slate-100 rounded-lg p-3 space-y-1 text-xs">
                    <p className="font-semibold text-slate-700">{contact.area || "Program"}</p>
                    <p className="text-slate-600">
                      {contact.name}
                      {contact.title ? ` • ${contact.title}` : ""}
                    </p>
                    <div className="flex flex-wrap gap-2 text-blue-600">
                      {contact.email ? (
                        <a href={`mailto:${contact.email}`} className="hover:underline flex items-center gap-1">
                          <Mail className="w-3 h-3" /> Email
                        </a>
                      ) : null}
                      {contact.phone ? (
                        <a href={`tel:${contact.phone}`} className="hover:underline flex items-center gap-1">
                          <Phone className="w-3 h-3" /> Call
                        </a>
                      ) : null}
                    </div>
                    {contact.notes ? <p className="text-slate-500">{contact.notes}</p> : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <div className="lg:col-span-4 space-y-4">
          <h4 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
            <Target className="w-4 h-4 text-indigo-600" />
            Financial Aid Pipeline
          </h4>
          <div className="space-y-3">
            {pipeline.length === 0 ? (
              <p className="text-sm text-slate-500">Add FAFSA, scholarship, or institutional aid steps to stay on track.</p>
            ) : (
              pipeline.map((stage) => {
                const badge = PIPELINE_STATUS_BADGES[stage.status] ?? PIPELINE_STATUS_BADGES.planned
                return (
                  <div key={stage.id} className="border border-slate-100 rounded-lg p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium text-slate-800">{stage.label || "Aid milestone"}</p>
                        <p className="text-xs text-slate-500">
                          Due {formatDate(stage.due_date)}
                          {stage.completed_at ? ` • Completed ${formatDate(stage.completed_at)}` : ""}
                        </p>
                        {stage.notes ? <p className="text-xs text-slate-600 mt-1">{stage.notes}</p> : null}
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className={`text-xs ${badge.className}`}
                        onClick={() => onToggleStage(application.id, stage.id)}
                      >
                        {badge.label}
                      </Button>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>
      </div>

      {application.notes ? (
        <>
          <Separator />
          <div className="p-5">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Advisor Notes</h4>
            <p className="text-sm text-slate-700 mt-2 whitespace-pre-line">{application.notes}</p>
          </div>
        </>
      ) : null}
    </div>
  )
}

function InlineStat({ icon: Icon, label, value }) {
  return (
    <span className="flex items-center gap-1 text-xs text-slate-600">
      <Icon className="w-3 h-3 text-slate-400" />
      <span className="font-medium text-slate-700">{label}:</span> {value}
    </span>
  )
}

function StatBox({ label, value }) {
  return (
    <div className="border border-slate-100 rounded-lg px-3 py-2">
      <p className="text-xs uppercase text-slate-500 tracking-wide font-semibold">{label}</p>
      <p className="text-sm font-semibold text-slate-900 mt-1">{value}</p>
    </div>
  )
}
