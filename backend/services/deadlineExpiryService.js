import { createLogger } from '../utils/logger.js'
const log = createLogger('deadlineExpiryService')
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

  // Step 1: Mark funding_opportunities inactive when deadline has passed.
  // Uses the `deadline` DATE column (schema.sql line ~154).
  // dialect-aware today expression:
  //   SQLite: date('now')
  //   Postgres: CURRENT_DATE
  const todayExpr = isPostgres ? 'CURRENT_DATE' : "date('now')"
  const inactiveVal = isPostgres ? 'FALSE' : '0'
  const activeVal = isPostgres ? 'TRUE' : '1'

  let expired = 0
  try {
    const result = await db
      .prepare(
        `UPDATE funding_opportunities
         SET is_active = ${inactiveVal},
             updated_at = CURRENT_TIMESTAMP
         WHERE is_active = ${activeVal}
           AND deadline IS NOT NULL
           AND deadline < ${todayExpr}
           AND (deadline_type IS NULL OR deadline_type NOT IN ('rolling', 'ongoing'))`,
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
  // Terminal statuses that must NOT be overwritten:
  //   awarded, rejected, archived, declined, declined_no_review
  // Also skip 'deadline_passed' to avoid redundant updates.
  const terminalStatuses = [
    'awarded',
    'rejected',
    'archived',
    'declined',
    'declined_no_review',
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
         WHERE status NOT IN (${placeholders})
           AND funding_opportunity_id IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM funding_opportunities fo
             WHERE fo.id = grants.funding_opportunity_id
               AND fo.is_active = ${inactiveVal}
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
