import express from 'express'
import { formatError } from '../middleware/errorHandler.js'
import { calculateMatchScore } from '../services/matchingEngine.js'
import { loadProfileContext } from '../services/profileHelpers.js'
import { buildProfileFacets } from '../services/profile/profileTaxonomy.js'
import { ensureProfileAccess } from '../utils/accessControl.js'
import { getDataReadiness } from '../services/dataReadinessService.js'
import { checkProfileReadiness } from '../services/profileReadinessService.js'
import { trustedOriginClause, trustedSourceClause } from '../utils/recordOrigins.js'

const router = express.Router()

/**
   * Junk origins (synthetic, manual) are excluded via a shared blocklist
   * in utils/recordOrigins.js. Content-level junk (CDC, MedlinePlus, etc.)
   * is caught by isInformationalResult() below.
   */

/**
   * Post-scoring filter: reject results that are clearly informational pages,
   * generic health directories, or resource listings rather than actual funding.
   */
function isInformationalResult(opp) {
    const title = (opp.title || '').toLowerCase()
    const desc = (opp.description || '').toLowerCase()
    const url = (opp.url || opp.application_url || opp.source_url || '').toLowerCase()
    const sponsor = (opp.sponsor || '').toLowerCase()
    const combined = title + ' ' + desc

  // Informational health pages (not funding)
  const infoPatterns = [
        'health topics', 'health information', 'medlineplus', 'health library',
        'medical encyclopedia', 'disease information', 'condition overview',
        'patient education', 'health topic', 'disease fact sheet',
        'symptoms and causes', 'what is', 'about this condition',
      ]
    if (infoPatterns.some(p => combined.includes(p))) return true

  // Informational domains
  const infoDomains = [
        'cdc.gov', 'medlineplus.gov', 'mayoclinic.org', 'webmd.com',
        'healthline.com', 'wikipedia.org', 'nih.gov/health',
        'niddk.nih.gov', 'ninds.nih.gov', 'nei.nih.gov',
      ]
    if (infoDomains.some(d => url.includes(d))) return true

  // Generic contact/directory pages
  const dirPatterns = [
        'contact your state', 'find a doctor', 'find a clinic',
        'find local help', 'connect to help', 'state contact directory',
        'office locator', 'provider directory',
      ]
    if (dirPatterns.some(p => combined.includes(p))) return true

  // Copay/patient assistance that are really just directories
  const copayDirPatterns = [
        'copay assistance', 'copay foundation', 'patient assistance program',
        'patient advocate foundation', 'needymeds', 'pan foundation',
        'healthwell foundation', 'rx assistance',
      ]
    // Only filter if it's not from a trusted source
  if (copayDirPatterns.some(p => combined.includes(p)) &&
            !opp.record_origin?.startsWith('curated')) return true

  return false
}

function requireAuth(req, res) {
    if (!req.ctx?.userId) {
          res.status(401).json({ error: 'Authentication required' })
          return null
    }
    return req.ctx
}

async function requireProfileAccess(req, res, profileId) {
    const ctx = requireAuth(req, res)
    if (!ctx) return null
    if (ctx.isAdmin) return ctx
    const ok = await ensureProfileAccess(req, res, profileId)
    if (!ok) return null
    return ctx
}

/**
 * Match a profile to grants in its organization pipeline.
 */
router.get('/profile/:profileId/grants', async (req, res) => {
    const profileId = req.params.profileId
    const auth = await requireProfileAccess(req, res, profileId)
    if (!auth) return

             try {
                   const profileRow = await req.db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId)
                   if (!profileRow) {
                           return res.status(404).json({ error: 'Profile not found' })
                   }

      const baseContext = await loadProfileContext(req.db, profileId)
                   const profileContext = buildProfileFacets(baseContext)

      if (!profileRow.organization_id) {
              return res.json([])
      }

      const rows = await req.db
                     .prepare(
                               `
                                       SELECT g.id AS grant_id, g.title AS grant_title, g.funder AS grant_funder,
                                                      g.status AS grant_status, g.deadline AS grant_deadline, g.notes AS grant_notes,
                                                                     g.funding_opportunity_id, fo.*
                                                                             FROM grants g
                                                                                     LEFT JOIN funding_opportunities fo ON fo.id = g.funding_opportunity_id
                                                                                             WHERE g.organization_id = ?
                                                                                                     ORDER BY g.updated_at DESC, g.created_at DESC
                                                                                                             `,
                             )
                     .all(profileRow.organization_id)

      const matches = rows.map((row) => {
              const candidate = row.id
                ? {
                              title: row.title,
                              description: row.description,
                              is_national: row.is_national,
                              state: row.state,
                              keywords: row.keywords,
                              categories: row.categories,
                              deadline: row.deadline ?? row.grant_deadline,
                              deadline_type: row.deadline_type,
                              amount_min: row.amount_min,
                              amount_max: row.amount_max,
                              requires_501c3: row.requires_501c3,
                              requires_match: row.requires_match,
                              match_percentage: row.match_percentage,
                              eligibility_bullets: row.eligibility_bullets,
                }
                        : {
                                      title: row.grant_title,
                                      description: row.grant_notes ?? null,
                                      is_national: null,
                                      state: null,
                                      keywords: null,
                                      categories: null,
                                      deadline: row.grant_deadline,
                        }

                                     const computed = calculateMatchScore(profileContext, candidate)
              return {
                        grant_id: row.grant_id,
                        title: row.grant_title,
                        funder: row.grant_funder,
                        status: row.grant_status,
                        deadline: row.grant_deadline,
                        funding_opportunity_id: row.funding_opportunity_id ?? null,
                        match_score: computed.score,
                        match_reasons: computed.reasons,
              }
      })

      matches.sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
                   res.json(matches)
             } catch (error) {
                   console.error('Error matching profile to grants:', error)
                   res.status(500).json(formatError(error))
             }
})

/**
   * Match a profile to live funding opportunities.
   *
   * CRITICAL FIX: Only return records from trusted/curated sources.
   * The funding_opportunities table was contaminated by old crawlers that stored
   * informational pages (CDC, MedlinePlus, NeedyMeds, Patient Advocate Foundation,
   * Medicaid directories, 211.org, etc.) as "funding opportunities."
   * These are NOT real funding sources — they are informational websites.
   *
   * The fix: filter by record_origin to only return curated/verified records,
   * AND post-filter to catch any informational pages that slipped through.
   */
router.get('/profile/:profileId/opportunities', async (req, res) => {
    const profileId = req.params.profileId
    const auth = await requireProfileAccess(req, res, profileId)
    if (!auth) return

             try {
                   const profileRow = await req.db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId)
                   if (!profileRow) {
                           return res.status(404).json({ error: 'Profile not found' })
                   }

      if (req.query.skip_readiness_check !== '1') {
              const readiness = await checkProfileReadiness(req.db, profileId)
              if (!readiness.ready) {
                        return res.status(422).json({
                                    error: 'profile_not_ready',
                                    message: readiness.guidance || 'Profile requires additional information before matching.',
                                    missing: readiness.missing,
                                    score: readiness.score,
                                    guidance: readiness.guidance,
                        })
              }
      }

      if (req.query.skip_readiness_check !== '1') {
              const dataReady = await getDataReadiness(req.db)
              if (dataReady.status === 'not_run') {
                        return res.status(503).json({
                                    error: 'catalog_not_ready',
                                    message: 'The funding opportunity catalog has not been populated yet. Please run crawls first.',
                                    data_readiness: dataReady,
                        })
              }
              if (dataReady.status === 'running') {
                        return res.status(503).json({
                                    error: 'catalog_loading',
                                    message: 'Crawls are in progress. Please try again shortly.',
                                    data_readiness: dataReady,
                        })
              }
      }

      const minScore = Number.parseInt(req.query.min_score ?? '50', 10)
                   const limit = Math.min(Math.max(Number.parseInt(req.query.limit ?? '2000', 10) || 2000, 1), 5000)
                   const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : ''

      const baseContext = await loadProfileContext(req.db, profileId)
                   const profileContext = buildProfileFacets(baseContext)

      const conditions = ['is_active = ?']
                   const params = []
                         params.push(true)

      const isPostgres = req.db?.dialect === 'postgres'

      // Unconditional exclusion of loans and matching-required funds.
      conditions.push(
              isPostgres
                ? '(requires_match IS NULL OR requires_match = FALSE)'
                : '(requires_match = 0 OR requires_match IS NULL)',
            )
                   conditions.push(
                           isPostgres
                             ? '(is_loan IS NULL OR is_loan = FALSE)'
                             : '(is_loan = 0 OR is_loan IS NULL)',
                         )

      conditions.push(trustedOriginClause())

      conditions.push(trustedSourceClause())

      // Keep results current
      conditions.push(
              `(deadline_type IN ('rolling','ongoing') OR deadline IS NULL OR deadline >= ${
                        isPostgres ? 'CURRENT_DATE' : "date('now')"
              })`,
            )

      if (q) {
              conditions.push(
                        '(LOWER(title) LIKE ? OR LOWER(description) LIKE ? OR LOWER(keywords) LIKE ? OR LOWER(categories) LIKE ?)',
                      )
              const pattern = `%${q}%`
              params.push(pattern, pattern, pattern, pattern)
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

      const deadlineNullSort = isPostgres
                     ? 'deadline IS NULL'
              : "deadline IS NULL OR deadline = ''"
                   const isNationalSort = isPostgres
                     ? "(is_national = TRUE OR state = 'nationwide')"
                           : "(is_national = 1 OR state = 'nationwide')"

      const candidates = await req.db
                     .prepare(
                               `
                                       SELECT * FROM funding_opportunities
                                               ${where}
                                                       ORDER BY
                                                                 CASE WHEN ${isNationalSort} THEN 0 ELSE 1 END,
                                                                           CASE WHEN ${deadlineNullSort} THEN 0 ELSE 1 END,
                                                                                     deadline ASC, updated_at DESC
                                                                                             LIMIT ?
                                                                                                     `,
                             )
                     .all(...params, limit)

      const scored = candidates
                     .map((opp) => {
                               // Post-scoring filter: reject informational/directory pages
                                  if (isInformationalResult(opp)) return null

                                  const computed = calculateMatchScore(profileContext, opp)
                               return {
                                           ...opp,
                                           match_score: computed.score,
                                           match_reasons: computed.reasons,
                                           url: opp.application_url ?? opp.source_url ?? null,
                               }
                     })
                     .filter((opp) => opp !== null)
                     .filter((opp) => (Number.isFinite(minScore) ? (opp.match_score ?? 0) >= minScore : true))

      scored.sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))

      res.json({
              profile_id: profileId,
              min_score: Number.isFinite(minScore) ? minScore : null,
              total_scored: candidates.length,
              returned: scored.length,
              opportunities: scored,
      })
             } catch (error) {
                   console.error('Error matching profile to opportunities:', error)
                   res.status(500).json(formatError(error))
             }
})

export default router
