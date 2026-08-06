import { createLogger } from '../utils/logger.js'
import { pointerKindSql } from '../config/opportunityKindClasses.js'
const log = createLogger('deadlineExpiryService')

async function fundingOpportunityColumnNames(db) {
  try {
    if (db?.dialect === 'postgres') {
      const rows = await db.prepare(`
        SELECT column_name
          FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'funding_opportunities'
      `).all()
      return new Set((rows || []).map((row) => row.column_name))
    }
    const rows = await db.prepare('PRAGMA table_info(funding_opportunities)').all()
    return new Set((rows || []).map((row) => row.name))
  } catch {
    return new Set()
  }
}

/**
 * Deadline Expiry Service
 *
 * Marks funding opportunities with passed deadlines as inactive and
 * transitions pipeline grants to a 'deadline_passed' stage.
 *
 * Run daily — called from server.js after DB is ready.
 */

/**
 * Expire opportunities whose deadline has passed and update pipeline grants
 * that reference now-inactive opportunities.
 *
 * @param {object} db - Dialect-aware db handle (SqliteDb or PostgresDb)
 * @returns {{ expired: number, pipelineUpdated: number }}
 */
export async function expirePassedDeadlines(db) {
  const isPostgres = db?.dialect === 'postgres'
  const opportunityColumns = await fundingOpportunityColumnNames(db)

  // Step 1: Mark funding_opportunities inactive when deadline has passed.
  // Uses the `deadline` DATE column (schema.sql line ~154).
  // dialect-aware today expression:
  //   SQLite: date('now')
  //   Postgres: CURRENT_DATE
  const todayExpr = isPostgres ? 'CURRENT_DATE' : "date('now')"
  const inactiveVal = isPostgres ? 'FALSE' : '0'
  const activeVal = isPostgres ? 'TRUE' : '1'
  const hiddenVal = isPostgres ? 'TRUE' : '1'
  const visibleVal = isPostgres ? 'FALSE' : '0'
  const expirySetClauses = [
    `is_active = ${inactiveVal}`,
    `is_hidden = ${hiddenVal}`,
    "status = 'expired'",
  ]
  if (opportunityColumns.has('deadline_status')) expirySetClauses.push("deadline_status = 'closed'")
  expirySetClauses.push('updated_at = CURRENT_TIMESTAMP')

  // A pointer/directory/referral is a place to FIND opportunities, not the
  // direct award named by a deadline on the page. Use the canonical kind
  // registry across the legacy representation columns; action_step is the
  // stored alias that the link lifecycle reclassifies to `referral`.
  const pointerPredicate = [
    pointerKindSql('opportunity_kind'),
    pointerKindSql('result_kind'),
    pointerKindSql('opportunity_type'),
    pointerKindSql('type'),
    "LOWER(COALESCE(result_kind, '')) = 'action_step'",
  ].map((part) => `(${part})`).join(' OR ')
  const preserveLifecyclePredicates = [
    "LOWER(COALESCE(status, 'active')) NOT IN ('retired', 'permanently_retired', 'quarantined')",
  ]
  if (opportunityColumns.has('link_status')) {
    preserveLifecyclePredicates.push(
      "LOWER(COALESCE(link_status, 'unverified')) NOT IN ('retired', 'permanently_retired', 'quarantined')",
    )
  }
  const needsCoherentExpiry = [
    "LOWER(COALESCE(status, 'active')) <> 'expired'",
    `COALESCE(is_active, ${activeVal}) <> ${inactiveVal}`,
    `COALESCE(is_hidden, ${visibleVal}) <> ${hiddenVal}`,
  ]
  if (opportunityColumns.has('deadline_status')) {
    needsCoherentExpiry.push("LOWER(COALESCE(deadline_status, 'unknown')) <> 'closed'")
  }

  let expired = 0
  try {
    const result = await db
      .prepare(
        `UPDATE funding_opportunities
         SET ${expirySetClauses.join(',\n             ')}
         WHERE ${preserveLifecyclePredicates.join('\n           AND ')}
           AND deadline IS NOT NULL
           AND deadline < ${todayExpr}
           AND (deadline_type IS NULL OR LOWER(deadline_type) NOT IN ('rolling', 'ongoing'))
           AND NOT (${pointerPredicate})
           AND (${needsCoherentExpiry.join('\n             OR ')})`,
      )
      .run()
    expired = Number(result?.changes ?? result?.rowCount ?? 0)
    log.info('[deadlineExpiry] Expired opportunities', { count: expired })
  } catch (error) {
    log.error('[deadlineExpiry] Failed to expire opportunities:', error?.message || error)
    throw error
  }

  // Step 2: Mark grants (pipeline items) as 'deadline_passed' when they reference
  // a now-inactive opportunity and are still in an active stage.
  //
  // Submitted/post-submission and outcome statuses must not be overwritten.
  // Also skip 'deadline_passed' to avoid redundant updates.
  const terminalStatuses = [
    // A passed opportunity deadline closes pre-submission work, but it cannot
    // rewrite an application that was already submitted or an outcome that was
    // already recorded.
    'submitted',
    'follow_up',
    'awarded',
    'rejected',
    'archived',
    'declined',
    'declined_no_review',
    'auto_applied',
    'pending_review',
    'under_review',
    'report',
    'closed',
    'deadline_passed',
  ]

  // Build IN clause placeholders (dialect-agnostic via ? placeholders — the db wrapper handles conversion)
  const placeholders = terminalStatuses.map(() => '?').join(', ')

  let pipelineUpdated = 0
  try {
    const result = await db
      .prepare(
        `UPDATE grants
         SET status = 'deadline_passed',
             updated_at = CURRENT_TIMESTAMP
         WHERE COALESCE(status, 'discovered') NOT IN (${placeholders})
           AND funding_opportunity_id IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM funding_opportunities fo
             WHERE fo.id = grants.funding_opportunity_id
               AND fo.status = 'expired'
               AND fo.is_active = ${inactiveVal}
               AND fo.deadline IS NOT NULL
               AND fo.deadline < ${todayExpr}
               AND (fo.deadline_type IS NULL OR LOWER(fo.deadline_type) NOT IN ('rolling', 'ongoing'))
               AND NOT (
                 ${[
                   pointerKindSql('fo.opportunity_kind'),
                   pointerKindSql('fo.result_kind'),
                   pointerKindSql('fo.opportunity_type'),
                   pointerKindSql('fo.type'),
                   "LOWER(COALESCE(fo.result_kind, '')) = 'action_step'",
                 ].map((part) => `(${part})`).join(' OR ')}
               )
           )`,
      )
      .run(...terminalStatuses)
    pipelineUpdated = Number(result?.changes ?? result?.rowCount ?? 0)
    log.info('[deadlineExpiry] Pipeline grants marked deadline_passed', { count: pipelineUpdated })
  } catch (error) {
    // Non-fatal: grants table may not have status='deadline_passed' in CHECK constraint on some DBs.
    // Log and continue — opportunity expiry is the primary goal.
    console.warn('[deadlineExpiry] Failed to update pipeline grants:', error?.message || error)
  }

  return { expired, pipelineUpdated }
}
