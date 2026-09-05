/**
 * Anya next-step guidance service.
 *
 * Purpose:
 *   Convert a match result + profile coverage + application state into a
 *   small, stable list of plain-language recommendations that Anya can read
 *   aloud ("Here's what to do next") and that the UI can render as a
 *   checklist/CTAs.
 *
 * Mission-audit drivers:
 *   - Anya must explain why a result appeared.
 *   - Anya must tell a returning user what to do next — complete a missing
 *     profile section, verify location, review a deadline, open the apply
 *     URL, save to pipeline, start an application, or upload supporting docs.
 *   - Zero-result experiences must be softened with concrete next steps.
 *
 * This module is pure: no DB calls, no mutation. Callers pass the facts and
 * receive the list. Keeps guidance traceable and reversible (logged, small).
 */

import { computeProfileCoverage } from './profileCoverage.js'
import { pickRealUrl, isPlaceholderUrl } from '../config/urlRules.js'

/**
 * @typedef {Object} NextStep
 * @property {string} id          machine id ('verify_deadline')
 * @property {string} category    grouping: 'profile' | 'application' | 'opportunity' | 'discovery'
 * @property {string} priority    'critical' | 'high' | 'normal' | 'low'
 * @property {string} label       short UI label
 * @property {string} detail      plain-language explanation for Anya
 * @property {string} [action]    CTA hint ('open_url' | 'save_to_pipeline' | 'edit_profile' ...)
 * @property {string} [href]      URL target (only for open_url actions)
 * @property {object} [meta]      extra fields for the UI (section key, field key, etc.)
 */

const LOW_SCORE_THRESHOLD = 40
const FALLBACK_COVERAGE_THRESHOLD = 0.5

function ensureArray(v) { return Array.isArray(v) ? v : [] }

function deadlineIsSoon(deadline) {
  if (!deadline) return false
  try {
    const d = new Date(deadline).getTime()
    if (!Number.isFinite(d)) return false
    const days = (d - Date.now()) / (24 * 3600 * 1000)
    return days >= 0 && days <= 14
  } catch { return false }
}

/**
 * Produce next-step guidance for a specific opportunity match.
 *
 * @param {object} args
 * @param {object} args.profile                normalized profile (or raw)
 * @param {object} [args.rawSections]          raw profile sections keyed by section_key
 * @param {object} args.opportunity            opportunity row
 * @param {object} [args.matchExplain]         match_explain block from matchEngine
 * @param {number} [args.score]                0-100 score
 * @param {object} [args.application]          optional application row (state machine row)
 * @returns {{ steps: NextStep[], rationale: string[], coverage: object }}
 */
export function buildNextStepsForMatch({
  profile,
  rawSections = null,
  opportunity,
  matchExplain = null,
  score = null,
  application = null,
} = {}) {
  const steps = []
  const rationale = []
  const coverage = computeProfileCoverage(profile || {}, rawSections)

  if (coverage.coverage < FALLBACK_COVERAGE_THRESHOLD) {
    rationale.push(
      `Profile is ${Math.round(coverage.coverage * 100)}% complete — match confidence is limited until we know more.`
    )
    for (const s of coverage.suggestions.slice(0, 3)) {
      steps.push({
        id: `complete_profile.${s.key}`,
        category: 'profile',
        priority: 'high',
        label: `Add ${s.label}`,
        detail: s.action,
        action: 'edit_profile',
        meta: { section: s.section, field: s.key },
      })
    }
  }

  const realUrl = pickRealUrl(opportunity || {})
  const oppUrlIsReal = Boolean(realUrl) && !isPlaceholderUrl(realUrl)
  const isInformational = !oppUrlIsReal
  const hasDeadline = Boolean(opportunity?.deadline)
  const isExpired =
    hasDeadline &&
    Number.isFinite(new Date(opportunity.deadline).getTime()) &&
    new Date(opportunity.deadline).getTime() < Date.now()
  const isLoan = Boolean(opportunity?.is_loan)

  if (isExpired) {
    rationale.push('Opportunity deadline has passed — it is shown for research/context only.')
    steps.push({
      id: 'find_similar',
      category: 'discovery',
      priority: 'normal',
      label: 'Find similar active opportunities',
      detail:
        'This grant is past its deadline. Let Anya search for similar active opportunities based on this grant\'s categories.',
      action: 'search_similar',
      meta: { categories: ensureArray(opportunity?.categories) },
    })
  } else if (deadlineIsSoon(opportunity?.deadline)) {
    rationale.push('Deadline is within 14 days — elevate this to "apply now" in your pipeline.')
    steps.push({
      id: 'verify_deadline',
      category: 'opportunity',
      priority: 'critical',
      label: `Confirm deadline (${opportunity.deadline})`,
      detail: 'The deadline is close. Verify it on the funder site and schedule your application work.',
      action: 'open_url',
      href: realUrl || opportunity?.source_url || null,
    })
  }

  if (oppUrlIsReal) {
    steps.push({
      id: 'open_apply_url',
      category: 'opportunity',
      priority: 'high',
      label: 'Open the application page',
      detail: 'Review eligibility and required documents directly on the funder\'s site.',
      action: 'open_url',
      href: realUrl,
    })
  } else {
    rationale.push('No actionable application URL on this record — it is treated as informational/referral.')
    steps.push({
      id: 'informational_resource',
      category: 'opportunity',
      priority: 'low',
      label: 'Use this as a reference',
      detail:
        'This record does not have a verified application link — use it to learn about the funder and look for a sibling opportunity with a real apply URL.',
      action: 'informational',
    })
  }

  if (isLoan) {
    rationale.push('This is a loan product — only pursue if you explicitly want debt financing.')
  }

  // Application-state driven CTAs
  const state = String(application?.state || application?.stage || '').toUpperCase()
  if (!application) {
    steps.push({
      id: 'save_to_pipeline',
      category: 'application',
      priority: 'normal',
      label: 'Save to your pipeline',
      detail: 'Track this opportunity so you don\'t lose it.',
      action: 'save_to_pipeline',
    })
  } else if (state === 'DISCOVERED' || state === 'SAVED') {
    steps.push({
      id: 'start_application',
      category: 'application',
      priority: 'high',
      label: 'Start the application workflow',
      detail: 'Check for duplicate applications before qualifying this opportunity.',
      action: 'transition',
      meta: { target: 'DEDUPED' },
    })
  } else if (state === 'DEDUPED') {
    steps.push({
      id: 'qualify_application',
      category: 'application',
      priority: 'high',
      label: 'Qualify the opportunity',
      detail: 'Confirm this opportunity is qualified before building its required fields.',
      action: 'transition',
      meta: { target: 'QUALIFIED' },
    })
  } else if (state === 'QUALIFIED') {
    steps.push({
      id: 'build_application_schema',
      category: 'application',
      priority: 'high',
      label: 'Build required fields',
      detail: 'Build the application schema from the qualified opportunity.',
      action: 'transition',
      meta: { target: 'SCHEMA_READY' },
    })
  } else if (state === 'SCHEMA_READY') {
    steps.push({
      id: 'map_requirements',
      category: 'application',
      priority: 'high',
      label: 'Map application requirements',
      detail: 'Map profile information and documents to the required fields.',
      action: 'transition',
      meta: { target: 'MAPPED' },
    })
  } else if (state === 'MAPPED') {
    steps.push({
      id: 'resolve_missing',
      category: 'application',
      priority: 'high',
      label: 'Resolve missing requirements',
      detail: 'Fill out the fields the funder requires and upload any requested documents.',
      action: 'transition',
      meta: { target: 'MISSING_RESOLVED' },
    })
  } else if (state === 'MISSING_RESOLVED' || state === 'DRAFTING') {
    steps.push({
      id: 'upload_docs',
      category: 'application',
      priority: 'normal',
      label: 'Upload supporting documents',
      detail: 'Attach the narrative, budget, and any letters of support to your application.',
      action: 'upload_docs',
    })
  }

  // Low-score softening
  if (typeof score === 'number' && score < LOW_SCORE_THRESHOLD) {
    rationale.push(
      `Score of ${score} is low — we kept this result because fallback rules engaged (category or geography was widened).`
    )
  } else if (
    matchExplain?.matchedSignals?.length === 0 &&
    !matchExplain?.profileReasonLines?.length
  ) {
    rationale.push(
      'Few explicit signals matched — complete your profile\'s funding needs and location to tighten the match.'
    )
  }

  return { steps, rationale, coverage }
}


/**
 * Produce profile-level guidance (used when the user has zero/few results
 * across the whole Discover view). Lets Anya redirect to the highest-leverage
 * profile gaps.
 */
export function buildProfileOnlyGuidance({ profile, rawSections = null, resultCount = 0 } = {}) {
  const coverage = computeProfileCoverage(profile || {}, rawSections)
  const steps = []
  const rationale = []

  if (resultCount === 0) {
    rationale.push('No opportunities surfaced yet. Profile signals tell us which grants are relevant.')
  }

  for (const s of coverage.suggestions) {
    steps.push({
      id: `profile.${s.key}`,
      category: 'profile',
      priority: coverage.coverage < 0.3 ? 'critical' : 'high',
      label: `Add ${s.label}`,
      detail: s.action,
      action: 'edit_profile',
      meta: { section: s.section, field: s.key },
    })
  }

  if (coverage.coverage < 0.3) {
    steps.push({
      id: 'profile.comprehensive_intake',
      category: 'profile',
      priority: 'critical',
      label: 'Complete the comprehensive intake',
      detail:
        'Walk through the guided intake so we can match you to nonprofit, faith-based, business, and individual-aid grants all at once.',
      action: 'edit_profile',
      meta: { section: 'comprehensive_application' },
    })
  }

  return { steps, rationale, coverage }
}
