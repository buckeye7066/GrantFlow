/**
 * robertRecommendationService.js
 *
 * Creates per-profile recommendation rows when Robert has a verified
 * opportunity that's a useful match. Robert does NOT auto-add anything
 * to a user's pipeline — it only queues a `pending` recommendation
 * with a toast title + body so the frontend can ask the user.
 *
 * Idempotency rules (enforced by both DB unique-index and this code):
 *   - Never two ACTIVE (pending|delivered|viewed) recommendations for
 *     the same (profile, opportunity).
 *   - If the user previously DECLINED, do not recreate unless the
 *     caller explicitly passes `supersedeDeclined: true` (the agent
 *     only sets this when an opportunity has materially changed).
 */

import {
  RECOMMENDATION_STATUS,
  DELIVERY_STATUS,
  TOAST_PRIORITY,
  MATCH_DECISION,
} from './robertTypes.js'
import {
  countRecommendationsToday,
  findRecommendationByPair,
  insertRecommendation,
  updateRecommendationStatus,
} from './robertRunStore.js'
import {
  SCORE_SCALE_ID,
  STRONG_MATCH_SCORE,
  translateLegacyMinScore,
} from '../../config/matchThresholds.js'
import { hasPositiveFourTruthProof } from '../../config/fundingTruthPolicy.js'
import { isPointerKind } from '../../config/opportunityKindClasses.js'

const DEFAULT_TOAST_TITLE = 'Robert found a possible funding source'
export const RESEARCH_LEAD_TOAST_TITLE = 'Robert found a research lead'
export const RESEARCH_LEAD_CLASSIFICATION = 'research_lead_not_direct_funding'

/**
 * A queued REVIEW row is a research lead — a directory or prior-award pointer
 * to investigate, never direct funding. Only an ACCEPT-band recommendation
 * (which carried positive four-truth proof at creation) may be added to the
 * pipeline. Returns the refusal payload for the accept route, or null.
 */
export function researchLeadAcceptRefusal(rec) {
  const decision = String(rec?.match_decision || '').toUpperCase()
  if (decision === MATCH_DECISION.ACCEPT) return null
  return {
    status: 409,
    body: {
      ok: false,
      error: 'Research leads are pointers to investigate and cannot be added as direct funding.',
      code: RESEARCH_LEAD_CLASSIFICATION,
      match_decision: decision || null,
    },
  }
}

function resolveToastPriorityThreshold(config = {}) {
  const configured = Number(config.minToastMatchScore ?? STRONG_MATCH_SCORE)
  if (!Number.isFinite(configured)) return STRONG_MATCH_SCORE

  // getRobertConfig stamps current-scale values. Unstamped values are accepted
  // for API/back-compat, but retired 0-100 settings must be translated before
  // they are used for presentation priority.
  if (config.minToastMatchScoreScaleId === SCORE_SCALE_ID) {
    return Math.max(0, Math.min(100, configured))
  }
  return Math.max(0, Math.min(100, translateLegacyMinScore(configured)))
}

/**
 * Decide whether to create a recommendation, then create it
 * idempotently.
 *
 * @returns {{ created, recommendation_id, reason, recommendation? }}
 */
export async function createRecommendationIfHelpful({
  db,
  profileId,
  opportunityId,
  matchDecision,
  matchScore,
  matchReasons = [],
  matchExplain = null,
  fourTruthProof = null,
  missingProfileFields = [],
  whyFound = '',
  searchQueryUsed = '',
  sourceCandidateId = null,
  opportunityCandidateId = null,
  robertRunId = null,
  opportunityTitle = '',
  profileDisplayName = '',
  config = {},
  supersedeDeclined = false,
} = {}) {
  if (!db) throw new Error('createRecommendationIfHelpful: db required')
  if (!profileId) return { created: false, reason: 'missing_profile_id' }
  if (!opportunityId) return { created: false, reason: 'missing_opportunity_id' }

  // Canonical decision is the sole recommendation-admission authority. The
  // score is retained for ranking/presentation only; Robert must not perform a
  // hidden second eligibility trial with its own numeric cutoff.
  const score = Number(matchScore || 0)
  const decision = String(matchDecision || '').toUpperCase()
  const minTopScore = resolveToastPriorityThreshold(config)
  if (!Object.values(MATCH_DECISION).includes(decision)) {
    return { created: false, reason: 'invalid_match_decision' }
  }
  if (decision !== MATCH_DECISION.ACCEPT) {
    return { created: false, reason: `decision_${decision.toLowerCase()}` }
  }

  // Robert's toast is a direct recommendation, not a research lead. It must
  // carry the same positive proof as every other surfaced direct source:
  // real, relatable, meets a declared profile need, and the profile qualifies.
  // A caller cannot turn a score or a historical ACCEPT into a recommendation.
  const proofCarrier = fourTruthProof
    ? { four_truth_proof: fourTruthProof }
    : (matchExplain || {})
  if (!hasPositiveFourTruthProof(proofCarrier)) {
    return { created: false, reason: 'missing_four_truth_proof' }
  }

  // Idempotency — refuse duplicates and skip declined unless superseding.
  const existing = await findRecommendationByPair(db, profileId, opportunityId)
  if (existing) {
    if (existing.recommendation_status === RECOMMENDATION_STATUS.DECLINED && !supersedeDeclined) {
      return { created: false, reason: 'previously_declined', recommendation: existing }
    }
    if ([RECOMMENDATION_STATUS.PENDING, RECOMMENDATION_STATUS.DELIVERED, RECOMMENDATION_STATUS.VIEWED].includes(existing.recommendation_status)) {
      return { created: false, reason: 'duplicate_active', recommendation: existing }
    }
    if (existing.recommendation_status === RECOMMENDATION_STATUS.ACCEPTED) {
      return { created: false, reason: 'previously_accepted', recommendation: existing }
    }
    // declined + supersedeDeclined: mark the old row as 'superseded' so it
    // never re-surfaces and the new insert can land cleanly.
    if (existing.recommendation_status === RECOMMENDATION_STATUS.DECLINED && supersedeDeclined) {
      await updateRecommendationStatus(db, existing.id, {
        recommendation_status: RECOMMENDATION_STATUS.SUPERSEDED,
      })
    }
  }

  // Daily toast cap.
  const dailyCount = await countRecommendationsToday(db, profileId)
  const dailyCap = Number(config.maxToastsPerProfilePerDay ?? 5)
  const overCap = dailyCount >= dailyCap

  // Compose toast text.
  const toastTitle = DEFAULT_TOAST_TITLE
  const toastReason = pickShortReason(matchReasons, whyFound)
  const toastBody = `${opportunityTitle || 'A new funding source'} may match ${profileDisplayName || 'this profile'}${toastReason ? ` because ${toastReason}` : ''}.`

  // Priority: ACCEPT high; REVIEW normal; below threshold low.
  let priority = TOAST_PRIORITY.NORMAL
  if (decision === MATCH_DECISION.ACCEPT && score >= minTopScore) priority = TOAST_PRIORITY.HIGH
  else if (decision === MATCH_DECISION.ACCEPT) priority = TOAST_PRIORITY.NORMAL
  else if (decision === MATCH_DECISION.REVIEW) priority = TOAST_PRIORITY.NORMAL
  else priority = TOAST_PRIORITY.LOW

  // If we're past the daily cap and this isn't HIGH priority, batch (downgrade to LOW + queued).
  if (overCap && priority !== TOAST_PRIORITY.HIGH) {
    priority = TOAST_PRIORITY.LOW
  }

  const insertResult = await insertRecommendation(db, {
    profile_id: profileId,
    opportunity_id: opportunityId,
    robert_run_id: robertRunId,
    recommendation_status: RECOMMENDATION_STATUS.PENDING,
    delivery_status: DELIVERY_STATUS.QUEUED,
    match_score: score,
    match_decision: decision,
    match_reasons: matchReasons,
    missing_profile_fields: missingProfileFields,
    why_found: whyFound,
    search_query_used: searchQueryUsed,
    source_candidate_id: sourceCandidateId,
    opportunity_candidate_id: opportunityCandidateId,
    toast_title: toastTitle,
    toast_body: toastBody,
    toast_priority: priority,
  })
  if (!insertResult.inserted) {
    return { created: false, reason: insertResult.duplicate ? 'duplicate_active' : 'insert_failed', recommendation: insertResult.existing }
  }
  return {
    created: true,
    recommendation_id: insertResult.id,
    reason: 'created',
    over_daily_cap: overCap,
    score_scale_id: SCORE_SCALE_ID,
  }
}

/**
 * Queue a RESEARCH LEAD in Robert's existing user-visible recommendation
 * table. Pointer rows (DIRECTORY / PAST_AWARD_INTEL) are intentionally absent
 * from direct recommendations, but they must not disappear: they land here at
 * REVIEW, the frontend labels REVIEW as a research lead and never offers
 * add-to-pipeline, and the accept route refuses them (researchLeadAcceptRefusal).
 *
 * Admission is the mirror image of createRecommendationIfHelpful: the decision
 * MUST be REVIEW and the kind MUST be a pointer. No four-truth proof is
 * required because nothing here is direct funding; a non-pointer REVIEW is
 * still refused so a weak direct match can never sneak into the queue.
 *
 * @returns {{ created, recommendation_id, reason, recommendation? }}
 */
export async function createResearchLeadIfHelpful({
  db,
  profileId,
  opportunityId,
  matchDecision,
  matchScore,
  opportunityKind,
  opportunityTitle = '',
  profileDisplayName = '',
  whyFound = '',
  robertRunId = null,
  searchQueryUsed = '',
  classification = RESEARCH_LEAD_CLASSIFICATION,
} = {}) {
  if (!db) throw new Error('createResearchLeadIfHelpful: db required')
  if (!profileId) return { created: false, reason: 'missing_profile_id' }
  if (!opportunityId) return { created: false, reason: 'missing_opportunity_id' }

  const decision = String(matchDecision || '').toUpperCase()
  if (decision !== MATCH_DECISION.REVIEW) {
    return { created: false, reason: decision ? `decision_${decision.toLowerCase()}` : 'invalid_match_decision' }
  }
  if (!isPointerKind(opportunityKind)) {
    return { created: false, reason: 'not_a_pointer_kind' }
  }

  const existing = await findRecommendationByPair(db, profileId, opportunityId)
  if (existing) {
    if (existing.recommendation_status === RECOMMENDATION_STATUS.DECLINED) {
      return { created: false, reason: 'previously_declined', recommendation: existing }
    }
    if ([RECOMMENDATION_STATUS.PENDING, RECOMMENDATION_STATUS.DELIVERED, RECOMMENDATION_STATUS.VIEWED].includes(existing.recommendation_status)) {
      return { created: false, reason: 'duplicate_active', recommendation: existing }
    }
    if (existing.recommendation_status === RECOMMENDATION_STATUS.ACCEPTED) {
      return { created: false, reason: 'previously_accepted', recommendation: existing }
    }
  }

  const score = Number(matchScore || 0)
  const insertResult = await insertRecommendation(db, {
    profile_id: profileId,
    opportunity_id: opportunityId,
    robert_run_id: robertRunId,
    recommendation_status: RECOMMENDATION_STATUS.PENDING,
    delivery_status: DELIVERY_STATUS.QUEUED,
    match_score: Number.isFinite(score) ? score : null,
    match_decision: MATCH_DECISION.REVIEW,
    match_reasons: [classification || RESEARCH_LEAD_CLASSIFICATION],
    missing_profile_fields: [],
    why_found: whyFound || 'Research lead from Robert discovery — a directory or prior-award pointer to investigate, not direct funding.',
    search_query_used: searchQueryUsed,
    toast_title: RESEARCH_LEAD_TOAST_TITLE,
    toast_body: `${opportunityTitle || 'A directory or prior-award pointer'} may be worth researching for ${profileDisplayName || 'this profile'}. It is not verified as direct funding.`,
    // Leads never compete with a verified direct recommendation for the toast slot.
    toast_priority: TOAST_PRIORITY.LOW,
  })
  if (!insertResult.inserted) {
    return { created: false, reason: insertResult.duplicate ? 'duplicate_active' : 'insert_failed', recommendation: insertResult.existing }
  }
  return {
    created: true,
    recommendation_id: insertResult.id,
    reason: 'created',
    classification: classification || RESEARCH_LEAD_CLASSIFICATION,
    score_scale_id: SCORE_SCALE_ID,
  }
}

/**
 * Mark a recommendation as accepted (caller is responsible for
 * actually adding the opportunity to the pipeline via the canonical
 * route — this just records the user decision so we never re-show).
 */
export async function markAccepted(db, id) {
  await updateRecommendationStatus(db, id, {
    recommendation_status: RECOMMENDATION_STATUS.ACCEPTED,
    accepted_at: new Date().toISOString(),
  })
}

/**
 * Mark a recommendation as declined. Stays declined until the
 * underlying opportunity materially changes (caller must explicitly
 * supersede).
 */
export async function markDeclined(db, id) {
  await updateRecommendationStatus(db, id, {
    recommendation_status: RECOMMENDATION_STATUS.DECLINED,
    declined_at: new Date().toISOString(),
  })
}

export async function markViewed(db, id) {
  await updateRecommendationStatus(db, id, {
    recommendation_status: RECOMMENDATION_STATUS.VIEWED,
    viewed_at: new Date().toISOString(),
  })
}

export async function markDismissed(db, id) {
  await updateRecommendationStatus(db, id, {
    delivery_status: DELIVERY_STATUS.DISMISSED,
  })
}

function pickShortReason(matchReasons, whyFound) {
  if (Array.isArray(matchReasons) && matchReasons.length > 0) {
    return String(matchReasons[0]).slice(0, 160)
  }
  if (whyFound) return String(whyFound).slice(0, 160)
  return ''
}

export const __testing__ = {
  pickShortReason,
  resolveToastPriorityThreshold,
  DEFAULT_TOAST_TITLE,
}
