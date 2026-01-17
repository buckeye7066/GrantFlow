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

  if (Array.isArray(value)) {
    return value.map((entry) => (entry === null || entry === undefined ? '' : String(entry))).filter(Boolean).join(', ')
  }

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

const basicInfoSchema = z.object({
  full_name: z.string().min(1, "Name is required"),
  email: z.string().email("Enter a valid email address").optional().or(z.literal("")),
  phone: z.string().optional().or(z.literal("")),
  website: z.string().url("Enter a valid URL").optional().or(z.literal("")),
  address: z.string().optional().or(z.literal("")),
  city: z.string().optional().or(z.literal("")),
  state: z.string().optional().or(z.literal("")),
  zip_code: z.string().optional().or(z.literal("")),
  county: z.string().optional().or(z.literal("")),
  date_of_birth: z.string().optional().or(z.literal("")),
  gender: z.string().optional().or(z.literal("")),
  nationality: z.string().optional().or(z.literal("")),
  notes: z.string().optional().or(z.literal("")),
})

const organizationDetailsSchema = z.object({
  organization_type: z.string().optional().or(z.literal("")),
  ein: z.string().optional().or(z.literal("")),
  uei: z.string().optional().or(z.literal("")),
  cage_code: z.string().optional().or(z.literal("")),
  annual_budget: z
    .union([z.number(), z.string()])
    .optional()
    .transform((value) => {
      if (value === "" || value === undefined || value === null) return ""
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : ""
    }),
  staff_count: z
    .union([z.number(), z.string()])
    .optional()
    .transform((value) => {
      if (value === "" || value === undefined || value === null) return ""
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : ""
    }),
  mission: z.string().optional().or(z.literal("")),
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

const toStringList = (value) => {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
  if (typeof value === 'string') {
    const raw = value.trim()
    if (!raw) return []
    // Allow JSON array input
    if (raw.startsWith('[')) {
      try {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) return parsed.map((v) => String(v).trim()).filter(Boolean)
      } catch {
        // Ignore invalid JSON input; fall back to comma-separated parsing.
      }
    }
    return raw.split(',').map((entry) => entry.trim()).filter(Boolean)
  }
  return []
}

const stringListField = z
  .union([z.array(z.string()), z.string()])
  .optional()
  .transform((value) => toStringList(value))

const financialInformationSchema = z.object({
  annual_income: z
    .union([z.number(), z.string()])
    .optional()
    .transform((value) => {
      if (value === "" || value === undefined || value === null) return ""
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : ""
    }),
  household_income: z
    .union([z.number(), z.string()])
    .optional()
    .transform((value) => {
      if (value === "" || value === undefined || value === null) return ""
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : ""
    }),
  household_size: z
    .union([z.number(), z.string()])
    .optional()
    .transform((value) => {
      if (value === "" || value === undefined || value === null) return ""
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : ""
    }),
  financial_need_level: z.string().optional().or(z.literal("")),
  low_income: booleanField,
  unemployed: booleanField,
  displaced_worker: booleanField,
  funding_needs: z.string().optional().or(z.literal("")),
  funding_purpose: z.string().optional().or(z.literal("")),
  receives_assistance: stringListField,
  assistance_notes: z.string().optional().or(z.literal("")),
  notes: z.string().optional().or(z.literal("")),
})

const assistanceSchema = z.object({
  medicaid_enrolled: booleanField,
  medicare_recipient: booleanField,
  ssi_recipient: booleanField,
  ssdi_recipient: booleanField,
  snap_recipient: booleanField,
  tanf_recipient: booleanField,
  section8_housing: booleanField,
  other_programs: z.string().optional().or(z.literal("")),
})

const healthSchema = z.object({
  chronic_illness: booleanField,
  chronic_illness_type: z.string().optional().or(z.literal("")),
  disability_type: z
    .union([z.array(z.string()), z.string()])
    .optional()
    .transform((value) => {
      if (Array.isArray(value)) return value
      if (typeof value === 'string' && value.trim() !== '') {
        return value.split(',').map((entry) => entry.trim()).filter(Boolean)
      }
      return []
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
  african_american: booleanField,
  hispanic_latino: booleanField,
  asian_american: booleanField,
  native_american: booleanField,
  tribal_affiliation: z.string().optional().or(z.literal("")),
  lgbtq: booleanField,
  immigrant_status: z.string().optional().or(z.literal("")),
  ethnicity: z.string().optional().or(z.literal("")),
  heritage: z.string().optional().or(z.literal("")),
  languages: stringListField,
  religious_affiliation: z.string().optional().or(z.literal("")),
  citizenship: z.string().optional().or(z.literal("")),
  us_citizen: booleanField,
  disability_status: z.string().optional().or(z.literal("")),
  veteran_status: z.string().optional().or(z.literal("")),
  age_group: z.string().optional().or(z.literal("")),
  white_caucasian: booleanField,
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

const educationSchema = z.object({
  highest_level: z.string().optional().or(z.literal("")),
  current_institution: z.string().optional().or(z.literal("")),
  target_colleges: stringListField,
  intended_major: z.string().optional().or(z.literal("")),
  gpa: z
    .union([z.number(), z.string()])
    .optional()
    .transform((value) => {
      if (value === "" || value === undefined || value === null) return ""
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : ""
    }),
  act_score: z
    .union([z.number(), z.string()])
    .optional()
    .transform((value) => {
      if (value === "" || value === undefined || value === null) return ""
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : ""
    }),
  sat_score: z
    .union([z.number(), z.string()])
    .optional()
    .transform((value) => {
      if (value === "" || value === undefined || value === null) return ""
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : ""
    }),
  community_service_hours: z
    .union([z.number(), z.string()])
    .optional()
    .transform((value) => {
      if (value === "" || value === undefined || value === null) return ""
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : ""
    }),
  leadership_roles: stringListField,
  valedictorian: booleanField,
  notes: z.string().optional().or(z.literal("")),
})

const employmentSchema = z.object({
  current_status: z.string().optional().or(z.literal("")),
  career_goal: z.string().optional().or(z.literal("")),
  experience: z.string().optional().or(z.literal("")),
  notes: z.string().optional().or(z.literal("")),
})

const housingSchema = z.object({
  status: z.string().optional().or(z.literal("")),
  type: z.string().optional().or(z.literal("")),
  address: z.string().optional().or(z.literal("")),
  broadband_speed: z.string().optional().or(z.literal("")),
  geographic_designation: stringListField,
  notes: z.string().optional().or(z.literal("")),
})

const householdSchema = z.object({
  household_size: z
    .union([z.number(), z.string()])
    .optional()
    .transform((value) => {
      if (value === "" || value === undefined || value === null) return ""
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : ""
    }),
  responsibilities: z.string().optional().or(z.literal("")),
  support_system: z.string().optional().or(z.literal("")),
  notes: z.string().optional().or(z.literal("")),
})

const programsServicesSchema = z.object({
  focus_areas: stringListField,
  interests: stringListField,
  keywords: stringListField,
  notes: z.string().optional().or(z.literal("")),
})

const narrativeSchema = z.object({
  mission: z.string().optional().or(z.literal("")),
  primary_goal: z.string().optional().or(z.literal("")),
  target_population: z.string().optional().or(z.literal("")),
  funding_amount_needed: z.string().optional().or(z.literal("")),
  timeline: z.string().optional().or(z.literal("")),
  past_experience: z.string().optional().or(z.literal("")),
  unique_qualities: z.string().optional().or(z.literal("")),
  collaboration_partners: z.string().optional().or(z.literal("")),
  sustainability_plan: z.string().optional().or(z.literal("")),
  barriers_faced: z.string().optional().or(z.literal("")),
  special_circumstances: z.string().optional().or(z.literal("")),
})

export const SECTION_CONFIG = {
  basic_information: {
    title: "Basic Information",
    description:
      "Primary contact details for this profile. This maps to Section 2 of the comprehensive application.",
    schema: basicInfoSchema,
    defaults: {
      full_name: "",
      email: "",
      phone: "",
      website: "",
      address: "",
      city: "",
      state: "",
      zip_code: "",
      county: "",
      date_of_birth: "",
      gender: "",
      nationality: "",
      notes: "",
    },
    fields: [
      { name: "full_name", label: "Full name / organization name", component: Input },
      { name: "email", label: "Email address", component: Input },
      { name: "phone", label: "Phone number", component: Input },
      { name: "website", label: "Website", component: Input },
      { name: "address", label: "Address", component: Textarea, props: { rows: 3 } },
      { name: "city", label: "City", component: Input },
      { name: "state", label: "State", component: Input, props: { maxLength: 2 }, description: "Two-letter abbreviation preferred (e.g. TN)." },
      { name: "zip_code", label: "ZIP code", component: Input },
      { name: "county", label: "County", component: Input },
      { name: "date_of_birth", label: "Date of birth", component: Input, props: { placeholder: "YYYY-MM-DD" } },
      { name: "gender", label: "Gender", component: Input },
      { name: "nationality", label: "Nationality", component: Input },
      { name: "notes", label: "Notes", component: Textarea, props: { rows: 3 } },
    ],
  },
  organization_details: {
    title: "Organization Details",
    description:
      "Entity registration, capacity indicators, and mission summary for Section 4 of the comprehensive application.",
    schema: organizationDetailsSchema,
    defaults: {
      organization_type: "",
      ein: "",
      uei: "",
      cage_code: "",
      annual_budget: "",
      staff_count: "",
      mission: "",
    },
    fields: [
      { name: "organization_type", label: "Organization type", component: Input },
      { name: "ein", label: "EIN (Tax ID)", component: Input },
      { name: "uei", label: "UEI", component: Input },
      { name: "cage_code", label: "CAGE Code", component: Input },
      { name: "annual_budget", label: "Annual budget", component: Input, props: { type: "number", min: 0 } },
      { name: "staff_count", label: "Staff count", component: Input, props: { type: "number", min: 0 } },
      { name: "mission", label: "Mission", component: Textarea, props: { rows: 4 } },
    ],
  },
  financial_information: {
    title: "Financial Situation",
    description:
      "Document income, household size, and employment status to support need-based matching.",
    schema: financialInformationSchema,
    defaults: {
      annual_income: "",
      household_income: "",
      household_size: "",
      financial_need_level: "",
      low_income: false,
      unemployed: false,
      displaced_worker: false,
      funding_needs: "",
      funding_purpose: "",
      receives_assistance: "",
      assistance_notes: "",
      notes: "",
    },
    fields: [
      { name: "annual_income", label: "Annual income (USD)", component: Input, props: { type: "number", min: 0 } },
      { name: "household_income", label: "Household income (USD)", component: Input, props: { type: "number", min: 0 } },
      { name: "household_size", label: "Household size", component: Input, props: { type: "number", min: 1 } },
      { name: "financial_need_level", label: "Financial need level", component: Input, props: { placeholder: "e.g. high, moderate" } },
      { name: "low_income", label: "Low income household", type: "boolean" },
      { name: "unemployed", label: "Currently unemployed", type: "boolean" },
      { name: "displaced_worker", label: "Displaced worker", type: "boolean" },
      { name: "funding_needs", label: "Funding needs", component: Textarea, props: { rows: 2, placeholder: "What do you need funding for?" } },
      { name: "funding_purpose", label: "Funding purpose", component: Textarea, props: { rows: 2, placeholder: "How will funds be used?" } },
      { name: "receives_assistance", label: "Receives assistance (list)", component: Textarea, props: { rows: 2, placeholder: "Separate with commas (e.g. SNAP, Medicaid)" } },
      { name: "assistance_notes", label: "Assistance notes", component: Textarea, props: { rows: 2, placeholder: "Any nuance about benefits or barriers" } },
      { name: "notes", label: "Notes", component: Textarea, props: { rows: 3, placeholder: "Context for financial need" } },
    ],
  },
  government_assistance: {
    title: "Government Assistance",
    description:
      "Track public benefits to strengthen eligibility profiling for specific funds.",
    schema: assistanceSchema,
    defaults: {
      medicaid_enrolled: false,
      medicare_recipient: false,
      ssi_recipient: false,
      ssdi_recipient: false,
      snap_recipient: false,
      tanf_recipient: false,
      section8_housing: false,
      other_programs: "",
    },
    fields: [
      { name: "medicaid_enrolled", label: "Medicaid enrolled", type: "boolean" },
      { name: "medicare_recipient", label: "Medicare recipient", type: "boolean" },
      { name: "ssi_recipient", label: "SSI recipient", type: "boolean" },
      { name: "ssdi_recipient", label: "SSDI recipient", type: "boolean" },
      { name: "snap_recipient", label: "SNAP recipient", type: "boolean" },
      { name: "tanf_recipient", label: "TANF recipient", type: "boolean" },
      { name: "section8_housing", label: "Section 8 housing", type: "boolean" },
      { name: "other_programs", label: "Other programs", component: Textarea, props: { rows: 3, placeholder: "List additional programs, if any" } },
    ],
  },
  health_medical: {
    title: "Health & Medical",
    description:
      "Capture relevant health information to highlight eligibility for medical and disability-focused opportunities.",
    schema: healthSchema,
    defaults: {
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
    title: "Demographics",
    description:
      "Document demographic information that influences funding eligibility and reporting requirements.",
    schema: demographicsSchema,
    defaults: {
      african_american: false,
      hispanic_latino: false,
      asian_american: false,
      native_american: false,
      tribal_affiliation: "",
      lgbtq: false,
      immigrant_status: "",
      ethnicity: "",
      heritage: "",
      languages: "",
      religious_affiliation: "",
      citizenship: "",
      us_citizen: false,
      disability_status: "",
      veteran_status: "",
      age_group: "",
      white_caucasian: false,
      notes: "",
    },
    fields: [
      { name: "african_american", label: "African American / Black", type: "boolean" },
      { name: "hispanic_latino", label: "Hispanic / Latino", type: "boolean" },
      { name: "asian_american", label: "Asian American / Pacific Islander", type: "boolean" },
      { name: "native_american", label: "Native American / Alaska Native", type: "boolean" },
      { name: "tribal_affiliation", label: "Tribal affiliation", component: Input, description: "Specify tribe if applicable." },
      { name: "lgbtq", label: "Identifies as LGBTQ+", type: "boolean" },
      { name: "immigrant_status", label: "Immigration status", component: Input, props: { placeholder: "us_citizen, permanent_resident, refugee, etc." } },
      { name: "ethnicity", label: "Ethnicity (free text)", component: Input },
      { name: "heritage", label: "Heritage / ancestry", component: Input },
      { name: "languages", label: "Languages (list)", component: Textarea, props: { rows: 2, placeholder: "Separate with commas" } },
      { name: "religious_affiliation", label: "Religious affiliation", component: Input },
      { name: "citizenship", label: "Citizenship", component: Input },
      { name: "us_citizen", label: "US citizen", type: "boolean" },
      { name: "disability_status", label: "Disability status (high level)", component: Input },
      { name: "veteran_status", label: "Veteran status (high level)", component: Input },
      { name: "age_group", label: "Age group", component: Input, props: { placeholder: "youth, young adult, senior, etc." } },
      { name: "white_caucasian", label: "White / Caucasian", type: "boolean" },
      { name: "notes", label: "Demographic notes", component: Textarea, props: { rows: 3, placeholder: "Additional context or identities" } },
    ],
  },

  education: {
    title: "Education",
    description:
      "Academic history and student qualifiers (GPA, tests, service hours) for scholarship and education-focused matching.",
    schema: educationSchema,
    defaults: {
      highest_level: "",
      current_institution: "",
      target_colleges: "",
      intended_major: "",
      gpa: "",
      act_score: "",
      sat_score: "",
      community_service_hours: "",
      leadership_roles: "",
      valedictorian: false,
      notes: "",
    },
    fields: [
      { name: "highest_level", label: "Highest level completed", component: Input, props: { placeholder: "high_school, associate, bachelor, etc." } },
      { name: "current_institution", label: "Current institution", component: Input },
      { name: "target_colleges", label: "Target colleges (list)", component: Textarea, props: { rows: 2, placeholder: "Separate with commas" } },
      { name: "intended_major", label: "Intended major", component: Input },
      { name: "gpa", label: "GPA", component: Input, props: { type: "number", min: 0, max: 4, step: "0.01" } },
      { name: "act_score", label: "ACT score", component: Input, props: { type: "number", min: 0, max: 36 } },
      { name: "sat_score", label: "SAT score", component: Input, props: { type: "number", min: 0, max: 1600 } },
      { name: "community_service_hours", label: "Community service hours", component: Input, props: { type: "number", min: 0 } },
      { name: "leadership_roles", label: "Leadership roles (list)", component: Textarea, props: { rows: 2, placeholder: "Separate with commas" } },
      { name: "valedictorian", label: "Valedictorian", type: "boolean" },
      { name: "notes", label: "Education notes", component: Textarea, props: { rows: 3 } },
    ],
  },

  employment: {
    title: "Employment",
    description:
      "Employment status and experience used for workforce training and career-change programs.",
    schema: employmentSchema,
    defaults: {
      current_status: "",
      career_goal: "",
      experience: "",
      notes: "",
    },
    fields: [
      { name: "current_status", label: "Current status", component: Input, props: { placeholder: "employed, unemployed, student, retired, etc." } },
      { name: "career_goal", label: "Career goal", component: Textarea, props: { rows: 2 } },
      { name: "experience", label: "Experience", component: Textarea, props: { rows: 3 } },
      { name: "notes", label: "Employment notes", component: Textarea, props: { rows: 2 } },
    ],
  },

  housing: {
    title: "Housing",
    description:
      "Housing stability and geographic designations relevant to assistance programs.",
    schema: housingSchema,
    defaults: {
      status: "",
      type: "",
      address: "",
      broadband_speed: "",
      geographic_designation: "",
      notes: "",
    },
    fields: [
      { name: "status", label: "Housing status", component: Input, props: { placeholder: "stable, homeless, transitional, etc." } },
      { name: "type", label: "Housing type", component: Input, props: { placeholder: "rent, own, shelter, etc." } },
      { name: "address", label: "Housing address (if different)", component: Textarea, props: { rows: 3 } },
      { name: "broadband_speed", label: "Broadband speed", component: Input, props: { placeholder: "e.g. 25/3 Mbps" } },
      { name: "geographic_designation", label: "Geographic designation (list)", component: Textarea, props: { rows: 2, placeholder: "Separate with commas (rural, urban, frontier...)" } },
      { name: "notes", label: "Housing notes", component: Textarea, props: { rows: 2 } },
    ],
  },

  family: {
    title: "Household Details",
    description:
      "Household structure and support system details (separate from eligibility flags).",
    schema: householdSchema,
    defaults: {
      household_size: "",
      responsibilities: "",
      support_system: "",
      notes: "",
    },
    fields: [
      { name: "household_size", label: "Household size", component: Input, props: { type: "number", min: 1 } },
      { name: "responsibilities", label: "Responsibilities", component: Textarea, props: { rows: 2 } },
      { name: "support_system", label: "Support system", component: Textarea, props: { rows: 2 } },
      { name: "notes", label: "Household notes", component: Textarea, props: { rows: 2 } },
    ],
  },

  programs_services: {
    title: "Programs & Services",
    description:
      "Focus areas, services, and keywords used to match funding opportunities (high-signal for crawlers).",
    schema: programsServicesSchema,
    defaults: {
      focus_areas: "",
      interests: "",
      keywords: "",
      notes: "",
    },
    fields: [
      { name: "focus_areas", label: "Focus areas (list)", component: Textarea, props: { rows: 2, placeholder: "Separate with commas" } },
      { name: "interests", label: "Interests (list)", component: Textarea, props: { rows: 2, placeholder: "Separate with commas" } },
      { name: "keywords", label: "Keywords (list)", component: Textarea, props: { rows: 2, placeholder: "Separate with commas" } },
      { name: "notes", label: "Programs/services notes", component: Textarea, props: { rows: 3 } },
    ],
  },
  family_life: {
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
      { name: "minority_owned_business", label: "Minority-owned business", type: "boolean" },
      { name: "women_owned_business", label: "Women-owned business", type: "boolean" },
      { name: "union_member", label: "Union member", type: "boolean" },
      { name: "farmer", label: "Agricultural worker / farmer", type: "boolean" },
      { name: "truck_driver", label: "Truck driver / transportation worker", type: "boolean" },
      { name: "notes", label: "Occupational notes", component: Textarea, props: { rows: 3, placeholder: "Additional occupations, certifications, or union local" } },
    ],
  },
  location_focus: {
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
    title: "Story & Goals",
    description:
      "Summarise the applicant's mission, goals, and unique narrative to feed proposals and AI tooling.",
    schema: narrativeSchema,
    defaults: {
      mission: "",
      primary_goal: "",
      target_population: "",
      funding_amount_needed: "",
      timeline: "",
      past_experience: "",
      unique_qualities: "",
      collaboration_partners: "",
      sustainability_plan: "",
      barriers_faced: "",
      special_circumstances: "",
    },
    fields: [
      { name: "mission", label: "Mission", component: Textarea, props: { rows: 3 } },
      { name: "primary_goal", label: "Primary goal", component: Textarea, props: { rows: 3 } },
      { name: "target_population", label: "Target population", component: Textarea, props: { rows: 3 } },
      { name: "funding_amount_needed", label: "Funding amount needed", component: Input, props: { placeholder: "e.g. $50,000 or description" } },
      { name: "timeline", label: "Timeline", component: Textarea, props: { rows: 2 } },
      { name: "past_experience", label: "Past experience", component: Textarea, props: { rows: 3 } },
      { name: "unique_qualities", label: "Unique qualities", component: Textarea, props: { rows: 3 } },
      { name: "collaboration_partners", label: "Collaboration partners", component: Textarea, props: { rows: 3 } },
      { name: "sustainability_plan", label: "Sustainability plan", component: Textarea, props: { rows: 3 } },
      { name: "barriers_faced", label: "Barriers faced", component: Textarea, props: { rows: 3 } },
      { name: "special_circumstances", label: "Special circumstances", component: Textarea, props: { rows: 3 } },
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
                return (
                  <div className="flex items-center justify-between rounded-lg border border-slate-200 p-3" key={field.name}>
                    <div className="space-y-1">
                      <Label htmlFor={field.name}>{field.label}</Label>
                      {field.description && (
                        <p className="text-xs text-slate-500">{field.description}</p>
                      )}
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
