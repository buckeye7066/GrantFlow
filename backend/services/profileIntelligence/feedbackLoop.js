/**
 * Profile Intelligence Feedback Loop
 *
 * Lightweight feedback storage for learning from user actions on matched opportunities.
 * Stores feedback signals: saved, dismissed, irrelevant, applied, won, broken_link,
 * not_eligible, too_burdensome.
 *
 * Design: Simple, deterministic, no ML. Feedback is stored and used to:
 * 1. Block opportunities that have been marked broken or not_eligible
 * 2. Boost opportunities in categories where user has saved/applied
 * 3. Surface patterns in dismissed opportunities for future filtering
 */

/**
 * @typedef {Object} FeedbackRecord
 * @property {string} profile_id
 * @property {string} opportunity_id
 * @property {string} action - 'saved'|'dismissed'|'irrelevant'|'applied'|'won'|'too_burdensome'|'link_broken'|'not_actually_eligible'
 * @property {string} need_code - The need code the opportunity was matched to
 * @property {number} score_at_feedback - Score when feedback was given
 * @property {string} created_at - ISO timestamp
 */

/**
 * Valid feedback action types.
 */
export const FEEDBACK_ACTIONS = {
  SAVED: 'saved',
  DISMISSED: 'dismissed',
  IRRELEVANT: 'irrelevant',
  APPLIED: 'applied',
  WON: 'won',
  TOO_BURDENSOME: 'too_burdensome',
  LINK_BROKEN: 'link_broken',
  NOT_ACTUALLY_ELIGIBLE: 'not_actually_eligible',
}

/** Positive feedback actions (user engaged with) */
export const POSITIVE_ACTIONS = new Set([FEEDBACK_ACTIONS.SAVED, FEEDBACK_ACTIONS.APPLIED,
  FEEDBACK_ACTIONS.WON])

/** Negative feedback actions (user rejected) */
export const NEGATIVE_ACTIONS = new Set([FEEDBACK_ACTIONS.DISMISSED, FEEDBACK_ACTIONS.IRRELEVANT,
  FEEDBACK_ACTIONS.TOO_BURDENSOME, FEEDBACK_ACTIONS.LINK_BROKEN,
  FEEDBACK_ACTIONS.NOT_ACTUALLY_ELIGIBLE])

/**
 * Validate a feedback record before storage.
 * Returns { valid: boolean, error?: string }
 */
export function validateFeedback(feedback) {
  if (!feedback || typeof feedback !== 'object') {
    return { valid: false, error: 'Feedback must be an object' }
  }
  if (!feedback.profile_id || typeof feedback.profile_id !== 'string') {
    return { valid: false, error: 'profile_id is required' }
  }
  if (!feedback.opportunity_id || typeof feedback.opportunity_id !== 'string') {
    return { valid: false, error: 'opportunity_id is required' }
  }
  if (!feedback.action || !Object.values(FEEDBACK_ACTIONS).includes(feedback.action)) {
    return {
      valid: false,
      error: `action must be one of: ${Object.values(FEEDBACK_ACTIONS).join(', ')}`,
    }
  }
  return { valid: true }
}

/**
 * Create a normalized feedback record with defaults.
 */
export function createFeedbackRecord(raw) {
  const validation = validateFeedback(raw)
  if (!validation.valid) {
    throw new Error(`Invalid feedback: ${validation.error}`)
  }

  return {
    profile_id: String(raw.profile_id),
    opportunity_id: String(raw.opportunity_id),
    action: raw.action,
    need_code: raw.need_code ?? null,
    score_at_feedback: typeof raw.score_at_feedback === 'number' ? raw.score_at_feedback : null,
    created_at: raw.created_at ?? new Date().toISOString(),
  }
}

/**
 * Analyze a set of feedback records to derive adjustment signals.
 *
 * Returns:
 * {
 *   blocked_opportunities: string[],  // opportunity_ids to hard-block
 *   boosted_needs: string[],           // need_codes to prioritize
 *   downweighted_needs: string[],      // need_codes to deprioritize
 *   summary: { positive: number, negative: number, total: number }
 * }
 */
export function analyzeFeedback(feedbackRecords) {
  if (!Array.isArray(feedbackRecords) || feedbackRecords.length === 0) {
    return {
      blocked_opportunities: [],
      boosted_needs: [],
      downweighted_needs: [],
      summary: { positive: 0, negative: 0, total: 0 },
    }
  }

  const blockedOpportunities = new Set()
  const needPositiveCount = new Map()
  const needNegativeCount = new Map()
  let positiveCount = 0
  let negativeCount = 0

  for (const record of feedbackRecords) {
    const action = record.action
    const needCode = record.need_code
    const oppId = record.opportunity_id

    // Hard-block broken links and confirmed ineligible
    if (action === FEEDBACK_ACTIONS.LINK_BROKEN ||
        action === FEEDBACK_ACTIONS.NOT_ACTUALLY_ELIGIBLE) {
      blockedOpportunities.add(oppId)
    }

    if (POSITIVE_ACTIONS.has(action)) {
      positiveCount++
      if (needCode) {
        needPositiveCount.set(needCode, (needPositiveCount.get(needCode) ?? 0) + 1)
      }
    } else if (NEGATIVE_ACTIONS.has(action)) {
      negativeCount++
      if (needCode) {
        needNegativeCount.set(needCode, (needNegativeCount.get(needCode) ?? 0) + 1)
      }
    }
  }

  // Boost needs with 2+ positive signals
  const boostedNeeds = Array.from(needPositiveCount.entries())
    .filter(([, count]) => count >= 2)
    .map(([code]) => code)

  // Downweight needs with 3+ negative signals (more conservative threshold)
  const downweightedNeeds = Array.from(needNegativeCount.entries())
    .filter(([, count]) => count >= 3)
    .map(([code]) => code)

  return {
    blocked_opportunities: Array.from(blockedOpportunities),
    boosted_needs: boostedNeeds,
    downweighted_needs: downweightedNeeds,
    summary: {
      positive: positiveCount,
      negative: negativeCount,
      total: feedbackRecords.length,
    },
  }
}

/**
 * Apply feedback adjustments to a score result.
 * Modifies total_score and verdict based on learned signals.
 *
 * @param {Object} scoreResult - From relevanceScorer.scoreOpportunity()
 * @param {Object} feedbackSignals - From analyzeFeedback()
 * @param {string} opportunityId
 * @returns Modified score result
 */
export function applyFeedbackToScore(scoreResult, feedbackSignals, opportunityId) {
  if (!scoreResult || !feedbackSignals) return scoreResult

  // Hard block: signal that this opportunity is blocked by prior feedback.
  // Do NOT emit a final verdict here — return a score of 0 with a flag so that
  // computeMatchDecision() receives the signal and issues the authoritative REJECT
  // with proper ineligibility_reasons, matcher_version, and evaluated_at.
  if (feedbackSignals.blocked_opportunities.includes(opportunityId)) {
    // Hard block remains explicit at this layer to preserve deterministic behavior
    // across existing pipeline consumers and tests.
    return {
      ...scoreResult,
      verdict: 'REJECT',
      total_score: 0,
      feedback_hard_blocked: true,
      ineligibility_reasons: [
        ...(scoreResult.ineligibility_reasons ?? []),
        'Previously marked as broken link or confirmed ineligible by user',
      ],
      why_may_not_fit: [
        ...(scoreResult.why_may_not_fit ?? []),
        'Previously marked as broken link or not eligible',
      ],
    }
  }

  let adjusted_score = scoreResult.total_score

  // Boost for matched boosted needs
  const boostedMatches = scoreResult.matched_needs.filter(
    n => feedbackSignals.boosted_needs.includes(n))
  if (boostedMatches.length > 0) {
    adjusted_score = Math.min(100, adjusted_score + 5 * boostedMatches.length)
  }

  // Downweight for matched downweighted needs.
  // Cap total downweight penalty at 20 pts (2 needs max) to avoid suppressing
  // opportunities the user genuinely qualifies for — Goal 7 (recall over suppression).
  const downweightedMatches = scoreResult.matched_needs.filter(
    n => feedbackSignals.downweighted_needs.includes(n))
  if (downweightedMatches.length > 0) {
    const penalty = Math.min(20, 10 * downweightedMatches.length)
    adjusted_score = Math.max(0, adjusted_score - penalty)
  }

  if (adjusted_score === scoreResult.total_score) {
    return {
      ...scoreResult,
      feedback_adjusted: false,
      feedback_evaluated: true,
    }
  }

  // Do NOT re-derive a verdict here. Only carry the adjusted score forward so
  // computeMatchDecision() can re-evaluate it as the single decision authority.
  // Callers MUST pass this adjusted scoreResult back through computeMatchDecision()
  // before storing any verdict in the pipeline.
  return {
    ...scoreResult,
    total_score: Math.round(adjusted_score),
    // Preserve the original verdict — caller must re-run computeMatchDecision()
    // to produce an authoritative verdict from the adjusted score.
    verdict: scoreResult.verdict,
    feedback_adjusted: true,
    feedback_adjustment_delta: Math.round(adjusted_score) - scoreResult.total_score,
    match_explanation: scoreResult.match_explanation
      ? `${scoreResult.match_explanation} [Feedback-adjusted by ${Math.round(adjusted_score - scoreResult.total_score) >= 0 ? '+' : ''}${Math.round(adjusted_score - scoreResult.total_score)} pts based on prior interactions]`
      : '[Feedback-adjusted score — re-run through computeMatchDecision for full explanation]',
  }
}
