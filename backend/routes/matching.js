import express from 'express'
import { formatError } from '../middleware/errorHandler.js'
import { computeMatchDecision, normalizeProfile } from '../services/matchEngine.js'
import { normalizeNeedCategory } from '../services/profileNormalizer.js'
import { loadProfileContext } from '../services/profileHelpers.js'
import { buildProfileFacets } from '../services/profile/profileTaxonomy.js'
import { ensureProfileAccess } from '../utils/accessControl.js'
import { getDataReadiness } from '../services/dataReadinessService.js'
import { checkProfileReadiness } from '../services/profileReadinessService.js'
import { trustedOriginClause, trustedSourceClause } from '../utils/recordOrigins.js'
import { isJunkOpportunity } from '../services/contentFilter.js'

const router = express.Router()

/**
 * Returns true when a REJECT decision represents a hard eligibility failure
 * (e.g. loan program, veteran-only for non-veteran) rather than a score-based
 * weak-match rejection. Score-based filtering is handled by the min_score threshold.
 */
function isHardEligibilityReject(decision) {
  return decision.decision === 'REJECT' &&
    decision.ineligibilityReasons?.some(r => !/^Score \d+/.test(r))
}

/**
   * Junk origins (synthetic, manual) are excluded via a shared blocklist
   * in utils/recordOrigins.js. Content-level junk (CDC, MedlinePlus, etc.)
   * is caught by the shared isJunkOpportunity() filter from services/contentFilter.js.
   */

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
    if (!auth || res.headersSent) return

             try {
                   const profileRow = await req.db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId)
                   if (!profileRow) {
                           return res.status(404).json({ error: 'Profile not found' })
                   }

      const baseContext = await loadProfileContext(req.db, profileId)
                   const profileContext = buildProfileFacets(baseContext)

      // Pre-normalize profile once for the v2.0.0 decision engine
      const rawProfileForGrants = profileContext?.profile ?? profileContext
      const profileSectionsForGrants = profileContext?.sections ?? null
      const profileNormForDecision = normalizeProfile(rawProfileForGrants, profileSectionsForGrants, baseContext.signals)

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
              // Skip grants without funding opportunity data to prevent corrupted matching
                if (!row.id) {
                    console.warn(`Grant ${row.grant_id} has no funding opportunity data, skipping match calculation`)
                    return null
                }
                const candidate = {
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

                                     // Use the canonical decision engine for scoring; fall back gracefully
                                     const decision = computeMatchDecision(profileContext, candidate)
                                     // Don't surface hard eligibility REJECTs in the grants view
                                     // (score-based weak-match REJECT is not filtered here)
                                     if (isHardEligibilityReject(decision)) return null
              return {
                        grant_id: row.grant_id,
                        title: row.grant_title,
                        funder: row.grant_funder,
                        status: row.grant_status,
                        deadline: row.grant_deadline,
                        funding_opportunity_id: row.funding_opportunity_id ?? null,
                        match_score: decision.score,
                        match_reasons: decision.matchedNeeds ?? [],
                        match_decision: decision.decision,
                        match_explanation: decision.explanation,
              }
      })
      .filter((m) => m !== null)

      matches.sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
                   res.json(matches)
             } catch (error) {
                   console.error('Error matching profile to grants:', error)
                   if (!res.headersSent) {
                       res.status(500).json(formatError(error))
                   }
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
    if (!auth || res.headersSent) return

             try {
                   const profileRow = await req.db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId)
                   if (!profileRow) {
                           return res.status(404).json({ error: 'Profile not found' })
                   }

      const readiness = await checkProfileReadiness(req.db, profileId)
      if (!readiness.ready && req.query.skip_readiness_check !== '1') {
                        return res.status(422).json({
                                    error: 'profile_not_ready',
                                    message: readiness.guidance || 'Profile requires additional information before matching.',
                                    missing: readiness.missing,
                                    score: readiness.score,
                                    guidance: readiness.guidance,
                        })
              }
      // Log warning if readiness check was bypassed
      if (!readiness.ready && req.query.skip_readiness_check === '1') {
          console.warn(`Profile ${profileId} readiness bypassed: score=${readiness.score}, missing=${readiness.missing?.join(', ')}`)
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

      const DEFAULT_MIN_SCORE = 50
      // Determine if the caller provided an explicit min_score threshold.
      // We accept only numeric strings; non-numeric values (e.g. "abc") are treated
      // as absent so they fall back to the system default without strict enforcement.
      const rawMinScore = req.query.min_score
      const parsedMinScore = rawMinScore !== undefined && rawMinScore !== ''
        ? Number.parseInt(rawMinScore, 10)
        : Number.NaN
      const requestedMinScore = Number.isFinite(parsedMinScore) ? parsedMinScore : null
      const minScore = requestedMinScore !== null ? requestedMinScore : DEFAULT_MIN_SCORE
      // When the caller explicitly set a valid numeric min_score, honor it strictly.
      // The zero-results fallback (which lowers the threshold automatically) is only
      // allowed when no explicit threshold was provided — this enforces the match slider.
      const isExplicitThreshold = requestedMinScore !== null
                   const limit = Math.min(Math.max(Number.parseInt(req.query.limit ?? '2000', 10) || 2000, 1), 5000)
                   const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : ''

      // Shared helper: split a search query string into individual phrases.
      // Splits on commas, " and " (with surrounding whitespace), or 2+ spaces,
      // producing terms that each independently contribute to SQL/scoring logic.
      const splitSearchTerms = (query) =>
        query.split(/,\s*|\s+and\s+|\s{2,}/)
          .map((t) => t.trim())
          .filter((t) => t.length >= 2)

      const baseContext = await loadProfileContext(req.db, profileId)
                   const profileContext = buildProfileFacets(baseContext)

      const isPostgres = req.db?.dialect === 'postgres'
      const activeVal = isPostgres ? 'TRUE' : '1'
      const conditions = [`is_active = ${activeVal}`]
      const params = []

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

      // Profile isolation: only global catalog entries (profile_id IS NULL) or this profile's own crawl results.
      conditions.push('(profile_id IS NULL OR profile_id = ?)')
      params.push(profileId)

      // Geographic pre-filter: only load opps in the profile's state, national, or unspecified.
      const profileState = profileContext?.signals?.location?.state || profileContext?.profile?.state
      if (profileState) {
        const natVal = isPostgres ? 'TRUE' : '1'
        conditions.push(`(state = ? OR state = 'nationwide' OR state IS NULL OR is_national = ${natVal})`)
        params.push(profileState)
      }

      // Keep results current
      conditions.push(
              `(deadline_type IN ('rolling','ongoing') OR deadline IS NULL OR deadline >= ${
                        isPostgres ? 'CURRENT_DATE' : "date('now')"
              })`,
            )

      if (q) {
              // Split on commas, "and", or multiple spaces to get individual search phrases
              // so each term independently matches via OR logic rather than requiring the
              // entire 80+ character phrase to appear verbatim in any DB field.
              const terms = splitSearchTerms(q)

              if (terms.length > 0) {
                const termClauses = terms.map(
                  () =>
                    '(LOWER(title) LIKE ? OR LOWER(description) LIKE ? OR LOWER(keywords) LIKE ? OR LOWER(categories) LIKE ?)',
                )
                conditions.push(`(${termClauses.join(' OR ')})`)
                for (const term of terms) {
                  const pattern = `%${term}%`
                  params.push(pattern, pattern, pattern, pattern)
                }
              }
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

      const healthSet = profileContext?.signals?.health
      const healthFacets = profileContext?.facets?.health ?? {}
      const kws = profileContext?.signals?.keywordSet ?? new Set()
      const filterHints = {
              hasHealthNeeds:
                (healthSet instanceof Set && healthSet.size > 0) ||
                healthFacets.disability_types?.length > 0 ||
                healthFacets.visual_impairment || healthFacets.hearing_impairment ||
                healthFacets.chronic_illness || healthFacets.mental_health_condition ||
                kws.has('disability') || kws.has('chronic') || kws.has('mental health') || kws.has('epilepsy'),
              needsTransport: kws.has('transportation') || kws.has('ride assistance'),
      }

      // Pre-normalize profile once for the v2.0.0 REJECT filter (avoids re-running per opportunity)
      const rawProfileForDecision = profileContext?.profile ?? profileContext
      const profileSectionsForDecision = profileContext?.sections ?? null
      const profileNormForDecision = normalizeProfile(rawProfileForDecision, profileSectionsForDecision, baseContext.signals)

      // Merge search-keyword-derived needs into profile for scoring.
      // The search keywords only filter the SQL query by default; here we also
      // inject any recognized canonical need categories so that need alignment
      // scoring returns meaningful scores for sparse individual profiles.
      if (q) {
        const searchTerms = splitSearchTerms(q)
          .map((t) => t.toLowerCase().replace(/[\s-]+/g, '_'))

        for (const term of searchTerms) {
          const canonical = normalizeNeedCategory(term)
          if (canonical && !profileNormForDecision.needCategories.includes(canonical)) {
            profileNormForDecision.needCategories.push(canonical)
          }
          // Also try individual words within compound terms (e.g. "work_clothing" → "clothing")
          for (const word of term.split('_')) {
            const wCanonical = normalizeNeedCategory(word)
            if (wCanonical && !profileNormForDecision.needCategories.includes(wCanonical)) {
              profileNormForDecision.needCategories.push(wCanonical)
            }
          }
        }
      }

      const allScored = candidates
                     .map((opp) => {
                                  if (isJunkOpportunity(opp, filterHints)) return null

                                  // Run canonical engine: filter hard eligibility failures (REJECT) before surfacing
                                  // Score-based weak-match REJECT is not filtered here — that is handled by min_score below.
                                  const decision = computeMatchDecision(profileContext, opp)
                                  if (isHardEligibilityReject(decision)) return null

                               return {
                                           ...opp,
                                           match_score: decision.score,
                                           match_reasons: decision.matchedNeeds ?? [],
                                           match_decision: decision.decision,
                                           match_explanation: decision.explanation,
                                           url: opp.application_url ?? opp.source_url ?? null,
                               }
                     })
                     .filter((opp) => opp !== null)

      allScored.sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))

      let scored = Number.isFinite(minScore)
        ? allScored.filter((opp) => (opp.match_score ?? 0) >= minScore)
        : allScored

      // Zero-results fallback: only applies when caller did NOT set an explicit threshold.
      // When the user sets a threshold (e.g. 80% via the slider), we MUST NOT return
      // results below that threshold — honoring the slider is a product requirement.
      let effectiveMinScore = minScore
      if (scored.length === 0 && allScored.length > 0 && !isExplicitThreshold) {
        const fallbackThresholds = [30, 15, 0]
        for (const threshold of fallbackThresholds) {
          scored = allScored.filter((opp) => (opp.match_score ?? 0) >= threshold)
          if (scored.length > 0) {
            effectiveMinScore = threshold
            console.info(`[matching] Zero results at min_score=${minScore}; relaxed to ${threshold} (${scored.length} results)`)
            break
          }
        }
        if (scored.length === 0) {
          scored = allScored.slice(0, 20)
          effectiveMinScore = 0
          console.info(`[matching] All thresholds exhausted; returning top ${scored.length} of ${allScored.length}`)
        }
      }

      const MAX_RESPONSE = 500
      const capped = scored.length > MAX_RESPONSE ? scored.slice(0, MAX_RESPONSE) : scored

      res.json({
              profile_id: profileId,
              min_score: Number.isFinite(effectiveMinScore) ? effectiveMinScore : null,
              total_scored: candidates.length,
              returned: capped.length,
              opportunities: capped,
              threshold_relaxed: effectiveMinScore !== minScore ? true : undefined,
              truncated: scored.length > MAX_RESPONSE ? true : undefined,
      })
             } catch (error) {
                   console.error('Error matching profile to opportunities:', error)
                   if (!res.headersSent) {
                       res.status(500).json(formatError(error))
                   }
             }
})

export default router
