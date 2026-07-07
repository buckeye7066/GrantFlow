/**
 * Profile Field Prompts (Architecture P1: Missing High-Value Field Prompts)
 *
 * Surfaces the HIGH-VALUE profile fields that — if filled — would unlock or
 * sharpen this profile's funding matches. These are PROMPTS, not gates: per
 * canonical rule G4, a missing field is never used to hard-reject a profile or
 * an opportunity. It is only ever surfaced as an encouraging "complete X to
 * improve your matches" nudge that deep-links to the relevant profile section.
 *
 * The contract for each prompt is intentionally small and UI-friendly:
 *
 *   { field, label, why, section_key }
 *
 *   - field       machine id (stable, for dedupe / dismissal keys)
 *   - label       short call-to-action ("Add your state or ZIP code")
 *   - why         plain-language reason it helps (no jargon)
 *   - section_key profile section to deep-link to (ProfileDetail ?section=…),
 *                 or null when it lives outside the section editor (Documents)
 *
 * This helper is purely additive: it reads the same source data the readiness /
 * matching-gaps helpers read, and returns a prioritized list. It never throws —
 * a DB hiccup yields an empty prompt list so the matching response degrades
 * gracefully rather than failing.
 */

// Organization-vs-student classification is derived from the single source of
// truth in shared/profileSectionApplicability.js, so a new profile type is
// recognised here the moment it is added to the curated list — no second
// hardcoded set to drift (the old ORG_PROFILE_TYPES/STUDENT_PROFILE_TYPES only
// covered ~10 of the 54 types, so org types like county_government got no
// org-status prompt).
import {
  isOrganizationProfileType,
  isStudentProfileType,
} from '../../shared/profileSectionApplicability.js'
import { shouldAskProfileQuestion } from './profileKnownFacts.js'

function normType(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_')
}

function safeArr(value) {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return []
    try {
      const parsed = JSON.parse(trimmed)
      return Array.isArray(parsed) ? parsed : [trimmed]
    } catch {
      return [trimmed]
    }
  }
  return []
}

function nonEmpty(value) {
  if (value === null || value === undefined) return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'string') return value.trim().length > 0
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0
  return Boolean(value)
}

/**
 * Load the profile row + parsed sections. Tolerant of missing tables/columns.
 *
 * @returns {Promise<{ profile: object|null, sections: Record<string, object> }>}
 */
async function loadProfileAndSections(db, profileId) {
  if (!db || !profileId) return { profile: null, sections: {} }

  let profile = null
  try {
    profile = await db.prepare('SELECT * FROM profiles WHERE id = ? LIMIT 1').get(String(profileId))
  } catch {
    profile = null
  }

  let sectionRows = []
  try {
    sectionRows = await db
      .prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?')
      .all(String(profileId))
  } catch {
    sectionRows = []
  }

  const sections = (sectionRows || []).reduce((acc, row) => {
    try {
      acc[row.section_key] = row.data ? JSON.parse(row.data) : {}
    } catch {
      acc[row.section_key] = {}
    }
    return acc
  }, {})

  return { profile, sections }
}

/**
 * Derive the missing HIGH-VALUE field prompts for a profile.
 *
 * @param {object} db        DB handle (sqlite/pg shim)
 * @param {string} profileId
 * @returns {Promise<Array<{ field: string, label: string, why: string, section_key: string|null }>>}
 */
export async function getProfileFieldPrompts(db, profileId) {
  try {
    const { profile, sections } = await loadProfileAndSections(db, profileId)
    if (!profile) return []

    const basic = sections.basic_information ?? {}
    const orgDetails = sections.organization_details ?? {}
    const nonprofitCompliance = sections.nonprofit_compliance ?? {}
    const demographics = sections.demographics ?? {}
    const financial = sections.financial_information ?? {}
    const narrative = sections.narrative ?? {}
    const programsServices = sections.programs_services ?? {}
    const education = sections.education ?? {}
    const locationFocus = sections.location_focus ?? {}

    const applicantType =
      profile.applicant_type ??
      profile.primary_type ??
      profile.primary_profile_type ??
      basic.profile_category ??
      null
    const isOrg = isOrganizationProfileType(applicantType)
    const isStudent = isStudentProfileType(applicantType)

    const prompts = []

    // ── 1. Applicant / org type (critical — unlocks the right funding pool) ──
    if (!nonEmpty(applicantType)) {
      prompts.push({
        field: 'applicant_type',
        label: 'Tell us who you are',
        why: 'Knowing whether you are an individual, family, nonprofit, school, or business lets us point you at the right pool of funders.',
        section_key: 'basic_information',
      })
    }

    // ── 2. Location (state / ZIP) — unlocks state, county & regional grants ──
    const state = basic.state || locationFocus.state || profile.state || null
    const zip =
      basic.zip_code || basic.zip || locationFocus.zip || profile.postal_code || profile.zip || profile.zip_code || null
    if (!nonEmpty(state) && !nonEmpty(zip)) {
      prompts.push({
        field: 'state_zip',
        label: 'Add your state or ZIP code',
        why: 'Lots of funding is local. Your state or ZIP unlocks state, county, and regional opportunities you would otherwise miss.',
        section_key: 'basic_information',
      })
    }

    // ── 3. What you need (focus / goal) — drives the whole match engine ──────
    const hasNeed = Boolean(
      narrative.primary_goal ||
        narrative.mission ||
        narrative.target_population ||
        safeArr(programsServices.focus_areas).length ||
        safeArr(programsServices.keywords).length ||
        safeArr(programsServices.interests).length ||
        safeArr(profile.keywords).length ||
        safeArr(profile.interests).length ||
        safeArr(profile.tags).length,
    )
    if (!hasNeed) {
      prompts.push({
        field: 'primary_need',
        label: 'Describe what you need funding for',
        why: 'A short goal or focus area (like "repair our roof" or "youth programs") is what we search for — it powers every match.',
        section_key: 'narrative',
      })
    }

    // ── 4. Organization / tax status (orgs only) — EIN / 501(c)(3) / org type ─
    if (isOrg) {
      // The org type is already known from the profile's applicant/primary type
      // (the user picks "Nonprofit", "Business", etc. at creation), so we never
      // nag for it again — only a genuinely missing tax id / status prompts.
      const hasOrgType = nonEmpty(
        applicantType || orgDetails.organization_type || orgDetails.legal_form || basic.organization_type,
      )
      // EIN / UEI may be saved under Organization Details OR Nonprofit Compliance.
      const hasTaxId = nonEmpty(
        orgDetails.ein || orgDetails.uei || nonprofitCompliance.ein || nonprofitCompliance.uei || basic.ein,
      )
      // 501(c)(3) status is captured as boolean toggles (public charity /
      // private foundation / confirmed) in either section, alongside any
      // free-form tax-exempt / tax-status text. Check ALL of them so a filled
      // nonprofit is not told to "add tax details" it already provided.
      const hasTaxStatus = nonEmpty(
        nonprofitCompliance.tax_exempt_status ||
          nonprofitCompliance.tax_status ||
          nonprofitCompliance.is_501c3 ||
          nonprofitCompliance.is_501c3_public_charity ||
          nonprofitCompliance.is_501c3_private_foundation ||
          orgDetails.tax_exempt_status ||
          orgDetails.tax_status ||
          orgDetails.is_501c3 ||
          orgDetails.is_501c3_public_charity ||
          orgDetails.is_501c3_private_foundation,
      )
      if (!hasOrgType || !hasTaxId || !hasTaxStatus) {
        prompts.push({
          field: 'org_status',
          label: 'Add your organization & tax details',
          why: 'Your EIN, UEI, and 501(c)(3) or tax status unlock grants that are restricted to registered organizations — a large share of funding.',
          section_key: isOrg && nonEmpty(nonprofitCompliance) ? 'nonprofit_compliance' : 'organization_details',
        })
      }
    }

    // ── 5. Student aid signals (students/individuals) — FAFSA / Pell ─────────
    if (isStudent) {
      const hasAid = nonEmpty(
        education.fafsa_status || education.pell_eligible || education.enrollment_status || education.school_type,
      )
      if (!hasAid) {
        prompts.push({
          field: 'student_aid',
          label: 'Share your student status',
          why: 'Whether you have filed the FAFSA, qualify for a Pell Grant, or your enrollment level opens up scholarships and student aid built for you.',
          section_key: 'education',
        })
      }
    }

    // ── 6. Eligibility traits (income / demographics) — targeted funding ─────
    const hasEligibilityTraits = Boolean(
      financial.household_income ||
        financial.annual_revenue ||
        demographics.veteran_status ||
        demographics.minority_owned ||
        demographics.disability ||
        demographics.lgbtq ||
        demographics.immigrant_status,
    )
    if (!hasEligibilityTraits) {
      prompts.push({
        field: 'eligibility_traits',
        label: 'Add eligibility details',
        why: 'Facts like income range, veteran status, or being minority-owned unlock targeted funding that generic profiles never see.',
        section_key: 'demographics',
      })
    }

    // ── 7. Budget / amount needed — avoids too-small / too-large matches ─────
    const hasBudget = Boolean(
      financial.funding_amount_needed ||
        narrative.funding_amount_needed ||
        narrative.amount_requested ||
        orgDetails.annual_budget,
    )
    if (!hasBudget) {
      prompts.push({
        field: 'funding_amount',
        label: 'Tell us how much you need',
        why: 'Funders filter by award size. A rough amount keeps us from showing grants that are far too small or too large for you.',
        section_key: 'financial_information',
      })
    }

    // Known-facts choke point (profileKnownFacts.js): the per-field checks
    // above are the first line; this net drops any prompt whose fact is
    // already answered under an ALIAS spelling the checks above don't read
    // (e.g. ZIP stored as location_focus.zip_code by the gap interview), and
    // any prompt that doesn't apply to this profile's org/person side.
    const factCtx = { profile, sections }
    return prompts.filter((p) => shouldAskProfileQuestion(p.field, factCtx))
  } catch {
    // Never let prompt derivation break the matching response.
    return []
  }
}

export const __testables = { normType, isOrganizationProfileType, isStudentProfileType }
