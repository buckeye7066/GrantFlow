/**
 * robertRecommendationDelivery.js
 *
 * Marks pending recommendations as delivered (live or on-login),
 * batches low-priority items so users aren't flooded, and provides
 * the helper a polling/SSE endpoint uses to fetch what to show next.
 *
 * The HTTP/transport layer lives in `backend/routes/robert.js`. This
 * module is just the rules engine.
 */

import {
  DELIVERY_STATUS,
  RECOMMENDATION_STATUS,
  TOAST_PRIORITY,
} from './robertTypes.js'
import {
  getRecommendation,
  listRecommendationsForProfile,
  updateRecommendationStatus,
} from './robertRunStore.js'

/**
 * Return what the frontend should show right now for a profile.
 * Splits into:
 *   - immediate: HIGH priority recs (one-by-one toast)
 *   - normal: NORMAL priority recs
 *   - batch: LOW priority recs (combined into a single "X new" toast)
 *
 * Stops at the daily cap so the listener can't flood the UI.
 */
export async function selectDeliverable({
  db,
  profileId,
  config = {},
  now = new Date(),
} = {}) {
  if (!db || !profileId) return { immediate: [], normal: [], batch: [], daily_cap_reached: false, total: 0 }
  const recs = await listRecommendationsForProfile(db, profileId, {
    statuses: [RECOMMENDATION_STATUS.PENDING, RECOMMENDATION_STATUS.DELIVERED, RECOMMENDATION_STATUS.VIEWED],
    limit: 100,
  })
  const dailyCap = Number(config.maxToastsPerProfilePerDay ?? 5)
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const deliveredToday = recs.filter((r) => r.toast_shown_at && new Date(r.toast_shown_at) >= since).length
  const immediate = []
  const normal = []
  const batch = []
  for (const rec of recs) {
    // Anything already shown stays out of the immediate queue.
    if (rec.delivery_status === DELIVERY_STATUS.DISMISSED) continue
    if (rec.toast_shown_at) continue
    switch ((rec.toast_priority || TOAST_PRIORITY.NORMAL).toLowerCase()) {
      case TOAST_PRIORITY.HIGH:
        immediate.push(rec); break
      case TOAST_PRIORITY.LOW:
        batch.push(rec); break
      default:
        normal.push(rec); break
    }
  }
  // Trim normal/immediate to the remaining daily cap.
  const remaining = Math.max(0, dailyCap - deliveredToday)
  const allowImmediate = immediate.slice(0, Math.max(1, remaining))            // at least 1 high-priority always
  const allowNormal = normal.slice(0, Math.max(0, remaining - allowImmediate.length))
  return {
    immediate: allowImmediate,
    normal: allowNormal,
    batch,
    daily_cap_reached: remaining === 0,
    total: allowImmediate.length + allowNormal.length + batch.length,
  }
}

/**
 * Mark a recommendation as delivered. `via` controls whether we record
 * 'delivered_live' (SSE/poll while logged in) or 'delivered_on_login'
 * (queued before the user was online).
 */
export async function markDelivered(db, recommendationId, { via = 'live', now = new Date() } = {}) {
  if (!db || !recommendationId) return null
  const rec = await getRecommendation(db, recommendationId)
  if (!rec) return null
  // Don't overwrite accepted/declined.
  if ([RECOMMENDATION_STATUS.ACCEPTED, RECOMMENDATION_STATUS.DECLINED, RECOMMENDATION_STATUS.EXPIRED, RECOMMENDATION_STATUS.SUPERSEDED].includes(rec.recommendation_status)) {
    return rec
  }
  const delivery_status = via === 'login' ? DELIVERY_STATUS.DELIVERED_ON_LOGIN : DELIVERY_STATUS.DELIVERED_LIVE
  await updateRecommendationStatus(db, recommendationId, {
    recommendation_status: RECOMMENDATION_STATUS.DELIVERED,
    delivery_status,
    toast_shown_at: now.toISOString(),
    last_delivered_at: now.toISOString(),
    delivery_attempts: (rec.delivery_attempts || 0) + 1,
  })
  return await getRecommendation(db, recommendationId)
}

/**
 * Helper for the polling endpoint: returns recommendations created
 * after `since` (ISO timestamp) so a polling client can resume.
 */
export async function listRecommendationsSince(db, profileId, sinceISO, { limit = 20 } = {}) {
  if (!db || !profileId) return []
  const since = sinceISO ? new Date(sinceISO).toISOString() : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const rows = await db.prepare(
    `SELECT * FROM robert_profile_recommendations
       WHERE profile_id = ?
         AND created_at >= ?
         AND recommendation_status NOT IN ('declined','expired','superseded')
       ORDER BY created_at DESC
       LIMIT ?`,
  ).all(profileId, since, Number(limit) || 20)
  return rows.map(shape)
}

function shape(row) {
  if (!row) return null
  return {
    id: row.id,
    profile_id: row.profile_id,
    opportunity_id: row.opportunity_id,
    recommendation_status: row.recommendation_status,
    delivery_status: row.delivery_status,
    match_score: row.match_score,
    match_decision: row.match_decision,
    why_found: row.why_found,
    search_query_used: row.search_query_used,
    toast_title: row.toast_title,
    toast_body: row.toast_body,
    toast_priority: row.toast_priority,
    created_at: row.created_at,
    last_delivered_at: row.last_delivered_at,
  }
}
