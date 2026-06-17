/**
 * robertVerification.js
 *
 * Verification step delegates entirely to canonical services Robert
 * already trusts. Robert is FORBIDDEN from inventing its own
 * accept/reject thresholds — every gate here either calls the
 * canonical service or applies a Robert-side filter that mirrors what
 * the canonical service does (e.g. a fast pre-check before paying for
 * a network round-trip).
 *
 * Order of evaluation (matches `upsertFundingOpportunity` so Robert's
 * pre-flight matches what real ingestion will reject):
 *   1. enforceOpportunityPolicy
 *   2. validateOpportunity
 *   3. reviewOpportunity
 *   4. assessReality
 *   5. checkUrl  (only if config.allowLiveWeb && config.requireRealApplicationUrl)
 *
 * Returns one of:
 *   { ok: true,  warnings: [...] }
 *   { ok: false, reason: <REJECTION_REASONS code>, stage: <gate>, raw: <gate result>, warnings: [...] }
 */

import { enforceOpportunityPolicy } from '../crawlers/opportunityPolicy.js'
import { validateOpportunity } from '../opportunityValidator.js'
import { reviewOpportunity } from '../reviewerAgent.js'
import { assessReality } from '../opportunityRealityGate.js'
import { REJECTION_REASONS } from './robertTypes.js'
import {
  isExpiredDeadline,
  isPlaceholderText,
  isPlaceholderUrl,
  isProbableLoanProduct,
  isProbableMatchingFunds,
  isSearchEngineUrl,
} from './robertSafety.js'

const POLICY_TO_REASON = {
  invalid_object: REJECTION_REASONS.INSUFFICIENT_EVIDENCE,
  no_real_url: REJECTION_REASONS.NO_REAL_URL,
  search_engine_url_for_direct_opp: REJECTION_REASONS.SEARCH_ENGINE_URL_FOR_DIRECT_OPP,
  placeholder_text: REJECTION_REASONS.PLACEHOLDER_TEXT,
  loan_like: REJECTION_REASONS.LOAN_LIKE,
  matching_funds: REJECTION_REASONS.MATCHING_FUNDS,
  expired_deadline: REJECTION_REASONS.EXPIRED_DEADLINE,
}

const VALIDATOR_TO_REASON = {
  invalid_object: REJECTION_REASONS.INSUFFICIENT_EVIDENCE,
  missing_or_short_title: REJECTION_REASONS.MISSING_TITLE,
  missing_sponsor_and_description: REJECTION_REASONS.MISSING_SPONSOR,
  no_valid_url: REJECTION_REASONS.NO_REAL_URL,
  non_actionable_url: REJECTION_REASONS.MISSING_APPLICATION_PATH,
  placeholder_content: REJECTION_REASONS.PLACEHOLDER_TEXT,
  loan_like: REJECTION_REASONS.LOAN_LIKE,
  matching_funds: REJECTION_REASONS.MATCHING_FUNDS,
  deadline_passed: REJECTION_REASONS.EXPIRED_DEADLINE,
  generic_directory: REJECTION_REASONS.DIRECTORY_ONLY,
  directory_no_actionable_link: REJECTION_REASONS.DIRECTORY_ONLY,
}

const REVIEWER_TO_REASON = {
  'reviewer:placeholder_title': REJECTION_REASONS.PLACEHOLDER_TEXT,
  'reviewer:placeholder_description': REJECTION_REASONS.PLACEHOLDER_TEXT,
  'reviewer:placeholder_url': REJECTION_REASONS.PLACEHOLDER_URL,
  'reviewer:firm_deadline_in_past': REJECTION_REASONS.EXPIRED_DEADLINE,
  'reviewer:hallucination_marker': REJECTION_REASONS.PLACEHOLDER_TEXT,
}

const REALITY_TO_REASON = {
  no_real_url: REJECTION_REASONS.NO_REAL_URL,
  placeholder_content: REJECTION_REASONS.PLACEHOLDER_TEXT,
  loan_like: REJECTION_REASONS.LOAN_LIKE,
  matching_funds_required: REJECTION_REASONS.MATCHING_FUNDS,
  social_only_url_for_direct: REJECTION_REASONS.SEARCH_ENGINE_URL_FOR_DIRECT_OPP,
  expired_deadline: REJECTION_REASONS.EXPIRED_DEADLINE,
  broken_direct_url: REJECTION_REASONS.DEAD_LINK,
}

/**
 * Run Robert's pre-flight + canonical chain.
 *
 * @param {object}   args
 * @param {object}   args.opportunity   normalized opportunity (output of normalizeForCanonicalInsert)
 * @param {Function} [args.checkUrl]    async (url, opts) => { status, code, error }
 * @param {object}   [args.config]      output of getRobertConfig()
 * @returns {Promise<{ ok, reason?, stage?, raw?, warnings, link? }>}
 */
export async function verifyOpportunity({ opportunity, checkUrl = null, config = {} } = {}) {
  if (!opportunity || typeof opportunity !== 'object') {
    return { ok: false, reason: REJECTION_REASONS.INSUFFICIENT_EVIDENCE, stage: 'preflight', warnings: [] }
  }
  const warnings = []

  // ---- Robert pre-flight (cheap, deterministic) ----
  const url = opportunity.application_url || opportunity.apply_url || opportunity.source_url
  if (!url) return { ok: false, reason: REJECTION_REASONS.NO_REAL_URL, stage: 'preflight', warnings }
  if (isPlaceholderUrl(url)) return { ok: false, reason: REJECTION_REASONS.PLACEHOLDER_URL, stage: 'preflight', warnings }
  if (isSearchEngineUrl(url)) return { ok: false, reason: REJECTION_REASONS.SEARCH_ENGINE_URL_FOR_DIRECT_OPP, stage: 'preflight', warnings }
  if (!opportunity.title) return { ok: false, reason: REJECTION_REASONS.MISSING_TITLE, stage: 'preflight', warnings }
  if (!opportunity.sponsor) return { ok: false, reason: REJECTION_REASONS.MISSING_SPONSOR, stage: 'preflight', warnings }
  if (isPlaceholderText(`${opportunity.title} ${opportunity.description || ''}`)) {
    return { ok: false, reason: REJECTION_REASONS.PLACEHOLDER_TEXT, stage: 'preflight', warnings }
  }
  if (isProbableLoanProduct(opportunity)) return { ok: false, reason: REJECTION_REASONS.LOAN_LIKE, stage: 'preflight', warnings }
  if (isProbableMatchingFunds(opportunity)) return { ok: false, reason: REJECTION_REASONS.MATCHING_FUNDS, stage: 'preflight', warnings }
  if (isExpiredDeadline(opportunity.deadline, opportunity.deadline_type)) {
    return { ok: false, reason: REJECTION_REASONS.EXPIRED_DEADLINE, stage: 'preflight', warnings }
  }

  // ---- Canonical opportunity policy ----
  const policy = enforceOpportunityPolicy(opportunity)
  if (!policy.ok) {
    const reason = POLICY_TO_REASON[policy.reason] || REJECTION_REASONS.INSUFFICIENT_EVIDENCE
    return { ok: false, reason, stage: 'policy', raw: policy, warnings }
  }

  // ---- Canonical validator ----
  const validation = validateOpportunity(opportunity, { allowExpired: false, allowLoans: false })
  if (!validation.valid) {
    const firstError = validation.errors?.[0]
    const reason = VALIDATOR_TO_REASON[firstError] || REJECTION_REASONS.INSUFFICIENT_EVIDENCE
    return { ok: false, reason, stage: 'validator', raw: validation, warnings: validation.warnings || [] }
  }
  if (Array.isArray(validation.warnings)) warnings.push(...validation.warnings)

  // ---- Canonical reviewer ----
  const reviewer = reviewOpportunity(opportunity)
  if (!reviewer.ok) {
    const reason = REVIEWER_TO_REASON[reviewer.reason] || REJECTION_REASONS.INSUFFICIENT_EVIDENCE
    return { ok: false, reason, stage: 'reviewer', raw: reviewer, warnings: [...warnings, ...(reviewer.warnings || [])] }
  }

  // ---- Canonical reality gate ----
  const reality = assessReality(opportunity)
  if (reality && reality.allowed === false) {
    const firstReason = (reality.reasons && reality.reasons[0]) || 'unknown'
    const reason = REALITY_TO_REASON[firstReason] || REJECTION_REASONS.INSUFFICIENT_EVIDENCE
    return { ok: false, reason, stage: 'reality', raw: reality, warnings }
  }

  // ---- Optional live link verification ----
  let link = null
  if (typeof checkUrl === 'function' && config?.allowLiveWeb && config?.requireRealApplicationUrl) {
    try {
      link = await checkUrl(url, { timeoutMs: config.timeoutMs ?? 10_000 })
      if (link?.status === 'broken') {
        return { ok: false, reason: REJECTION_REASONS.DEAD_LINK, stage: 'link_verify', raw: link, warnings, link }
      }
    } catch (err) {
      warnings.push(`link_verify_error:${String(err?.message || err).slice(0, 120)}`)
    }
  }

  return { ok: true, warnings, link, reality }
}

export const __testing__ = { POLICY_TO_REASON, VALIDATOR_TO_REASON, REVIEWER_TO_REASON, REALITY_TO_REASON }
