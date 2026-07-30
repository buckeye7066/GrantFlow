import { REVIEW_SCORE } from '../../config/matchThresholds.js'
import { SURFACED_MATCHER_VERSIONS_SQL } from '../../config/matchSurfacing.js'

const RESOURCE_KINDS_SQL = "('DIRECTORY', 'PAST_AWARD_INTEL', 'SCHOOL_PORTAL', 'REFERRAL')"

function changes(result) {
  return Number(result?.changes ?? result?.rowCount ?? 0)
}

function profileClause(profileIds = []) {
  const ids = [...new Set((Array.isArray(profileIds) ? profileIds : [profileIds])
    .map((value) => String(value || '').trim())
    .filter(Boolean))]
  if (ids.length === 0) return { sql: '', params: [] }
  return {
    sql: ` AND profile_id IN (${ids.map(() => '?').join(', ')})`,
    params: ids,
  }
}

function isMissingIntegritySchema(error) {
  const code = String(error?.code || '')
  const message = String(error?.message || error || '')
  return (
    code === '42P01' ||
    code === '42703' ||
    /no such table:\s*(profile_opportunity_matches|funding_opportunities)/i.test(message) ||
    /relation\s+["']?(profile_opportunity_matches|funding_opportunities)["']?\s+does not exist/i.test(message) ||
    /no such column:\s*(match_decision|match_score|matcher_version|opportunity_kind)/i.test(message) ||
    /column\s+["']?(match_decision|match_score|matcher_version|opportunity_kind)["']?\s+does not exist/i.test(message)
  )
}

/**
 * Normalize persisted profile-match decisions to the product's structural rules.
 *
 * - REJECT is not a surfaced match and is removed from every surfaced matcher lane.
 * - A resource below the REVIEW score is profile-irrelevant and is removed.
 * - Every surviving resource is navigational evidence, not direct funding, and is
 *   persisted as REVIEW so no directory/referral inflates ACCEPT totals.
 *
 * The pass is bounded by optional profile ids, idempotent, and safe to run at
 * startup, after crawler persistence, and before an owner-facing match read.
 */
export async function normalizePersistedMatchDecisionIntegrity(db, options = {}) {
  if (!db?.prepare) {
    return {
      ok: false,
      removed_rejects: 0,
      removed_below_review_resources: 0,
      normalized_resources: 0,
      reason: 'database_unavailable',
    }
  }

  const scope = profileClause(options.profileIds || options.profileId || [])
  const run = async (connection) => {
    const removedRejects = await connection.prepare(
      `DELETE FROM profile_opportunity_matches
        WHERE matcher_version IN ${SURFACED_MATCHER_VERSIONS_SQL}
          AND LOWER(COALESCE(match_decision, '')) = 'reject'
          ${scope.sql}`,
    ).run(...scope.params)

    const removedBelowReview = await connection.prepare(
      `DELETE FROM profile_opportunity_matches
        WHERE matcher_version IN ${SURFACED_MATCHER_VERSIONS_SQL}
          AND opportunity_id IN (
            SELECT id
              FROM funding_opportunities
             WHERE UPPER(COALESCE(opportunity_kind, '')) IN ${RESOURCE_KINDS_SQL}
          )
          AND match_score IS NOT NULL
          AND match_score < ?
          ${scope.sql}`,
    ).run(REVIEW_SCORE, ...scope.params)

    const normalizedResources = await connection.prepare(
      `UPDATE profile_opportunity_matches
          SET match_decision = 'review',
              updated_at = CURRENT_TIMESTAMP
        WHERE matcher_version IN ${SURFACED_MATCHER_VERSIONS_SQL}
          AND opportunity_id IN (
            SELECT id
              FROM funding_opportunities
             WHERE UPPER(COALESCE(opportunity_kind, '')) IN ${RESOURCE_KINDS_SQL}
          )
          AND (match_score IS NULL OR match_score >= ?)
          AND LOWER(COALESCE(match_decision, '')) <> 'review'
          ${scope.sql}`,
    ).run(REVIEW_SCORE, ...scope.params)

    return {
      ok: true,
      removed_rejects: changes(removedRejects),
      removed_below_review_resources: changes(removedBelowReview),
      normalized_resources: changes(normalizedResources),
      profile_count: scope.params.length,
      reason: null,
    }
  }

  try {
    if (typeof db.withTransaction === 'function') {
      return await db.withTransaction(run)
    }
    return await run(db)
  } catch (error) {
    if (isMissingIntegritySchema(error)) {
      return {
        ok: false,
        removed_rejects: 0,
        removed_below_review_resources: 0,
        normalized_resources: 0,
        profile_count: scope.params.length,
        reason: 'schema_unavailable',
      }
    }
    throw error
  }
}

export default {
  normalizePersistedMatchDecisionIntegrity,
}
