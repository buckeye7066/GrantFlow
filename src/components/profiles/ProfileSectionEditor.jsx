/* eslint-disable react-refresh/only-export-components */
import React, { useEffect, useState } from "react"
import { Controller, useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Info, Sparkles, Loader2 } from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import ProfileFieldWithAI from "@/components/profiles/ProfileFieldWithAI"

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false
  return Object.prototype.toString.call(value) === '[object Object]'
}

function formatAddressObject(address) {
  if (!isPlainObject(address)) return null

  const parts = []
  const line1 = address.line1 ?? address.address1 ?? address.street ?? address.street1
  const line2 = address.line2 ?? address.address2 ?? address.street2
  if (line1) parts.push(String(line1).trim())
  if (line2) parts.push(String(line2).trim())

  const city = address.city
  const state = address.state ?? address.region
  const postal = address.zip ?? address.postal ?? address.postal_code ?? address.zip_code

  const cityLineParts = [city, state].filter(Boolean).map((v) => String(v).trim())
  const cityLine = cityLineParts.join(', ')
  const cityPostal = [cityLine, postal].filter(Boolean).join(' ')
  if (cityPostal) parts.push(cityPostal.trim())

  const country = address.country
  if (country) parts.push(String(country).trim())

  return parts.filter(Boolean).join('\n').trim() || null
}

function normalizeTextValue(fieldName, value) {
  if (value === undefined || value === null) return ""
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)

  if (isPlainObject(value) && fieldName === 'address') {
    const formatted = formatAddressObject(value)
    if (formatted) return formatted
  }

  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }

  return String(value)
}

function normalizeInitialData(config, initialData) {
  if (!config) return {}
  if (!initialData || typeof initialData !== 'object') return {}

  const out = { ...initialData }

  // Backwards-compatible alias mapping so profiles created with older scripts/UI
  // still populate the canonical comprehensive-application fields.
  if (config.key === "basic_information") {
    if (!out.name && out.full_name) out.name = out.full_name
  }
  if (config.key === "organization_details") {
    if (!out.organization_ein && out.ein) out.organization_ein = out.ein
    if (!out.organization_uei && out.uei) out.organization_uei = out.uei
    if (!out.organization_cage_code && out.cage_code) out.organization_cage_code = out.cage_code
    if (!out.applicant_type && out.organization_type) out.applicant_type = out.organization_type
  }
  if (config.key === "demographics") {
    if (!out.immigration_status && out.immigrant_status) out.immigration_status = out.immigrant_status
  }

  for (const field of config.fields ?? []) {
    if (!field?.name) continue
    if (field.type === 'boolean') continue

    const current = out[field.name]
    // Inputs/Textareas should never receive an object value
    if (typeof current === 'object' && current !== null) {
      out[field.name] = normalizeTextValue(field.name, current)
    }
  }

  return out
}

const splitList = (value) => {
  if (!value) return []
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
  if (typeof value !== "string") return [String(value)].map((v) => v.trim()).filter(Boolean)
  return value
    .split(/[\n,]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

const numberOrEmptyString = z
  .union([z.number(), z.string()])
  .optional()
  .transform((value) => {
    if (value === "" || value === undefined || value === null) return ""
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : ""
  })

const basicInfoSchema = z
  .object({
    // Comprehensive application parity fields
    name: z.string().optional().or(z.literal("")),
    date_of_birth: z.string().optional().or(z.literal("")),
    age: numberOrEmptyString,
    email: z
      .union([z.array(z.string()), z.string()])
      .optional()
      .transform((value) => splitList(value)),
    phone: z
      .union([z.array(z.string()), z.string()])
      .optional()
      .transform((value) => splitList(value)),
    address: z.string().optional().or(z.literal("")),
    city: z.string().optional().or(z.literal("")),
    state: z.string().optional().or(z.literal("")),
    zip: z.string().optional().or(z.literal("")),
    website: z.string().optional().or(z.literal("")),

    // Backwards-compatible aliases used by older tooling/import scripts.
    full_name: z.string().optional().or(z.literal("")),
    notes: z.string().optional().or(z.literal("")),
  })
  .superRefine((value, ctx) => {
    const hasName = Boolean(String(value.name || "").trim())
    const hasFullName = Boolean(String(value.full_name || "").trim())
    if (!hasName && !hasFullName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Name is required",
        path: ["name"],
      })
    }
  })

const organizationDetailsSchema = z.object({
  // Comprehensive application parity fields
  applicant_type: z.string().optional().or(z.literal("")),
  nonprofit_type: z.string().optional().or(z.literal("")),
  organization_ein: z.string().optional().or(z.literal("")),
  organization_uei: z.string().optional().or(z.literal("")),
  organization_cage_code: z.string().optional().or(z.literal("")),
  ntee_code: z.string().optional().or(z.literal("")),
  evidence_based_program: z.string().optional().or(z.literal("")),
  annual_budget: numberOrEmptyString,
  staff_count: numberOrEmptyString,
  sam_gov_registered: booleanField,
  grants_gov_active: booleanField,
  hipaa_compliant: booleanField,
  ferpa_compliant: booleanField,
  faith_based_organization: booleanField,
  serves_rural_area: booleanField,
  liability_insurance: booleanField,
  liability_coverage_limit: z.string().optional().or(z.literal("")),
  directors_officers_insurance: booleanField,
  workers_comp_insurance: booleanField,
  professional_liability_insurance: booleanField,
  business_501c3_certified: booleanField,
  business_501c4_certified: booleanField,
  minority_owned_certification: booleanField,
  women_owned_certification: booleanField,
  veteran_owned_business: booleanField,
  promise_zone_designation: booleanField,
  opportunity_zone_designation: booleanField,
  business_affected_covid: booleanField,
  mission: z.string().optional().or(z.literal("")),

  // Backwards-compatible aliases used elsewhere in the app
  organization_type: z.string().optional().or(z.literal("")),
  ein: z.string().optional().or(z.literal("")),
  uei: z.string().optional().or(z.literal("")),
  cage_code: z.string().optional().or(z.literal("")),
})

const toBoolean = (value) => {
  if (value === undefined || value === null || value === '') return false
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  const normalized = String(value).toLowerCase().trim()
  return ['true', 'yes', 'y', '1'].includes(normalized)
}

const booleanField = z
  .union([z.boolean(), z.string(), z.number()])
  .optional()
  .transform((value) => toBoolean(value))

const financialInformationSchema = z.object({
  household_income: numberOrEmptyString,
  household_size: numberOrEmptyString,
  financial_need_level: z.string().optional().or(z.literal("")),
  low_income: booleanField,
  unemployed: booleanField,
  displaced_worker: booleanField,
  notes: z.string().optional().or(z.literal("")),
})

const assistanceSchema = z.object({
  medicaid_enrolled: booleanField,
  medicaid_waiver_program: z.string().optional().or(z.literal("")),
  medicare_recipient: booleanField,
  ssi_recipient: booleanField,
  ssdi_recipient: booleanField,
  snap_recipient: booleanField,
  tanf_recipient: booleanField,
  section8_housing: booleanField,
  tenncare_id: z.string().optional().or(z.literal("")),
  other_programs: z.string().optional().or(z.literal("")),
})

const healthSchema = z.object({
  cancer_survivor: booleanField,
  cancer_type: z.string().optional().or(z.literal("")),
  cancer_diagnosis_year: numberOrEmptyString,
  chronic_illness: booleanField,
  chronic_illness_type: z.string().optional().or(z.literal("")),
  disability_type: z
    .union([z.array(z.string()), z.string()])
    .optional()
    .transform((value) => {
      return splitList(value)
    }),
  support_needs_level: z.string().optional().or(z.literal("")),
  dialysis_patient: booleanField,
  organ_transplant: booleanField,
  hiv_aids: booleanField,
  tbi_survivor: booleanField,
  amputee: booleanField,
  neurodivergent: booleanField,
  visual_impairment: booleanField,
  hearing_impairment: booleanField,
  wheelchair_user: booleanField,
  substance_recovery: booleanField,
  mental_health_condition: booleanField,
  notes: z.string().optional().or(z.literal("")),
})

const demographicsSchema = z.object({
  immigration_status: z.string().optional().or(z.literal("")),
  permanent_resident: booleanField,
  refugee: booleanField,
  new_immigrant: booleanField,
  african_american: booleanField,
  hispanic_latino: booleanField,
  asian_american: booleanField,
  native_american: booleanField,
  tribal_affiliation: z.string().optional().or(z.literal("")),
  lgbtq: booleanField,
  // Backwards-compatible alias (some older datasets used immigrant_status)
  immigrant_status: z.string().optional().or(z.literal("")),
  notes: z.string().optional().or(z.literal("")),
})

const familyLifeSchema = z.object({
  single_parent: booleanField,
  foster_youth: booleanField,
  orphan: booleanField,
  adopted: booleanField,
  foster_parent: booleanField,
  caregiver: booleanField,
  widow_widower: booleanField,
  grandparent_raising_grandchildren: booleanField,
  first_time_parent: booleanField,
  homeless: booleanField,
  domestic_violence_survivor: booleanField,
  trafficking_survivor: booleanField,
  disaster_survivor: booleanField,
  formerly_incarcerated: booleanField,
  notes: z.string().optional().or(z.literal("")),
})

const militarySchema = z.object({
  veteran: booleanField,
  active_duty_military: booleanField,
  national_guard: booleanField,
  disabled_veteran: booleanField,
  military_spouse: booleanField,
  military_dependent: booleanField,
  gold_star_family: booleanField,
  notes: z.string().optional().or(z.literal("")),
})

const occupationSchema = z.object({
  healthcare_worker: booleanField,
  healthcare_worker_type: z.string().optional().or(z.literal("")),
  ems_worker: booleanField,
  educator: booleanField,
  firefighter: booleanField,
  law_enforcement: booleanField,
  public_servant: booleanField,
  clergy: booleanField,
  missionary: booleanField,
  nonprofit_employee: booleanField,
  small_business_owner: booleanField,
  is_minority_owned_business_owner: booleanField,
  is_women_owned_business_owner: booleanField,
  minority_owned_business: booleanField,
  women_owned_business: booleanField,
  union_member: booleanField,
  farmer: booleanField,
  truck_driver: booleanField,
  notes: z.string().optional().or(z.literal("")),
})

const locationSchema = z.object({
  rural_resident: booleanField,
  appalachian_region: booleanField,
  urban_underserved: booleanField,
  geographic_focus: z.string().optional().or(z.literal("")),
  notes: z.string().optional().or(z.literal("")),
})

const narrativeSchema = z.object({
  mission: z.string().optional().or(z.literal("")),
  primary_goal: z.string().optional().or(z.literal("")),
  target_population: z.string().optional().or(z.literal("")),
  geographic_focus: z.string().optional().or(z.literal("")),
  funding_amount_needed: z.string().optional().or(z.literal("")),
  timeline: z.string().optional().or(z.literal("")),
  past_experience: z.string().optional().or(z.literal("")),
  unique_qualities: z.string().optional().or(z.literal("")),
  collaboration_partners: z.string().optional().or(z.literal("")),
  sustainability_plan: z.string().optional().or(z.literal("")),
  barriers_faced: z.string().optional().or(z.literal("")),
  special_circumstances: z.string().optional().or(z.literal("")),
  keywords: z
    .union([z.array(z.string()), z.string()])
    .optional()
    .transform((value) => splitList(value)),
  focus_areas: z
    .union([z.array(z.string()), z.string()])
    .optional()
    .transform((value) => splitList(value)),
})

const studentSchema = z.object({
  student_grade_levels: z
    .union([z.array(z.string()), z.string()])
    .optional()
    .transform((value) => splitList(value)),
  current_college: z.string().optional().or(z.literal("")),
  target_colleges: z
    .union([z.array(z.string()), z.string()])
    .optional()
    .transform((value) => splitList(value)),
  gpa: numberOrEmptyString,
  act_score: numberOrEmptyString,
  sat_score: numberOrEmptyString,
  intended_major: z.string().optional().or(z.literal("")),
  first_generation: booleanField,
  stem_student: booleanField,
  extracurricular_activities: z
    .union([z.array(z.string()), z.string()])
    .optional()
    .transform((value) => splitList(value)),
  achievements: z
    .union([z.array(z.string()), z.string()])
    .optional()
    .transform((value) => splitList(value)),
  community_service_hours: numberOrEmptyString,
  ged_graduate: booleanField,
  returning_adult_student: booleanField,
  recent_graduate: booleanField,
  job_retraining: booleanField,
  minor_child: booleanField,
  young_adult: booleanField,
})

const firearmsSchema = z.object({
  second_amendment_supporter: booleanField,
  gun_owner: booleanField,
  concealed_carry_permit: booleanField,
  nra_member: booleanField,
  firearm_instructor: booleanField,
  competitive_shooter: booleanField,
  hunting_license: booleanField,
})

const politicalCivicSchema = z.object({
  registered_voter: booleanField,
  political_party: z.string().optional().or(z.literal("")),
  politically_active: booleanField,
  community_organizer: booleanField,
  advocacy_work: booleanField,
  civic_volunteer: booleanField,
  election_worker: booleanField,
})

export const SECTION_CONFIG = {
  basic_information: {
    key: "basic_information",
    title: "Basic Information",
    description:
      "Primary contact details for this profile. This maps to Section 2 of the comprehensive application.",
    schema: basicInfoSchema,
    defaults: {
      name: "",
      date_of_birth: "",
      age: "",
      email: [],
      phone: [],
      website: "",
      address: "",
      city: "",
      state: "",
      zip: "",
      full_name: "",
      notes: "",
    },
    fields: [
      {
        name: "name",
        label: "Full name / organization name",
        component: Input,
        description: "This is the primary applicant name used across applications and matching.",
      },
      {
        name: "date_of_birth",
        label: "Date of birth",
        component: Input,
        props: { type: "date" },
        description: "Used for age-based eligibility rules. Leave blank if not applicable.",
      },
      {
        name: "age",
        label: "Age",
        component: Input,
        props: { type: "number", min: 0 },
        description: "Optional alternate to date of birth. If both are present, DOB is preferred.",
      },
      {
        name: "email",
        label: "Email address(es)",
        component: Textarea,
        props: { rows: 2, placeholder: "one@example.com, two@example.com" },
        description: "Comma or newline separated. Multiple emails improve contact matching.",
      },
      {
        name: "phone",
        label: "Phone number(s)",
        component: Textarea,
        props: { rows: 2, placeholder: "(555) 123-4567\n(555) 222-3333" },
        description: "Comma or newline separated.",
      },
      { name: "website", label: "Website", component: Input },
      { name: "address", label: "Street address", component: Textarea, props: { rows: 2 } },
      { name: "city", label: "City", component: Input },
      { name: "state", label: "State (2-letter)", component: Input, props: { maxLength: 2 } },
      { name: "zip", label: "ZIP code", component: Input, props: { maxLength: 10 } },
      { name: "notes", label: "Notes", component: Textarea, props: { rows: 3 } },
    ],
  },
  organization_details: {
    key: "organization_details",
    title: "Organization Details",
    description:
      "Entity registration, capacity indicators, and mission summary for Section 4 of the comprehensive application.",
    schema: organizationDetailsSchema,
    defaults: {
      applicant_type: "",
      nonprofit_type: "",
      organization_ein: "",
      organization_uei: "",
      organization_cage_code: "",
      annual_budget: "",
      staff_count: "",
      ntee_code: "",
      evidence_based_program: "",
      sam_gov_registered: false,
      grants_gov_active: false,
      hipaa_compliant: false,
      ferpa_compliant: false,
      faith_based_organization: false,
      serves_rural_area: false,
      liability_insurance: false,
      liability_coverage_limit: "",
      directors_officers_insurance: false,
      workers_comp_insurance: false,
      professional_liability_insurance: false,
      business_501c3_certified: false,
      business_501c4_certified: false,
      minority_owned_certification: false,
      women_owned_certification: false,
      veteran_owned_business: false,
      promise_zone_designation: false,
      opportunity_zone_designation: false,
      business_affected_covid: false,
      mission: "",

      // legacy aliases
      organization_type: "",
      ein: "",
      uei: "",
      cage_code: "",
    },
    fields: [
      {
        name: "applicant_type",
        label: "Applicant type",
        component: Input,
        description:
          "Matches the comprehensive application’s profile type (organization, student, individual, etc.).",
      },
      { name: "nonprofit_type", label: "Nonprofit type", component: Input, description: "Optional classification." },
      { name: "organization_ein", label: "EIN (Tax ID)", component: Input },
      { name: "organization_uei", label: "UEI", component: Input },
      { name: "organization_cage_code", label: "CAGE Code", component: Input },
      { name: "annual_budget", label: "Annual budget", component: Input, props: { type: "number", min: 0 } },
      { name: "staff_count", label: "Staff count", component: Input, props: { type: "number", min: 0 } },
      { name: "ntee_code", label: "NTEE code", component: Input },
      {
        name: "evidence_based_program",
        label: "Evidence-based program model",
        component: Input,
        description: "Used to match opportunities requiring evidence-based implementation.",
      },
      { name: "sam_gov_registered", label: "SAM.gov registered", type: "boolean" },
      { name: "grants_gov_active", label: "Grants.gov account active", type: "boolean" },
      { name: "hipaa_compliant", label: "HIPAA compliant", type: "boolean" },
      { name: "ferpa_compliant", label: "FERPA compliant", type: "boolean" },
      { name: "faith_based_organization", label: "Faith-based organization", type: "boolean" },
      { name: "serves_rural_area", label: "Serves rural area", type: "boolean" },
      { name: "liability_insurance", label: "General liability insurance", type: "boolean" },
      { name: "liability_coverage_limit", label: "Liability coverage limit", component: Input },
      { name: "directors_officers_insurance", label: "Directors & officers insurance", type: "boolean" },
      { name: "workers_comp_insurance", label: "Workers comp insurance", type: "boolean" },
      { name: "professional_liability_insurance", label: "Professional liability insurance", type: "boolean" },
      { name: "business_501c3_certified", label: "501(c)(3) certified", type: "boolean" },
      { name: "business_501c4_certified", label: "501(c)(4) certified", type: "boolean" },
      { name: "minority_owned_certification", label: "Minority-owned certification", type: "boolean" },
      { name: "women_owned_certification", label: "Women-owned certification", type: "boolean" },
      { name: "veteran_owned_business", label: "Veteran-owned business", type: "boolean" },
      { name: "promise_zone_designation", label: "Promise zone designation", type: "boolean" },
      { name: "opportunity_zone_designation", label: "Opportunity zone designation", type: "boolean" },
      { name: "business_affected_covid", label: "Business affected by COVID", type: "boolean" },
      { name: "mission", label: "Mission", component: Textarea, props: { rows: 4 } },
    ],
  },
  financial_information: {
    key: "financial_information",
    title: "Financial Situation",
    description:
      "Document income, household size, and employment status to support need-based matching.",
    schema: financialInformationSchema,
    defaults: {
      household_income: "",
      household_size: "",
      financial_need_level: "",
      low_income: false,
      unemployed: false,
      displaced_worker: false,
      notes: "",
    },
    fields: [
      { name: "household_income", label: "Household income (USD)", component: Input, props: { type: "number", min: 0 } },
      { name: "household_size", label: "Household size", component: Input, props: { type: "number", min: 1 } },
      { name: "financial_need_level", label: "Financial need level", component: Input, props: { placeholder: "e.g. high, moderate" } },
      { name: "low_income", label: "Low income household", type: "boolean" },
      { name: "unemployed", label: "Currently unemployed", type: "boolean" },
      { name: "displaced_worker", label: "Displaced worker", type: "boolean" },
      { name: "notes", label: "Notes", component: Textarea, props: { rows: 3, placeholder: "Context for financial need" } },
    ],
  },
  government_assistance: {
    key: "government_assistance",
    title: "Government Assistance",
    description:
      "Track public benefits to strengthen eligibility profiling for specific funds.",
    schema: assistanceSchema,
    defaults: {
      medicaid_enrolled: false,
      medicaid_waiver_program: "",
      medicare_recipient: false,
      ssi_recipient: false,
      ssdi_recipient: false,
      snap_recipient: false,
      tanf_recipient: false,
      section8_housing: false,
      tenncare_id: "",
      other_programs: "",
    },
    fields: [
      { name: "medicaid_enrolled", label: "Medicaid enrolled", type: "boolean" },
      {
        name: "medicaid_waiver_program",
        label: "Medicaid waiver program",
        component: Input,
        description: "e.g. Katie Beckett, ECF CHOICES, etc.",
      },
      { name: "medicare_recipient", label: "Medicare recipient", type: "boolean" },
      { name: "ssi_recipient", label: "SSI recipient", type: "boolean" },
      { name: "ssdi_recipient", label: "SSDI recipient", type: "boolean" },
      { name: "snap_recipient", label: "SNAP recipient", type: "boolean" },
      { name: "tanf_recipient", label: "TANF recipient", type: "boolean" },
      { name: "section8_housing", label: "Section 8 housing", type: "boolean" },
      { name: "tenncare_id", label: "TennCare ID", component: Input },
      { name: "other_programs", label: "Other programs", component: Textarea, props: { rows: 3, placeholder: "List additional programs, if any" } },
    ],
  },
  health_medical: {
    key: "health_medical",
    title: "Health & Medical",
    description:
      "Capture relevant health information to highlight eligibility for medical and disability-focused opportunities.",
    schema: healthSchema,
    defaults: {
      cancer_survivor: false,
      cancer_type: "",
      cancer_diagnosis_year: "",
      chronic_illness: false,
      chronic_illness_type: "",
      disability_type: [],
      support_needs_level: "",
      dialysis_patient: false,
      organ_transplant: false,
      hiv_aids: false,
      tbi_survivor: false,
      amputee: false,
      neurodivergent: false,
      visual_impairment: false,
      hearing_impairment: false,
      wheelchair_user: false,
      substance_recovery: false,
      mental_health_condition: false,
      notes: "",
    },
    fields: [
      { name: "cancer_survivor", label: "Cancer survivor", type: "boolean" },
      { name: "cancer_type", label: "Cancer type", component: Input },
      { name: "cancer_diagnosis_year", label: "Cancer diagnosis year", component: Input, props: { type: "number", min: 1900, max: 2100 } },
      { name: "chronic_illness", label: "Chronic illness", type: "boolean" },
      { name: "chronic_illness_type", label: "Illness type", component: Input, description: "Provide diagnosis or condition if known." },
      { name: "disability_type", label: "Disability types", component: Textarea, props: { rows: 3, placeholder: "Separate multiple entries with commas" } },
      { name: "support_needs_level", label: "Support needs level", component: Input, props: { placeholder: "e.g. high, moderate, low, unknown" } },
      { name: "dialysis_patient", label: "Dialysis patient", type: "boolean" },
      { name: "organ_transplant", label: "Organ transplant recipient", type: "boolean" },
      { name: "hiv_aids", label: "Living with HIV/AIDS", type: "boolean" },
      { name: "tbi_survivor", label: "Traumatic brain injury survivor", type: "boolean" },
      { name: "amputee", label: "Amputee", type: "boolean" },
      { name: "neurodivergent", label: "Neurodivergent", type: "boolean" },
      { name: "visual_impairment", label: "Visual impairment", type: "boolean" },
      { name: "hearing_impairment", label: "Hearing impairment", type: "boolean" },
      { name: "wheelchair_user", label: "Wheelchair user", type: "boolean" },
      { name: "substance_recovery", label: "In substance recovery", type: "boolean" },
      { name: "mental_health_condition", label: "Mental health condition", type: "boolean" },
      { name: "notes", label: "Medical notes", component: Textarea, props: { rows: 4, placeholder: "Additional context about health needs" } },
    ],
  },
  demographics: {
    key: "demographics",
    title: "Demographics",
    description:
      "Document demographic information that influences funding eligibility and reporting requirements.",
    schema: demographicsSchema,
    defaults: {
      immigration_status: "",
      permanent_resident: false,
      refugee: false,
      new_immigrant: false,
      african_american: false,
      hispanic_latino: false,
      asian_american: false,
      native_american: false,
      tribal_affiliation: "",
      lgbtq: false,
      immigrant_status: "",
      notes: "",
    },
    fields: [
      {
        name: "immigration_status",
        label: "Immigration / citizenship status",
        component: Input,
        description: "e.g. us_citizen, permanent_resident, refugee, asylee, daca, visa_holder",
      },
      { name: "permanent_resident", label: "Permanent resident (green card)", type: "boolean" },
      { name: "refugee", label: "Refugee", type: "boolean" },
      { name: "new_immigrant", label: "New immigrant", type: "boolean" },
      { name: "african_american", label: "African American / Black", type: "boolean" },
      { name: "hispanic_latino", label: "Hispanic / Latino", type: "boolean" },
      { name: "asian_american", label: "Asian American / Pacific Islander", type: "boolean" },
      { name: "native_american", label: "Native American / Alaska Native", type: "boolean" },
      { name: "tribal_affiliation", label: "Tribal affiliation", component: Input, description: "Specify tribe if applicable." },
      { name: "lgbtq", label: "Identifies as LGBTQ+", type: "boolean" },
      { name: "immigrant_status", label: "Immigration status (legacy)", component: Input },
      { name: "notes", label: "Demographic notes", component: Textarea, props: { rows: 3, placeholder: "Additional context or identities" } },
    ],
  },
  family_life: {
    key: "family_life",
    title: "Family & Life Situation",
    description:
      "Capture household and life events that may trigger eligibility for supportive programs.",
    schema: familyLifeSchema,
    defaults: {
      single_parent: false,
      foster_youth: false,
      orphan: false,
      adopted: false,
      foster_parent: false,
      caregiver: false,
      widow_widower: false,
      grandparent_raising_grandchildren: false,
      first_time_parent: false,
      homeless: false,
      domestic_violence_survivor: false,
      trafficking_survivor: false,
      disaster_survivor: false,
      formerly_incarcerated: false,
      notes: "",
    },
    fields: [
      { name: "single_parent", label: "Single parent household", type: "boolean" },
      { name: "foster_youth", label: "Current/former foster youth", type: "boolean" },
      { name: "orphan", label: "Orphan", type: "boolean" },
      { name: "adopted", label: "Adopted", type: "boolean" },
      { name: "foster_parent", label: "Foster parent", type: "boolean" },
      { name: "caregiver", label: "Primary caregiver (non-parent)", type: "boolean" },
      { name: "widow_widower", label: "Widow / widower", type: "boolean" },
      { name: "grandparent_raising_grandchildren", label: "Grandparent raising grandchildren", type: "boolean" },
      { name: "first_time_parent", label: "First-time parent", type: "boolean" },
      { name: "homeless", label: "Experiencing homelessness", type: "boolean" },
      { name: "domestic_violence_survivor", label: "Domestic violence survivor", type: "boolean" },
      { name: "trafficking_survivor", label: "Human trafficking survivor", type: "boolean" },
      { name: "disaster_survivor", label: "Disaster survivor", type: "boolean" },
      { name: "formerly_incarcerated", label: "Formerly incarcerated / returning citizen", type: "boolean" },
      { name: "notes", label: "Life circumstances notes", component: Textarea, props: { rows: 4, placeholder: "Additional details (confidential)" } },
    ],
  },
  military_service: {
    key: "military_service",
    title: "Military Status",
    description:
      "Record any military service or affiliation to unlock veteran-focused resources.",
    schema: militarySchema,
    defaults: {
      veteran: false,
      active_duty_military: false,
      national_guard: false,
      disabled_veteran: false,
      military_spouse: false,
      military_dependent: false,
      gold_star_family: false,
      notes: "",
    },
    fields: [
      { name: "veteran", label: "Veteran", type: "boolean" },
      { name: "active_duty_military", label: "Active duty military", type: "boolean" },
      { name: "national_guard", label: "National Guard / Reserve", type: "boolean" },
      { name: "disabled_veteran", label: "Disabled veteran", type: "boolean" },
      { name: "military_spouse", label: "Military spouse", type: "boolean" },
      { name: "military_dependent", label: "Military dependent", type: "boolean" },
      { name: "gold_star_family", label: "Gold Star family", type: "boolean" },
      { name: "notes", label: "Service details", component: Textarea, props: { rows: 3, placeholder: "Branch, service years, disability rating, etc." } },
    ],
  },
  occupation: {
    key: "occupation",
    title: "Occupation",
    description:
      "Track professional roles and designations relevant to workforce or training programs.",
    schema: occupationSchema,
    defaults: {
      healthcare_worker: false,
      healthcare_worker_type: "",
      ems_worker: false,
      educator: false,
      firefighter: false,
      law_enforcement: false,
      public_servant: false,
      clergy: false,
      missionary: false,
      nonprofit_employee: false,
      small_business_owner: false,
      is_minority_owned_business_owner: false,
      is_women_owned_business_owner: false,
      minority_owned_business: false,
      women_owned_business: false,
      union_member: false,
      farmer: false,
      truck_driver: false,
      notes: "",
    },
    fields: [
      { name: "healthcare_worker", label: "Healthcare worker", type: "boolean" },
      { name: "healthcare_worker_type", label: "Healthcare role", component: Input, props: { placeholder: "RN, CNA, EMT, etc." } },
      { name: "ems_worker", label: "EMS/First responder", type: "boolean" },
      { name: "educator", label: "Educator / teacher", type: "boolean" },
      { name: "firefighter", label: "Firefighter", type: "boolean" },
      { name: "law_enforcement", label: "Law enforcement / corrections", type: "boolean" },
      { name: "public_servant", label: "Public servant / government employee", type: "boolean" },
      { name: "clergy", label: "Clergy / religious worker", type: "boolean" },
      { name: "missionary", label: "Missionary / evangelist", type: "boolean" },
      { name: "nonprofit_employee", label: "Nonprofit employee", type: "boolean" },
      { name: "small_business_owner", label: "Small business owner", type: "boolean" },
      { name: "is_minority_owned_business_owner", label: "Minority-owned business owner", type: "boolean" },
      { name: "is_women_owned_business_owner", label: "Women-owned business owner", type: "boolean" },
      { name: "minority_owned_business", label: "Minority-owned business", type: "boolean" },
      { name: "women_owned_business", label: "Women-owned business", type: "boolean" },
      { name: "union_member", label: "Union member", type: "boolean" },
      { name: "farmer", label: "Agricultural worker / farmer", type: "boolean" },
      { name: "truck_driver", label: "Truck driver / transportation worker", type: "boolean" },
      { name: "notes", label: "Occupational notes", component: Textarea, props: { rows: 3, placeholder: "Additional occupations, certifications, or union local" } },
    ],
  },
  location_focus: {
    key: "location_focus",
    title: "Location Focus",
    description:
      "Define where the applicant lives or delivers services to align with geographic funding criteria.",
    schema: locationSchema,
    defaults: {
      rural_resident: false,
      appalachian_region: false,
      urban_underserved: false,
      geographic_focus: "",
      notes: "",
    },
    fields: [
      { name: "rural_resident", label: "Rural resident", type: "boolean" },
      { name: "appalachian_region", label: "Located in Appalachian region", type: "boolean" },
      { name: "urban_underserved", label: "Urban underserved community", type: "boolean" },
      { name: "geographic_focus", label: "Geographic focus", component: Input, props: { placeholder: "Primary service area, city, or county" } },
      { name: "notes", label: "Location notes", component: Textarea, props: { rows: 3, placeholder: "Census tract, region, or other details" } },
    ],
  },
  narrative: {
    key: "narrative",
    title: "Story & Goals",
    description:
      "Summarise the applicant's mission, goals, and unique narrative to feed proposals and AI tooling.",
    schema: narrativeSchema,
    defaults: {
      mission: "",
      primary_goal: "",
      target_population: "",
      geographic_focus: "",
      funding_amount_needed: "",
      timeline: "",
      past_experience: "",
      unique_qualities: "",
      collaboration_partners: "",
      sustainability_plan: "",
      barriers_faced: "",
      special_circumstances: "",
      keywords: [],
      focus_areas: [],
    },
    fields: [
      { name: "mission", label: "Mission", component: Textarea, props: { rows: 3 } },
      { name: "primary_goal", label: "Primary goal", component: Textarea, props: { rows: 3 } },
      { name: "target_population", label: "Target population", component: Textarea, props: { rows: 3 } },
      { name: "geographic_focus", label: "Geographic focus", component: Input, description: "Where you live or who you serve." },
      { name: "funding_amount_needed", label: "Funding amount needed", component: Input, props: { placeholder: "e.g. $50,000 or description" } },
      { name: "timeline", label: "Timeline", component: Textarea, props: { rows: 2 } },
      { name: "past_experience", label: "Past experience", component: Textarea, props: { rows: 3 } },
      { name: "unique_qualities", label: "Unique qualities", component: Textarea, props: { rows: 3 } },
      { name: "collaboration_partners", label: "Collaboration partners", component: Textarea, props: { rows: 3 } },
      { name: "sustainability_plan", label: "Sustainability plan", component: Textarea, props: { rows: 3 } },
      { name: "barriers_faced", label: "Barriers faced", component: Textarea, props: { rows: 3 } },
      { name: "special_circumstances", label: "Special circumstances", component: Textarea, props: { rows: 3 } },
      {
        name: "keywords",
        label: "Keywords",
        component: Textarea,
        props: { rows: 2, placeholder: "education, workforce, healthcare" },
        description: "Comma/newline separated. These directly drive crawler queries and matching.",
      },
      {
        name: "focus_areas",
        label: "Focus areas",
        component: Textarea,
        props: { rows: 2, placeholder: "youth development, rural health" },
        description: "Comma/newline separated.",
      },
    ],
  },

  student_details: {
    key: "student_details",
    title: "Student & Education Details",
    description:
      "Academic background and student qualifiers used for scholarship matching (comprehensive application Education section).",
    schema: studentSchema,
    defaults: {
      student_grade_levels: [],
      current_college: "",
      target_colleges: [],
      gpa: "",
      act_score: "",
      sat_score: "",
      intended_major: "",
      first_generation: false,
      stem_student: false,
      extracurricular_activities: [],
      achievements: [],
      community_service_hours: "",
      ged_graduate: false,
      returning_adult_student: false,
      recent_graduate: false,
      job_retraining: false,
      minor_child: false,
      young_adult: false,
    },
    fields: [
      { name: "student_grade_levels", label: "Grade level(s)", component: Textarea, props: { rows: 2 } },
      { name: "current_college", label: "Current college/university", component: Input },
      { name: "target_colleges", label: "Target colleges", component: Textarea, props: { rows: 2 } },
      { name: "intended_major", label: "Intended major", component: Input },
      { name: "gpa", label: "GPA", component: Input, props: { type: "number", step: "0.01", min: 0, max: 5 } },
      { name: "act_score", label: "ACT score", component: Input, props: { type: "number", min: 0, max: 36 } },
      { name: "sat_score", label: "SAT score", component: Input, props: { type: "number", min: 0, max: 1600 } },
      { name: "community_service_hours", label: "Community service hours", component: Input, props: { type: "number", min: 0 } },
      { name: "extracurricular_activities", label: "Extracurricular activities", component: Textarea, props: { rows: 3 } },
      { name: "achievements", label: "Awards & achievements", component: Textarea, props: { rows: 3 } },
      { name: "first_generation", label: "First-generation student", type: "boolean" },
      { name: "stem_student", label: "STEM student", type: "boolean" },
      { name: "ged_graduate", label: "GED graduate", type: "boolean" },
      { name: "returning_adult_student", label: "Returning adult student", type: "boolean" },
      { name: "recent_graduate", label: "Recent graduate", type: "boolean" },
      { name: "job_retraining", label: "Job retraining", type: "boolean" },
      { name: "minor_child", label: "Minor child", type: "boolean" },
      { name: "young_adult", label: "Young adult", type: "boolean" },
    ],
  },

  firearms: {
    key: "firearms",
    title: "Firearms / Second Amendment",
    description:
      "Optional qualifiers captured in the comprehensive application that may be relevant for niche opportunities.",
    schema: firearmsSchema,
    defaults: {
      second_amendment_supporter: false,
      gun_owner: false,
      concealed_carry_permit: false,
      nra_member: false,
      firearm_instructor: false,
      competitive_shooter: false,
      hunting_license: false,
    },
    fields: [
      { name: "second_amendment_supporter", label: "Second Amendment supporter", type: "boolean" },
      { name: "gun_owner", label: "Gun owner", type: "boolean" },
      { name: "concealed_carry_permit", label: "Concealed carry permit holder", type: "boolean" },
      { name: "nra_member", label: "NRA member", type: "boolean" },
      { name: "firearm_instructor", label: "Firearm instructor", type: "boolean" },
      { name: "competitive_shooter", label: "Competitive shooter", type: "boolean" },
      { name: "hunting_license", label: "Hunting license holder", type: "boolean" },
    ],
  },

  political_civic: {
    key: "political_civic",
    title: "Political / Civic Engagement",
    description:
      "Optional civic engagement indicators captured in the comprehensive application for targeted matching.",
    schema: politicalCivicSchema,
    defaults: {
      registered_voter: false,
      political_party: "",
      politically_active: false,
      community_organizer: false,
      advocacy_work: false,
      civic_volunteer: false,
      election_worker: false,
    },
    fields: [
      { name: "registered_voter", label: "Registered voter", type: "boolean" },
      { name: "political_party", label: "Political party", component: Input },
      { name: "politically_active", label: "Politically active", type: "boolean" },
      { name: "community_organizer", label: "Community organizer", type: "boolean" },
      { name: "advocacy_work", label: "Advocacy work", type: "boolean" },
      { name: "civic_volunteer", label: "Civic volunteer", type: "boolean" },
      { name: "election_worker", label: "Election / poll worker", type: "boolean" },
    ],
  },
}

export default function ProfileSectionEditor({
  open,
  sectionKey,
  initialData,
  profileId,
  onClose,
  onSave,
  isSaving,
  onAskAI,
}) {
  const config = SECTION_CONFIG[sectionKey]
  const defaults = config?.defaults ?? {}
  const normalizedData = config ? normalizeInitialData(config, initialData) : {}
  const initialValues = config ? { ...defaults, ...(normalizedData ?? {}) } : {}
  const [aiStatus, setAiStatus] = useState('idle')
  const [aiError, setAiError] = useState(null)

  const form = useForm({
    resolver: config ? zodResolver(config.schema) : undefined,
    defaultValues: initialValues,
  })

  useEffect(() => {
    if (config) {
      form.reset({ ...defaults, ...(normalizeInitialData(config, initialData) ?? {}) })
      setAiStatus('idle')
      setAiError(null)
    }
  }, [config, defaults, initialData, form])

  const handleSubmit = form.handleSubmit((values) => {
    onSave(values)
  })

  const handleAskAI = async () => {
    if (!config || !onAskAI) return
    setAiStatus('loading')
    setAiError(null)
    try {
      const suggestion = await onAskAI(form.getValues())
      if (suggestion && typeof suggestion === 'object') {
        form.reset({ ...defaults, ...suggestion })
        setAiStatus('succeeded')
      } else {
        setAiStatus('idle')
      }
    } catch (error) {
      console.error(error)
      setAiStatus('failed')
      setAiError(error instanceof Error ? error.message : 'AI suggestion unavailable. Try again later.')
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !isSaving && !next && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <div className="flex-1">
              <DialogTitle>
                {config ? config.title : `Editing ${sectionKey}`}
              </DialogTitle>
              <DialogDescription className="mt-1">
                {config ? config.description : "We have not yet mapped this section. You can still edit the raw JSON from the overview until a dedicated form is available."}
              </DialogDescription>
            </div>
            {config && onAskAI && (
              <Button
                type="button"
                variant="default"
                size="sm"
                onClick={handleAskAI}
                disabled={aiStatus === 'loading' || isSaving}
                className="ml-4 shrink-0 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700"
              >
                <svg 
                  className="w-4 h-4 mr-2" 
                  fill="none" 
                  stroke="currentColor" 
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                {aiStatus === 'loading' ? 'Generating...' : 'Assist with AI'}
              </Button>
            )}
          </div>
        </DialogHeader>

        {!config ? (
          <Alert variant="default">
            <Info className="w-4 h-4" />
            <AlertDescription className="text-sm text-slate-600">
              This section isn’t wired to a form yet. Close this dialog and use the “Edit section” button to update the JSON directly.
            </AlertDescription>
          </Alert>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {config.fields.map((field) => {
              if (field.type === 'boolean') {
                const description =
                  field.description ??
                  "Eligibility qualifier from the comprehensive application. Turn on only when it applies to this profile."
                return (
                  <div className="flex items-center justify-between rounded-lg border border-slate-200 p-3" key={field.name}>
                    <div className="space-y-1">
                      <Label htmlFor={field.name}>{field.label}</Label>
                      <p className="text-xs text-slate-500">{description}</p>
                    </div>
                    <Controller
                      control={form.control}
                      name={field.name}
                      render={({ field: controllerField }) => (
                        <Switch
                          id={field.name}
                          checked={Boolean(controllerField.value)}
                          onCheckedChange={(checked) => controllerField.onChange(checked)}
                          disabled={isSaving || aiStatus === 'loading'}
                        />
                      )}
                    />
                  </div>
                )
              }

              // Use ProfileFieldWithAI for text fields to provide individual AI assistance
              return (
                <div key={field.name}>
                  <ProfileFieldWithAI
                    field={field}
                    value={form.watch(field.name)}
                    onChange={(newValue) => form.setValue(field.name, newValue)}
                    disabled={isSaving || aiStatus === 'loading'}
                    profileId={profileId}
                    sectionKey={sectionKey}
                    formContext={form.getValues()}
                    {...form.register(field.name)}
                  />
                  {form.formState.errors?.[field.name] && (
                    <p className="text-xs text-red-600 mt-1">
                      {form.formState.errors[field.name]?.message}
                    </p>
                  )}
                </div>
              )
            })}
          </form>
        )}

        {aiError && (
          <Alert variant="destructive" className="mt-4">
            <AlertDescription className="text-sm">
              {aiError}
            </AlertDescription>
          </Alert>
        )}

        {aiStatus === 'succeeded' && (
          <Alert variant="default" className="mt-4">
            <AlertDescription className="text-sm text-blue-700">
              AI suggestion applied. Review and adjust before saving.
            </AlertDescription>
          </Alert>
        )}

        <DialogFooter className="flex items-center justify-between">
          <Button variant="ghost" onClick={onClose} disabled={isSaving}>
            Cancel
          </Button>
          {config && (
            <Button onClick={handleSubmit} disabled={isSaving}>
              {isSaving ? "Saving..." : "Save changes"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
