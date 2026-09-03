import { REVIEW_SCORE } from '../../config/matchThresholds.js'
import { SURFACED_MATCHER_VERSIONS_SQL } from '../../config/matchSurfacing.js'
import { hasPositiveFourTruthProof } from '../../config/fundingTruthPolicy.js'

/**
 * The opportunity kinds rules 3 and 4 below govern: navigational evidence, not
 * direct funding. Exported so a WRITER can pre-apply the same bar instead of
 * re-encoding the list at its own call site (CLAUDE.md: one choke point).
 */
export const RESOURCE_OPPORTUNITY_KINDS = Object.freeze([
  'DIRECTORY',
  'PAST_AWARD_INTEL',
  'SCHOOL_PORTAL',
  'REFERRAL',
])

const RESOURCE_KINDS_SQL = `(${RESOURCE_OPPORTUNITY_KINDS.map((k) => `'${k}'`).join(', ')})`

/**
 * Would rule 3 delete this row the instant it is written?
 *
 * PURE. A writer that persists a resource-kind match below REVIEW_SCORE creates
 * work for `normalizePersistedMatchDecisionIntegrity` on the SAME boot, and the
 * pair then cycles insert→delete forever — the tug-of-war signature (a repair
 * count that never trends to zero). Measured 2026-08-21: `funder_behavior_recall`
 * (ladder step 33) minted exactly one such row per boot and step 39 deleted it,
 * holding the ladder's `totalRepaired` at a permanent floor of 7.
 *
 * A NULL/non-numeric score is NOT below the bar — rule 3 requires an explicit
 * score, and rule 4 relabels those to REVIEW instead of deleting them.
 *
 * @param {{ opportunityKind?: string|null, matchScore?: number|string|null }} row
 * @returns {boolean}
 */
export function isBelowReviewResourceMatch({ opportunityKind = null, matchScore = null } = {}) {
  const kind = String(opportunityKind ?? '').trim().toUpperCase()
  if (!RESOURCE_OPPORTUNITY_KINDS.includes(kind)) return false
  const score = Number(matchScore)
  if (!Number.isFinite(score)) return false
  return score < REVIEW_SCORE
}

function changes(result) {
  return Number(result?.changes ?? result?.rowCount ?? 0)
}

function uniqueProfileIds(profileIds = []) {
  return [...new Set((Array.isArray(profileIds) ? profileIds : [profileIds])
    .map((value) => String(value || '').trim())
    .filter(Boolean))]
}

function profileClause(profileIds = [], column = 'profile_id') {
  const ids = uniqueProfileIds(profileIds)
  if (ids.length === 0) return { sql: '', params: [], ids }
  return {
    sql: ` AND ${column} IN (${ids.map(() => '?').join(', ')})`,
    params: ids,
    ids,
  }
}

function parseCanonicalDecision(value) {
  if (value === null || value === undefined || value === '') return null
  try {
    const parsed = typeof value === 'object' ? value : JSON.parse(String(value))
    return String(parsed?.canonical_decision || '').trim().toLowerCase() || null
  } catch {
    return null
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
    /no such column:\s*(?:\w+\.)?(match_decision|match_score|matcher_version|match_explain_json|opportunity_kind|updated_at)/i.test(message) ||
    /column\s+["']?(?:\w+\.)?(match_decision|match_score|matcher_version|match_explain_json|opportunity_kind|updated_at)["']?\s+does not exist/i.test(message)
  )
}

/**
 * Normalize persisted profile-match decisions to GrantFlow's structural rules.
 *
 * Rules, in precedence order:
 * 1. A persisted REJECT is not a surfaced match and is deleted.
 * 2. A row whose canonical evidence says REJECT is also deleted. A later writer
 *    may never relabel hard ineligibility as REVIEW or ACCEPT.
 * 3. A resource with an explicit score below REVIEW is profile-irrelevant and
 *    is deleted.
 * 4. Every surviving resource is navigational evidence, not direct funding, and
 *    is persisted as REVIEW so it cannot inflate ACCEPT totals.
 *
 * The pass covers every surfaced matcher lane, including web-llm, is optionally
 * profile-scoped, idempotent, and safe at startup and after every match writer.
 */
export async function normalizePersistedMatchDecisionIntegrity(db, options = {}) {
  const ids = options.profileIds || options.profileId || []
  const plainScope = profileClause(ids, 'profile_id')
  const aliasedScope = profileClause(ids, 'm.profile_id')

  const empty = (reason) => ({
    ok: false,
    scanned_canonical_evidence: 0,
    removed_rejects: 0,
    removed_canonical_rejects: 0,
    removed_unproven_direct_accepts: 0,
    removed_below_review_resources: 0,
    normalized_resources: 0,
    repaired: 0,
    profile_count: plainScope.ids.length,
    reason,
  })

  if (!db?.prepare) return empty('database_unavailable')

  const run = async (connection) => {
    const removedRejects = await connection.prepare(
      `DELETE FROM profile_opportunity_matches
        WHERE matcher_version IN ${SURFACED_MATCHER_VERSIONS_SQL}
          AND LOWER(COALESCE(match_decision, '')) = 'reject'
          ${plainScope.sql}`,
    ).run(...plainScope.params)

    // Canonical-decision evidence is JSON text in both SQLite and PostgreSQL.
    // Parse it in JavaScript rather than relying on dialect-specific JSON SQL.
    const evidenceRows = await connection.prepare(
`SELECT m.profile_id, m.opportunity_id, m.match_explain_json,
              m.match_decision, fo.opportunity_kind
         FROM profile_opportunity_matches m
         JOIN funding_opportunities fo ON fo.id = m.opportunity_id
        WHERE m.matcher_version IN ${SURFACED_MATCHER_VERSIONS_SQL}
          AND m.match_explain_json IS NOT NULL
          ${aliasedScope.sql}`,
    ).all(...aliasedScope.params)

    const deleteCanonicalReject = connection.prepare(
      `DELETE FROM profile_opportunity_matches
        WHERE profile_id = ? AND opportunity_id = ?
          AND matcher_version IN ${SURFACED_MATCHER_VERSIONS_SQL}`,
    )
    let removedCanonicalRejects = 0
    let removedUnprovenDirectAccepts = 0
    for (const row of Array.isArray(evidenceRows) ? evidenceRows : []) {
      if (parseCanonicalDecision(row.match_explain_json) === 'reject') {
        removedCanonicalRejects += changes(
          await deleteCanonicalReject.run(String(row.profile_id), String(row.opportunity_id)),
        )
        continue
      }
      const pointer = RESOURCE_OPPORTUNITY_KINDS.includes(
        String(row.opportunity_kind ?? '').trim().toUpperCase(),
      )
      if (!pointer &&
          String(row.match_decision ?? '').trim().toLowerCase() === 'accept' &&
          !hasPositiveFourTruthProof(row)) {
        removedUnprovenDirectAccepts += changes(
          await deleteCanonicalReject.run(String(row.profile_id), String(row.opportunity_id)),
        )
      }
    }

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
          ${plainScope.sql}`,
    ).run(REVIEW_SCORE, ...plainScope.params)

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
          ${plainScope.sql}`,
    ).run(REVIEW_SCORE, ...plainScope.params)

    const result = {
      ok: true,
      scanned_canonical_evidence: Array.isArray(evidenceRows) ? evidenceRows.length : 0,
      removed_rejects: changes(removedRejects),
      removed_canonical_rejects: removedCanonicalRejects,
      removed_unproven_direct_accepts: removedUnprovenDirectAccepts,
      removed_below_review_resources: changes(removedBelowReview),
      normalized_resources: changes(normalizedResources),
      profile_count: plainScope.ids.length,
      reason: null,
    }
    result.repaired = result.removed_rejects + result.removed_canonical_rejects +
      result.removed_unproven_direct_accepts +
      result.removed_below_review_resources + result.normalized_resources
    return result
  }

  try {
    if (typeof db.withTransaction === 'function') return await db.withTransaction(run)
    return await run(db)
  } catch (error) {
    if (isMissingIntegritySchema(error)) return empty('schema_unavailable')
    throw error
  }
}

export default {
  normalizePersistedMatchDecisionIntegrity,
  RESOURCE_OPPORTUNITY_KINDS,
  isBelowReviewResourceMatch,
}
