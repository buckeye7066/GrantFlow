import express from 'express'
import { formatError } from '../middleware/errorHandler.js'
import { computeMatchDecision, normalizeProfile } from '../services/matchDecisionEngine.js'
import { loadProfileContext } from '../services/profileHelpers.js'
import { buildProfileFacets } from '../services/profile/profileTaxonomy.js'
import { ensureProfileAccess } from '../utils/accessControl.js'
import { getDataReadiness } from '../services/dataReadinessService.js'
import { checkProfileReadiness } from '../services/profileReadinessService.js'
import { trustedOriginClause, trustedSourceClause } from '../utils/recordOrigins.js'
import { isJunkOpportunity } from '../services/contentFilter.js'
import { interpretFundingIntent, sanitizeSearchTerm } from '../services/smartMatcherIntent.js'
import { createOpenAIClient } from '../utils/openaiClient.js'

const router = express.Router()

/** @param {import('express').Request} req */
function collectSearchTermsFromQuery(req) {
  const terms = []
  const q = typeof req.query.q === 'string' ? sanitizeSearchTerm(req.query.q) : ''
  if (q) terms.push(q)

  const raw = req.query.q_terms
  const arr = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]
  for (const t of arr) {
    const s = sanitizeSearchTerm(String(t))
    if (s) terms.push(s)
  }

  const out = []
  const seen = new Set()
  for (const t of terms) {
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
    if (out.length >= 16) break
  }
  return out
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
 * POST /api/matching/interpret-intent
 * Parse free-text funding needs into catalog search terms (rules + optional OpenAI).
 */
router.post('/interpret-intent', async (req, res) => {
  const ctx = requireAuth(req, res)
  if (!ctx) return
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text : ''
    if (!String(text).trim()) {
      return res.status(400).json({
        error: 'text_required',
        message: 'Describe what you are looking for in the text field.',
      })
    }
    let openai = null
    try {
      const r = createOpenAIClient({ allowMissing: true })
      openai = r?.openai ?? null
    } catch {
      openai = null
    }
    const result = await interpretFundingIntent(text, { openai })
    res.json({ ok: true, ...result })
  } catch (error) {
    console.error('[matching/interpret-intent]', error)
    res.status(500).json(formatError(error))
  }
})

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

      // Pre-normalize profile once for the v2.0.0 decision engine.
      // CRITICAL: pass signals so needCategories are populated from buildProfileSignals().
      const rawProfileForGrants = profileContext?.profile ?? profileContext
      const profileSectionsForGrants = profileContext?.sections ?? null
      const profileNormForDecision = normalizeProfile(rawProfileForGrants, profileSectionsForGrants, profileContext?.signals ?? null)

      // Query grants by organization_id if set, otherwise fall back to profile_id-scoped grants.
      let rows
      if (profileRow.organization_id) {
        rows = await req.db
          .prepare(
            `SELECT g.id AS grant_id, g.title AS grant_title, g.funder AS grant_funder,
                    g.status AS grant_status, g.deadline AS grant_deadline, g.notes AS grant_notes,
                    g.funding_opportunity_id, fo.*
             FROM grants g
             LEFT JOIN funding_opportunities fo ON fo.id = g.funding_opportunity_id
             WHERE g.organization_id = ?
             ORDER BY g.updated_at DESC, g.created_at DESC`,
          )
          .all(profileRow.organization_id)
      } else {
        // Profile exists but has no linked organization — check for profile-scoped grants.
        rows = await req.db
          .prepare(
            `SELECT g.id AS grant_id, g.title AS grant_title, g.funder AS grant_funder,
                    g.status AS grant_status, g.deadline AS grant_deadline, g.notes AS grant_notes,
                    g.funding_opportunity_id, fo.*
             FROM grants g
             LEFT JOIN funding_opportunities fo ON fo.id = g.funding_opportunity_id
             WHERE g.profile_id = ?
             ORDER BY g.updated_at DESC, g.created_at DESC`,
          )
          .all(profileId)
        if (rows.length === 0) {
          return res.json([])
        }
      }

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

                                     // Use the canonical decision engine for scoring; fall back gracefully
                                     const decision = computeMatchDecision(profileNormForDecision, candidate)
                                     // Don't surface hard REJECTS in the grants view either
                                     if (decision.decision === 'REJECT') return null
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
      // When strict=1 (Discover slider), do not relax threshold — honor the user's minimum match %.
      const strictMin =
        req.query.strict === '1' ||
        req.query.allow_relax === '0' ||
        String(req.query.relax ?? '1') === '0'
      const limit = Math.min(Math.max(Number.parseInt(req.query.limit ?? '2000', 10) || 2000, 1), 5000)
      const searchTerms = collectSearchTermsFromQuery(req)

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

      if (searchTerms.length > 0) {
        const orParts = searchTerms.map(
          () =>
            '(LOWER(title) LIKE ? OR LOWER(description) LIKE ? OR LOWER(keywords) LIKE ? OR LOWER(categories) LIKE ?)',
        )
        conditions.push(`(${orParts.join(' OR ')})`)
        for (const t of searchTerms) {
          const pattern = `%${t}%`
          params.push(pattern, pattern, pattern, pattern)
        }
        if (searchTerms.length > 1) {
          console.info(`[matching] catalog filter: ${searchTerms.length} OR search terms (smart matcher / multi-keyword)`)
        }
      }

      // (profile isolation already applied above; no duplicate needed)

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

      // Pre-normalize profile once for the v2.0.0 REJECT filter (avoids re-running per opportunity).
      // CRITICAL: pass signals so needCategories are populated from buildProfileSignals().
      const rawProfileForDecision = profileContext?.profile ?? profileContext
      const profileSectionsForDecision = profileContext?.sections ?? null
      const profileNormForDecision = normalizeProfile(rawProfileForDecision, profileSectionsForDecision, profileContext?.signals ?? null)

      const allScored = candidates
                     .map((opp) => {
                                  if (isJunkOpportunity(opp, filterHints)) return null

                                  // Run v2.0.0 engine: filter hard ineligibles (REJECT) before surfacing
                                  const decision = computeMatchDecision(profileNormForDecision, opp)
                                  if (decision.decision === 'REJECT') return null

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

      // Zero-results fallback: progressively lower threshold so users always see results.
      // Skipped when strict=1 (Discover page) so the UI min-match slider is honored.
      let effectiveMinScore = minScore
      if (!strictMin && scored.length === 0 && allScored.length > 0) {
        const fallbackThresholds = [30, 15, 0]
        for (const threshold of fallbackThresholds) {
          scored = allScored.filter((opp) => (opp.match_score ?? 0) >= threshold)
          if (scored.length > 0) {
            effectiveMinScore = threshold
            console.log(`[matching] Zero results at min_score=${minScore}; relaxed to ${threshold} (${scored.length} results)`)
            break
          }
        }
        if (scored.length === 0) {
          scored = allScored.slice(0, 20)
          effectiveMinScore = 0
          console.log(`[matching] All thresholds exhausted; returning top ${scored.length} of ${allScored.length}`)
        }
      } else if (strictMin && scored.length === 0 && allScored.length > 0) {
        console.info(`[matching] strict min_score=${minScore} — no relax; returning 0 of ${allScored.length} scored`)
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
                   res.status(500).json(formatError(error))
             }
})

export default router
