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

const DEFAULT_TOAST_TITLE = 'Robert found a possible funding source'

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

  // Score / decision gates.
  const score = Number(matchScore || 0)
  const decision = String(matchDecision || '').toUpperCase()
  const minTopScore = Number(config.minToastMatchScore ?? 70)
  const allowReview = config.allowReviewMatchToasts !== false
  const reviewMin = Math.max(35, minTopScore - 25)         // matches engine REVIEW threshold

  if (decision === MATCH_DECISION.REJECT) return { created: false, reason: 'decision_reject' }
  if (decision === MATCH_DECISION.NEEDS_PROFILE_DATA) {
    // we still record one recommendation but with priority=low and no
    // delivery toast, so the admin can see what Robert needs.
  }
  if (decision === MATCH_DECISION.ACCEPT && score < minTopScore) {
    // Fall through — accepted-by-engine but below user-toast threshold.
  } else if (decision === MATCH_DECISION.REVIEW && !allowReview) {
    return { created: false, reason: 'review_toasts_disabled' }
  } else if (decision === MATCH_DECISION.REVIEW && score < reviewMin) {
    return { created: false, reason: 'below_review_threshold' }
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

export const __testing__ = { pickShortReason, DEFAULT_TOAST_TITLE }
