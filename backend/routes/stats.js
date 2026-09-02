import express from 'express'
import {
  requireAuthenticatedUser,
  getAccessibleProfileIds,
  getAccessibleOrganizationIds,
} from '../utils/accessControl.js'
import { standardRateLimiter } from '../middleware/rateLimiting.js'
// Choke point for pipeline-$ semantics: status list + per-grant value fallback
// (amount_requested → amount_max → amount_min). Do not re-inline either here.
import { PIPELINE_ACTIVE_STATUSES, pipelineValueSql, unvaluedCountSql } from '../config/pipelineValue.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:stats')

const router = express.Router()

const ZERO_STATS = {
  organizations: 0,
  fundsSecured: 0,
  activeProfiles: 0,
  opportunitiesFound: 0,
  grantsTotal: 0,
  pipelineTotal: 0,
  isRealData: true,
}

/**
 * Build a SQL `column IN (...)` fragment for a list of ids.
 * Returns a clause that matches nothing when the id list is empty, so an
 * unscoped (no-access) user honestly gets zeros rather than every row.
 */
function inClause(column, ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return { sql: '1 = 0', params: [] }
  }
  return { sql: `${column} IN (${ids.map(() => '?').join(', ')})`, params: ids }
}

/**
 * Compute REAL dashboard stats.
 * @param db database handle
 * @param scope null → all rows (admin); otherwise { profileIds, orgIds } arrays
 *        used to restrict every aggregate to the user's own data.
 */
async function computeDashboardStats(db, scope) {
  const isAdmin = scope === null

  // Counts of the user's own profiles/orgs (or all, for admin).
  let organizations
  let activeProfiles
  let grantScopeSql
  let grantScopeParams

  if (isAdmin) {
    organizations = (await db.prepare('SELECT COUNT(*) as count FROM organizations').get())?.count ?? 0
    activeProfiles = (await db.prepare('SELECT COUNT(*) as count FROM profiles').get())?.count ?? 0
    grantScopeSql = '1 = 1'
    grantScopeParams = []
  } else {
    const profileIds = scope.profileIds
    const orgIds = scope.orgIds
    organizations = orgIds.length
    activeProfiles = profileIds.length
    // A grant belongs to the user if it is tied to one of their organizations
    // OR one of their profiles.
    const orgClause = inClause('organization_id', orgIds)
    const profileClause = inClause('profile_id', profileIds)
    grantScopeSql = `(${orgClause.sql} OR ${profileClause.sql})`
    grantScopeParams = [...orgClause.params, ...profileClause.params]
  }

  const grantsTotal = (await db
    .prepare(`SELECT COUNT(*) as count FROM grants WHERE ${grantScopeSql}`)
    .get(...grantScopeParams))?.count ?? 0

  const fundsSecured = (await db
    .prepare(`SELECT COALESCE(SUM(amount_awarded), 0) as total FROM grants
              WHERE ${grantScopeSql} AND status = 'awarded' AND amount_awarded > 0`)
    .get(...grantScopeParams))?.total ?? 0

  const pipelineStatusClause = `status IN (${PIPELINE_ACTIVE_STATUSES.map(() => '?').join(', ')})`
  const pipelineRow = await db
    .prepare(`SELECT COALESCE(SUM(${pipelineValueSql('g', 'fo.opportunity_kind')}), 0) as total,
                     COALESCE(${unvaluedCountSql('g', 'fo.opportunity_kind')}, 0) as unvalued
              FROM grants g
              LEFT JOIN funding_opportunities fo ON fo.id = g.funding_opportunity_id
              WHERE ${grantScopeSql.replaceAll('organization_id', 'g.organization_id').replaceAll('profile_id', 'g.profile_id')} AND g.${pipelineStatusClause}`)
    .get(...grantScopeParams, ...PIPELINE_ACTIVE_STATUSES)
  const pipelineTotal = pipelineRow?.total ?? 0
  const pipelineUnvaluedCount = pipelineRow?.unvalued ?? 0

  // opportunitiesFound is the real, currently-active funding catalog the user can
  // search — a genuine "X real opportunities available to find" figure, not a
  // per-user number, and honestly the same for everyone.
  const opportunitiesFound = (await db
    .prepare('SELECT COUNT(*) as count FROM funding_opportunities WHERE is_active = 1')
    .get())?.count ?? 0

  return {
    organizations,
    fundsSecured,
    activeProfiles,
    opportunitiesFound,
    grantsTotal,
    pipelineTotal,
    pipelineUnvaluedCount,
    isRealData: true,
  }
}

/**
 * GET /api/stats/dashboard
 * Returns REAL dashboard statistics for the authenticated user:
 * - Admin users see database-wide totals.
 * - Regular users see totals scoped to their own profiles/organizations.
 * No marketing/placeholder numbers are ever returned to an authenticated user —
 * the dashboard must show the user's real data (or honest zeros).
 */
router.get('/dashboard', standardRateLimiter, async (req, res) => {
  try {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return

    if (!req.db) {
      return res.status(500).json({ error: 'Database not available', ...ZERO_STATS })
    }

    const isAdmin = Boolean(req.ctx?.isAdmin)
    let scope = null
    if (!isAdmin) {
      const profileIdSet = await getAccessibleProfileIds(req.db, user)
      const orgIdSet = await getAccessibleOrganizationIds(req.db, user)
      // A null id set means the access layer itself classified this user as an
      // admin — fall through to unscoped (DB-wide) stats rather than zeros.
      if (profileIdSet === null && orgIdSet === null) {
        scope = null
      } else {
        scope = {
          profileIds: [...(profileIdSet || [])],
          orgIds: [...(orgIdSet || [])],
        }
      }
    }

    const stats = await computeDashboardStats(req.db, scope)
    return res.json(stats)
  } catch (error) {
    routeLogger.error('[stats/dashboard] Error:', error)
    return res.status(500).json({ error: 'Failed to fetch dashboard stats', ...ZERO_STATS })
  }
})

export default router
