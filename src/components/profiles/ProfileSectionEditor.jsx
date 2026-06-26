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
import { Info, Sparkles, Loader2, Plus, Trash2 } from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import ProfileFieldWithAI from "@/components/profiles/ProfileFieldWithAI"
import { SECTION_METADATA } from "@/config/sectionMetadata"
import FieldHelpTip from "@/components/help/FieldHelpTip"

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false
  return Object.prototype.toString.call(value) === '[object Object]'
}

// Treat null/undefined/empty-string as "missing" but keep legitimate falsy values like 0 / '0'.
function hasValue(v) {
  return v !== null && v !== undefined && String(v).trim() !== ''
}

function formatAddressObject(address) {
  if (!isPlainObject(address)) return null

  const trimToString = (v) => (hasValue(v) ? String(v).trim() : null)

  const parts = []
  const line1 = trimToString(address.line1 ?? address.address1 ?? address.street ?? address.street1)
  const line2 = trimToString(address.line2 ?? address.address2 ?? address.street2)
  if (line1 !== null) parts.push(line1)
  if (line2 !== null) parts.push(line2)

  const city = trimToString(address.city)
  const state = trimToString(address.state ?? address.region)
  const postal = trimToString(address.zip ?? address.postal ?? address.postal_code ?? address.zip_code)

  const cityLine = [city, state].filter((v) => v !== null).join(', ')
  const cityPostal = [cityLine, postal].filter((v) => v !== null && v !== '').join(' ').trim()
  if (cityPostal) parts.push(cityPostal)

  const country = trimToString(address.country)
  if (country !== null) parts.push(country)

  return parts.filter((v) => v !== null && v !== '').join('\n').trim() || null
}

function normalizeTextValue(fieldName, value) {
  if (value === undefined || value === null) return ""
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)

  if (Array.isArray(value)) {
    if (fieldName === 'conditions') {
      // health_medical.conditions is an array of objects; present it as a simple list for editing.
      return value
        .map((entry) => {
          if (entry === null) return ''
          if (typeof entry === 'string') return entry
          if (typeof entry === 'object' && typeof entry.name === 'string') return entry.name
          return ''
        })
        .filter(Boolean)
        .join('\n')
    }
    return value
      .map((entry) => {
        if (entry === null || entry === undefined) return ''
        // Avoid '[object Object]' corruption for arrays of objects.
        if (typeof entry === 'object') {
          try {
            return JSON.stringify(entry)
          } catch {
            return ''
          }
        }
        return String(entry)
      })
      .filter(Boolean)
      .join(', ')
  }

  if (isPlainObject(value) && fieldName === 'address') {
    const formatted = formatAddressObject(value)
    if (formatted) return formatted
  }

  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2)
    } catch (error) {
      console.error('normalizeTextValue: failed to JSON.stringify value for field', fieldName, error)
      return ''
    }
  }

  return String(value)
}

function normalizeInitialData(config, initialData) {
  if (!config) return {}
  if (!initialData || typeof initialData !== 'object') return {}

  const allowed = new Set((config.fields ?? []).map((field) => field.name))
  const out = Object.fromEntries(Object.entries(initialData).filter(([key]) => allowed.has(key)))

  for (const field of config.fields ?? []) {
    if (!field?.name) continue
    if (field.type === 'boolean') continue
    // Non-text field types (e.g. contacts arrays of objects) must not be flattened to text.
    if (field.type === 'contacts') continue

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
  first_name: z.string().optional().or(z.literal("")),
  middle_name: z.string().optional().or(z.literal("")),
  last_name: z.string().optional().or(z.literal("")),
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
  contacts: z.array(z.object({
    name: z.string().min(1, "Contact name is required"),
    email: z.string().email("Enter a valid email address"),
    role: z.enum(["admin", "full_access", "read_only"]).default("full_access"),
    addedDate: z.string().optional().default(() => new Date().toISOString()),
  })).optional().default([]),
})
const toBoolean = (value) => {
  if (value === undefined || value === null || value === '') return false
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  const normalized = String(value).toLowerCase().trim()
  return ['true', 'yes', 'y', '1'].includes(normalized)
}

// Tri-state aware boolean field: leaves unset values as `undefined` so a partial
// submit that omits the field does not overwrite a previously-stored `true` with `false`.
const booleanField = z
  .union([z.boolean(), z.string(), z.number()])
  .optional()
  .transform((value) => {
    if (value === undefined || value === null || value === '') return undefined
    return toBoolean(value)
  })

const toStringList = (value) => {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
  if (value && typeof value === 'object') {
    // Only flatten known list-like shapes; reject arbitrary nested objects rather
    // than silently producing a meaningless flattened string list.
    if (!isPlainObject(value)) return []
    const values = Object.values(value)
    const allListFriendly = values.every(
      (entry) => Array.isArray(entry) || typeof entry === 'string' || typeof entry === 'number',
    )
    if (!allListFriendly) return []
    return values
      .flatMap((entry) => (Array.isArray(entry) ? entry : [entry]))
      .map((entry) => String(entry).trim())
      .filter(Boolean)
  }
  if (typeof value === 'string') {
    const raw = value.trim()
    if (!raw) return []
    // Allow JSON array input
    if (raw.startsWith('[')) {
      try {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) return parsed.map((v) => String(v).trim()).filter(Boolean)
      } catch {
        // Ignore invalid JSON input; fall back to comma/newline-separated parsing.
      }
    }
    // Split on commas OR newlines so users can use either delimiter.
    return raw.split(/[,\n]+/).map((entry) => entry.trim()).filter(Boolean)
  }
  return []
}

const stringListField = z
  .union([z.array(z.string()), z.string()])
  .optional()
  .transform((value) => toStringList(value))


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
  // Federal Compliance
  sam_gov_registered: booleanField,
  grants_gov_account: booleanField,
  era_commons_account: booleanField,
  sam_exclusions_passed: booleanField,
  audited_financials: booleanField,
  nicra_rate: z
    .union([z.number(), z.string()])
    .optional()
    .transform((value) => {
      if (value === "" || value === undefined || value === null) return ""
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : ""
    }),
  ntee_code: z.string().optional().or(z.literal("")),
  // General Qualifications
  is_faith_based: booleanField,
  is_rural_serving: booleanField,
  is_minority_serving: booleanField,
  is_501c3_public_charity: booleanField,
  is_501c3_private_foundation: booleanField,
  // Business Certifications
  cert_8a: booleanField,
  cert_hubzone: booleanField,
  cert_sdvosb: booleanField,
  cert_mbe: booleanField,
  cert_wbe: booleanField,
  cert_sbir_sttr: booleanField,
  // Geographic & Special Designations
  in_opportunity_zone: booleanField,
  in_qct: booleanField,
  in_epa_ej_area: booleanField,
  in_usda_persistent_poverty_county: booleanField,
  in_appalachian_region: booleanField,
  broadband_unserved: booleanField,
  in_fema_disaster_area: booleanField,
  // Specialized Org Types
  is_tribal_government: booleanField,
  is_community_action_agency: booleanField,
  is_housing_authority: booleanField,
  is_workforce_dev_board: booleanField,
  is_cdfi: booleanField,
  is_msi_hbcu: booleanField,
  is_rural_health_clinic: booleanField,
  is_cooperative: booleanField,
})


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
  underemployed: booleanField,
  has_medical_debt: booleanField,
  has_education_debt: booleanField,
  bankruptcy_foreclosure: booleanField,
  first_time_homebuyer: booleanField,
})

const assistanceSchema = z.object({
  medicaid_enrolled: booleanField,
  medicaid_waiver_program: z.string().optional().or(z.literal("")),
  ecf_choices_role: z.string().optional().or(z.literal("")),
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
  conditions: z
    .union([
      z.array(
        z.object({
          name: z.string(),
          icd10: z.string().optional(),
          stage: z.string().optional(),
          diagnosed_year: z.union([z.number(), z.string()]).optional(),
        }),
      ),
      z.string(),
    ])
    .optional()
    .transform((value) => {
      if (Array.isArray(value)) {
        return value
          .map((c) => ({
            name: String(c?.name || '').trim(),
            icd10: c?.icd10 ? String(c.icd10).trim() : undefined,
            stage: c?.stage ? String(c.stage).trim() : undefined,
            diagnosed_year:
              c?.diagnosed_year === undefined || c?.diagnosed_year === null || c?.diagnosed_year === ''
                ? undefined
                : Number.isFinite(Number(c.diagnosed_year))
                  ? Number(c.diagnosed_year)
                  : undefined,
          }))
          .filter((c) => c.name.length > 0)
      }
      if (typeof value === 'string' && value.trim() !== '') {
        // Accept either JSON or newline/comma separated condition names.
        const raw = value.trim()
        try {
          const parsed = JSON.parse(raw)
          if (Array.isArray(parsed)) {
            return parsed
              .map((c) => {
                if (typeof c === 'string') return { name: c.trim() }
                if (c && typeof c === 'object' && typeof c.name === 'string') return { name: c.name.trim() }
                return null
              })
              .filter(Boolean)
          }
        } catch {
          // fall through
        }
        return raw
          .split(/[\n,;]+/)
          .map((s) => s.trim())
          .filter(Boolean)
          .map((name) => ({ name }))
      }
      return []
    }),
  disability_type: z
    .union([z.array(z.string()), z.string()])
    .optional()
    .transform((value) => {
      if (Array.isArray(value)) {
        return value.map((v) => String(v).trim()).filter(Boolean)
      }
      if (typeof value === 'string' && value.trim() !== '') {
        return value.split(',').map((entry) => entry.trim()).filter(Boolean)
      }
      return []
    }),
  support_needs: z
    .union([z.array(z.string()), z.string()])
    .optional()
    .transform((value) => {
      if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
      if (typeof value === 'string' && value.trim() !== '') {
        return value
          .split(/[,;\n]+/)
          .map((entry) => entry.trim())
          .filter(Boolean)
      }
      return []
    }),
  support_needs_level: z.string().optional().or(z.literal("")),
  consent_for_studies: booleanField,
  mobility_or_transport_notes: z.string().optional().or(z.literal("")),
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

const medicalInsuranceSchema = z.object({
  insurance_provider: z.string().optional().or(z.literal("")),
  plan_name: z.string().optional().or(z.literal("")),
  plan_type: z.string().optional().or(z.literal("")),
  member_id: z.string().optional().or(z.literal("")),
  group_id: z.string().optional().or(z.literal("")),
  policy_holder_name: z.string().optional().or(z.literal("")),
  effective_date: z.string().optional().or(z.literal("")),
  phone_for_claims: z.string().optional().or(z.literal("")),
  notes: z.string().optional().or(z.literal("")),
})

const toStringArray = (value) => {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
  if (value && typeof value === "object") {
    if (!isPlainObject(value)) return []
    const values = Object.values(value)
    const allListFriendly = values.every(
      (entry) => Array.isArray(entry) || typeof entry === 'string' || typeof entry === 'number',
    )
    if (!allListFriendly) return []
    return values
      .flatMap((entry) => (Array.isArray(entry) ? entry : [entry]))
      .map((entry) => String(entry).trim())
      .filter(Boolean)
  }
  if (typeof value === "string" && value.trim() !== "") {
    return value.split(/[,\n]+/).map((entry) => entry.trim()).filter(Boolean)
  }
  return []
}

const medicalHistorySchema = z.object({
  primary_condition: z.string().optional().or(z.literal("")),
  secondary_conditions: z.union([z.array(z.string()), z.string()]).optional().transform((v) => toStringArray(v)),
  mobility_needs: z.string().optional().or(z.literal("")),
  dme_needed: z.union([z.array(z.string()), z.string()]).optional().transform((v) => toStringArray(v)),
  doctor_name: z.string().optional().or(z.literal("")),
  clinic_name: z.string().optional().or(z.literal("")),
  letter_support_needed: booleanField,
  notes: z.string().optional().or(z.literal("")),
})

const nonprofitComplianceSchema = z.object({
  is_501c3: booleanField,
  fiscal_sponsor: booleanField,
  fiscal_sponsor_name: z.string().optional().or(z.literal("")),
  sam_registered: booleanField,
  insurance_coverage: z.string().optional().or(z.literal("")),
  compliance_notes: z.string().optional().or(z.literal("")),
})

const smallBusinessDetailsSchema = z.object({
  business_name: z.string().optional().or(z.literal("")),
  naics_code: z.string().optional().or(z.literal("")),
  years_in_business: z
    .union([z.number(), z.string()])
    .optional()
    .transform((value) => {
      if (value === "" || value === undefined || value === null) return ""
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : ""
    }),
  employee_count: z
    .union([z.number(), z.string()])
    .optional()
    .transform((value) => {
      if (value === "" || value === undefined || value === null) return ""
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : ""
    }),
  annual_revenue: z
    .union([z.number(), z.string()])
    .optional()
    .transform((value) => {
      if (value === "" || value === undefined || value === null) return ""
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : ""
    }),
  certifications: z.union([z.array(z.string()), z.string()]).optional().transform((v) => toStringArray(v)),
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
  good_credit_score: booleanField,
  religious_denomination: z.string().optional().or(z.literal("")),
  jewish_heritage: booleanField,
  irish_heritage: booleanField,
  italian_heritage: booleanField,
  greek_heritage: booleanField,
  armenian_heritage: booleanField,
  appalachian_heritage: booleanField,
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
  pell_grant_eligible: booleanField,
  fafsa_completed: booleanField,
  first_generation_college_student: booleanField,
  dual_enrollment: booleanField,
  rotc_jrotc: booleanField,
  cte_pathway: z.string().optional().or(z.literal("")),
  honor_societies: z.string().optional().or(z.literal("")),
  efc_sai_band: z.string().optional().or(z.literal("")),
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

/**
 * UI section configuration.
 *
 * Titles and descriptions are derived from the canonical {@link SECTION_METADATA} module
 * (`src/config/sectionMetadata.js`), which is the single source of truth.
 * UI-specific concerns (Zod schemas, React components, field props) live here.
 *
 * @see src/config/sectionMetadata.js
 */
export const SECTION_CONFIG = {
  basic_information: {
    title: "Basic Information",
    description:
      "Primary contact details for this profile. This maps to Section 2 of the comprehensive application.",
    schema: basicInfoSchema,
    defaults: {
      full_name: "",
      first_name: "",
      middle_name: "",
      last_name: "",
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
      contacts: [],
    },
    fields: [
      { name: "full_name", label: "Full name / organization name", component: Input },
      { name: "first_name", label: "First name", component: Input, description: "Auto-filled from the full name. Edit if the split is wrong." },
      { name: "middle_name", label: "Middle name", component: Input },
      { name: "last_name", label: "Last name", component: Input, description: "Auto-filled from the full name. Edit if the split is wrong." },
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
      { name: "contacts", label: "Profile Contacts", type: "contacts" },
    ],
  },
  organization_details: {
    title: "Organization Details",
    description:
      "Entity registration, capacity indicators, and mission summary for Section 4 of the comprehensive application.",
    // Avoid redundancy: organization-only fields should not appear for individual/family/student profiles.
    applies_to: ["organization", "nonprofit", "small_business", "government"],
    schema: organizationDetailsSchema,
    defaults: {
      organization_type: "",
      ein: "",
      uei: "",
      cage_code: "",
      annual_budget: "",
      staff_count: "",
      mission: "",
      // Federal Compliance
      sam_gov_registered: false,
      grants_gov_account: false,
      era_commons_account: false,
      sam_exclusions_passed: false,
      audited_financials: false,
      nicra_rate: "",
      ntee_code: "",
      // General Qualifications
      is_faith_based: false,
      is_rural_serving: false,
      is_minority_serving: false,
      is_501c3_public_charity: false,
      is_501c3_private_foundation: false,
      // Business Certifications
      cert_8a: false,
      cert_hubzone: false,
      cert_sdvosb: false,
      cert_mbe: false,
      cert_wbe: false,
      cert_sbir_sttr: false,
      // Geographic & Special Designations
      in_opportunity_zone: false,
      in_qct: false,
      in_epa_ej_area: false,
      in_usda_persistent_poverty_county: false,
      in_appalachian_region: false,
      broadband_unserved: false,
      in_fema_disaster_area: false,
      // Specialized Org Types
      is_tribal_government: false,
      is_community_action_agency: false,
      is_housing_authority: false,
      is_workforce_dev_board: false,
      is_cdfi: false,
      is_msi_hbcu: false,
      is_rural_health_clinic: false,
      is_cooperative: false,
    },
    // Mission is captured in the Narrative section for all profile types; keep stored value but don't ask twice.
    hidden_fields: [
      {
        name: "mission",
        note: "Mission is captured in “Story & Goals” to avoid asking the same question twice.",
      },
    ],
    fields: [
      { name: "organization_type", label: "Organization type", component: Input },
      { name: "ein", label: "EIN (Tax ID)", component: Input },
      { name: "uei", label: "UEI", component: Input },
      { name: "cage_code", label: "CAGE Code", component: Input },
      { name: "annual_budget", label: "Annual budget", component: Input, props: { type: "number", min: 0 } },
      { name: "staff_count", label: "Staff count", component: Input, props: { type: "number", min: 0 } },
      // Federal Compliance
      { name: "sam_gov_registered", label: "SAM.gov Registered", type: "boolean", description: "Required for all federal grants." },
      { name: "grants_gov_account", label: "Grants.gov Account Active", type: "boolean", description: "Increases eligibility for federal opportunities." },
      { name: "era_commons_account", label: "eRA Commons Account (NIH/Health Research)", type: "boolean" },
      { name: "sam_exclusions_passed", label: "SAM Exclusions Check Passed", type: "boolean", description: "Not debarred from federal contracts." },
      { name: "audited_financials", label: "Audited Financials Available", type: "boolean" },
      { name: "nicra_rate", label: "NICRA Indirect Cost Rate (%)", component: Input, props: { type: "number", min: 0, max: 100, step: "0.01" }, description: "Federally Negotiated Indirect Cost Rate." },
      { name: "ntee_code", label: "NTEE Code", component: Input, props: { placeholder: "e.g., A01, B20" }, description: "National Taxonomy of Exempt Entities." },
      // General Qualifications
      { name: "is_faith_based", label: "Faith-Based Organization / Church / Ministry", type: "boolean" },
      { name: "is_rural_serving", label: "Serves Rural Area", type: "boolean" },
      { name: "is_minority_serving", label: "Minority-Serving Organization", type: "boolean" },
      { name: "is_501c3_public_charity", label: "501(c)(3) Public Charity", type: "boolean" },
      { name: "is_501c3_private_foundation", label: "501(c)(3) Private Foundation", type: "boolean" },
      // Business Certifications
      { name: "cert_8a", label: "8(a) Certified", type: "boolean", description: "SBA program for disadvantaged businesses." },
      { name: "cert_hubzone", label: "HUBZone Certified", type: "boolean" },
      { name: "cert_sdvosb", label: "Service-Disabled Veteran-Owned Small Business (SDVOSB)", type: "boolean" },
      { name: "cert_mbe", label: "Minority Business Enterprise (MBE)", type: "boolean" },
      { name: "cert_wbe", label: "Women Business Enterprise (WBE)", type: "boolean" },
      { name: "cert_sbir_sttr", label: "SBIR/STTR Eligible", type: "boolean" },
      // Geographic & Special Designations
      { name: "in_opportunity_zone", label: "Opportunity Zone Location", type: "boolean", description: "Economically distressed community eligible for tax incentives." },
      { name: "in_qct", label: "Qualified Census Tract (QCT)", type: "boolean", description: "HUD-designated low-income area." },
      { name: "in_epa_ej_area", label: "EPA Environmental Justice Area", type: "boolean" },
      { name: "in_usda_persistent_poverty_county", label: "USDA Persistent-Poverty County", type: "boolean" },
      { name: "in_appalachian_region", label: "Appalachian Region", type: "boolean", description: "Served by Appalachian Regional Commission." },
      { name: "broadband_unserved", label: "Broadband-Unserved (FCC Map Block)", type: "boolean", description: "No high-speed internet — USDA ReConnect and NTIA grants." },
      { name: "in_fema_disaster_area", label: "FEMA Disaster Declaration Area", type: "boolean" },
      // Specialized Org Types
      { name: "is_tribal_government", label: "Tribal Government / Tribally Controlled Organization", type: "boolean" },
      { name: "is_community_action_agency", label: "Community Action Agency (CAA)", type: "boolean", description: "CSBG eligible entity." },
      { name: "is_housing_authority", label: "Housing Authority", type: "boolean" },
      { name: "is_workforce_dev_board", label: "Workforce Development Board", type: "boolean" },
      { name: "is_cdfi", label: "CDFI Partner", type: "boolean", description: "Community Development Financial Institution." },
      { name: "is_msi_hbcu", label: "MSI/HBCU/HSI/TCU", type: "boolean", description: "Minority-Serving Institution." },
      { name: "is_rural_health_clinic", label: "Rural Health Clinic (RHC)", type: "boolean" },
      { name: "is_cooperative", label: "Cooperative (Ag/Electric/Housing/Worker)", type: "boolean" },
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
      underemployed: false,
      has_medical_debt: false,
      has_education_debt: false,
      bankruptcy_foreclosure: false,
      first_time_homebuyer: false,
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
      { name: "underemployed", label: "Underemployed", type: "boolean", description: "Working part-time or below skill level." },
      { name: "has_medical_debt", label: "Medical Debt", type: "boolean", description: "Outstanding medical bills — debt relief programs available." },
      { name: "has_education_debt", label: "Education/Student Loan Debt", type: "boolean", description: "Student loan forgiveness programs available." },
      { name: "bankruptcy_foreclosure", label: "Bankruptcy / Foreclosure", type: "boolean", description: "Recent financial crisis — recovery assistance available." },
      { name: "first_time_homebuyer", label: "First-Time Homebuyer", type: "boolean", description: "Down payment assistance programs available." },
    ],
  },
  government_assistance: {
    title: "Government Assistance",
    description:
      "Track public benefits to strengthen eligibility profiling for specific funds.",
    schema: assistanceSchema,
    defaults: {
      medicaid_enrolled: false,
      medicaid_waiver_program: "none",
      ecf_choices_role: "",
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
      {
        name: "medicaid_waiver_program",
        label: "Medicaid waiver program",
        component: Input,
        description: "Use 'ecf_choices' for ECF CHOICES. Otherwise: none / other short label.",
        props: { placeholder: "none | ecf_choices | other" },
      },
      {
        name: "ecf_choices_role",
        label: "ECF CHOICES role (for crawler unlock)",
        component: Input,
        description: "Use: participant | caregiver | provider (leave blank if not applicable).",
        props: { placeholder: "participant | caregiver | provider" },
      },
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
      conditions: [],
      chronic_illness: false,
      chronic_illness_type: "",
      disability_type: [],
      support_needs: [],
      support_needs_level: "",
      consent_for_studies: false,
      mobility_or_transport_notes: "",
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
      {
        name: "conditions",
        label: "Conditions (list)",
        component: Textarea,
        props: { rows: 4, placeholder: "One per line (e.g., Epilepsy)\nOptional: paste JSON array of {name, icd10, stage, diagnosed_year}" },
      },
      { name: "chronic_illness", label: "Chronic illness", type: "boolean" },
      { name: "chronic_illness_type", label: "Illness type", component: Input, description: "Provide diagnosis or condition if known." },
      { name: "disability_type", label: "Disability types", component: Textarea, props: { rows: 3, placeholder: "Separate multiple entries with commas" } },
      { name: "support_needs", label: "Support needs (list)", component: Textarea, props: { rows: 3, placeholder: "Comma or newline separated (transportation, copay_assistance, lodging...)" } },
      { name: "support_needs_level", label: "Support needs level", component: Input, props: { placeholder: "e.g. high, moderate, low, unknown" } },
      { name: "consent_for_studies", label: "Consent to view research studies/trials", type: "boolean" },
      { name: "mobility_or_transport_notes", label: "Mobility / transportation notes", component: Textarea, props: { rows: 2, placeholder: "Optional context for appointment transportation support" } },
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
  medical_insurance: {
    title: "Medical Insurance",
    description: "Store insurance details (provider/plan). Upload insurance cards or letters in the Files panel.",
    applies_to: ["medical_assistance", "medical_need", "individual_need", "family"],
    schema: medicalInsuranceSchema,
    defaults: {
      insurance_provider: "",
      plan_name: "",
      plan_type: "",
      member_id: "",
      group_id: "",
      policy_holder_name: "",
      effective_date: "",
      phone_for_claims: "",
      notes: "",
    },
    fields: [
      { name: "insurance_provider", label: "Insurance provider", component: Input },
      { name: "plan_name", label: "Plan name", component: Input },
      { name: "plan_type", label: "Plan type", component: Input, props: { placeholder: "Medicaid, Medicare, Marketplace, HMO, PPO…" } },
      { name: "member_id", label: "Member ID (optional)", component: Input },
      { name: "group_id", label: "Group ID (optional)", component: Input },
      { name: "policy_holder_name", label: "Policy holder name", component: Input },
      { name: "effective_date", label: "Effective date", component: Input, props: { placeholder: "YYYY-MM-DD" } },
      { name: "phone_for_claims", label: "Member services phone", component: Input },
      { name: "notes", label: "Notes", component: Textarea, props: { rows: 3 } },
    ],
  },
  medical_history: {
    title: "Medical History & Needs",
    description: "Capture medical context needed for assistance resources and support letters (keep concise).",
    applies_to: ["medical_assistance", "medical_need", "individual_need", "family"],
    schema: medicalHistorySchema,
    defaults: {
      primary_condition: "",
      secondary_conditions: [],
      mobility_needs: "",
      dme_needed: [],
      doctor_name: "",
      clinic_name: "",
      letter_support_needed: false,
      notes: "",
    },
    fields: [
      { name: "primary_condition", label: "Primary condition", component: Input },
      { name: "secondary_conditions", label: "Secondary conditions", component: Textarea, props: { rows: 3, placeholder: "Enter items separated by commas or new lines" } },
      { name: "mobility_needs", label: "Mobility needs", component: Textarea, props: { rows: 2 } },
      { name: "dme_needed", label: "DME needed", component: Textarea, props: { rows: 3, placeholder: "Enter items separated by commas or new lines (e.g., shower chair, walker)" } },
      { name: "doctor_name", label: "Doctor / clinician", component: Input },
      { name: "clinic_name", label: "Clinic / hospital", component: Input },
      { name: "letter_support_needed", label: "Support letter needed", type: "boolean" },
      { name: "notes", label: "Notes", component: Textarea, props: { rows: 4 } },
    ],
  },
  nonprofit_compliance: {
    title: "Nonprofit Compliance",
    description: "Track core compliance readiness signals used by many grants.",
    applies_to: ["nonprofit", "organization"],
    schema: nonprofitComplianceSchema,
    defaults: {
      is_501c3: false,
      fiscal_sponsor: false,
      fiscal_sponsor_name: "",
      sam_registered: false,
      insurance_coverage: "",
      compliance_notes: "",
    },
    fields: [
      { name: "is_501c3", label: "501(c)(3) status confirmed", type: "boolean" },
      { name: "fiscal_sponsor", label: "Uses a fiscal sponsor", type: "boolean" },
      { name: "fiscal_sponsor_name", label: "Fiscal sponsor name", component: Input },
      { name: "sam_registered", label: "SAM.gov registered", type: "boolean" },
      { name: "insurance_coverage", label: "Insurance coverage", component: Textarea, props: { rows: 2 } },
      { name: "compliance_notes", label: "Compliance notes", component: Textarea, props: { rows: 3 } },
    ],
  },
  small_business_details: {
    title: "Small Business Details",
    description: "Track business details needed for small business programs and certifications.",
    applies_to: ["small_business"],
    schema: smallBusinessDetailsSchema,
    defaults: {
      business_name: "",
      naics_code: "",
      years_in_business: "",
      employee_count: "",
      annual_revenue: "",
      certifications: [],
      notes: "",
    },
    fields: [
      { name: "business_name", label: "Business name", component: Input },
      { name: "naics_code", label: "NAICS code", component: Input },
      { name: "years_in_business", label: "Years in business", component: Input, props: { type: "number", min: 0 } },
      { name: "employee_count", label: "Employee count", component: Input, props: { type: "number", min: 0 } },
      { name: "annual_revenue", label: "Annual revenue (USD)", component: Input, props: { type: "number", min: 0 } },
      { name: "certifications", label: "Certifications", component: Textarea, props: { rows: 2, placeholder: "Enter items separated by commas or new lines (e.g., WOSB, HUBZone)" } },
      { name: "notes", label: "Notes", component: Textarea, props: { rows: 3 } },
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
      good_credit_score: false,
      religious_denomination: "",
      jewish_heritage: false,
      irish_heritage: false,
      italian_heritage: false,
      greek_heritage: false,
      armenian_heritage: false,
      appalachian_heritage: false,
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
      { name: "good_credit_score", label: "Good Credit Score (700+)", type: "boolean", description: "Qualifies for financial literacy programs and non-loan support." },
      { name: "religious_denomination", label: "Religious Denomination", component: Input, props: { placeholder: "e.g., Baptist, Methodist, Catholic, Lutheran" }, description: "Denominational scholarships available." },
      { name: "jewish_heritage", label: "Jewish Heritage", type: "boolean", description: "Extensive funding from Jewish federations, Hillel, and synagogues." },
      { name: "irish_heritage", label: "Irish Heritage", type: "boolean", description: "Hibernian societies, Irish cultural organizations." },
      { name: "italian_heritage", label: "Italian Heritage", type: "boolean" },
      { name: "greek_heritage", label: "Greek Heritage", type: "boolean", description: "AHEPA, Hellenic societies." },
      { name: "armenian_heritage", label: "Armenian Heritage", type: "boolean" },
      { name: "appalachian_heritage", label: "Appalachian Heritage", type: "boolean" },
    ],
  },

  education: {
    title: "Education",
    description:
      "Academic history and student qualifiers (GPA, tests, service hours) for scholarship and education-focused matching.",
    // Avoid showing student-only questions to non-student profiles.
    applies_to: ["student", "college_student", "high_school_student", "graduate_student"],
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
      pell_grant_eligible: false,
      fafsa_completed: false,
      first_generation_college_student: false,
      dual_enrollment: false,
      rotc_jrotc: false,
      cte_pathway: "",
      honor_societies: "",
      efc_sai_band: "",
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
      { name: "pell_grant_eligible", label: "Pell Grant Eligible", type: "boolean", description: "Federal grant for low-income students." },
      { name: "fafsa_completed", label: "FAFSA Completed", type: "boolean", description: "Required for most federal financial aid." },
      { name: "first_generation_college_student", label: "First-Generation College Student", type: "boolean", description: "First in your family to attend college." },
      { name: "dual_enrollment", label: "Dual Enrollment / Early College", type: "boolean" },
      { name: "rotc_jrotc", label: "ROTC / JROTC Participation", type: "boolean", description: "Military training — ROTC scholarships available." },
      { name: "cte_pathway", label: "CTE Pathway", component: Input, props: { placeholder: "e.g., EMT, welding, cybersecurity, nursing" }, description: "Career/Technical Education pathway." },
      { name: "honor_societies", label: "Honor Societies", component: Input, props: { placeholder: "e.g., NHS, Phi Theta Kappa" } },
      { name: "efc_sai_band", label: "EFC/SAI Band", component: Input, props: { placeholder: "Expected Family Contribution / Student Aid Index" } },
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
      geographic_designation: [],
      notes: "",
    },
    fields: [
      { name: "status", label: "Housing status", component: Input, props: { placeholder: "stable, homeless, transitional, etc." } },
      { name: "type", label: "Housing type", component: Input, props: { placeholder: "rent, own, shelter, etc." } },
      { name: "address", label: "Housing address (if different)", component: Textarea, props: { rows: 3 } },
      { name: "broadband_speed", label: "Broadband speed", component: Input, props: { placeholder: "e.g. 25/3 Mbps" } },
      { name: "geographic_designation", label: "Geographic designation (list)", component: Textarea, props: { rows: 2, placeholder: "Enter items separated by commas or new lines (e.g. rural, urban, frontier)" } },
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
    // Household size is already captured in Financial Situation; keep stored value but don't ask twice.
    hidden_fields: [
      {
        name: "household_size",
        note: "Household size is captured in “Financial Situation” to avoid redundancy.",
      },
    ],
    fields: [
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
      focus_areas: [],
      interests: [],
      keywords: [],
      notes: "",
    },
    fields: [
      { name: "focus_areas", label: "Focus areas (list)", component: Textarea, props: { rows: 2, placeholder: "Enter items separated by commas or new lines" } },
      { name: "interests", label: "Interests (list)", component: Textarea, props: { rows: 2, placeholder: "Enter items separated by commas or new lines" } },
      { name: "keywords", label: "Keywords (list)", component: Textarea, props: { rows: 2, placeholder: "Enter items separated by commas or new lines" } },
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

function buildMetadataSchema(meta) {
  return z.object(Object.fromEntries((meta?.fields ?? []).map((field) => [field.name, z.any().optional()])))
}

function fieldConfigFromMetadata(field, existingField) {
  const format = field.format ?? "text"
  const component = existingField?.component ?? (format === "long_text" || format === "json" ? Textarea : Input)
  const props = existingField?.props ?? (format === "long_text" || format === "json" ? { rows: 3 } : {})
  return {
    ...existingField,
    name: field.name,
    label: field.label,
    description: field.help,
    component,
    props,
    type: existingField?.type ?? (format === "boolean_tri" ? "boolean" : format === "json" ? "json" : undefined),
    format,
  }
}

// Enforce SECTION_METADATA as the single source of truth for titles, descriptions, schemas, and fields.
for (const [key, meta] of Object.entries(SECTION_METADATA)) {
  const existing = SECTION_CONFIG[key] ?? {}
  const existingFields = new Map((existing.fields ?? []).map((field) => [field.name, field]))
  const metadataFields = (meta.fields ?? []).map((field) => fieldConfigFromMetadata(field, existingFields.get(field.name)))
  SECTION_CONFIG[key] = {
    ...existing,
    title: meta.title,
    description: meta.description,
    schema: buildMetadataSchema(meta),
    defaults: Object.fromEntries(metadataFields.map((field) => [field.name, existing.defaults?.[field.name] ?? ""])),
    fields: metadataFields,
  }
}

export default function ProfileSectionEditor({
  open,
  sectionKey,
  initialData,
  focusField,
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
  const hiddenFields = Array.isArray(config?.hidden_fields) ? config.hidden_fields : []
  const metadataFieldNames = new Set((config?.fields ?? []).map((field) => field.name))
  const legacyEntries = Object.entries(initialData ?? {}).filter(([key]) => !metadataFieldNames.has(key))
  const [dropLegacyOnSave, setDropLegacyOnSave] = useState(true)
  const [aiStatus, setAiStatus] = useState('idle')
  const [aiError, setAiError] = useState(null)

  const form = useForm({
    resolver: config ? zodResolver(config.schema) : undefined,
    defaultValues: initialValues,
  })

  useEffect(() => {
    if (config) {
      form.reset({ ...defaults, ...(normalizeInitialData(config, initialData) ?? {}) })
      setDropLegacyOnSave(true)
      setAiStatus('idle')
      setAiError(null)
    }
  }, [config, defaults, initialData, form])

  // Deep-link focus: when opened via a "Fix in profile" link that names a
  // specific field, scroll it into view and focus it once the dialog mounts.
  useEffect(() => {
    if (!open || !config || !focusField) return
    const isKnownField = (config.fields ?? []).some((f) => f.name === focusField)
    if (!isKnownField) return
    const timer = setTimeout(() => {
      try { form.setFocus(focusField, { shouldSelect: true }) } catch { /* field not focusable yet */ }
    }, 150)
    return () => clearTimeout(timer)
  }, [open, config, focusField, form])

  const handleSubmit = form.handleSubmit((values) => {
    const legacyValues = dropLegacyOnSave ? {} : Object.fromEntries(legacyEntries)

    // Preserve structured condition metadata (icd10/stage/diagnosed_year) when the
    // editor only round-tripped condition names through the textarea. We merge parsed
    // names against the original stored conditions so additional fields are not lost.
    if (sectionKey === 'health_medical' && Array.isArray(values.conditions)) {
      const originalConditions = Array.isArray(initialData?.conditions) ? initialData.conditions : []
      const originalByName = new Map(
        originalConditions
          .filter((c) => c && typeof c === 'object' && typeof c.name === 'string')
          .map((c) => [c.name.trim().toLowerCase(), c]),
      )
      values = {
        ...values,
        conditions: values.conditions.map((c) => {
          const original = originalByName.get(String(c?.name || '').trim().toLowerCase())
          if (!original) return c
          return {
            ...original,
            ...c,
            // Prefer newly parsed values when present, otherwise fall back to original metadata.
            icd10: c.icd10 ?? original.icd10,
            stage: c.stage ?? original.stage,
            diagnosed_year: c.diagnosed_year ?? original.diagnosed_year,
          }
        }),
      }
    }

    onSave({ ...legacyValues, ...values })
  })

  const handleAskAI = async () => {
    if (!config || !onAskAI) return
    // Capture stable references before the async gap.
    const capturedConfig = config
    const currentValues = form.getValues()
    setAiStatus('loading')
    setAiError(null)
    try {
      const suggestion = await onAskAI(currentValues)
      // Guard: if section changed while awaiting, do nothing.
      if (config !== capturedConfig) return
      if (suggestion && typeof suggestion === 'object') {
        // Merge AI suggestion ON TOP of current user values so no existing data is erased.
        form.reset({ ...currentValues, ...suggestion })
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
      {/* Keep actions visible even for long forms */}
      <DialogContent data-flash-id="profile-section-editor" className="max-w-xl max-h-[85vh] overflow-hidden flex flex-col">
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

        {/* Scrollable body (native scrollbar/slider) */}
        <div className="flex-1 overflow-y-auto pr-1">
          {!config ? (
            <Alert variant="default">
              <Info className="w-4 h-4" />
              <AlertDescription className="text-sm text-slate-600">
                This section isn’t wired to a form yet. Close this dialog and use the “Edit section” button to update the
                JSON directly.
              </AlertDescription>
            </Alert>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {hiddenFields.length > 0 ? (
                <Alert variant="default">
                  <Info className="w-4 h-4" />
                  <AlertDescription className="text-sm text-slate-600">
                    <div className="font-medium text-slate-800">Some fields are captured in other sections</div>
                    <ul className="mt-1 list-disc list-inside space-y-1">
                      {hiddenFields.map((hf) => (
                        <li key={hf.name}>{hf.note || `${hf.name} captured elsewhere`}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              ) : null}

              {/* Register hidden fields so existing saved values are preserved on save */}
              {hiddenFields.map((hf) => (
                <Controller
                  key={hf.name}
                  control={form.control}
                  name={hf.name}
                  render={({ field: controllerField }) => (
                    <input
                      type="hidden"
                      name={controllerField.name}
                      value={
                        controllerField.value === null || controllerField.value === undefined
                          ? ""
                          : typeof controllerField.value === "string"
                            ? controllerField.value
                            : Array.isArray(controllerField.value)
                              ? JSON.stringify(controllerField.value)
                              : typeof controllerField.value === "object"
                                ? JSON.stringify(controllerField.value)
                                : String(controllerField.value)
                      }
                      onChange={(e) => controllerField.onChange(e.target.value)}
                    />
                  )}
                />
              ))}

              {legacyEntries.length > 0 ? (
                <details className="rounded-lg border border-amber-200 bg-amber-50/60 p-3">
                  <summary className="cursor-pointer text-sm font-medium text-amber-900">Legacy fields</summary>
                  <div className="mt-3 space-y-3 text-sm text-amber-900">
                    <p>These saved keys are not declared in SECTION_METADATA and will not be shown as editable inputs.</p>
                    <div className="flex items-center justify-between gap-3 rounded-md bg-white/70 p-2">
                      <Label htmlFor="drop-legacy-fields">Drop on save</Label>
                      <Switch id="drop-legacy-fields" checked={dropLegacyOnSave} onCheckedChange={setDropLegacyOnSave} />
                    </div>
                    <ul className="list-disc space-y-1 pl-5">
                      {legacyEntries.map(([key]) => (
                        <li key={key}>{key}</li>
                      ))}
                    </ul>
                  </div>
                </details>
              ) : null}

              {config.fields.map((field) => {
                if (field.type === 'boolean') {
                  return (
                    <div
                      className="flex items-center justify-between rounded-lg border border-slate-200 p-3"
                      key={field.name}
                    >
                      <div className="space-y-1">
                        <Label htmlFor={field.name} className="flex items-center gap-1">
                          <span>{field.label}</span>
                          {/* Goal 11 — surface "why we ask" from profileFieldUsageRegistry.
                              Unknown ids degrade silently inside FieldHelpTip. */}
                          <FieldHelpTip id={`${sectionKey}.${field.name}`} />
                        </Label>
                        {field.description && <p className="text-xs text-slate-500">{field.description}</p>}
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

                // Handle contacts field with custom UI
                if (field.type === 'contacts') {
                  return (
                    <div key={field.name}>
                      <Label>{field.label}</Label>
                      <Controller
                        control={form.control}
                        name={field.name}
                        render={({ field: controllerField }) => {
                          const contacts = Array.isArray(controllerField.value) ? controllerField.value : []
                          
                          const addContact = () => {
                            const newContact = {
                              name: "",
                              email: "",
                              role: "full_access",
                              addedDate: new Date().toISOString(),
                            }
                            controllerField.onChange([...contacts, newContact])
                          }
                          
                          const removeContact = (index) => {
                            const updated = contacts.filter((_, i) => i !== index)
                            controllerField.onChange(updated)
                          }
                          
                          const updateContact = (index, updates) => {
                            const updated = contacts.map((contact, i) => {
                              if (i !== index) return contact
                              const merged = { ...contact, ...updates }
                              // Ensure addedDate is always populated for downstream consumers.
                              if (!merged.addedDate) merged.addedDate = new Date().toISOString()
                              return merged
                            })
                            controllerField.onChange(updated)
                          }
                          
                          return (
                            <div className="space-y-3 mt-2">
                              {contacts.map((contact, index) => (
                                <div key={index} className="p-4 border border-slate-200 rounded-lg space-y-3">
                                  <div className="flex items-center justify-between">
                                    <span className="text-sm font-medium text-slate-700">Contact {index + 1}</span>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => removeContact(index)}
                                      disabled={isSaving || aiStatus === 'loading'}
                                    >
                                      <Trash2 className="w-4 h-4 text-red-600" />
                                    </Button>
                                  </div>
                                  <div className="grid grid-cols-1 gap-3">
                                    <div>
                                      <Label htmlFor={`contact-name-${index}`} className="text-xs">Name</Label>
                                      <Input
                                        id={`contact-name-${index}`}
                                        value={contact.name || ""}
                                        onChange={(e) => updateContact(index, { name: e.target.value })}
                                        placeholder="Contact name"
                                        disabled={isSaving || aiStatus === 'loading'}
                                      />
                                      {form.formState.errors?.contacts?.[index]?.name && (
                                        <p className="text-xs text-red-600 mt-1">{form.formState.errors.contacts[index].name.message}</p>
                                      )}
                                    </div>
                                    <div>
                                      <Label htmlFor={`contact-email-${index}`} className="text-xs">Email</Label>
                                      <Input
                                        id={`contact-email-${index}`}
                                        type="email"
                                        value={contact.email || ""}
                                        onChange={(e) => updateContact(index, { email: e.target.value })}
                                        placeholder="email@example.com"
                                        disabled={isSaving || aiStatus === 'loading'}
                                      />
                                    </div>
                                    <div>
                                      <Label htmlFor={`contact-role-${index}`} className="text-xs">Access Role</Label>
                                      <Select
                                        value={contact.role || "full_access"}
                                        onValueChange={(value) => updateContact(index, { role: value })}
                                        disabled={isSaving || aiStatus === 'loading'}
                                      >
                                        <SelectTrigger id={`contact-role-${index}`}>
                                          <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                          <SelectItem value="admin">Admin</SelectItem>
                                          <SelectItem value="full_access">Full Access</SelectItem>
                                          <SelectItem value="read_only">Read Only</SelectItem>
                                        </SelectContent>
                                      </Select>
                                    </div>
                                  </div>
                                </div>
                              ))}
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={addContact}
                                disabled={isSaving || aiStatus === 'loading'}
                                className="w-full"
                              >
                                <Plus className="w-4 h-4 mr-2" />
                                Add Contact
                              </Button>
                            </div>
                          )
                        }}
                      />
                      {form.formState.errors?.[field.name] && (
                        <p className="text-xs text-red-600 mt-1">{form.formState.errors[field.name]?.message}</p>
                      )}
                    </div>
                  )
                }

                // Use ProfileFieldWithAI for text fields to provide individual AI assistance
                return (
                  <div key={field.name}>
                    <Controller
                      control={form.control}
                      name={field.name}
                      render={({ field: controllerField }) => (
                        <ProfileFieldWithAI
                          field={field}
                          value={controllerField.value}
                          onChange={(newValue) => controllerField.onChange(newValue)}
                          onBlur={controllerField.onBlur}
                          name={controllerField.name}
                          inputRef={controllerField.ref}
                          disabled={isSaving || aiStatus === 'loading'}
                          profileId={profileId}
                          sectionKey={sectionKey}
                          formContext={form.getValues()}
                        />
                      )}
                    />
                    {form.formState.errors?.[field.name] && (
                      <p className="text-xs text-red-600 mt-1">{form.formState.errors[field.name]?.message}</p>
                    )}
                  </div>
                )
              })}
            </form>
          )}

          {aiError && (
            <Alert variant="destructive" className="mt-4">
              <AlertDescription className="text-sm">{aiError}</AlertDescription>
            </Alert>
          )}

          {aiStatus === 'succeeded' && (
            <Alert variant="default" className="mt-4">
              <AlertDescription className="text-sm text-blue-700">
                AI suggestion applied. Review and adjust before saving.
              </AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter className="flex items-center justify-between border-t border-slate-200 pt-4">
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
