/**
 * missingInfoTargets.js
 *
 * Single source of truth that maps a missing-info `key` (as emitted by
 * Hamilton's preflight / application_missing_info, or referenced by the AI
 * Profile Action Plan) to a concrete navigation target inside ProfileDetail:
 *   { tab, section, field, label }
 *
 * This is what turns a flat "Profile is missing first name" string into a
 * clickable deep-link that drops the user on the exact section editor where
 * they can fix it. Consumed by:
 *   - components/profiles/MissingInfoChecklist.jsx
 *   - components/hamilton/HamiltonTaskDrawer.jsx
 *   - components/profiles/PrintableProfileTodo.jsx
 *
 * `tab` matches the <Tabs value> used in pages/ProfileDetail.jsx.
 * `section` matches a profile_sections.section_key.
 * `field` (optional) is the field the section editor should scroll/focus.
 */

import { createPageUrl } from "@/utils"

export const MISSING_INFO_TARGETS = {
  // ── basic_information (the "Profile Information" tab) ──────────────
  full_name: { tab: "profile", section: "basic_information", field: "full_name", label: "Full name" },
  first_name: { tab: "profile", section: "basic_information", field: "first_name", label: "First name" },
  middle_name: { tab: "profile", section: "basic_information", field: "middle_name", label: "Middle name" },
  last_name: { tab: "profile", section: "basic_information", field: "last_name", label: "Last name" },
  email: { tab: "profile", section: "basic_information", field: "email", label: "Email address" },
  phone: { tab: "profile", section: "basic_information", field: "phone", label: "Phone number" },
  website: { tab: "profile", section: "basic_information", field: "website", label: "Website" },
  address: { tab: "profile", section: "basic_information", field: "address", label: "Mailing address" },
  city: { tab: "profile", section: "basic_information", field: "city", label: "City" },
  state: { tab: "profile", section: "basic_information", field: "state", label: "State" },
  zip: { tab: "profile", section: "basic_information", field: "zip", label: "ZIP code" },

  // ── financial_information ─────────────────────────────────────────
  household_income: { tab: "profile", section: "financial_information", field: "household_income", label: "Household income" },
  fafsa_efc: { tab: "profile", section: "financial_information", field: "fafsa_efc", label: "FAFSA EFC / SAI" },

  // ── education / school ────────────────────────────────────────────
  // university_applications has no modal section editor — the "universities"
  // tab owns that UI — so these deep-link to the tab, not a section editor.
  school_name: { tab: "universities", section: "university_applications", field: "name", label: "School / university" },
  major: { tab: "universities", section: "university_applications", field: "major", label: "Program / major" },

  // ── documents ─────────────────────────────────────────────────────
  // documents are managed on the "documents" tab, not as a profile_section.
  transcript: { tab: "documents", section: "documents", isDocument: true, label: "Transcript" },
  personal_statement: { tab: "documents", section: "documents", isDocument: true, label: "Personal statement / essay" },
}

/**
 * Sections that have a real modal editor in ProfileSectionEditor's
 * SECTION_CONFIG. Deep-links only pass a `section` query param for these;
 * for everything else (documents, university_applications) the link just
 * switches tabs so we never pop the raw-JSON "unmapped section" fallback.
 */
export const EDITABLE_SECTIONS = new Set([
  "basic_information", "organization_details", "financial_information",
  "government_assistance", "health_medical", "medical_insurance", "medical_history",
  "nonprofit_compliance", "small_business_details", "demographics", "education",
  "employment", "housing", "family", "programs_services", "family_life",
  "military_service", "occupation", "location_focus", "narrative",
])

/**
 * Section-level fallback so an AI todo item that only knows its target
 * SECTION (not a specific field) can still deep-link. Keys are
 * profile_sections.section_key values.
 */
export const SECTION_TAB_MAP = {
  basic_information: "profile",
  demographics: "profile",
  financial_information: "profile",
  education: "profile",
  employment: "profile",
  health_medical: "profile",
  housing: "profile",
  narrative: "profile",
  additional: "profile",
  university_applications: "universities",
  documents: "documents",
}

function normalizeKey(key) {
  return String(key || "").trim().toLowerCase().replace(/[\s-]+/g, "_")
}

/**
 * Resolve a missing-info key (or a raw section key) to a navigation target.
 * Returns null when the key is not a profile-fillable field (e.g. portal
 * login, funder mailing address, application fee — those live on the funding
 * opportunity / authorizations, not the profile, so there is nowhere on the
 * profile to deep-link to).
 */
export function resolveMissingInfoTarget(key) {
  const k = normalizeKey(key)
  if (!k) return null
  if (MISSING_INFO_TARGETS[k]) return { key: k, ...MISSING_INFO_TARGETS[k] }
  // Allow callers to pass a bare section key.
  if (SECTION_TAB_MAP[k]) return { key: k, tab: SECTION_TAB_MAP[k], section: k, field: null, label: null }
  return null
}

/**
 * Build a ProfileDetail deep-link URL for a missing-info key.
 * Returns null when the key has no profile target.
 */
export function buildProfileSectionLink(profileId, key) {
  if (!profileId) return null
  const target = resolveMissingInfoTarget(key)
  if (!target) return null
  // Only pass section/field when the section has a real modal editor; otherwise
  // just switch tabs so we never open the raw-JSON "unmapped section" fallback.
  const editable = target.section && EDITABLE_SECTIONS.has(target.section)
  return createPageUrl("ProfileDetail", {
    id: profileId,
    tab: target.tab,
    section: editable ? target.section : undefined,
    field: editable ? target.field || undefined : undefined,
  })
}

export default { MISSING_INFO_TARGETS, SECTION_TAB_MAP, resolveMissingInfoTarget, buildProfileSectionLink }
