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

function generateId(prefix = "item") {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
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
    name: entry.name ?? "",
    title: entry.title ?? "",
    email: entry.email ?? "",
    phone: entry.phone ?? "",
    notes: entry.notes ?? "",
  }))
}

const defaultContacts = [
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

const defaultPipeline = [
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

const emptyValues = {
  id: generateId("application"),
  name: "",
  status: "planning",
  application_type: "regular_decision",
  institution_type: "public",
  acceptance_rate: "",
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
  actions: {
    apply_url: "",
    pay_fee_url: "",
    visit_url: "",
  },
  contacts: defaultContacts,
  financial_aid_pipeline: defaultPipeline,
  department_contacts: [],
  notes: "",
}

export default function UniversityApplicationForm({
  open,
  mode = "create",
  initialValues = null,
  onSubmit,
  onClose,
  isSubmitting = false,
}) {
  const defaultValues = useMemo(() => {
    if (!initialValues) return emptyValues

    const contacts = normaliseContacts(initialValues.contacts)
    const pipeline = normalisePipeline(initialValues.financial_aid_pipeline)
    const departmentContacts = normaliseDepartmentContacts(initialValues.department_contacts)
    const interests = Array.isArray(initialValues.interests) ? initialValues.interests : []

    return {
      ...emptyValues,
      ...initialValues,
      contacts: contacts.length > 0 ? contacts : defaultContacts,
      financial_aid_pipeline: pipeline.length > 0 ? pipeline : defaultPipeline,
      department_contacts: departmentContacts,
      interests_text: interests.join(", "),
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

  useEffect(() => {
    reset(defaultValues)
  }, [defaultValues, reset])

  const submitForm = (values) => {
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
        ? acceptanceRate > 1 && acceptanceRate <= 100
          ? acceptanceRate
          : acceptanceRate * 100
        : null

    const normalisedGpa = values.avg_gpa ? Number.parseFloat(String(values.avg_gpa)) : null
    const normalisedTuition = values.tuition ? Number.parseFloat(String(values.tuition)) : null
    const normalisedFee = values.application_fee
      ? Number.parseFloat(String(values.application_fee))
      : 0
    const normalisedRecs = Number.isFinite(Number(values.rec_letters_required))
      ? Number.parseInt(String(values.rec_letters_required), 10)
      : 0

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

    const payload = {
      id: values.id ?? generateId("application"),
      name: values.name.trim(),
      status: values.status,
      application_type: values.application_type,
      institution_type: values.institution_type,
      acceptance_rate: normalisedAcceptance,
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

    onSubmit(payload)
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
              <Label>Status</Label>
              <Controller
                control={control}
                name="status"
                render={({ field }) => (
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
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
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
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
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
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
            <div className="space-y-2">
              <Label htmlFor="acceptance_rate">Acceptance Rate (%)</Label>
              <Input id="acceptance_rate" type="number" step="0.1" min="0" max="100" {...register("acceptance_rate")} />
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

          <section className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="actions.apply_url">Apply URL</Label>
              <Input id="actions.apply_url" placeholder="https://..." {...register("actions.apply_url")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="actions.pay_fee_url">Pay Fee URL</Label>
              <Input id="actions.pay_fee_url" placeholder="https://..." {...register("actions.pay_fee_url")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="actions.visit_url">Visit URL</Label>
              <Input id="actions.visit_url" placeholder="https://..." {...register("actions.visit_url")} />
            </div>
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
                        <Select onValueChange={field.onChange} defaultValue={field.value}>
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
                      disabled={pipelineArray.fields.length <= 1}
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
                    <Input placeholder="https://example.edu/admissions" {...register(`contacts.${index}.url`)} />
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
                  Capture coaches or professors for majors, band, athletics, or other interests.
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
                    name: "",
                    title: "",
                    email: "",
                    phone: "",
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
                Separate multiple interests with commas. These power targeted contacts and scholarships.
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
