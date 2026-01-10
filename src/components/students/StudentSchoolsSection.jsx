import React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/components/ui/use-toast"
import { upsertProfileSection } from "@/api/profiles"
import { triggerProfileEnrichment } from "@/api/crawlers"
import { ExternalLink, Plus, RefreshCw } from "lucide-react"

function titleCase(value = "") {
  return value
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1))
}

function formatPct(value) {
  if (value === null || value === undefined || value === "") return "—"
  const num = Number(value)
  return Number.isFinite(num) ? `${Math.round(num)}%` : "—"
}

function formatMoney(value) {
  if (value === null || value === undefined || value === "") return "—"
  const num = Number(value)
  if (!Number.isFinite(num)) return "—"
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(num)
}

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

function normalizeUrl(value) {
  if (!value || typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed
}

function buildDeadlinePrompt({ schoolName }) {
  return `
Update ONLY the "${schoolName}" entry inside the "university_applications" section.

Focus on deadlines + portals + contacts:
- application_deadline
- financial_aid_deadline
- decision_release_date
- actions.apply_url / pay_fee_url / visit_url
- contacts.admissions + contacts.financial_aid
- department_contacts for the student's interests (coach/director/dean when applicable)

Do not add duplicate schools. If the school already exists, update/extend it.
If a field cannot be confirmed, leave it null/empty.
  `.trim()
}

export default function StudentSchoolsSection({ profile }) {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const sectionMap = React.useMemo(() => {
    const map = new Map()
    ;(profile.sections ?? []).forEach((section) => {
      map.set(section.section_key, section)
    })
    return map
  }, [profile.sections])

  const universityApps = sectionMap.get("university_applications")?.data ?? { applications: [] }
  const education = sectionMap.get("education")?.data ?? {}
  const applications = safeArray(universityApps.applications)
  const pastSchools = safeArray(education.past_schools)

  const [selected, setSelected] = React.useState(null)
  const [addOpen, setAddOpen] = React.useState(false)
  const [addForm, setAddForm] = React.useState({
    name: "",
    application_type: "regular_decision",
    institution_type: "public",
    interests: "",
  })

  const upsertMutation = useMutation({
    mutationFn: async (nextData) => upsertProfileSection(profile.id, "university_applications", nextData),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["profile", profile.id] })
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : "Unable to save school updates."
      toast({ title: "Save failed", description: message, variant: "destructive" })
    },
  })

  const enrichmentMutation = useMutation({
    mutationFn: async ({ schoolName }) =>
      triggerProfileEnrichment({
        profileId: profile.id,
        sections: ["university_applications"],
        prompt: buildDeadlinePrompt({ schoolName }),
      }),
    onSuccess: () => {
      toast({
        title: "Deadline refresh queued",
        description: "AI will update deadlines/contacts for this school as it finds verified info.",
      })
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : "Unable to queue the AI refresh."
      toast({ title: "Request failed", description: message, variant: "destructive" })
    },
  })

  const isStudentProfile = ["student", "high_school_student", "college_student"].includes(profile.primary_type)
  if (!isStudentProfile) return null

  const saveApplications = (nextApplications) => {
    const nextData = { ...(universityApps ?? {}), applications: nextApplications }
    upsertMutation.mutate(nextData)
  }

  const updateApplication = (name, updater) => {
    const next = applications.map((app) => {
      if (!app || typeof app !== "object") return app
      if ((app.name ?? "") !== name) return app
      return updater(app)
    })
    saveApplications(next)
  }

  const toggleInterested = (app, checked) => {
    const currentStatus = app.status ?? "planning"
    const nextStatus = checked ? (currentStatus === "planning" ? "interested" : currentStatus) : "planning"
    updateApplication(app.name, (prev) => ({
      ...prev,
      status: nextStatus,
    }))
  }

  const toggleApplied = (app, checked) => {
    const nextStatus = checked ? "submitted" : "interested"
    updateApplication(app.name, (prev) => ({
      ...prev,
      status: nextStatus,
    }))

    if (checked) {
      enrichmentMutation.mutate({ schoolName: app.name })
    }
  }

  const portals = [
    { label: "FAFSA", url: normalizeUrl(education.fafsa_portal_url) },
    { label: "Common App", url: normalizeUrl(education.commonapp_profile_url) },
    { label: "Transcript Portal", url: normalizeUrl(education.transcript_portal_url) },
    { label: "Test Scores Portal", url: normalizeUrl(education.test_scores_portal_url) },
  ].filter((entry) => Boolean(entry.url))

  return (
    <>
      <section className="rounded-3xl border border-slate-200 bg-white/80 backdrop-blur-sm shadow-sm p-6 md:p-8 space-y-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="space-y-1">
            <h2 className="text-xl font-semibold text-slate-900">Schools</h2>
            <p className="text-sm text-slate-600">
              Track interested/applied schools, contacts, and deadlines. Click a school card for details.
            </p>
            {education.current_school ? (
              <p className="text-xs text-slate-500">Current school: {education.current_school}</p>
            ) : null}
            {pastSchools.length > 0 ? (
              <p className="text-xs text-slate-500">
                Past schools: {pastSchools.length}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => setAddOpen(true)}
              disabled={upsertMutation.isPending}
            >
              <Plus className="w-4 h-4" />
              Add School
            </Button>
            {portals.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {portals.map((portal) => (
                  <Button
                    key={portal.label}
                    variant="outline"
                    size="sm"
                    className="gap-2"
                    onClick={() => window.open(portal.url, "_blank", "noopener,noreferrer")}
                  >
                    <ExternalLink className="w-4 h-4" />
                    {portal.label}
                  </Button>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        {applications.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-sm text-slate-600">
            No schools added yet. Click <span className="font-semibold">Add School</span> to start tracking colleges and deadlines.
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {applications.map((app) => {
              if (!app || typeof app !== "object") return null
              const status = app.status ?? "planning"
              const isInterested = status !== "planning"
              const isApplied = status === "submitted" || status === "accepted" || status === "deferred" || status === "waitlisted"

              const metrics = [
                { label: "Accept Rate", value: formatPct(app.acceptance_rate) },
                { label: "Avg GPA", value: app.avg_gpa ?? "—" },
                { label: "SAT", value: app.sat_range || (app.sat_score ? String(app.sat_score) : "—") },
                { label: "Tuition", value: formatMoney(app.tuition) },
                { label: "FAFSA", value: app.fafsa_code || "—" },
              ]

              const applyUrl = normalizeUrl(app.actions?.apply_url)
              const payFeeUrl = normalizeUrl(app.actions?.pay_fee_url)
              const visitUrl = normalizeUrl(app.actions?.visit_url)

              return (
                <Card
                  key={app.name}
                  className="border border-slate-200 bg-white/70 backdrop-blur-md shadow-sm hover:border-blue-200 cursor-pointer transition"
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelected(app)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault()
                      setSelected(app)
                    }
                  }}
                >
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1">
                        <CardTitle className="text-base font-semibold text-slate-900">{app.name}</CardTitle>
                        <p className="text-xs text-slate-500">
                          {titleCase(app.application_type || "regular_decision")} • {titleCase(app.institution_type || "public")}
                        </p>
                      </div>
                      <Badge className="capitalize bg-slate-100 text-slate-700 border border-slate-200">
                        {titleCase(status)}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-2 gap-2">
                      {metrics.map((m) => (
                        <div key={m.label} className="rounded-lg border border-slate-200 bg-slate-50/70 p-2">
                          <p className="text-[11px] uppercase tracking-wide text-slate-500">{m.label}</p>
                          <p className="text-sm font-semibold text-slate-900 mt-1">{String(m.value)}</p>
                        </div>
                      ))}
                    </div>

                    <div className="flex flex-wrap items-center gap-4">
                      <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          id={`${app.name}-interested`}
                          checked={isInterested}
                          onCheckedChange={(value) => toggleInterested(app, Boolean(value))}
                          disabled={upsertMutation.isPending}
                        />
                        <Label htmlFor={`${app.name}-interested`} className="text-sm text-slate-700">
                          Interested
                        </Label>
                      </div>
                      <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          id={`${app.name}-applied`}
                          checked={isApplied}
                          onCheckedChange={(value) => toggleApplied(app, Boolean(value))}
                          disabled={upsertMutation.isPending}
                        />
                        <Label htmlFor={`${app.name}-applied`} className="text-sm text-slate-700">
                          Applied
                        </Label>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2" onClick={(e) => e.stopPropagation()}>
                      {applyUrl ? (
                        <Button variant="outline" size="sm" className="gap-2" onClick={() => window.open(applyUrl, "_blank")}>
                          <ExternalLink className="w-4 h-4" /> Apply
                        </Button>
                      ) : null}
                      {payFeeUrl ? (
                        <Button variant="outline" size="sm" className="gap-2" onClick={() => window.open(payFeeUrl, "_blank")}>
                          <ExternalLink className="w-4 h-4" /> Pay Fee
                        </Button>
                      ) : null}
                      {visitUrl ? (
                        <Button variant="outline" size="sm" className="gap-2" onClick={() => window.open(visitUrl, "_blank")}>
                          <ExternalLink className="w-4 h-4" /> Visit
                        </Button>
                      ) : null}
                      {isApplied ? (
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-2"
                          onClick={() => enrichmentMutation.mutate({ schoolName: app.name })}
                          disabled={enrichmentMutation.isPending}
                        >
                          <RefreshCw className="w-4 h-4" />
                          Refresh deadlines
                        </Button>
                      ) : null}
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}
      </section>

      <Dialog open={Boolean(selected)} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{selected?.name ?? "School"}</DialogTitle>
            <DialogDescription>
              Contacts, synopsis, deadlines, and program-specific departments (coach/director/dean).
            </DialogDescription>
          </DialogHeader>

          {selected ? (
            <div className="space-y-5">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Deadlines</p>
                  <div className="mt-2 space-y-1 text-sm text-slate-700">
                    <div>Application: {selected.application_deadline ?? "—"}</div>
                    <div>Financial Aid: {selected.financial_aid_deadline ?? "—"}</div>
                    <div>Decision Release: {selected.decision_release_date ?? "—"}</div>
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Synopsis</p>
                  <div className="mt-2 space-y-1 text-sm text-slate-700">
                    <div>Acceptance rate: {formatPct(selected.acceptance_rate)}</div>
                    <div>Avg GPA: {selected.avg_gpa ?? "—"}</div>
                    <div>SAT: {selected.sat_range || "—"}</div>
                    <div>Tuition: {formatMoney(selected.tuition)}</div>
                  </div>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-slate-200 bg-white p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Admissions</p>
                  <div className="mt-2 text-sm text-slate-700 space-y-1">
                    <div>{selected.contacts?.admissions?.name || "—"}</div>
                    <div className="text-slate-500">{selected.contacts?.admissions?.title || ""}</div>
                    {selected.contacts?.admissions?.email ? <div>Email: {selected.contacts.admissions.email}</div> : null}
                    {selected.contacts?.admissions?.phone ? <div>Phone: {selected.contacts.admissions.phone}</div> : null}
                    {normalizeUrl(selected.contacts?.admissions?.url) ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-2 mt-2"
                        onClick={() => window.open(selected.contacts.admissions.url, "_blank")}
                      >
                        <ExternalLink className="w-4 h-4" />
                        Admissions portal
                      </Button>
                    ) : null}
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Financial Aid</p>
                  <div className="mt-2 text-sm text-slate-700 space-y-1">
                    <div>{selected.contacts?.financial_aid?.name || "—"}</div>
                    <div className="text-slate-500">{selected.contacts?.financial_aid?.title || ""}</div>
                    {selected.contacts?.financial_aid?.email ? <div>Email: {selected.contacts.financial_aid.email}</div> : null}
                    {selected.contacts?.financial_aid?.phone ? <div>Phone: {selected.contacts.financial_aid.phone}</div> : null}
                    {normalizeUrl(selected.contacts?.financial_aid?.url) ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-2 mt-2"
                        onClick={() => window.open(selected.contacts.financial_aid.url, "_blank")}
                      >
                        <ExternalLink className="w-4 h-4" />
                        Financial aid portal
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>

              {safeArray(selected.department_contacts).length > 0 ? (
                <div className="rounded-xl border border-slate-200 bg-white p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Departments / Programs</p>
                  <div className="mt-3 space-y-3">
                    {safeArray(selected.department_contacts).map((contact, idx) => (
                      <div key={`${contact.area}-${idx}`} className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-sm font-semibold text-slate-900">{contact.area || "Program"}</p>
                          {contact.title ? (
                            <Badge variant="secondary" className="text-xs">
                              {contact.title}
                            </Badge>
                          ) : null}
                        </div>
                        <div className="mt-2 text-sm text-slate-700 space-y-1">
                          <div>{contact.name || "—"}</div>
                          {contact.email ? <div>Email: {contact.email}</div> : null}
                          {contact.phone ? <div>Phone: {contact.phone}</div> : null}
                          {contact.notes ? <div className="text-slate-500">{contact.notes}</div> : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add a school</DialogTitle>
            <DialogDescription>
              Add the school now; AI can enrich contacts/deadlines once you mark it as applied.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="school-name">School name</Label>
              <Input
                id="school-name"
                value={addForm.name}
                onChange={(e) => setAddForm((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="e.g., Middle Tennessee State University"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="school-interests">Interests / programs (comma-separated)</Label>
              <Textarea
                id="school-interests"
                rows={3}
                value={addForm.interests}
                onChange={(e) => setAddForm((prev) => ({ ...prev, interests: e.target.value }))}
                placeholder="e.g., forensics, band, volleyball"
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <Button variant="ghost" onClick={() => setAddOpen(false)} disabled={upsertMutation.isPending}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  const name = addForm.name.trim()
                  if (!name) {
                    toast({
                      title: "School name required",
                      description: "Please enter a school name before saving.",
                      variant: "destructive",
                    })
                    return
                  }
                  const interests = addForm.interests
                    .split(",")
                    .map((i) => i.trim())
                    .filter(Boolean)
                  const next = applications.concat([
                    {
                      name,
                      status: "planning",
                      application_type: addForm.application_type,
                      institution_type: addForm.institution_type,
                      acceptance_rate: null,
                      avg_gpa: null,
                      sat_range: "",
                      tuition: null,
                      fafsa_code: "",
                      application_fee: null,
                      test_optional: false,
                      essay_required: false,
                      rec_letters_required: 0,
                      application_deadline: null,
                      financial_aid_deadline: null,
                      decision_release_date: null,
                      interests,
                      actions: { apply_url: null, pay_fee_url: null, visit_url: null },
                      contacts: {
                        admissions: { name: "", title: "", email: "", phone: "", url: "" },
                        financial_aid: { name: "", title: "", email: "", phone: "", url: "" },
                        general: { name: "", title: "", email: "", phone: "", url: "" },
                      },
                      department_contacts: [],
                      financial_aid_pipeline: [],
                      notes: "",
                    },
                  ])
                  saveApplications(next)
                  setAddOpen(false)
                  setAddForm({
                    name: "",
                    application_type: "regular_decision",
                    institution_type: "public",
                    interests: "",
                  })
                }}
                disabled={upsertMutation.isPending}
              >
                Save school
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

