import { SURFACED_MATCHER_VERSIONS_SQL } from '../../config/matchSurfacing.js'
import { loadVnextGuidanceByOpportunity } from './vnextApplicationGuidance.js'

/**
 * Canonical live-table query contract for the owner-facing funding list.
 *
 * Crawler OS has its own in-memory shape (`summary`, `eligibility`, etc.), but
 * crawlerOsPersistenceCore maps that shape into the live legacy table:
 *   summary -> funding_opportunities.description
 *   eligibility facts -> funding_opportunities.eligibility_bullets / page facts
 *
 * The former route queried the in-memory names directly from PostgreSQL. One
 * undefined column (`fo.summary`) aborted the entire SELECT, and the route's
 * resilience catch returned an empty HTTP-200 list even though thousands of
 * persisted matches existed. Keep this projection pinned to columns guaranteed
 * by the live base schema or boot invariants, and provide compatibility aliases
 * in SQL instead of inventing physical columns.
 */
export const FUNDING_SOURCE_QUERY_CONTRACT = 'canonical-live-funding-columns-v1'

export const FUNDING_SOURCE_ROUTE_PROJECTION = `
       fo.id,
       fo.title,
       fo.sponsor,
       fo.description,
       fo.description AS summary,
       fo.eligibility_bullets AS eligibility,
       fo.eligibility_bullets AS eligibility_text,
       fo.eligibility_bullets AS eligibility_criteria,
       CAST(NULL AS TEXT) AS restrictions,
       fo.deadline,
       fo.deadline_type,
       fo.amount_min,
       fo.amount_max,
       fo.state,
       fo.is_national,
       fo.application_url,
       fo.application_url AS apply_url,
       fo.source_url,
       fo.source,
       fo.source_id,
       fo.record_origin,
       fo.opportunity_kind,
       fo.opportunity_type,
       fo.type,
       fo.opportunity_type AS funding_type,
       fo.source_trust_tier,
       fo.categories,
       fo.keywords,
       fo.link_status,
       fo.link_status_code,
       fo.last_verified_at,
       fo.verification_method,
       pom.match_score,
       pom.match_confidence,
       pom.match_decision,
       pom.match_explanation,
       pom.match_reasons,
       pom.match_explain_json,
       pom.matcher_version,
       CAST(NULL AS TEXT) AS ineligibility_reasons`

const FUNDING_SOURCE_BASE_FROM = `
  FROM profile_opportunity_matches pom
  JOIN funding_opportunities fo ON fo.id = pom.opportunity_id
 WHERE pom.profile_id = ?
   AND pom.matcher_version IN ${SURFACED_MATCHER_VERSIONS_SQL}
   AND (fo.is_active IS NULL OR fo.is_active = 1)
   AND (fo.is_hidden IS NULL OR fo.is_hidden = 0)`

const DISMISSAL_FILTER = `
   AND NOT EXISTS (
     SELECT 1
       FROM pipeline_dismissals d
      WHERE d.profile_id = pom.profile_id
        AND (
          (d.opportunity_id IS NOT NULL AND d.opportunity_id = pom.opportunity_id)
          OR (d.title IS NOT NULL AND lower(d.title) = lower(fo.title))
        )
   )`

export const FUNDING_SOURCES_BY_PROFILE_SQL = `
SELECT ${FUNDING_SOURCE_ROUTE_PROJECTION}
${FUNDING_SOURCE_BASE_FROM}
${DISMISSAL_FILTER}
 ORDER BY pom.match_score DESC, fo.updated_at DESC`

// A read-only audit cannot CREATE the dismissal table. If the table genuinely
// does not exist, it also contains no tombstones to enforce, so this SELECT-only
// fallback is equivalent and keeps the audit honest. Every other DB error stays
// loud and reaches the route's 503 response.
export const FUNDING_SOURCES_BY_PROFILE_WITHOUT_DISMISSALS_SQL = `
SELECT ${FUNDING_SOURCE_ROUTE_PROJECTION}
${FUNDING_SOURCE_BASE_FROM}
 ORDER BY pom.match_score DESC, fo.updated_at DESC`

export const NEED_FIRST_RECONCILIATION_ROWS_SQL = `
SELECT m.profile_id,
       m.opportunity_id,
       m.match_score,
       m.match_confidence,
       m.match_decision,
       m.match_explanation,
       m.match_reasons,
       m.match_explain_json,
       m.matcher_version,
       o.id,
       o.title,
       o.sponsor,
       o.description,
       o.description AS summary,
       o.eligibility_bullets AS eligibility,
       o.eligibility_bullets AS eligibility_text,
       o.eligibility_bullets AS eligibility_criteria,
       CAST(NULL AS TEXT) AS restrictions,
       o.opportunity_kind,
       o.opportunity_type,
       o.type,
       o.opportunity_type AS funding_type,
       o.categories,
       o.keywords,
       o.application_url,
       o.application_url AS apply_url,
       o.source_url,
       o.record_origin,
       o.link_status,
       o.link_status_code,
       o.last_verified_at,
       o.verification_method
  FROM profile_opportunity_matches m
  JOIN funding_opportunities o ON o.id = m.opportunity_id
 WHERE m.profile_id = ?
 ORDER BY m.match_score DESC
 LIMIT ?`

export function isMissingPipelineDismissalsTable(error) {
  const code = String(error?.code || '')
  const message = String(error?.message || error || '')
  return Boolean(
    code === '42P01' ||
    /no such table:\s*pipeline_dismissals/i.test(message) ||
    /relation\s+["']?pipeline_dismissals["']?\s+does not exist/i.test(message),
  )
}

export async function readFundingSourceRows(db, profileId) {
  try {
    const rows = await db.prepare(FUNDING_SOURCES_BY_PROFILE_SQL).all(String(profileId))
    const normalizedRows = Array.isArray(rows) ? rows : []
    const applications = await loadVnextGuidanceByOpportunity(db, profileId, normalizedRows.map((row) => row.id))
    return {
      rows: normalizedRows.map((row) => ({ ...row, ...applications.get(String(row.id)) })),
      dismissal_filter: 'enforced',
    }
  } catch (error) {
    if (!isMissingPipelineDismissalsTable(error)) throw error
    const rows = await db
      .prepare(FUNDING_SOURCES_BY_PROFILE_WITHOUT_DISMISSALS_SQL)
      .all(String(profileId))
    const normalizedRows = Array.isArray(rows) ? rows : []
    const applications = await loadVnextGuidanceByOpportunity(db, profileId, normalizedRows.map((row) => row.id))
    return {
      rows: normalizedRows.map((row) => ({ ...row, ...applications.get(String(row.id)) })),
      dismissal_filter: 'table_absent',
    }
  }
}

export default {
  FUNDING_SOURCE_QUERY_CONTRACT,
  FUNDING_SOURCE_ROUTE_PROJECTION,
  FUNDING_SOURCES_BY_PROFILE_SQL,
  FUNDING_SOURCES_BY_PROFILE_WITHOUT_DISMISSALS_SQL,
  NEED_FIRST_RECONCILIATION_ROWS_SQL,
  isMissingPipelineDismissalsTable,
  readFundingSourceRows,
}
