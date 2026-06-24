import React, { useEffect, useMemo } from "react"
import { useForm, useFieldArray, Controller } from "react-hook-form"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Plus, Trash2 } from "lucide-react"

const PIPELINE_STATUS_OPTIONS = [
  { value: "planned", label: "Planned" },
  { value: "in_progress", label: "In Progress" },
  { value: "completed", label: "Completed" },
  { value: "blocked", label: "Blocked" },
]

const STATUS_OPTIONS = [
  "planning",
  "interested",
  "in_progress",
  "submitted",
  "accepted",
  "committed",
  "deferred",
  "waitlisted",
  "denied",
]

const APPLICATION_TYPES = [
  "regular_decision",
  "early_action",
  "early_decision",
  "rolling",
  "transfer",
  "international",
  "other",
]

const INSTITUTION_TYPES = [
  "public",
  "private",
  "community_college",
  "technical",
  "trade_school",
  "military",
  "other",
]

const HOUSING_PREFERENCES = ["unknown", "on_campus", "off_campus", "commuter"]

const CONTACT_GENDER_TARGETS = ["any", "women", "men", "coed", "unknown"]

// Delimiter used to round-trip interests as text without corrupting values that
// themselves contain commas. We display with commas but store/split on this
// sentinel internally is not feasible for a single text field, so we validate
// and split on commas but trim entries; interests containing commas are not
// supported via this text input by design.
function generateId(prefix = "item") {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

// Lightweight URL validator suitable for react-hook-form `validate`.
// Returns true (valid) for empty values (fields are optional) and for
// well-formed http(s) URLs; otherwise returns an error message string.
function isValidURL(value) {
  if (value === undefined || value === null) return true
  const trimmed = String(value).trim()
  if (trimmed === "") return true
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return true
    }
    return "Enter a valid http(s) URL."
  } catch {
    return "Enter a valid http(s) URL."
  }
}

function normaliseContacts(contacts = []) {
  if (!Array.isArray(contacts)) return []
  return contacts.map((contact) => ({
    id: contact.id ?? generateId("contact"),
    label: contact.label ?? "Contact",
    name: contact.name ?? "",
    title: contact.title ?? "",
    email: contact.email ?? "",
    phone: contact.phone ?? "",
    url: contact.url ?? "",
  }))
}

function normalisePipeline(pipeline = []) {
  if (!Array.isArray(pipeline)) return []
  return pipeline.map((stage) => ({
    id: stage.id ?? generateId("stage"),
    label: stage.label ?? "",
    status: stage.status ?? "planned",
    due_date: stage.due_date ?? "",
    completed_at: stage.completed_at ?? "",
    notes: stage.notes ?? "",
  }))
}

function normaliseDepartmentContacts(entries = []) {
  if (!Array.isArray(entries)) return []
  return entries.map((entry) => ({
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
  }))
}

function normaliseMealPlans(plans = []) {
  if (!Array.isArray(plans)) return []
  return plans.map((plan) => ({
    id: plan.id ?? generateId("mealplan"),
    name: plan.name ?? "",
    cost_per_semester: plan.cost_per_semester ?? "",
    notes: plan.notes ?? "",
  }))
}

function buildDefaultContacts() {
  return [
    {
      id: generateId("contact"),
      label: "Admissions Office",
      name: "",
      title: "",
      email: "",
      phone: "",
      url: "",
    },
    {
      id: generateId("contact"),
      label: "Financial Aid Office",
      name: "",
      title: "",
      email: "",
      phone: "",
      url: "",
    },
  ]
}

function buildDefaultPipeline() {
  return [
    {
      id: generateId("stage"),
      label: "FAFSA Submitted",
      status: "planned",
      due_date: "",
      completed_at: "",
      notes: "",
    },
    {
      id: generateId("stage"),
      label: "School Aid Application",
      status: "planned",
      due_date: "",
      completed_at: "",
      notes: "",
    },
  ]
}

// Build a fresh empty value object on every call so that mutable/array fields
// (and especially the generated id) are not shared across separate "create"
// forms. Generating ids lazily here avoids two consecutively created
// universities colliding on the same module-level id.
function buildEmptyValues() {
  return {
    // Leave id empty for create mode; it is generated on submit if missing.
    id: "",
    name: "",
    status: "planning",
    application_type: "regular_decision",
    institution_type: "public",
    website_url: "",
    campus_address: "",
    city: "",
    state: "",
    zip: "",
    main_phone: "",
    main_email: "",
    theme: {
      primary_color: "",
      secondary_color: "",
      cheer_line: "",
      cheer_enabled: true,
    },
    acceptance_rate: "",
    graduation_rate: "",
    student_teacher_ratio: "",
    avg_class_size: "",
    avg_gpa: "",
    sat_range: "",
    tuition: "",
    fafsa_code: "",
    application_fee: "",
    test_optional: false,
    essay_required: false,
    rec_letters_required: 0,
    application_deadline: "",
    financial_aid_deadline: "",
    decision_release_date: "",
    interests_text: "",
    portals: {
      admissions_url: "",
      financial_aid_url: "",
      student_portal_url: "",
      counseling_url: "",
      transcripts_url: "",
      send_scores_url: "",
    },
    costs: {
      housing_preference: "unknown",
      on_campus_total: "",
      off_campus_total: "",
      selected_meal_plan_id: "",
      meal_plans: [],
    },
    // Optional: a per-school list of offered activities (sports/clubs/greek life/etc.)
    // Used by the in-card "Interests" popup so the selection can be school-specific.
    activity_catalog: [],
    actions: {
      apply_url: "",
      pay_fee_url: "",
      visit_url: "",
    },
    contacts: buildDefaultContacts(),
    financial_aid_pipeline: buildDefaultPipeline(),
    department_contacts: [],
    notes: "",
  }
}

export default function UniversityApplicationForm({
  open,
  mode = "create",
  initialValues = null,
  onSubmit = () => {},
  onClose = () => {},
  isSubmitting = false,
}) {
  const defaultValues = useMemo(() => {
    const base = buildEmptyValues()
    if (!initialValues) return base

    const contacts = normaliseContacts(initialValues.contacts)
    const pipeline = normalisePipeline(initialValues.financial_aid_pipeline)
    const departmentContacts = normaliseDepartmentContacts(initialValues.department_contacts)
    const interests = Array.isArray(initialValues.interests) ? initialValues.interests : []
    const mealPlans = normaliseMealPlans(initialValues.costs?.meal_plans)

    // Avoid leaking raw nested objects / raw interests array into form state by
    // omitting them from the spread; we set normalised versions explicitly.
    const {
      interests: _rawInterests,
      theme: _rawTheme,
      portals: _rawPortals,
      costs: _rawCosts,
      contacts: _rawContacts,
      financial_aid_pipeline: _rawPipeline,
      department_contacts: _rawDepartments,
      actions: _rawActions,
      activity_catalog: _rawCatalog,
      ...restInitial
    } = initialValues

    return {
      ...base,
      ...restInitial,
      status: initialValues.status || base.status,
      application_type: initialValues.application_type || base.application_type,
      institution_type: initialValues.institution_type || base.institution_type,
      contacts: contacts.length > 0 ? contacts : buildDefaultContacts(),
      financial_aid_pipeline: pipeline.length > 0 ? pipeline : buildDefaultPipeline(),
      department_contacts: departmentContacts,
      interests_text: interests.join(", "),
      theme: {
        ...base.theme,
        ...(initialValues.theme ?? {}),
      },
      portals: {
        ...base.portals,
        ...(initialValues.portals ?? {}),
      },
      costs: {
        ...base.costs,
        ...(initialValues.costs ?? {}),
        meal_plans: mealPlans,
      },
      activity_catalog: Array.isArray(initialValues.activity_catalog) ? initialValues.activity_catalog : [],
      actions: {
        apply_url: initialValues.actions?.apply_url ?? "",
        pay_fee_url: initialValues.actions?.pay_fee_url ?? "",
        visit_url: initialValues.actions?.visit_url ?? "",
      },
    }
  }, [initialValues])

  const form = useForm({
    defaultValues,
  })

  const {
    control,
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors },
  } = form

  const contactsArray = useFieldArray({
    control,
    name: "contacts",
  })

  const pipelineArray = useFieldArray({
    control,
    name: "financial_aid_pipeline",
  })

  const departmentsArray = useFieldArray({
    control,
    name: "department_contacts",
  })

  const mealPlansArray = useFieldArray({
    control,
    name: "costs.meal_plans",
  })

  useEffect(() => {
    reset(defaultValues)
  }, [defaultValues, reset])

  const submitForm = async (values) => {
    const interests = values.interests_text
      ? values.interests_text
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : []

    const acceptanceRate = values.acceptance_rate
      ? Number.parseFloat(String(values.acceptance_rate))
      : null

    const normalisedAcceptance =
      typeof acceptanceRate === "number" && Number.isFinite(acceptanceRate)
        ? acceptanceRate >= 1
          ? acceptanceRate
          : acceptanceRate * 100
        : null

    const parseNumberOrNull = (raw) => {
      if (raw === undefined || raw === null || String(raw).trim() === "") return null
      const n = Number.parseFloat(String(raw))
      return Number.isFinite(n) ? n : null
    }

    const normalisedGpa = parseNumberOrNull(values.avg_gpa)
    const normalisedTuition = parseNumberOrNull(values.tuition)
    const normalisedFee = (() => {
      if (values.application_fee === undefined || values.application_fee === null || String(values.application_fee).trim() === "") {
        return 0
      }
      const n = Number.parseFloat(String(values.application_fee))
      return Number.isFinite(n) ? n : 0
    })()
    const normalisedGradRate = parseNumberOrNull(values.graduation_rate)
    const normalisedRatio = parseNumberOrNull(values.student_teacher_ratio)
    const normalisedClassSize = parseNumberOrNull(values.avg_class_size)
    const normalisedRecs = (() => {
      const n = Number.parseInt(String(values.rec_letters_required), 10)
      return Number.isFinite(n) ? n : 0
    })()

    const contacts = values.contacts.map((contact) => ({
      ...contact,
      id: contact.id ?? generateId("contact"),
    }))

    const pipeline = values.financial_aid_pipeline.map((stage) => ({
      ...stage,
      id: stage.id ?? generateId("stage"),
    }))

    const departmentContacts = values.department_contacts.map((entry) => ({
      ...entry,
      id: entry.id ?? generateId("department"),
    }))

    const mealPlans = (values.costs?.meal_plans ?? []).map((plan) => ({
      ...plan,
      id: plan.id ?? generateId("mealplan"),
      name: plan.name?.trim?.() ?? "",
    }))

    const normalisedOnCampusTotal = parseNumberOrNull(values.costs?.on_campus_total)
    const normalisedOffCampusTotal = parseNumberOrNull(values.costs?.off_campus_total)

    const rawSelectedMealPlan = values.costs?.selected_meal_plan_id ?? ""
    const selectedMealPlanId = rawSelectedMealPlan === "none" ? "" : rawSelectedMealPlan

    const payload = {
      id: values.id || generateId("application"),
      name: values.name.trim(),
      status: values.status,
      application_type: values.application_type,
      institution_type: values.institution_type,
      website_url: values.website_url?.trim?.() ?? "",
      campus_address: values.campus_address?.trim?.() ?? "",
      city: values.city?.trim?.() ?? "",
      state: values.state?.trim?.() ?? "",
      zip: values.zip?.trim?.() ?? "",
      main_phone: values.main_phone?.trim?.() ?? "",
      main_email: values.main_email?.trim?.() ?? "",
      theme: {
        primary_color: values.theme?.primary_color?.trim?.() ?? "",
        secondary_color: values.theme?.secondary_color?.trim?.() ?? "",
        cheer_line: values.theme?.cheer_line?.trim?.() ?? "",
        cheer_enabled: Boolean(values.theme?.cheer_enabled ?? true),
      },
      acceptance_rate: normalisedAcceptance,
      graduation_rate: normalisedGradRate,
      student_teacher_ratio: normalisedRatio,
      avg_class_size: normalisedClassSize,
      avg_gpa: normalisedGpa,
      sat_range: values.sat_range?.trim() ?? "",
      tuition: normalisedTuition,
      fafsa_code: values.fafsa_code?.trim() ?? "",
      application_fee: normalisedFee,
      test_optional: Boolean(values.test_optional),
      essay_required: Boolean(values.essay_required),
      rec_letters_required: normalisedRecs,
      application_deadline: values.application_deadline || null,
      financial_aid_deadline: values.financial_aid_deadline || null,
      decision_release_date: values.decision_release_date || null,
      interests,
      portals: {
        admissions_url: values.portals?.admissions_url?.trim?.() ?? "",
        financial_aid_url: values.portals?.financial_aid_url?.trim?.() ?? "",
        student_portal_url: values.portals?.student_portal_url?.trim?.() ?? "",
        counseling_url: values.portals?.counseling_url?.trim?.() ?? "",
        transcripts_url: values.portals?.transcripts_url?.trim?.() ?? "",
        send_scores_url: values.portals?.send_scores_url?.trim?.() ?? "",
      },
      costs: {
        housing_preference: HOUSING_PREFERENCES.includes(values.costs?.housing_preference)
          ? values.costs.housing_preference
          : "unknown",
        on_campus_total: normalisedOnCampusTotal,
        off_campus_total: normalisedOffCampusTotal,
        selected_meal_plan_id: selectedMealPlanId,
        meal_plans: mealPlans,
      },
      // Preserve per-school offerings catalog when editing via the form.
      activity_catalog: Array.isArray(values.activity_catalog)
        ? values.activity_catalog
        : [],
      actions: {
        apply_url: values.actions?.apply_url?.trim() ?? "",
        pay_fee_url: values.actions?.pay_fee_url?.trim() ?? "",
        visit_url: values.actions?.visit_url?.trim() ?? "",
      },
      contacts,
      financial_aid_pipeline: pipeline,
      department_contacts: departmentContacts,
      notes: values.notes ?? "",
    }

    try {
      await onSubmit(payload)
    } catch (error) {
      // Surface the error to the console so it is not silently swallowed.
      // The parent owns isSubmitting state and user-facing error messaging.
      // eslint-disable-next-line no-console
      console.error("Failed to submit university application form:", error)
    }
  }

  const statusWatch = watch("status")

  return (
    <Dialog open={open} onOpenChange={(next) => !isSubmitting && !next && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto max-w-3xl">
        <form onSubmit={handleSubmit(submitForm)} className="space-y-6">
          <DialogHeader>
            <DialogTitle>{mode === "edit" ? "Edit University Application" : "Add University Application"}</DialogTitle>
            <DialogDescription>
              Capture admissions details, contacts, and financial aid pipeline for this school.
            </DialogDescription>
            <div className="flex flex-wrap gap-2 pt-2">
              <Badge variant="outline" className="uppercase tracking-wide text-xs">
                Status: {statusWatch?.replace(/_/g, " ")}
              </Badge>
            </div>
          </DialogHeader>

          <section className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="name">University Name *</Label>
              <Input id="name" placeholder="Austin Peay State University" {...register("name", { required: true })} />
              {errors.name && (
                <p className="text-xs text-red-600">University name is required.</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="website_url">Website</Label>
              <Input id="website_url" placeholder="https://www.example.edu" {...register("website_url", { validate: isValidURL })} />
              {errors.website_url && (
                <p className="text-xs text-red-600">{errors.website_url.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label>Status</Label>
              <Controller
                control={control}
                name="status"
                render={({ field }) => (
                  <Select onValueChange={field.onChange} value={field.value || "planning"}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select status" />
                    </SelectTrigger>
                    <SelectContent>
                      {STATUS_OPTIONS.map((option) => (
                        <SelectItem key={option} value={option}>
                          {option.replace(/_/g, " ")}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
            <div className="space-y-2">
              <Label>Application Type</Label>
              <Controller
                control={control}
                name="application_type"
                render={({ field }) => (
                  <Select onValueChange={field.onChange} value={field.value || "regular_decision"}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select type" />
                    </SelectTrigger>
                    <SelectContent>
                      {APPLICATION_TYPES.map((option) => (
                        <SelectItem key={option} value={option}>
                          {option.replace(/_/g, " ")}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
            <div className="space-y-2">
              <Label>Institution Type</Label>
              <Controller
                control={control}
                name="institution_type"
                render={({ field }) => (
                  <Select onValueChange={field.onChange} value={field.value || "public"}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select institution type" />
                    </SelectTrigger>
                    <SelectContent>
                      {INSTITUTION_TYPES.map((option) => (
                        <SelectItem key={option} value={option}>
                          {option.replace(/_/g, " ")}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="application_deadline">Application Deadline</Label>
              <Input id="application_deadline" type="date" {...register("application_deadline")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="financial_aid_deadline">Financial Aid Deadline</Label>
              <Input id="financial_aid_deadline" type="date" {...register("financial_aid_deadline")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="decision_release_date">Decision Release Date</Label>
              <Input id="decision_release_date" type="date" {...register("decision_release_date")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="application_fee">Application Fee (USD)</Label>
              <Input id="application_fee" type="number" step="1" min="0" {...register("application_fee")} />
            </div>
          </section>

          <section className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="campus_address">Campus Address</Label>
              <Input id="campus_address" placeholder="601 College St, Clarksville, TN" {...register("campus_address")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="city">City</Label>
              <Input id="city" placeholder="Clarksville" {...register("city")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="state">State</Label>
              <Input id="state" placeholder="TN" {...register("state")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="zip">ZIP</Label>
              <Input id="zip" placeholder="37040" {...register("zip")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="main_phone">Main Phone</Label>
              <Input id="main_phone" placeholder="(555) 123-4567" {...register("main_phone")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="main_email">Main Email</Label>
              <Input id="main_email" type="email" placeholder="info@example.edu" {...register("main_email")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="acceptance_rate">Acceptance Rate (%)</Label>
              <Input id="acceptance_rate" type="number" step="0.1" min="0" max="100" {...register("acceptance_rate")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="graduation_rate">Graduation Rate (%)</Label>
              <Input id="graduation_rate" type="number" step="0.1" min="0" max="100" {...register("graduation_rate")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="avg_gpa">Average GPA</Label>
              <Input id="avg_gpa" type="number" step="0.01" min="0" max="4.5" {...register("avg_gpa")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sat_range">SAT Range</Label>
              <Input id="sat_range" placeholder="950-1170" {...register("sat_range")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="tuition">Tuition (Annual USD)</Label>
              <Input id="tuition" type="number" step="100" min="0" {...register("tuition")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="student_teacher_ratio">Student/Teacher Ratio</Label>
              <Input id="student_teacher_ratio" type="number" step="0.1" min="0" {...register("student_teacher_ratio")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="avg_class_size">Average Class Size</Label>
              <Input id="avg_class_size" type="number" step="1" min="0" {...register("avg_class_size")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="fafsa_code">FAFSA Code</Label>
              <Input id="fafsa_code" placeholder="003478" {...register("fafsa_code")} />
            </div>
            <div className="flex items-center justify-between space-y-0 border rounded-lg p-3">
              <div>
                <Label className="text-sm font-medium">Test Optional</Label>
                <p className="text-xs text-muted-foreground">
                  Indicates whether standardized test scores are optional.
                </p>
              </div>
              <Controller
                control={control}
                name="test_optional"
                render={({ field }) => (
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                )}
              />
            </div>
            <div className="flex items-center justify-between space-y-0 border rounded-lg p-3">
              <div>
                <Label className="text-sm font-medium">Essay Required</Label>
                <p className="text-xs text-muted-foreground">Whether personal essays are mandatory.</p>
              </div>
              <Controller
                control={control}
                name="essay_required"
                render={({ field }) => (
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                )}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="rec_letters_required">Recommendation Letters Required</Label>
              <Input
                id="rec_letters_required"
                type="number"
                min="0"
                max="5"
                {...register("rec_letters_required")}
              />
            </div>
          </section>

          <section className="space-y-4">
            <div>
              <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">School theme</h3>
              <p className="text-xs text-muted-foreground">
                Optional. If set, this card can render using the school\u2019s colors and a cheer line.
              </p>
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="theme.primary_color">Primary color</Label>
                <div className="flex items-center gap-2">
                  <Input id="theme.primary_color" placeholder="#BB0000" {...register("theme.primary_color")} />
                  <input
                    type="color"
                    aria-label="Primary color picker"
                    className="h-10 w-12 rounded border border-slate-200 bg-white"
                    onChange={(e) =>
                      form.setValue("theme.primary_color", e.target.value, {
                        shouldDirty: true,
                        shouldTouch: true,
                      })
                    }
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="theme.secondary_color">Secondary color</Label>
                <div className="flex items-center gap-2">
                  <Input id="theme.secondary_color" placeholder="#666666" {...register("theme.secondary_color")} />
                  <input
                    type="color"
                    aria-label="Secondary color picker"
                    className="h-10 w-12 rounded border border-slate-200 bg-white"
                    onChange={(e) =>
                      form.setValue("theme.secondary_color", e.target.value, {
                        shouldDirty: true,
                        shouldTouch: true,
                      })
                    }
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="theme.cheer_line">Cheer line</Label>
                <Input id="theme.cheer_line" placeholder="Go Buckeyes!" {...register("theme.cheer_line")} />
              </div>
              <div className="flex items-center justify-between space-y-0 border rounded-lg p-3 md:col-span-3">
                <div>
                  <Label className="text-sm font-medium">Show cheer line on card</Label>
                  <p className="text-xs text-muted-foreground">Turn off if you want colors only.</p>
                </div>
                <Controller
                  control={control}
                  name="theme.cheer_enabled"
                  render={({ field }) => (
                    <Switch checked={Boolean(field.value)} onCheckedChange={field.onChange} />
                  )}
                />
              </div>
            </div>
          </section>

          <section className="space-y-4">
            <div>
              <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Portals</h3>
              <p className="text-xs text-muted-foreground">
                Add links for admissions, financial aid, current student portals, counseling, and transcript/score sending.
              </p>
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="portals.admissions_url">Admissions Portal</Label>
                <Input id="portals.admissions_url" placeholder="https://..." {...register("portals.admissions_url", { validate: isValidURL })} />
                {errors.portals?.admissions_url && (
                  <p className="text-xs text-red-600">{errors.portals.admissions_url.message}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="portals.financial_aid_url">Financial Aid Portal</Label>
                <Input id="portals.financial_aid_url" placeholder="https://..." {...register("portals.financial_aid_url", { validate: isValidURL })} />
                {errors.portals?.financial_aid_url && (
                  <p className="text-xs text-red-600">{errors.portals.financial_aid_url.message}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="portals.student_portal_url">Current Student Portal</Label>
                <Input id="portals.student_portal_url" placeholder="https://..." {...register("portals.student_portal_url", { validate: isValidURL })} />
                {errors.portals?.student_portal_url && (
                  <p className="text-xs text-red-600">{errors.portals.student_portal_url.message}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="portals.counseling_url">Counseling / Advising</Label>
                <Input id="portals.counseling_url" placeholder="https://..." {...register("portals.counseling_url", { validate: isValidURL })} />
                {errors.portals?.counseling_url && (
                  <p className="text-xs text-red-600">{errors.portals.counseling_url.message}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="portals.transcripts_url">Transcripts Request / Send</Label>
                <Input id="portals.transcripts_url" placeholder="https://..." {...register("portals.transcripts_url", { validate: isValidURL })} />
                {errors.portals?.transcripts_url && (
                  <p className="text-xs text-red-600">{errors.portals.transcripts_url.message}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="portals.send_scores_url">Send Test Scores</Label>
                <Input id="portals.send_scores_url" placeholder="https://..." {...register("portals.send_scores_url", { validate: isValidURL })} />
                {errors.portals?.send_scores_url && (
                  <p className="text-xs text-red-600">{errors.portals.send_scores_url.message}</p>
                )}
              </div>
            </div>
          </section>

          <section className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="actions.apply_url">Apply URL</Label>
              <Input id="actions.apply_url" placeholder="https://..." {...register("actions.apply_url", { validate: isValidURL })} />
              {errors.actions?.apply_url && (
                <p className="text-xs text-red-600">{errors.actions.apply_url.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="actions.pay_fee_url">Pay Fee URL</Label>
              <Input id="actions.pay_fee_url" placeholder="https://..." {...register("actions.pay_fee_url", { validate: isValidURL })} />
              {errors.actions?.pay_fee_url && (
                <p className="text-xs text-red-600">{errors.actions.pay_fee_url.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="actions.visit_url">Visit URL</Label>
              <Input id="actions.visit_url" placeholder="https://..." {...register("actions.visit_url", { validate: isValidURL })} />
              {errors.actions?.visit_url && (
                <p className="text-xs text-red-600">{errors.actions.visit_url.message}</p>
              )}
            </div>
          </section>

          <section className="space-y-4">
            <div>
              <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Cost planner</h3>
              <p className="text-xs text-muted-foreground">
                Track estimated costs and meal plan options that affect budgeting.
              </p>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label>Housing preference</Label>
                <Controller
                  control={control}
                  name="costs.housing_preference"
                  render={({ field }) => (
                    <Select onValueChange={field.onChange} value={field.value || "unknown"}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select preference" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="unknown">Unknown</SelectItem>
                        <SelectItem value="on_campus">On campus</SelectItem>
                        <SelectItem value="off_campus">Off campus</SelectItem>
                        <SelectItem value="commuter">Commuter</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="costs.on_campus_total">On-campus total (annual USD)</Label>
                <Input id="costs.on_campus_total" type="number" step="100" min="0" {...register("costs.on_campus_total")} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="costs.off_campus_total">Off-campus total (annual USD)</Label>
                <Input id="costs.off_campus_total" type="number" step="100" min="0" {...register("costs.off_campus_total")} />
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <h4 className="text-sm font-semibold text-slate-700">Meal plans</h4>
                <p className="text-xs text-muted-foreground">Add meal plan options offered by the school.</p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  mealPlansArray.append({
                    id: generateId("mealplan"),
                    name: "",
                    cost_per_semester: "",
                    notes: "",
                  })
                }
              >
                <Plus className="w-4 h-4 mr-2" />
                Add meal plan
              </Button>
            </div>

            {mealPlansArray.fields.length > 0 ? (
              <div className="space-y-3">
                {mealPlansArray.fields.map((field, index) => (
                  <div key={field.id} className="grid gap-3 border rounded-lg p-3 md:grid-cols-12">
                    <div className="md:col-span-5 space-y-2">
                      <Label>Name</Label>
                      <Input placeholder="Unlimited + Dining Dollars" {...register(`costs.meal_plans.${index}.name`)} />
                    </div>
                    <div className="md:col-span-3 space-y-2">
                      <Label>Cost / semester (USD)</Label>
                      <Input
                        type="number"
                        step="50"
                        min="0"
                        {...register(`costs.meal_plans.${index}.cost_per_semester`)}
                      />
                    </div>
                    <div className="md:col-span-3 space-y-2">
                      <Label>Notes</Label>
                      <Input placeholder="Includes weekends" {...register(`costs.meal_plans.${index}.notes`)} />
                    </div>
                    <div className="md:col-span-1 flex items-start justify-end">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => mealPlansArray.remove(index)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                ))}

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Selected meal plan</Label>
                    <Controller
                      control={control}
                      name="costs.selected_meal_plan_id"
                      render={({ field }) => (
                        <Select
                          onValueChange={field.onChange}
                          value={field.value || "none"}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select a plan (optional)" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">None</SelectItem>
                            {mealPlansArray.fields.map((plan) => (
                              <SelectItem key={plan.id} value={plan.id}>
                                {String(plan.name || "Meal plan").trim() || "Meal plan"}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-sm text-slate-500">No meal plans recorded yet.</p>
            )}
          </section>

          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                  Financial Aid Pipeline
                </h3>
                <p className="text-xs text-muted-foreground">
                  Track each milestone required to unlock aid for this institution.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  pipelineArray.append({
                    id: generateId("stage"),
                    label: "",
                    status: "planned",
                    due_date: "",
                    completed_at: "",
                    notes: "",
                  })
                }
              >
                <Plus className="w-4 h-4 mr-2" />
                Add Step
              </Button>
            </div>

            <div className="space-y-3">
              {pipelineArray.fields.map((field, index) => (
                <div key={field.id} className="grid gap-3 border rounded-lg p-3 md:grid-cols-12">
                  <div className="md:col-span-4 space-y-2">
                    <Label>Stage</Label>
                    <Input
                      placeholder="Scholarship Interview"
                      {...register(`financial_aid_pipeline.${index}.label`)}
                    />
                  </div>
                  <div className="md:col-span-3 space-y-2">
                    <Label>Status</Label>
                    <Controller
                      control={control}
                      name={`financial_aid_pipeline.${index}.status`}
                      render={({ field }) => (
                        <Select onValueChange={field.onChange} value={field.value || "planned"}>
                          <SelectTrigger>
                            <SelectValue placeholder="Select status" />
                          </SelectTrigger>
                          <SelectContent>
                            {PIPELINE_STATUS_OPTIONS.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </div>
                  <div className="md:col-span-2 space-y-2">
                    <Label>Due Date</Label>
                    <Input type="date" {...register(`financial_aid_pipeline.${index}.due_date`)} />
                  </div>
                  <div className="md:col-span-2 space-y-2">
                    <Label>Completed</Label>
                    <Input type="date" {...register(`financial_aid_pipeline.${index}.completed_at`)} />
                  </div>
                  <div className="md:col-span-11 space-y-2">
                    <Label>Notes</Label>
                    <Textarea
                      placeholder="Interview scheduled, scholarship director to confirm."
                      {...register(`financial_aid_pipeline.${index}.notes`)}
                    />
                  </div>
                  <div className="md:col-span-1 flex items-start justify-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => pipelineArray.remove(index)}
                      disabled={false}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                  University Contacts
                </h3>
                <p className="text-xs text-muted-foreground">
                  Admissions, financial aid, and general points of contact.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  contactsArray.append({
                    id: generateId("contact"),
                    label: "Contact",
                    name: "",
                    title: "",
                    email: "",
                    phone: "",
                    url: "",
                  })
                }
              >
                <Plus className="w-4 h-4 mr-2" />
                Add Contact
              </Button>
            </div>

            <div className="space-y-3">
              {contactsArray.fields.map((field, index) => (
                <div key={field.id} className="grid gap-3 border rounded-lg p-3 md:grid-cols-12">
                  <div className="md:col-span-4 space-y-2">
                    <Label>Label</Label>
                    <Input
                      placeholder="Admissions Office"
                      {...register(`contacts.${index}.label`)}
                    />
                  </div>
                  <div className="md:col-span-4 space-y-2">
                    <Label>Name</Label>
                    <Input placeholder="Jane Doe" {...register(`contacts.${index}.name`)} />
                  </div>
                  <div className="md:col-span-3 space-y-2">
                    <Label>Title</Label>
                    <Input placeholder="Associate Director" {...register(`contacts.${index}.title`)} />
                  </div>
                  <div className="md:col-span-1 flex items-start justify-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => contactsArray.remove(index)}
                      disabled={contactsArray.fields.length <= 1}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                  <div className="md:col-span-4 space-y-2">
                    <Label>Email</Label>
                    <Input type="email" placeholder="admissions@example.edu" {...register(`contacts.${index}.email`)} />
                  </div>
                  <div className="md:col-span-4 space-y-2">
                    <Label>Phone</Label>
                    <Input placeholder="555-123-4567" {...register(`contacts.${index}.phone`)} />
                  </div>
                  <div className="md:col-span-4 space-y-2">
                    <Label>URL</Label>
                    <Input placeholder="https://example.edu/admissions" {...register(`contacts.${index}.url`, { validate: isValidURL })} />
                    {errors.contacts?.[index]?.url && (
                      <p className="text-xs text-red-600">{errors.contacts[index].url.message}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                  Department & Program Contacts
                </h3>
                <p className="text-xs text-muted-foreground">
                  Capture coaches or professors for majors, band, athletics, or other interests. Use gender targeting for sports.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  departmentsArray.append({
                    id: generateId("department"),
                    area: "",
                    category: "",
                    gender_target: "any",
                    name: "",
                    title: "",
                    email: "",
                    phone: "",
                    url: "",
                    notes: "",
                  })
                }
              >
                <Plus className="w-4 h-4 mr-2" />
                Add Department Contact
              </Button>
            </div>

            <div className="space-y-3">
              {departmentsArray.fields.map((field, index) => (
                <div key={field.id} className="grid gap-3 border rounded-lg p-3 md:grid-cols-12">
                  <div className="md:col-span-4 space-y-2">
                    <Label>Program / Department</Label>
                    <Input placeholder="Music - Band Program" {...register(`department_contacts.${index}.area`)} />
                  </div>
                  <div className="md:col-span-3 space-y-2">
                    <Label>Category</Label>
                    <Input placeholder="Athletics / Band / Department" {...register(`department_contacts.${index}.category`)} />
                  </div>
                  <div className="md:col-span-3 space-y-2">
                    <Label>Gender target (sports)</Label>
                    <Controller
                      control={control}
                      name={`department_contacts.${index}.gender_target`}
                      render={({ field }) => (
                        <Select onValueChange={field.onChange} value={field.value || "any"}>
                          <SelectTrigger>
                            <SelectValue placeholder="Any" />
                          </SelectTrigger>
                          <SelectContent>
                            {CONTACT_GENDER_TARGETS.map((value) => (
                              <SelectItem key={value} value={value}>
                                {value}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </div>
                  <div className="md:col-span-4 space-y-2">
                    <Label>Contact Name</Label>
                    <Input placeholder="Coach Taylor" {...register(`department_contacts.${index}.name`)} />
                  </div>
                  <div className="md:col-span-3 space-y-2">
                    <Label>Title / Role</Label>
                    <Input placeholder="Director" {...register(`department_contacts.${index}.title`)} />
                  </div>
                  <div className="md:col-span-1 flex items-start justify-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => departmentsArray.remove(index)}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                  <div className="md:col-span-4 space-y-2">
                    <Label>Email</Label>
                    <Input type="email" placeholder="band@example.edu" {...register(`department_contacts.${index}.email`)} />
                  </div>
                  <div className="md:col-span-4 space-y-2">
                    <Label>Phone</Label>
                    <Input placeholder="555-987-6543" {...register(`department_contacts.${index}.phone`)} />
                  </div>
                  <div className="md:col-span-4 space-y-2">
                    <Label>URL</Label>
                    <Input placeholder="https://example.edu/athletics" {...register(`department_contacts.${index}.url`, { validate: isValidURL })} />
                    {errors.department_contacts?.[index]?.url && (
                      <p className="text-xs text-red-600">{errors.department_contacts[index].url.message}</p>
                    )}
                  </div>
                  <div className="md:col-span-12 space-y-2">
                    <Label>Notes</Label>
                    <Textarea placeholder="Left voicemail on 12/15 regarding auditions." {...register(`department_contacts.${index}.notes`)} />
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="interests_text">Interests & Programs</Label>
              <Input
                id="interests_text"
                placeholder="band, volleyball, nursing"
                {...register("interests_text")}
              />
              <p className="text-xs text-muted-foreground">
                Separate multiple interests with commas. Avoid commas inside an individual interest, as they are used as separators. These power targeted contacts and scholarships.
              </p>
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="notes">Notes</Label>
              <Textarea
                id="notes"
                rows={4}
                placeholder="E.g. Admissions counselor promised merit review by Feb 15."
                {...register("notes")}
              />
            </div>
          </section>

          <DialogFooter className="flex items-center justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => !isSubmitting && onClose()}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Saving..." : mode === "edit" ? "Save Changes" : "Add University"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
