import React, { useEffect, useMemo, useRef, useState, useCallback } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Bot,
  Building2,
  CalendarDays,
  CheckCircle2,
  DollarSign,
  Edit,
  GraduationCap,
  Mail,
  MapPin,
  Phone,
  Target,
  Trash2,
  Link as LinkIcon,
  Sparkles,
  Landmark,
  ShieldCheck,
  Layers,
  ListChecks,
  FileUp,
  Loader2,
} from "lucide-react"
import { fetchLocalFundingByZip } from "@/api/colleges.js"
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter } from "@/components/ui/alert-dialog"
import { useToast } from "@/components/ui/use-toast"
import UniversityApplicationForm from "./UniversityApplicationForm.jsx"
import { deleteDocument, ingestDocument, listDocuments } from "@/api/documents"
import DocumentItem from "@/components/documents/DocumentItem"
import { useSchoolAIAssist, mapAIDataToApplicationPatch, AIAssistButton, AIAssistLog, SchoolAIAssistStyles } from "./SchoolCardAIAssist"

const STATUS_STYLES = {
  planning: { label: "Planning", className: "bg-slate-100 text-slate-700 border-slate-200" },
  interested: { label: "Interested", className: "bg-amber-100 text-amber-700 border-amber-200" },
  in_progress: { label: "In Progress", className: "bg-blue-100 text-blue-700 border-blue-200" },
  submitted: { label: "Submitted", className: "bg-indigo-100 text-indigo-700 border-indigo-200" },
  accepted: { label: "Accepted", className: "bg-emerald-100 text-emerald-700 border-emerald-200" },
  committed: { label: "Committed", className: "bg-emerald-200 text-emerald-900 border-emerald-300 font-bold" },
  deferred: { label: "Deferred", className: "bg-purple-100 text-purple-700 border-purple-200" },
  waitlisted: { label: "Waitlisted", className: "bg-orange-100 text-orange-700 border-orange-200" },
  denied: { label: "Denied", className: "bg-rose-100 text-rose-700 border-rose-200" },
}

// Status values that mark a school as "the one I'm attending". Mirrors
// COMMITTED_SCHOOL_STATUSES in backend/services/crawlers/crawlerManager.js
// so the UI's "committed" badge and the backend's school-card narrowing
// agree on the same vocabulary.
const COMMITTED_STATUSES = new Set(["committed", "enrolled", "attending"])
const isCommittedStatus = (status) =>
  COMMITTED_STATUSES.has(String(status || "").trim().toLowerCase())

const PIPELINE_STATUS_BADGES = {
  planned: { label: "Planned", className: "bg-slate-100 text-slate-700 border-slate-200" },
  in_progress: { label: "In Progress", className: "bg-sky-100 text-sky-700 border-sky-200" },
  completed: { label: "Completed", className: "bg-emerald-100 text-emerald-700 border-emerald-200" },
  blocked: { label: "Blocked", className: "bg-rose-100 text-rose-700 border-rose-200" },
}

const PIPELINE_STATUS_SEQUENCE = ["planned", "in_progress", "completed", "planned"]

const DEFAULT_ACTIVITY_CATALOG = [
  // Athletics (varsity / club / intramural varies by school; this is a starter set)
  { id: "sport_basketball", label: "Basketball", category: "Sports" },
  { id: "sport_soccer", label: "Soccer", category: "Sports" },
  { id: "sport_volleyball", label: "Volleyball", category: "Sports" },
  { id: "sport_softball", label: "Softball", category: "Sports" },
  { id: "sport_baseball", label: "Baseball", category: "Sports" },
  { id: "sport_tennis", label: "Tennis", category: "Sports" },
  { id: "sport_track", label: "Track & Field", category: "Sports" },
  { id: "sport_cross_country", label: "Cross Country", category: "Sports" },
  { id: "sport_swimming", label: "Swimming", category: "Sports" },
  { id: "sport_golf", label: "Golf", category: "Sports" },
  { id: "sport_cheer", label: "Cheerleading", category: "Sports" },
  { id: "sport_dance", label: "Dance Team", category: "Sports" },
  { id: "sport_wrestling", label: "Wrestling", category: "Sports" },
  { id: "sport_lacrosse", label: "Lacrosse", category: "Sports" },
  { id: "sport_field_hockey", label: "Field Hockey", category: "Sports" },

  // Arts & performance
  { id: "arts_band", label: "Band", category: "Arts & Performance" },
  { id: "arts_choir", label: "Choir", category: "Arts & Performance" },
  { id: "arts_orchestra", label: "Orchestra", category: "Arts & Performance" },
  { id: "arts_theatre", label: "Theatre", category: "Arts & Performance" },
  { id: "arts_visual", label: "Visual Arts", category: "Arts & Performance" },

  // Academic / professional clubs
  { id: "club_robotics", label: "Robotics Club", category: "Academic & Professional" },
  { id: "club_debate", label: "Debate Team", category: "Academic & Professional" },
  { id: "club_student_gov", label: "Student Government", category: "Academic & Professional" },
  { id: "club_pre_med", label: "Pre-Med Society", category: "Academic & Professional" },
  { id: "club_pre_law", label: "Pre-Law Society", category: "Academic & Professional" },
  { id: "club_nursing", label: "Nursing Student Association", category: "Academic & Professional" },
  { id: "club_business", label: "Business Club", category: "Academic & Professional" },
  { id: "club_engineering", label: "Engineering Club", category: "Academic & Professional" },
  { id: "club_cs", label: "Computer Science Club", category: "Academic & Professional" },

  // Service / leadership
  { id: "service_volunteer", label: "Volunteer/Service Organizations", category: "Service & Leadership" },
  { id: "service_rotaract", label: "Rotaract", category: "Service & Leadership" },
  { id: "service_peer_mentor", label: "Peer Mentoring", category: "Service & Leadership" },

  // Greek life
  { id: "greek_fraternity", label: "Fraternity (Greek Life)", category: "Greek Life" },
  { id: "greek_sorority", label: "Sorority (Greek Life)", category: "Greek Life" },

  // Faith & identity
  { id: "faith_campus_ministry", label: "Campus Ministry / Faith Groups", category: "Community" },
  { id: "community_cultural", label: "Cultural/Identity Organizations", category: "Community" },
]

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

function normalizeActivityCatalog(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (!item) return null
      if (typeof item === "string") {
        const label = item.trim()
        if (!label) return null
        return { id: generateId("activity"), label, category: "Custom" }
      }
      const label = typeof item.label === "string" ? item.label.trim() : ""
      if (!label) return null
      return {
        id: item.id ?? generateId("activity"),
        label,
        category: typeof item.category === "string" ? item.category.trim() : "Custom",
      }
    })
    .filter(Boolean)
}

function buildEffectiveActivityOptions(application) {
  const savedCatalog = normalizeActivityCatalog(application?.activity_catalog)
  if (savedCatalog.length > 0) return savedCatalog
  return DEFAULT_ACTIVITY_CATALOG
}

function uniqByLowerLabel(items) {
  const map = new Map()
  safeArray(items).forEach((item) => {
    const label = typeof item?.label === "string" ? item.label.trim() : ""
    if (!label) return
    const key = label.toLowerCase()
    if (!map.has(key)) map.set(key, item)
  })
  return [...map.values()]
}

function normalizeGender(value) {
  const v = String(value || "").trim().toLowerCase()
  if (!v) return ""
  if (["f", "female", "woman", "women", "girl"].includes(v)) return "female"
  if (["m", "male", "man", "men", "boy"].includes(v)) return "male"
  return v
}

function normalizeZip(value) {
  const v = String(value || "").trim()
  const m = v.match(/\b\d{5}(?:-\d{4})?\b/)
  return m ? m[0] : ""
}

function zillowRentalsUrlFromZip(zip) {
  const z = normalizeZip(zip)
  if (!z) return ""
  return `https://www.zillow.com/homes/for_rent/${encodeURIComponent(z)}/`
}

function normalizeSchoolName(value) {
  return String(value || "").trim().toLowerCase()
}

function getSchoolTheme(application) {
  const explicit = application?.theme ?? null
  const explicitPrimary = explicit?.primary_color ? String(explicit.primary_color).trim() : ""
  const explicitSecondary = explicit?.secondary_color ? String(explicit.secondary_color).trim() : ""
  const explicitCheer = explicit?.cheer_line ? String(explicit.cheer_line).trim() : ""
  const cheerEnabled = explicit?.cheer_enabled !== false

  if (explicitPrimary || explicitSecondary || explicitCheer) {
    return {
      school: application?.name ?? "School",
      primary: explicitPrimary || "#0f172a",
      secondary: explicitSecondary || "#64748b",
      cheer: cheerEnabled ? explicitCheer : "",
    }
  }

  const name = normalizeSchoolName(application?.name)

  // Keep this intentionally small + safe; we can grow it over time.
  // Ohio State: Scarlet + Gray (official-ish web-safe values)
  if (
    name.includes("the ohio state") ||
    name.includes("ohio state university") ||
    (name.includes("ohio state") && !name.includes("oregon state"))
  ) {
    return {
      school: "The Ohio State University",
      primary: "#BB0000", // Scarlet
      secondary: "#666666", // Gray
      cheer: "Go Buckeyes!",
    }
  }

  return null
}

function formatRatio(value) {
  if (value === null || value === undefined || value === "") return "—"
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return "—"
  // Represent as "15:1"
  return `${Math.round(number)}:1`
}

function formatNumber(value) {
  if (value === null || value === undefined || value === "") return "—"
  const number = Number(value)
  if (!Number.isFinite(number)) return "—"
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(number)
}

function safeText(value) {
  return typeof value === "string" ? value.trim() : ""
}

function scoreDepartmentContactForGender(contact, studentGender) {
  const gender = String(contact?.gender_target ?? "any").toLowerCase()
  const g = normalizeGender(studentGender)
  if (!g) return 0
  if (g === "female") {
    if (gender === "women") return 100
    if (gender === "coed" || gender === "any" || gender === "unknown") return 50
    if (gender === "men") return 10
  }
  if (g === "male") {
    if (gender === "men") return 100
    if (gender === "coed" || gender === "any" || gender === "unknown") return 50
    if (gender === "women") return 10
  }
  return 0
}

function sortDepartmentContactsForStudent(contacts, studentGender) {
  const arr = safeArray(contacts)
  const g = normalizeGender(studentGender)
  if (!g) return arr
  return arr
    .slice()
    .sort((a, b) => scoreDepartmentContactForGender(b, g) - scoreDepartmentContactForGender(a, g))
}

function matchesAnyInterest(contact, interests) {
  const list = safeArray(interests).map((v) => String(v || "").trim().toLowerCase()).filter(Boolean)
  if (list.length === 0) return false
  const haystack = [
    contact?.area,
    contact?.category,
    contact?.name,
    contact?.title,
    contact?.notes,
  ]
    .map((v) => String(v || "").toLowerCase())
    .join(" | ")
  return list.some((needle) => haystack.includes(needle))
}

function normaliseApplications(applications) {
  if (!Array.isArray(applications)) return []
  return applications.map((application) => ({
    ...application,
    id: application.id ?? generateId("application"),
    website_url: application.website_url ?? "",
    campus_address: application.campus_address ?? "",
    city: application.city ?? "",
    state: application.state ?? "",
    zip: application.zip ?? "",
    main_phone: application.main_phone ?? "",
    main_email: application.main_email ?? "",
    theme: {
      primary_color: application.theme?.primary_color ?? "",
      secondary_color: application.theme?.secondary_color ?? "",
      cheer_line: application.theme?.cheer_line ?? "",
      cheer_enabled: application.theme?.cheer_enabled ?? true,
    },
    graduation_rate: application.graduation_rate ?? null,
    student_teacher_ratio: application.student_teacher_ratio ?? null,
    avg_class_size: application.avg_class_size ?? null,
    portals: {
      admissions_url: application.portals?.admissions_url ?? "",
      financial_aid_url: application.portals?.financial_aid_url ?? "",
      student_portal_url: application.portals?.student_portal_url ?? "",
      counseling_url: application.portals?.counseling_url ?? "",
      transcripts_url: application.portals?.transcripts_url ?? "",
      send_scores_url: application.portals?.send_scores_url ?? "",
    },
    costs: {
      housing_preference: application.costs?.housing_preference ?? "unknown",
      on_campus_total: application.costs?.on_campus_total ?? null,
      off_campus_total: application.costs?.off_campus_total ?? null,
      selected_meal_plan_id: application.costs?.selected_meal_plan_id ?? "",
      meal_plans: safeArray(application.costs?.meal_plans).map((plan) => ({
        id: plan.id ?? generateId("mealplan"),
        name: plan.name ?? "",
        cost_per_semester: plan.cost_per_semester ?? "",
        notes: plan.notes ?? "",
      })),
    },
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
      category: entry.category ?? "",
      gender_target: entry.gender_target ?? "any",
      name: entry.name ?? "",
      title: entry.title ?? "",
      email: entry.email ?? "",
      phone: entry.phone ?? "",
      url: entry.url ?? "",
      notes: entry.notes ?? "",
    })),
    interests: safeArray(application.interests),
    activity_catalog: normalizeActivityCatalog(application.activity_catalog),
    local_funding: safeArray(application.local_funding),
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
      const mergedTheme = {
        ...(match.theme ?? {}),
        ...(incomingNormalised.theme ?? {}),
      }
      // Prefer non-empty strings from incoming theme (avoid overwriting with empty values).
      ;['primary_color', 'secondary_color', 'cheer_line'].forEach((key) => {
        const v = incomingNormalised.theme?.[key]
        if (typeof v === 'string' && !v.trim()) {
          mergedTheme[key] = match.theme?.[key] ?? ''
        }
      })

      const mergedPortals = {
        ...(match.portals ?? {}),
        ...(incomingNormalised.portals ?? {}),
      }

      const mergedCosts = {
        ...(match.costs ?? {}),
        ...(incomingNormalised.costs ?? {}),
      }
      mergedCosts.meal_plans = mergeArrayById(
        safeArray(match.costs?.meal_plans),
        safeArray(incomingNormalised.costs?.meal_plans),
      )
      // If the incoming suggestion didn't specify a selection, keep the existing selected plan.
      if (!incomingNormalised.costs?.selected_meal_plan_id && match.costs?.selected_meal_plan_id) {
        mergedCosts.selected_meal_plan_id = match.costs.selected_meal_plan_id
      }

      const merged = {
        ...match,
        ...incomingNormalised,
        contacts: mergeArrayById(match.contacts, incomingNormalised.contacts),
        financial_aid_pipeline: mergeArrayById(match.financial_aid_pipeline, incomingNormalised.financial_aid_pipeline),
        department_contacts: mergeArrayById(match.department_contacts, incomingNormalised.department_contacts),
        interests: mergeUniqueStrings(match.interests, incomingNormalised.interests),
        theme: mergedTheme,
        portals: mergedPortals,
        costs: mergedCosts,
        activity_catalog: mergeArrayById(match.activity_catalog, incomingNormalised.activity_catalog),
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
  studentGender = "",
  profileId = "",
}) {
  const { toast } = useToast()
  const queryClient = useQueryClient()
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

  const { data: profileDocuments = [] } = useQuery({
    queryKey: ["documents", profileId],
    queryFn: () => listDocuments({ profile_id: profileId }),
    enabled: Boolean(profileId),
    staleTime: 10_000,
  })

  const deleteSchoolDocMutation = useMutation({
    mutationFn: (docId) => deleteDocument(docId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["documents", profileId] })
      queryClient.invalidateQueries({ queryKey: ["profile", profileId] })
      toast({ title: "Deleted", description: "The file was removed from this profile." })
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Delete failed",
        description: error instanceof Error ? error.message : "Unable to delete this file.",
      })
    },
  })

  const uploadSchoolDocMutation = useMutation({
    mutationFn: async ({ file, docType, universityApplicationId, universityApplicationName }) => {
      const formData = new FormData()
      formData.append("profile_id", profileId)
      formData.append("document", file)
      formData.append("name", file.name)
      formData.append("type", docType)
      formData.append("university_application_id", universityApplicationId)
      formData.append("university_application_name", universityApplicationName ?? "")

      // Default: try to parse. These are usually letters/forms and are useful for enrichment.
      formData.append("skip_parsing", "false")
      formData.append("ocr", "true")
      formData.append("handwriting", "true")
      formData.append("ocr_language", "eng")

      return ingestDocument(formData)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["documents", profileId] })
      queryClient.invalidateQueries({ queryKey: ["profile", profileId] })
      toast({
        title: "School file uploaded",
        description: "We’ll parse what we can and sync updates shortly.",
      })
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Upload failed",
        description: error instanceof Error ? error.message : "Unable to upload this file.",
      })
    },
  })

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

  const handleQuickUpdateApplication = useCallback(
    async (applicationId, patch, successMessage) => {
      const nextApplications = localApplications.map((application) => {
        if (application.id !== applicationId) return application
        return { ...application, ...patch }
      })
      setLocalApplications(nextApplications)
      await persistApplications(nextApplications, successMessage ?? "Updated university details.")
    },
    [localApplications, persistApplications],
  )

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

  // Schools the student has actually committed to attending. When this is
  // non-empty, the backend's generateSchoolCards narrows funding cards to
  // these schools only — the others "fall off" so the student isn't
  // pestered about UCF / Alabama / etc. once they've chosen MTSU.
  const committedApplications = useMemo(
    () => localApplications.filter((app) => isCommittedStatus(app.status)),
    [localApplications],
  )

  // Once a school is committed, the other (non-committed) schools should drop
  // out of view by default — the student chose MTSU, so UCF / Alabama / etc.
  // shouldn't keep cluttering the list. We don't delete them (uncommit must be
  // able to bring them back), we just collapse them behind a toggle.
  const [showOtherApplications, setShowOtherApplications] = useState(false)
  const hasCommitted = committedApplications.length > 0
  const otherApplications = useMemo(
    () => localApplications.filter((app) => !isCommittedStatus(app.status)),
    [localApplications],
  )

  // Commit one school + (optionally) deferred-mark every other still-active
  // application. We do NOT auto-overwrite explicit decisions like 'denied'
  // or 'accepted' at other schools — the user can still browse those for
  // reference. We mark 'planning' / 'interested' / 'in_progress' as
  // 'deferred' so the dashboard makes the chosen-vs-not-chosen state clear.
  const handleCommitToSchool = useCallback(
    async (applicationId) => {
      const target = localApplications.find((a) => a.id === applicationId)
      if (!target) return
      const proceed = window.confirm(
        `Commit to ${target.name}?\n\n` +
        "This marks this school as the one you're attending. Other schools' " +
        "funding cards (financial aid, housing, off-campus, scholarships) " +
        "will fall off the funding feed for this profile. You can uncommit " +
        "later if plans change.",
      )
      if (!proceed) return

      const STILL_ACTIVE = new Set([
        "planning",
        "interested",
        "in_progress",
        "submitted",
        "accepted",
        "waitlisted",
      ])
      const nextApplications = localApplications.map((app) => {
        if (app.id === applicationId) return { ...app, status: "committed" }
        if (STILL_ACTIVE.has(String(app.status || "").toLowerCase())) {
          return { ...app, status: "deferred" }
        }
        return app
      })
      setLocalApplications(nextApplications)
      await persistApplications(
        nextApplications,
        `Committed to ${target.name}. Other schools' funding cards will fall off.`,
      )
    },
    [localApplications, persistApplications],
  )

  const handleUncommitSchool = useCallback(
    async (applicationId) => {
      const target = localApplications.find((a) => a.id === applicationId)
      if (!target) return
      const proceed = window.confirm(
        `Uncommit from ${target.name}?\n\n` +
        "This will move the school back to 'planning' so you can compare " +
        "options again. Funding cards for all schools will reappear in the " +
        "funding feed for this profile.",
      )
      if (!proceed) return
      const nextApplications = localApplications.map((app) =>
        app.id === applicationId ? { ...app, status: "planning" } : app,
      )
      setLocalApplications(nextApplications)
      await persistApplications(nextApplications, `Uncommitted from ${target.name}.`)
    },
    [localApplications, persistApplications],
  )

  return (
    <Card className="mt-10 border-slate-200 shadow-sm">
      <SchoolAIAssistStyles />
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
        {committedApplications.length > 0 ? (
          <Alert className="border-emerald-300 bg-emerald-50">
            <CheckCircle2 className="h-4 w-4 text-emerald-700" />
            <AlertDescription className="text-emerald-900">
              <span className="font-semibold">
                Committed to {committedApplications.map((a) => a.name).join(", ")}.
              </span>{" "}
              School-specific funding cards (financial aid, housing, off-campus, institutional scholarships)
              are now scoped to {committedApplications.length === 1 ? "this school" : "these schools"} only.
              Other applications are hidden (use “Show other applications” below to review them) and no longer
              drive the funding feed. Use <span className="font-medium">Uncommit</span> on the school card to undo.
            </AlertDescription>
          </Alert>
        ) : null}

        {localApplications.length === 0 ? (
          <Alert>
            <AlertDescription>
              No universities have been added yet. Use <span className="font-semibold">Add University</span> to
              capture admissions details, upload decisions, and plan financial aid tasks.
            </AlertDescription>
          </Alert>
        ) : (
          <div className="space-y-6">
            {/* When a school is committed, hide the other schools by default —
                the student has chosen, so the rest shouldn't linger in view.
                A toggle reveals them (they're deferred, not deleted, so Uncommit
                still works). */}
            {hasCommitted && otherApplications.length > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-slate-600"
                onClick={() => setShowOtherApplications((v) => !v)}
              >
                {showOtherApplications
                  ? `Hide ${otherApplications.length} other application${otherApplications.length === 1 ? "" : "s"}`
                  : `Show ${otherApplications.length} other application${otherApplications.length === 1 ? "" : "s"}`}
              </Button>
            ) : null}
            {(hasCommitted && !showOtherApplications ? committedApplications : localApplications)
              .slice()
              .sort((a, b) => {
                // Pin committed schools to the top so the chosen school is
                // always the first card the user sees.
                const aCommitted = isCommittedStatus(a.status)
                const bCommitted = isCommittedStatus(b.status)
                if (aCommitted && !bCommitted) return -1
                if (!aCommitted && bCommitted) return 1
                return a.name.localeCompare(b.name)
              })
              .map((application) => (
                <ApplicationCard
                  key={application.id}
                  application={application}
                  onEdit={() => handleEditApplication(application)}
                  onDelete={() => setDeleteTarget(application)}
                  onToggleStage={handleTogglePipelineStatus}
                  studentGender={studentGender}
                  onQuickUpdate={handleQuickUpdateApplication}
                  onCommit={() => handleCommitToSchool(application.id)}
                  onUncommit={() => handleUncommitSchool(application.id)}
                  hasAnyCommittedSchool={committedApplications.length > 0}
                  disabled={persistenceInFlight}
                  documents={profileDocuments}
                  onUploadSchoolDoc={(payload) => uploadSchoolDocMutation.mutate(payload)}
                  onDeleteSchoolDoc={(doc) => {
                    if (!doc?.id) return
                    const ok = window.confirm(`Delete "${doc.name}"? This cannot be undone.`)
                    if (!ok) return
                    deleteSchoolDocMutation.mutate(doc.id)
                  }}
                  docBusy={uploadSchoolDocMutation.isPending || deleteSchoolDocMutation.isPending}
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

const UNIVERSITY_DOC_TYPES = [
  { value: "university_acceptance_letter", label: "Acceptance letter" },
  { value: "university_scholarship_letter", label: "Scholarship letter" },
  { value: "university_financial_aid_award", label: "Financial aid award" },
  { value: "university_denial_letter", label: "Denial letter" },
  { value: "university_housing", label: "Housing form/info" },
  { value: "university_transcript", label: "Transcript" },
  { value: "university_test_scores", label: "Test score report" },
  { value: "university_other", label: "Other" },
]

function ApplicationCard({
  application,
  onEdit,
  onDelete,
  onToggleStage,
  studentGender,
  onQuickUpdate,
  onCommit,
  onUncommit,
  hasAnyCommittedSchool,
  disabled,
  documents,
  onUploadSchoolDoc,
  onDeleteSchoolDoc,
  docBusy,
}) {
  const isCommitted = isCommittedStatus(application?.status)
  // Once any school is committed, mute the others visually so the user can
  // see at a glance which school they chose. We don't hide them — the user
  // may still want to reference acceptance letters, financial aid awards,
  // etc. uploaded under those schools — we just signal that they're not
  // driving the funding feed anymore.
  const isMutedByOtherCommit = hasAnyCommittedSchool && !isCommitted
  const aiAssist = useSchoolAIAssist()
  const aiLogRef = useRef(null)
  const { toast } = useToast()

  const handleAIAutoFill = async () => {
    if (!application.name) return
    try {
      const data = await aiAssist.runLookup(application.name)
      if (!data) {
        toast({
          title: "AI assist unavailable",
          description: "We could not load school data right now. Please try again.",
          variant: "destructive",
        })
        return
      }

      if (onQuickUpdate) {
        const patch = mapAIDataToApplicationPatch(data)
        if (Object.keys(patch).length > 0) {
          await onQuickUpdate(application.id, patch, "AI auto-filled school data.")
          toast({
            title: "School data updated",
            description: `AI assist updated ${application.name}.`,
          })
          return
        }
      }

      toast({
        title: "No new school data found",
        description: `AI assist did not find any new fields for ${application.name}.`,
      })
    } catch (error) {
      toast({
        title: "AI assist failed",
        description: error instanceof Error ? error.message : "We could not update this school right now.",
        variant: "destructive",
      })
    }
  }

  const statusStyle = STATUS_STYLES[application.status] ?? STATUS_STYLES.planning
  const pipeline = safeArray(application.financial_aid_pipeline)
  const contacts = safeArray(application.contacts)
  const departmentContacts = sortDepartmentContactsForStudent(application.department_contacts, studentGender)
  const interests = safeArray(application.interests)
  const zip = application.zip || ""
  const zillowUrl = zillowRentalsUrlFromZip(zip)
  const portals = application.portals ?? {}
  const costs = application.costs ?? {}
  const mealPlans = safeArray(costs.meal_plans)
  const selectedMealPlan =
    mealPlans.find((p) => p.id && String(p.id) === String(costs.selected_meal_plan_id)) ?? null
  const relevantDepartmentContacts = departmentContacts.filter((contact) => matchesAnyInterest(contact, interests))
  const schoolDocs = useMemo(() => {
    const docs = safeArray(documents)
    return docs
      .filter((doc) => String(doc?.university_application_id || "") === String(application.id))
      .sort((a, b) => String(b?.created_at || "").localeCompare(String(a?.created_at || "")))
  }, [documents, application.id])
  const [interestDialogOpen, setInterestDialogOpen] = useState(false)
  const [interestSearch, setInterestSearch] = useState("")
  const [customInterest, setCustomInterest] = useState("")
  const [draftInterests, setDraftInterests] = useState(() => interests)
  const [draftCatalog, setDraftCatalog] = useState(() => normalizeActivityCatalog(application.activity_catalog))
  const [catalogTouched, setCatalogTouched] = useState(false)

  const [schoolUploadFile, setSchoolUploadFile] = useState(null)
  const [schoolUploadType, setSchoolUploadType] = useState(UNIVERSITY_DOC_TYPES[0].value)
  const maxFileSize = 50 * 1024 * 1024
  const [localFundingLoading, setLocalFundingLoading] = useState(false)

  useEffect(() => {
    if (!interestDialogOpen) return
    setDraftInterests(safeArray(application.interests))
    setDraftCatalog(normalizeActivityCatalog(application.activity_catalog))
    setCatalogTouched(false)
    setInterestSearch("")
    setCustomInterest("")
  }, [interestDialogOpen, application])

  const effectiveOptions = useMemo(() => {
    const base = buildEffectiveActivityOptions({ activity_catalog: draftCatalog })
    const merged = uniqByLowerLabel([...base, ...draftCatalog])
    const q = interestSearch.trim().toLowerCase()
    if (!q) return merged
    return merged.filter((item) => String(item.label || "").toLowerCase().includes(q))
  }, [draftCatalog, interestSearch])

  const groupedOptions = useMemo(() => {
    const groups = new Map()
    effectiveOptions.forEach((item) => {
      const category = String(item.category || "Other").trim() || "Other"
      if (!groups.has(category)) groups.set(category, [])
      groups.get(category).push(item)
    })
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [effectiveOptions])

  const draftSet = useMemo(() => new Set(draftInterests.map((v) => String(v || "").trim()).filter(Boolean)), [draftInterests])

  const toggleDraftInterest = (label) => {
    const clean = String(label || "").trim()
    if (!clean) return
    const next = new Set(draftSet)
    if (next.has(clean)) next.delete(clean)
    else next.add(clean)
    setDraftInterests([...next].sort((a, b) => a.localeCompare(b)))
  }

  const handleAddCustomInterest = () => {
    const label = customInterest.trim()
    if (!label) return
    const newItem = { id: generateId("activity"), label, category: "Custom" }
    setDraftCatalog((prev) => [...normalizeActivityCatalog(prev), newItem])
    setCatalogTouched(true)
    setCustomInterest("")
    toggleDraftInterest(label)
  }

  const handlePopulateFromTemplate = () => {
    setDraftCatalog((prev) => uniqByLowerLabel([...normalizeActivityCatalog(prev), ...DEFAULT_ACTIVITY_CATALOG]))
    setCatalogTouched(true)
  }

  const handleSaveInterests = async () => {
    if (!onQuickUpdate) {
      setInterestDialogOpen(false)
      return
    }
    const patch = { interests: draftInterests }
    const existingCatalog = normalizeActivityCatalog(application.activity_catalog)
    if (catalogTouched || existingCatalog.length > 0) {
      patch.activity_catalog = uniqByLowerLabel(draftCatalog)
    }
    await onQuickUpdate(application.id, patch, "Updated interests for this school.")
    setInterestDialogOpen(false)
  }

  const handleFetchLocalFunding = async () => {
    const zip = (application.zip || application.zip_code || "").trim()
    const m = zip.match(/\b\d{5}(?:-\d{4})?\b/)
    const effectiveZip = m ? m[0] : ""
    if (!effectiveZip) {
      return
    }
    if (!onQuickUpdate) return
    setLocalFundingLoading(true)
    try {
      const res = await fetchLocalFundingByZip({ zip: effectiveZip, radiusMiles: 25 })
      const results = Array.isArray(res?.results) ? res.results : []
      const mapped = results.map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        source: r.source ?? "",
        distanceMiles: r.distanceMiles,
      }))
      await onQuickUpdate(
        application.id,
        { local_funding: mapped },
        `Found ${mapped.length} local funding resource(s) within 25 miles.`,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to fetch local funding"
      toast({ variant: "destructive", title: "Local funding fetch failed", description: msg })
      throw err
    } finally {
      setLocalFundingLoading(false)
    }
  }

  const localFunding = safeArray(application.local_funding)

  const handleSchoolFileSelect = (event) => {
    const file = event.target.files?.[0] ?? null
    if (!file) {
      setSchoolUploadFile(null)
      return
    }
    if (file.size > maxFileSize) {
      setSchoolUploadFile(null)
      alert("File must be 50MB or smaller.")
      return
    }
    setSchoolUploadFile(file)
  }

  const handleUploadSchoolFile = () => {
    if (!onUploadSchoolDoc) return
    if (!schoolUploadFile) return
    onUploadSchoolDoc({
      file: schoolUploadFile,
      docType: schoolUploadType,
      universityApplicationId: application.id,
      universityApplicationName: application.name ?? "",
    })
    setSchoolUploadFile(null)
  }

  const selectedHousingPreference = safeText(costs.housing_preference || "")
  const estimatedCost =
    selectedHousingPreference === "on_campus"
      ? costs.on_campus_total
      : selectedHousingPreference === "off_campus"
        ? costs.off_campus_total
        : null

  const theme = getSchoolTheme(application)
  const borderColor = theme?.primary || undefined
  const handleCardActivate = useCallback(
    (event) => {
      if (!onEdit || disabled) return
      const interactiveTarget = event.target instanceof Element
        ? event.target.closest('a,button,input,select,textarea,[role="button"],[data-card-ignore-click="true"]')
        : null
      if (interactiveTarget && interactiveTarget !== event.currentTarget) return
      onEdit()
    },
    [disabled, onEdit],
  )

  const handleCardKeyDown = useCallback(
    (event) => {
      if (!onEdit || disabled) return
      if (event.target !== event.currentTarget) return
      if (event.key !== "Enter" && event.key !== " ") return
      event.preventDefault()
      onEdit()
    },
    [disabled, onEdit],
  )

  return (
    <div
      className={`border rounded-xl shadow-sm bg-white overflow-hidden ${
        isCommitted
          ? "border-emerald-400 ring-2 ring-emerald-200"
          : isMutedByOtherCommit
            ? "border-slate-200 opacity-60 grayscale"
            : "border-slate-200"
      } ${disabled ? "" : "cursor-pointer hover:shadow-md transition-shadow"}`}
      style={borderColor && !isMutedByOtherCommit ? { borderColor } : undefined}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label={`Open university card for ${application.name}`}
      onClick={handleCardActivate}
      onKeyDown={handleCardKeyDown}
    >
      {theme ? (
        <div
          className="px-5 py-2 flex items-center justify-between gap-3"
          style={{
            background: `linear-gradient(90deg, ${theme.primary}, ${theme.secondary})`,
          }}
        >
          <p className="text-xs font-semibold tracking-wide text-white/95">
            {theme.school}
          </p>
          {theme.cheer ? (
            <p className="text-xs font-semibold tracking-wide text-white/95">
              {theme.cheer}
            </p>
          ) : null}
        </div>
      ) : null}
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
          <ExternalLinkButton href={application.website_url}>Website</ExternalLinkButton>
          <ExternalLinkButton href={portals.admissions_url}>Admissions</ExternalLinkButton>
          <ExternalLinkButton href={portals.financial_aid_url}>Financial Aid</ExternalLinkButton>
          <ExternalLinkButton href={portals.student_portal_url}>Student Portal</ExternalLinkButton>
          <ExternalLinkButton href={portals.counseling_url}>Counseling</ExternalLinkButton>
          <ExternalLinkButton href={portals.transcripts_url}>Transcripts</ExternalLinkButton>
          <ExternalLinkButton href={portals.send_scores_url}>Send Scores</ExternalLinkButton>
          <ExternalLinkButton href={application.actions?.apply_url}>Apply</ExternalLinkButton>
          <ExternalLinkButton href={application.actions?.pay_fee_url}>Pay Fee</ExternalLinkButton>
          <ExternalLinkButton href={application.actions?.visit_url}>Visit</ExternalLinkButton>
          <ExternalLinkButton href={zillowUrl}>Housing (Zillow)</ExternalLinkButton>
          <AIAssistButton
            status={aiAssist.status}
            onClick={handleAIAutoFill}
          />
          {isCommitted ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onUncommit}
              disabled={disabled || !onUncommit}
              className="border-emerald-400 text-emerald-800 hover:bg-emerald-50"
              title="Move this school back to 'planning' so other schools' funding cards reappear."
            >
              <CheckCircle2 className="w-4 h-4 mr-2 text-emerald-700" />
              Uncommit
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onCommit}
              disabled={disabled || !onCommit || hasAnyCommittedSchool}
              className="border-emerald-300 text-emerald-800 hover:bg-emerald-50"
              title={
                hasAnyCommittedSchool
                  ? "Uncommit from your current school first to commit to a different one."
                  : "Commit to this school. Other schools' funding cards will fall off."
              }
            >
              <CheckCircle2 className="w-4 h-4 mr-2" />
              I&apos;m attending
            </Button>
          )}
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
            <StatBox label="Graduation Rate" value={formatPercent(application.graduation_rate)} />
            <StatBox label="Student/Teacher" value={formatRatio(application.student_teacher_ratio)} />
            <StatBox label="Avg Class Size" value={formatNumber(application.avg_class_size)} />
            <StatBox label="Est. Cost" value={formatCurrency(estimatedCost)} />
          </div>

          {(application.campus_address || application.city || application.state || application.zip || application.main_phone || application.main_email) ? (
            <div className="space-y-2">
              <h5 className="text-xs font-semibold uppercase tracking-wide text-slate-500">School info</h5>
              <div className="text-sm text-slate-700 space-y-1">
                {application.campus_address ? <p>{application.campus_address}</p> : null}
                {(application.city || application.state || application.zip) ? (
                  <p>
                    {[safeText(application.city), safeText(application.state)].filter(Boolean).join(", ")}{" "}
                    {safeText(application.zip)}
                  </p>
                ) : null}
                {application.main_phone ? (
                  <p className="text-blue-600">
                    <a href={`tel:${application.main_phone}`} className="hover:underline">
                      <Phone className="inline-block w-3 h-3 mr-1" />
                      {application.main_phone}
                    </a>
                  </p>
                ) : null}
                {application.main_email ? (
                  <p className="text-blue-600">
                    <a href={`mailto:${application.main_email}`} className="hover:underline">
                      <Mail className="inline-block w-3 h-3 mr-1" />
                      {application.main_email}
                    </a>
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}

          {mealPlans.length > 0 ? (
            <div className="space-y-2">
              <h5 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Meal plans</h5>
              <div className="space-y-2">
                {selectedMealPlan ? (
                  <div className="border border-slate-100 rounded-lg p-3">
                    <p className="text-sm font-semibold text-slate-800">{selectedMealPlan.name || "Selected plan"}</p>
                    <p className="text-xs text-slate-600">
                      {selectedMealPlan.cost_per_semester ? `Cost/semester: ${formatCurrency(selectedMealPlan.cost_per_semester)}` : "Cost/semester: —"}
                    </p>
                    {selectedMealPlan.notes ? <p className="text-xs text-slate-500 mt-1">{selectedMealPlan.notes}</p> : null}
                  </div>
                ) : (
                  <p className="text-sm text-slate-500">Plans available: {mealPlans.length}. Select one in Edit.</p>
                )}
              </div>
            </div>
          ) : null}

          {interests.length > 0 ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <h5 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Interests</h5>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setInterestDialogOpen(true)}
                  disabled={disabled}
                >
                  <ListChecks className="w-4 h-4 mr-2" />
                  Edit interests
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                {interests.map((interest) => (
                  <Badge key={interest} variant="outline">
                    {interest}
                  </Badge>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <h5 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Interests</h5>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setInterestDialogOpen(true)}
                  disabled={disabled}
                >
                  <ListChecks className="w-4 h-4 mr-2" />
                  Choose interests
                </Button>
              </div>
              <p className="text-sm text-slate-500">Select sports/clubs/etc. to surface the right contacts.</p>
            </div>
          )}
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
              {interests.length > 0 ? (
                <p className="text-xs text-slate-500">
                  Showing contacts prioritized for the selected interests when possible.
                </p>
              ) : null}
              <div className="space-y-2">
                {relevantDepartmentContacts.length > 0 ? (
                  <div className="border border-slate-100 rounded-lg p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
                      Matches selected interests
                    </p>
                    <div className="space-y-2">
                      {relevantDepartmentContacts.slice(0, 5).map((contact) => (
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
                            {contact.url ? (
                              <a href={contact.url} target="_blank" rel="noopener noreferrer" className="hover:underline flex items-center gap-1">
                                <LinkIcon className="w-3 h-3" /> Link
                              </a>
                            ) : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
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
                      {contact.url ? (
                        <a href={contact.url} target="_blank" rel="noopener noreferrer" className="hover:underline flex items-center gap-1">
                          <LinkIcon className="w-3 h-3" /> Link
                        </a>
                      ) : null}
                    </div>
                    {contact.category || contact.gender_target ? (
                      <p className="text-slate-500">
                        {[safeText(contact.category), safeText(contact.gender_target)].filter(Boolean).join(" • ")}
                      </p>
                    ) : null}
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

        {aiAssist.status !== "idle" && (
          <div className="lg:col-span-12">
            <AIAssistLog status={aiAssist.status} log={aiAssist.log} logRef={aiLogRef} />
          </div>
        )}

        <div className="lg:col-span-12 space-y-4">
          <h4 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
            <MapPin className="w-4 h-4 text-indigo-600" />
            Local funding (25 miles)
          </h4>
          {(() => {
            const z = (application.zip || application.zip_code || "").trim()
            const hasZip = /\b\d{5}(?:-\d{4})?\b/.test(z)
            if (!hasZip) {
              return (
                <p className="text-sm text-slate-500">
                  ZIP needed to fetch local funding. Add campus ZIP in Edit to fetch nearby resources.
                </p>
              )
            }
            return (
              <div className="space-y-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleFetchLocalFunding}
                  disabled={disabled || localFundingLoading}
                >
                  {localFundingLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Fetching…
                    </>
                  ) : (
                    "Fetch local funding (25 miles)"
                  )}
                </Button>
                {localFunding.length > 0 ? (
                  <div className="space-y-2">
                    <p className="text-xs text-slate-500">{localFunding.length} resource(s) found</p>
                    <div className="flex flex-wrap gap-2">
                      {localFunding.slice(0, 8).map((r, i) => (
                        <div key={i} className="border border-slate-100 rounded-lg px-3 py-2 text-sm">
                          {r.url ? (
                            <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                              {r.title || r.source || "Resource"}
                            </a>
                          ) : (
                            <span>{r.title || r.source || "Resource"}</span>
                          )}
                          {r.source ? (
                            <span className="text-slate-500 text-xs ml-1">({r.source})</span>
                          ) : null}
                        </div>
                      ))}
                      {localFunding.length > 8 ? (
                        <span className="text-xs text-slate-500">+{localFunding.length - 8} more</span>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            )
          })()}
        </div>
      </div>

      <Separator />
      <div className="p-5 space-y-4">
        <h4 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
          <FileUp className="w-4 h-4 text-indigo-600" />
          School-specific files
        </h4>

        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-3">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-2 md:col-span-1">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Type</p>
              <Select value={schoolUploadType} onValueChange={setSchoolUploadType} disabled={disabled || docBusy}>
                <SelectTrigger>
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  {UNIVERSITY_DOC_TYPES.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2 md:col-span-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Upload</p>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <input
                  type="file"
                  onChange={handleSchoolFileSelect}
                  disabled={disabled || docBusy}
                  className="w-full text-sm"
                />
                <Button
                  type="button"
                  onClick={handleUploadSchoolFile}
                  disabled={disabled || docBusy || !schoolUploadFile}
                >
                  Upload & parse
                </Button>
              </div>
              {schoolUploadFile ? (
                <p className="text-xs text-slate-600">
                  Ready: <span className="font-medium">{schoolUploadFile.name}</span>
                </p>
              ) : null}
              <p className="text-xs text-slate-500">
                Upload acceptance letters, scholarship letters, housing forms, financial aid awards, etc. We’ll extract text and queue parsing automatically.
              </p>
            </div>
          </div>
        </div>

        {schoolDocs.length === 0 ? (
          <p className="text-sm text-slate-500">No school-specific files uploaded yet.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {schoolDocs.map((doc) => (
              <DocumentItem key={doc.id} document={doc} onDelete={onDeleteSchoolDoc} />
            ))}
          </div>
        )}
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

      <Dialog open={interestDialogOpen} onOpenChange={setInterestDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Activities & interests</DialogTitle>
            <DialogDescription>
              Choose sports/clubs/Greek life/etc. the student is interested in for this school. This helps you track the right contacts.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Search</p>
                <Input value={interestSearch} onChange={(e) => setInterestSearch(e.target.value)} placeholder="Search activities…" />
              </div>
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">College offerings list</p>
                <div className="flex gap-2 flex-wrap">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handlePopulateFromTemplate}
                    disabled={disabled}
                  >
                    Populate common list
                  </Button>
                  <p className="text-xs text-slate-500 self-center">
                    {normalizeActivityCatalog(application.activity_catalog).length > 0
                      ? "Using this school’s saved list."
                      : "No school list yet—use the common list or add custom items."}
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              {groupedOptions.map(([category, items]) => (
                <div key={category} className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{category}</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {items.map((item) => {
                      const checked = draftSet.has(item.label)
                      return (
                        <label
                          key={item.id ?? item.label}
                          className="flex items-start gap-2 rounded-lg border border-slate-100 p-2 hover:border-slate-200 cursor-pointer"
                        >
                          <Checkbox checked={checked} onCheckedChange={() => toggleDraftInterest(item.label)} />
                          <span className="text-sm text-slate-800">{item.label}</span>
                        </label>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>

            <div className="border-t pt-4 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Add custom</p>
              <div className="flex gap-2">
                <Input value={customInterest} onChange={(e) => setCustomInterest(e.target.value)} placeholder="e.g., Women’s basketball, Jazz ensemble, Esports…" />
                <Button type="button" variant="outline" onClick={handleAddCustomInterest} disabled={disabled}>
                  Add
                </Button>
              </div>
              <p className="text-xs text-slate-500">
                Custom items are saved to this school’s offerings list so future profiles can reuse them.
              </p>
            </div>
          </div>

          <DialogFooter className="flex items-center justify-between gap-2">
            <Button type="button" variant="ghost" onClick={() => setInterestDialogOpen(false)} disabled={disabled}>
              Cancel
            </Button>
            <Button type="button" onClick={handleSaveInterests} disabled={disabled}>
              Save interests
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
