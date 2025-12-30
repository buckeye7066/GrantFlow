import { Controller, useForm } from "react-hook-form"
import type { Profile } from "../../api/base44Client"
import { Input } from "../ui/input"
import { Textarea } from "../ui/textarea"
import { Select } from "../ui/select"
import { Checkbox } from "../ui/checkbox"
import { Button } from "../ui/button"

export type ProfileFormValues = {
  profile_type: string
  display_name: string
  notes: string
  full_name: string
  dob: string
  job_title: string
  address_line1: string
  address_line2: string
  city: string
  state: string
  zip: string
  contact_email: string
  contact_phone: string
  website: string
  mission_statement: string
  ein: string
  duns: string
  cage_code: string
  naics_codes: string
  annual_budget: string
  staff_count: string
  volunteer_count: string
  service_area: string
  demographics_served: string
  program_focus_areas: string
  compliance_notes: string
  certifications: string
  created_by: string
  owner_id: string
  case_manager_id: string
  admin_id: string
  last_contacted_at: string
  status: string
  phi_access_required: boolean
}

const PROFILE_TYPES = [
  { value: "organization", label: "Organization" },
  { value: "individual", label: "Individual" },
  { value: "student", label: "Student" },
]

const PROFILE_STATUSES = [
  { value: "active", label: "Active" },
  { value: "prospect", label: "Prospect" },
  { value: "inactive", label: "Inactive" },
]

// eslint-disable-next-line react-refresh/only-export-components
export function toProfileFormValues(profile?: Profile | null): ProfileFormValues {
  return {
    profile_type: profile?.profile_type ?? "organization",
    display_name: profile?.display_name ?? "",
    notes: profile?.notes ?? "",
    full_name: profile?.full_name ?? "",
    dob: profile?.dob ?? "",
    job_title: profile?.job_title ?? "",
    address_line1: profile?.address_line1 ?? "",
    address_line2: profile?.address_line2 ?? "",
    city: profile?.city ?? "",
    state: profile?.state ?? "",
    zip: profile?.zip ?? "",
    contact_email: profile?.contact_email ?? "",
    contact_phone: profile?.contact_phone ?? "",
    website: profile?.website ?? "",
    mission_statement: profile?.mission_statement ?? "",
    ein: profile?.ein ?? "",
    duns: profile?.duns ?? "",
    cage_code: profile?.cage_code ?? "",
    naics_codes: profile?.naics_codes ?? "",
    annual_budget: profile?.annual_budget != null ? String(profile.annual_budget) : "",
    staff_count: profile?.staff_count != null ? String(profile.staff_count) : "",
    volunteer_count: profile?.volunteer_count != null ? String(profile.volunteer_count) : "",
    service_area: profile?.service_area ?? "",
    demographics_served: profile?.demographics_served ?? "",
    program_focus_areas: profile?.program_focus_areas ?? "",
    compliance_notes: profile?.compliance_notes ?? "",
    certifications: profile?.certifications ?? "",
    created_by: profile?.created_by ?? "",
    owner_id: profile?.owner_id ?? "",
    case_manager_id: profile?.case_manager_id ?? "",
    admin_id: profile?.admin_id ?? "",
    last_contacted_at: profile?.last_contacted_at ?? "",
    status: profile?.status ?? "active",
    phi_access_required: Boolean(profile?.phi_access_required),
  }
}

// eslint-disable-next-line react-refresh/only-export-components
export function profilePayloadFromValues(values: ProfileFormValues): Partial<Profile> {
  const normaliseString = (value: string) => (value.trim().length > 0 ? value.trim() : null)
  const normaliseNumber = (value: string) => {
    if (!value || value.trim() === "") return null
    const numeric = Number(value)
    return Number.isNaN(numeric) ? null : numeric
  }

  return {
    profile_type: values.profile_type,
    display_name: values.display_name,
    notes: values.notes,
    full_name: normaliseString(values.full_name),
    dob: normaliseString(values.dob),
    job_title: normaliseString(values.job_title),
    address_line1: normaliseString(values.address_line1),
    address_line2: normaliseString(values.address_line2),
    city: normaliseString(values.city),
    state: normaliseString(values.state),
    zip: normaliseString(values.zip),
    contact_email: normaliseString(values.contact_email),
    contact_phone: normaliseString(values.contact_phone),
    website: normaliseString(values.website),
    mission_statement: normaliseString(values.mission_statement),
    ein: normaliseString(values.ein),
    duns: normaliseString(values.duns),
    cage_code: normaliseString(values.cage_code),
    naics_codes: normaliseString(values.naics_codes),
    annual_budget: normaliseNumber(values.annual_budget),
    staff_count: normaliseNumber(values.staff_count),
    volunteer_count: normaliseNumber(values.volunteer_count),
    service_area: normaliseString(values.service_area),
    demographics_served: normaliseString(values.demographics_served),
    program_focus_areas: normaliseString(values.program_focus_areas),
    compliance_notes: normaliseString(values.compliance_notes),
    certifications: normaliseString(values.certifications),
    phi_access_required: values.phi_access_required,
    created_by: normaliseString(values.created_by),
    owner_id: normaliseString(values.owner_id),
    case_manager_id: normaliseString(values.case_manager_id),
    admin_id: normaliseString(values.admin_id),
    last_contacted_at: values.last_contacted_at
      ? new Date(values.last_contacted_at).toISOString()
      : null,
    status: normaliseString(values.status),
  }
}

interface ProfileFormProps {
  initialValues?: ProfileFormValues
  onSubmit: (values: ProfileFormValues) => void
  onCancel: () => void
  submitLabel?: string
  isSubmitting?: boolean
}

export function ProfileForm({
  initialValues,
  onSubmit,
  onCancel,
  submitLabel = "Save profile",
  isSubmitting = false,
}: ProfileFormProps) {
  const form = useForm<ProfileFormValues>({
    defaultValues: initialValues ?? toProfileFormValues(),
  })

  return (
    <form
      className="space-y-6"
      onSubmit={form.handleSubmit(onSubmit)}
      onReset={() => {
        form.reset(initialValues ?? toProfileFormValues())
      }}
    >
      <section className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">
            Profile Type
            <Select {...form.register("profile_type")}>
              {PROFILE_TYPES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </label>
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">
            Display Name<span className="text-destructive">*</span>
            <Input
              {...form.register("display_name", { required: true })}
              placeholder="River Valley Education Fund"
            />
          </label>
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">
            Status
            <Select {...form.register("status")}>
              {PROFILE_STATUSES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </label>
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">
            Last Contacted
            <Input type="datetime-local" {...form.register("last_contacted_at")} />
          </label>
        </div>
      </section>

      <section className="space-y-4">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Primary Contacts
        </h3>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">
              Primary Contact
              <Input {...form.register("full_name")} placeholder="Jordan Lee" />
            </label>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">
              Job Title
              <Input {...form.register("job_title")} placeholder="Executive Director" />
            </label>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">
              Email
              <Input type="email" {...form.register("contact_email")} placeholder="hello@example.org" />
            </label>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">
              Phone
              <Input {...form.register("contact_phone")} placeholder="+1 (423) 555-0101" />
            </label>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">
              Website
              <Input {...form.register("website")} placeholder="https://example.org" />
            </label>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">
              Date of Birth
              <Input type="date" {...form.register("dob")} />
            </label>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Location
        </h3>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2 md:col-span-2">
            <label className="text-sm font-medium text-foreground">
              Address Line 1
              <Input {...form.register("address_line1")} placeholder="123 Grant Avenue" />
            </label>
          </div>
          <div className="space-y-2 md:col-span-2">
            <label className="text-sm font-medium text-foreground">
              Address Line 2
              <Input {...form.register("address_line2")} placeholder="Suite 400" />
            </label>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">
              City
              <Input {...form.register("city")} />
            </label>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">
              State / Province
              <Input {...form.register("state")} />
            </label>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">
              ZIP / Postal Code
              <Input {...form.register("zip")} />
            </label>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Organizational Profile
        </h3>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">
              Mission Statement
              <Textarea rows={4} {...form.register("mission_statement")} />
            </label>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">
              Focus Areas
              <Textarea
                rows={4}
                {...form.register("program_focus_areas")}
                placeholder="STEM education, workforce development, community health..."
              />
            </label>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">
              Service Area
              <Input {...form.register("service_area")} placeholder="Tennessee, Northern Georgia" />
            </label>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">
              Demographics Served
              <Input
                {...form.register("demographics_served")}
                placeholder="Rural students, first-generation college applicants"
              />
            </label>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">
              Annual Budget (USD)
              <Input type="number" step="0.01" min="0" {...form.register("annual_budget")} />
            </label>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">
              Staff Count
              <Input type="number" min="0" {...form.register("staff_count")} />
            </label>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">
              Volunteer Count
              <Input type="number" min="0" {...form.register("volunteer_count")} />
            </label>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Compliance & Identifiers
        </h3>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">
              EIN
              <Input {...form.register("ein")} />
            </label>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">
              DUNS
              <Input {...form.register("duns")} />
            </label>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">
              CAGE Code
              <Input {...form.register("cage_code")} />
            </label>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">
              NAICS Codes
              <Input {...form.register("naics_codes")} placeholder="611110, 622110" />
            </label>
          </div>
          <div className="space-y-2 md:col-span-2">
            <label className="text-sm font-medium text-foreground">
              Certifications & Registrations
              <Textarea {...form.register("certifications")} />
            </label>
          </div>
          <div className="space-y-2 md:col-span-2">
            <label className="text-sm font-medium text-foreground">
              Compliance Notes
              <Textarea {...form.register("compliance_notes")} />
            </label>
          </div>
          <div className="flex items-center gap-3 md:col-span-2">
            <Controller
              control={form.control}
              name="phi_access_required"
              render={({ field }) => (
                <>
                  <Checkbox
                    checked={field.value}
                    onChange={(event) => field.onChange(event.target.checked)}
                    onBlur={field.onBlur}
                    ref={field.ref}
                  />
                  <span className="text-sm text-muted-foreground">
                    Protected Health Information (PHI) access required
                  </span>
                </>
              )}
            />
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Ownership & Roles
        </h3>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">
              Created By
              <Input {...form.register("created_by")} placeholder="clerk_123" />
            </label>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">
              Owner ID
              <Input {...form.register("owner_id")} placeholder="owner_456" />
            </label>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">
              Case Manager ID
              <Input {...form.register("case_manager_id")} placeholder="case_mgr_789" />
            </label>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">
              Admin ID
              <Input {...form.register("admin_id")} placeholder="admin_123" />
            </label>
          </div>
        </div>
      </section>

      <section className="space-y-2">
        <label className="text-sm font-medium text-foreground">
          Internal Notes
          <Textarea rows={4} {...form.register("notes")} />
        </label>
      </section>

      <div className="flex flex-col gap-2 border-t border-border/60 pt-4 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Saving..." : submitLabel}
        </Button>
      </div>
    </form>
  )
}


