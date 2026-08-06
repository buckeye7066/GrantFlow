/**
 * pricingRules.js
 *
 * Two pure-function decision tables:
 *
 *   1. determineClientCategory({ profile, intakeAnswers, organization })
 *      → which billing category the client falls into.
 *
 *   2. recommendServices({ clientCategory, profile, intakeAnswers, matches })
 *      → which catalog services Anya should suggest, with reasons + confidence.
 *
 * Neither function reads the DB. Both return structured output that
 * pricingEngine.js consumes.
 */

import {
  CLIENT_CATEGORIES,
  CLIENT_CATEGORY_BUDGET_THRESHOLDS,
  CLIENT_CATEGORY_CONFIDENCE,
  SERVICE_KEYS,
} from './pricingTypes.js'
import {
  profileTypeToClientCategory,
  orgCategoryForBudget,
  parseAnnualBudget,
} from '../../../shared/profileTypeToClientCategory.js'
import { STRONG_MATCH_SCORE } from '../../config/matchThresholds.js'

const { INDIVIDUAL, SMALL, MID_SIZE, LARGE } = CLIENT_CATEGORIES
const { HIGH, ESTIMATED, NEEDS_ADMIN_REVIEW } = CLIENT_CATEGORY_CONFIDENCE

const ORG_PROFILE_TYPES = new Set([
  'nonprofit',
  'ministry',
  'church',
  'school',
  'volunteer_fire_department',
  'small_business',
  'business',
  'organization',
  'other_organization',
])

// The shared mapper returns the 4-code 'mid'; the pricing-engine return shape
// uses the longer 'mid_size'. Map back so quote line items keep their labels.
const SHARED_TO_ENGINE_CATEGORY = Object.freeze({
  individual: INDIVIDUAL,
  small: SMALL,
  mid: MID_SIZE,
  large: LARGE,
})

/**
 * The billing client category is derived from the profile TYPE taxonomy via
 * the single shared mapper (shared/profileTypeToClientCategory.js), so the
 * tier a user is billed/entitled at always matches their profile type. This
 * function layers the pricing-engine's confidence / reason / missing-field
 * metadata on top of that one categorisation decision.
 *
 * @returns {{
 *   client_category: string,
 *   confidence: string,
 *   reason: string,
 *   missing_fields: string[],
 * }}
 */
export function determineClientCategory({
  profile = {},
  intakeAnswers = {},
  organization = {},
} = {}) {
  const missing = []
  const profileType = String(
    profile.primary_type || profile.profile_type || profile.applicant_type ||
    intakeAnswers.profile_type || '',
  ).toLowerCase()
  const orgSubtype =
    organization.org_subtype || organization.nonprofit_type ||
    profile.org_subtype || profile.nonprofit_type || ''

  const annualBudget = parseAnnualBudget(
    pickFirstDefined([
      organization.annual_budget,
      profile.annual_budget,
      intakeAnswers.annual_budget,
      intakeAnswers.budget,
    ]),
  )

  // ── The single categorisation decision (shared SoT) ───────────────────────
  const sharedCategory = profileTypeToClientCategory({
    primaryType: profileType,
    orgSubtype,
    annualBudget,
  })
  const clientCategory = SHARED_TO_ENGINE_CATEGORY[sharedCategory] || SMALL

  // Individual tier — high confidence, nothing missing.
  if (clientCategory === INDIVIDUAL) {
    return {
      client_category: INDIVIDUAL,
      confidence: HIGH,
      reason: profileType
        ? `Profile type "${profileType}" maps to the Individual billing category.`
        : 'No organization signals — defaulting to the Individual billing category.',
      missing_fields: [],
    }
  }

  // ── Organization tiers — annotate the budget-derived band ─────────────────
  if (annualBudget !== null) {
    const band = orgCategoryForBudget(annualBudget)
    const reason =
      band === 'small'
        ? `Annual budget $${annualBudget.toLocaleString()} is below the $${CLIENT_CATEGORY_BUDGET_THRESHOLDS.small_max.toLocaleString()} small-org threshold.`
        : band === 'mid'
          ? `Annual budget $${annualBudget.toLocaleString()} falls in the $${CLIENT_CATEGORY_BUDGET_THRESHOLDS.small_max.toLocaleString()}–$${CLIENT_CATEGORY_BUDGET_THRESHOLDS.mid_size_max.toLocaleString()} mid-size band.`
          : `Annual budget $${annualBudget.toLocaleString()} is above the $${CLIENT_CATEGORY_BUDGET_THRESHOLDS.mid_size_max.toLocaleString()} mid-size cap.`
    return { client_category: clientCategory, confidence: HIGH, reason, missing_fields: missing }
  }

  // Budget unknown — the shared mapper defaulted org → small.
  missing.push('annual_budget')

  if (ORG_PROFILE_TYPES.has(profileType) || orgSubtype) {
    const looksSmall = looksLikeSmallOrLocalOrg({ profile, intakeAnswers, organization })
    return {
      client_category: clientCategory,
      confidence: looksSmall ? ESTIMATED : NEEDS_ADMIN_REVIEW,
      reason: looksSmall
        ? 'Annual budget unknown but profile signals (size, locality, narrative) suggest a small/local organization.'
        : 'Annual budget unknown and no small-org signals found — defaulting to Small Org for the quote and flagging for admin review.',
      missing_fields: missing,
    }
  }

  // Profile type unknown entirely AND it resolved to an org tier (only happens
  // when an org sub-type was supplied without a recognised type). Flag it.
  return {
    client_category: clientCategory,
    confidence: NEEDS_ADMIN_REVIEW,
    reason:
      'Profile type and annual budget are both unknown. Defaulted to Small Org and flagged for admin review.',
    missing_fields: ['profile_type', 'annual_budget'],
  }
}

/**
 * Return the first candidate that is not null/undefined/'' (preserves 0).
 */
function pickFirstDefined(candidates) {
  for (const c of candidates) {
    if (c !== null && c !== undefined && c !== '') return c
  }
  return null
}

function looksLikeSmallOrLocalOrg({ profile, intakeAnswers, organization }) {
  const counts = pickFiniteNumber([
    organization.staff_count,
    organization.employee_count,
    intakeAnswers.employee_count,
    profile.employee_count,
  ])
  if (counts !== null && counts < 25) return true

  const locationOnly = Boolean(
    profile.city || intakeAnswers.location_city || organization.city,
  )
  const noNationalScope = !(
    profile.is_national ||
    intakeAnswers.is_national ||
    organization.is_national
  )
  return locationOnly && noNationalScope
}

function pickFiniteNumber(candidates) {
  for (const c of candidates) {
    const n = typeof c === 'string' ? Number(c.replace(/[$,\s]/g, '')) : Number(c)
    if (Number.isFinite(n) && n >= 0) return n
  }
  return null
}

// ────────────────────────────────────────────────────────────────────────────
// Service recommendation rules
// ────────────────────────────────────────────────────────────────────────────

const FEDERAL_SIGNALS = ['federal', 'sam.gov', 'grants.gov', 'cdfa', 'dhs', 'doe', 'usda', 'hhs']

/**
 * @returns {{
 *   recommended_package_name: string,
 *   line_items: Array<{
 *     service_key: string,
 *     quantity: number,
 *     reason: string,
 *     confidence: number,
 *   }>,
 *   reasons: string[],
 *   missing_pricing_inputs: string[],
 *   admin_review_required: boolean,
 * }}
 */
export function recommendServices({
  clientCategory,
  profile = {},
  intakeAnswers = {},
  matches = [],
} = {}) {
  const reasons = []
  const missing = []
  const lineItems = []
  let adminReviewRequired = false

  const matchCount = Array.isArray(matches) ? matches.length : 0
  const strongMatches = (matches || []).filter((m) => {
    const decision = String(m.match_decision ?? m.decision ?? '').trim().toUpperCase()
    const score = Number(m.match_score ?? m.score)
    return decision === 'ACCEPT' && Number.isFinite(score) && score >= STRONG_MATCH_SCORE
  })
  const profileType = String(profile.primary_type || profile.profile_type || intakeAnswers.profile_type || '').toLowerCase()
  const wantsResearchOnly = Boolean(
    intakeAnswers.wants_research_only ||
    intakeAnswers.preferred_help_types?.includes?.('research') ||
    intakeAnswers.preferred_help_types?.includes?.('eligibility_check'),
  )
  const wantsApplicationHelp = Boolean(
    intakeAnswers.wants_application_help ||
    intakeAnswers.preferred_help_types?.includes?.('application_help'),
  )
  const hasDraft = Boolean(intakeAnswers.has_draft || intakeAnswers.existing_proposal)
  const wantsBudgetModel = Boolean(intakeAnswers.needs_budget || intakeAnswers.needs_logic_model)
  const postAward = Boolean(intakeAnswers.already_funded || intakeAnswers.needs_compliance_reporting)
  const wantsCalendar = Boolean(intakeAnswers.wants_calendar || matchCount >= 3)
  const isStudentTransfer =
    profileType === 'student' && Boolean(intakeAnswers.is_transfer_student || intakeAnswers.transfer_scholarship_signal)
  const requestedAmount = pickFiniteNumber([
    intakeAnswers.amount_requested,
    intakeAnswers.amount,
    profile.amount_requested,
  ])
  const matchedAmountMax = (matches || [])
    .map((m) => Number(m.amount_max || m.amount_high || 0))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => b - a)[0] || null
  const headlineAmount = requestedAmount ?? matchedAmountMax

  const looksFederalOrComplex = (matches || []).some((m) => {
    const txt = `${m.title || ''} ${m.sponsor || ''} ${m.source || ''} ${m.url || ''}`.toLowerCase()
    return FEDERAL_SIGNALS.some((sig) => txt.includes(sig)) || Boolean(m.is_federal)
  }) || Boolean(intakeAnswers.is_federal_application) || (headlineAmount !== null && headlineAmount > 250000)

  // ── A. Research-only / early exploration ───────────────────────────────────
  if (wantsResearchOnly && !wantsApplicationHelp && !hasDraft) {
    if (matchCount >= 8 || intakeAnswers.broad_landscape) {
      lineItems.push({
        service_key: SERVICE_KEYS.COMPREHENSIVE_FUNDING_DOSSIER,
        quantity: 1,
        reason: 'User wants to explore the full funding landscape and there are many candidate matches.',
        confidence: 0.9,
      })
      reasons.push('Broad landscape requested — Comprehensive Funding Dossier.')
    } else {
      lineItems.push({
        service_key: SERVICE_KEYS.QUICK_ELIGIBILITY_SCAN,
        quantity: 1,
        reason: 'User wants a quick read on what they qualify for before committing to an application.',
        confidence: 0.9,
      })
      reasons.push('Research-only intent — Quick Eligibility Scan.')
    }
  }

  // ── B. Strong matches + needs prioritization ───────────────────────────────
  if (!wantsResearchOnly && strongMatches.length > 0 && !hasDraft && !postAward) {
    if (lineItems.length === 0 || (intakeAnswers.wants_strategy ?? false)) {
      lineItems.push({
        service_key: SERVICE_KEYS.APPLICATION_STRATEGY_SESSION,
        quantity: 1,
        reason: `${strongMatches.length} strong matches — a strategy session helps prioritize and sequence applications.`,
        confidence: 0.75,
      })
      reasons.push('Strong matches — Application Strategy Session.')
    }
  }

  // ── C. Application help ────────────────────────────────────────────────────
  if (wantsApplicationHelp && !hasDraft) {
    if (looksFederalOrComplex) {
      lineItems.push({
        service_key: SERVICE_KEYS.COMPLEX_FEDERAL_APPLICATION,
        quantity: 1,
        reason:
          headlineAmount && headlineAmount > 250000
            ? `Application target $${headlineAmount.toLocaleString()} qualifies as complex/federal.`
            : 'Federal/large-foundation signals detected in matches or intake.',
        confidence: 0.85,
      })
      reasons.push('Complex/federal scope — Complex/Federal Application.')
    } else if (headlineAmount !== null && headlineAmount < 5000) {
      lineItems.push({
        service_key: SERVICE_KEYS.MICRO_GRANT_APPLICATION,
        quantity: 1,
        reason: `Target amount $${headlineAmount.toLocaleString()} fits the under-$5K micro-grant tier.`,
        confidence: 0.85,
      })
      reasons.push('Under-$5K target — Micro-Grant Application.')
    } else if (headlineAmount === null) {
      missing.push('amount_requested')
      lineItems.push({
        service_key: SERVICE_KEYS.STANDARD_FOUNDATION_APPLICATION,
        quantity: 1,
        reason: 'Application help requested but no target amount captured — defaulted to Standard Foundation Application; flagged for admin review.',
        confidence: 0.4,
      })
      adminReviewRequired = true
      reasons.push('Application help with unknown amount — defaulted to Standard Foundation Application; needs admin review.')
    } else {
      lineItems.push({
        service_key: SERVICE_KEYS.STANDARD_FOUNDATION_APPLICATION,
        quantity: 1,
        reason: `Target amount $${headlineAmount.toLocaleString()} fits the $5K–$250K foundation tier.`,
        confidence: 0.8,
      })
      reasons.push('Foundation-tier target — Standard Foundation Application.')
    }
  }

  // ── D. Student transfer scholarships ───────────────────────────────────────
  if (isStudentTransfer) {
    lineItems.push({
      service_key: SERVICE_KEYS.TRANSFER_SCHOLARSHIP_PACK,
      quantity: 1,
      reason: 'Student profile with transfer-scholarship intent — coordinate multi-school applications.',
      confidence: 0.9,
    })
    reasons.push('Transfer student — Transfer Scholarship Pack.')
  }

  // ── E. Existing draft ──────────────────────────────────────────────────────
  if (hasDraft) {
    lineItems.push({
      service_key: SERVICE_KEYS.EDITING_REDRAFT,
      quantity: 1,
      reason: 'User already has a draft and wants improvement — edit and align with scoring rubric.',
      confidence: 0.9,
    })
    reasons.push('Existing draft — Editing & Redraft Service.')
  }

  // ── F. Budget / logic model ────────────────────────────────────────────────
  if (wantsBudgetModel) {
    lineItems.push({
      service_key: SERVICE_KEYS.BUDGET_LOGIC_MODEL,
      quantity: 1,
      reason: 'User needs a standalone budget and/or logic model.',
      confidence: 0.85,
    })
    reasons.push('Budget / logic-model gap — Budget & Logic Model Development.')
  }

  // ── G. Post-award ──────────────────────────────────────────────────────────
  if (postAward) {
    lineItems.push({
      service_key: SERVICE_KEYS.COMPLIANCE_REPORTING,
      quantity: 1,
      reason: 'User has already received funding and needs ongoing reporting / compliance support.',
      confidence: 0.9,
    })
    reasons.push('Post-award support — Compliance Reporting & Management.')
  }

  // ── H. Deadline tracking ───────────────────────────────────────────────────
  if (wantsCalendar) {
    lineItems.push({
      service_key: SERVICE_KEYS.GRANT_CALENDAR,
      quantity: 1,
      reason:
        matchCount >= 3
          ? `${matchCount} matched opportunities — a single calendar prevents missed deadlines.`
          : 'User asked to track multiple deadlines.',
      confidence: 0.7,
    })
    reasons.push('Multiple deadlines — Grant Calendar Setup & Management.')
  }

  // ── I. Fallback ────────────────────────────────────────────────────────────
  if (lineItems.length === 0) {
    lineItems.push({
      service_key: SERVICE_KEYS.HOURLY_CONSULTATION,
      quantity: Number(intakeAnswers.estimated_hours) > 0 ? Number(intakeAnswers.estimated_hours) : 1,
      reason:
        'No clear single-package fit — start with hourly advisory while scope is clarified.',
      confidence: 0.4,
    })
    adminReviewRequired = true
    reasons.push('Unclear scope — defaulted to Hourly Consultation; flagged for admin review.')
  }

  const recommendedPackageName = lineItems.length === 1 ? '' : `Custom GrantFlow Package (${lineItems.length} services)`

  // Sanity: warn if client category is missing/unknown
  if (!Object.values(CLIENT_CATEGORIES).includes(clientCategory)) {
    adminReviewRequired = true
    missing.push('client_category')
    reasons.push(`Unknown client category "${clientCategory}" — flagged for admin review.`)
  }

  return {
    recommended_package_name: recommendedPackageName,
    line_items: lineItems,
    reasons,
    missing_pricing_inputs: missing,
    admin_review_required: adminReviewRequired,
  }
}
