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
      const sortBy = req.query.sort_by ?? 'match_score' // match_score | deadline | amount | recently_added
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

      // Sort by user-requested criteria
      if (sortBy === 'recently_added') {
        allScored.sort((a, b) => new Date(b.created_at ?? 0) - new Date(a.created_at ?? 0))
      } else if (sortBy === 'deadline') {
        allScored.sort((a, b) => {
          const da = a.deadline ? new Date(a.deadline) : new Date('2099-12-31')
          const db = b.deadline ? new Date(b.deadline) : new Date('2099-12-31')
          return da - db
        })
      } else if (sortBy === 'amount') {
        allScored.sort((a, b) => (b.amount_max ?? b.amount_min ?? 0) - (a.amount_max ?? a.amount_min ?? 0))
      } else {
        allScored.sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
      }

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
        const rawScores = allScored
          .map(o => typeof o.match_score === 'number' ? o.match_score : 0)
          .sort((a, b) => b - a)
        const bestScore = rawScores[0] || 0
        const sugIdx = Math.min(4, rawScores.length - 1)
        const suggestedThreshold = Math.max(5, Math.floor(rawScores[sugIdx] / 5) * 5)
        const countAtSuggested = rawScores.filter(s => s >= suggestedThreshold).length
        allScored._scoreHint = { bestScore, suggestedThreshold, countAtSuggested, totalScored: rawScores.length }
        console.info(`[matching] strict min_score=${minScore} — no relax; returning 0 of ${allScored.length} scored (best=${bestScore}, suggest=${suggestedThreshold})`)
      }

      const MAX_RESPONSE = 500
      const capped = scored.length > MAX_RESPONSE ? scored.slice(0, MAX_RESPONSE) : scored

      res.json({
              profile_id: profileId,
              min_score: Number.isFinite(effectiveMinScore) ? effectiveMinScore : null,
              total_scored: candidates.length,
              returned: capped.length,
              opportunities: capped,
              score_hint: allScored._scoreHint || null,
              threshold_relaxed: effectiveMinScore !== minScore ? true : undefined,
              truncated: scored.length > MAX_RESPONSE ? true : undefined,
      })
             } catch (error) {
                   console.error('Error matching profile to opportunities:', error)
                   res.status(500).json(formatError(error))
             }
})

/**
 * GET /api/matching/profile/:profileId/matching-gaps
 *
 * Returns only the profile data gaps that actually affect match scoring.
 * Each gap includes: id, label, description, section_key (for deep-link),
 * and impact (how much fixing it improves matches).
 *
 * Also returns "success_steps" — real-world items the person needs based
 * on their stated goals/narrative (e.g., vendor's license, food truck).
 */
router.get('/profile/:profileId/matching-gaps', async (req, res) => {
  const profileId = req.params.profileId
  const auth = await requireProfileAccess(req, res, profileId)
  if (!auth) return

  try {
    const profileRow = await req.db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId)
    if (!profileRow) {
      return res.status(404).json({ error: 'Profile not found' })
    }

    let sectionRows = []
    try {
      sectionRows = await req.db
        .prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?')
        .all(String(profileId))
    } catch { /* sections table may not exist */ }

    const sections = sectionRows.reduce((acc, row) => {
      try { acc[row.section_key] = row.data ? JSON.parse(row.data) : {} }
      catch { acc[row.section_key] = {} }
      return acc
    }, {})

    const basic = sections.basic_information ?? {}
    const orgDetails = sections.organization_details ?? {}
    const demographics = sections.demographics ?? {}
    const financial = sections.financial_information ?? {}
    const narrative = sections.narrative ?? {}
    const programsServices = sections.programs_services ?? {}
    const health = sections.health_medical ?? {}
    const familyLife = sections.family_life ?? {}
    const military = sections.military_service ?? {}

    const applicantType =
      profileRow.applicant_type ?? profileRow.primary_type ?? profileRow.primary_profile_type ?? basic.profile_category ?? null

    const state = basic.state || profileRow.state || null
    const zip = basic.zip_code || profileRow.postal_code || profileRow.zip || profileRow.zip_code || null

    const hasGoal = Boolean(
      narrative.primary_goal || narrative.mission || narrative.target_population ||
      programsServices.focus_areas?.length || programsServices.keywords?.length ||
      programsServices.interests?.length ||
      profileRow.keywords?.length || profileRow.interests?.length || profileRow.tags?.length
    )

    const hasDemographics = Boolean(
      demographics.veteran_status || demographics.minority_owned || demographics.disability ||
      demographics.lgbtq || demographics.immigrant_status ||
      health.disability_type || health.chronic_illness || health.mental_health_condition ||
      military.veteran || military.active_duty ||
      familyLife.single_parent || familyLife.foster_youth || familyLife.caregiver
    )

    const isOrgType = ['nonprofit', 'small_business', 'organization', 'government', 'church', 'school']
      .includes((applicantType || '').toLowerCase().replace(/\s+/g, '_'))

    const hasOrgDetails = !isOrgType || Boolean(
      orgDetails.ein || orgDetails.organization_type || orgDetails.mission || orgDetails.annual_budget
    )

    const hasBudget = Boolean(
      financial.household_income || financial.annual_revenue || financial.funding_amount_needed ||
      narrative.funding_amount_needed || orgDetails.annual_budget
    )

    // Check for uploaded documents
    let docCount = 0
    try {
      const docRow = await req.db.prepare(
        'SELECT COUNT(*) as cnt FROM documents WHERE profile_id = ?'
      ).get(String(profileId))
      docCount = docRow?.cnt ?? 0
    } catch { /* documents table may not exist */ }

    const hasStory = Boolean(
      narrative.story || narrative.background || narrative.barriers_faced || narrative.primary_goal
    )

    // Build the gaps array — only items that are genuinely missing
    const gaps = []

    if (!applicantType) {
      gaps.push({
        id: 'profile_type',
        label: 'Set your profile type',
        description: 'Tells the matcher whether you\'re an individual, business, nonprofit, church, etc. — different types unlock different funding pools.',
        section_key: 'basic_information',
        impact: 'critical',
      })
    }

    if (!state && !zip) {
      gaps.push({
        id: 'state_zip',
        label: 'Add your state or ZIP code',
        description: 'Many grants are location-specific. Without this, you\'ll miss state, county, and regional opportunities.',
        section_key: 'basic_information',
        impact: 'critical',
      })
    }

    if (!hasGoal) {
      gaps.push({
        id: 'primary_goal',
        label: 'Define your primary goal or need',
        description: 'What you\'re trying to accomplish (e.g., start a food truck, repair a roof). This drives the entire matching engine.',
        section_key: 'narrative',
        impact: 'critical',
      })
    }

    if (!hasDemographics) {
      gaps.push({
        id: 'demographics',
        label: 'Complete your demographics',
        description: 'Details like veteran status, minority-owned, or disability unlock targeted funding that generic profiles miss.',
        section_key: 'demographics',
        impact: 'high',
      })
    }

    if (isOrgType && !hasOrgDetails) {
      gaps.push({
        id: 'org_details',
        label: 'Fill in organization details',
        description: 'EIN, founding year, staff count, and budget help match you to grants with specific eligibility thresholds.',
        section_key: 'organization_details',
        impact: 'high',
      })
    }

    if (!hasBudget) {
      gaps.push({
        id: 'budget_range',
        label: 'Specify a budget or funding amount',
        description: 'Funders filter by award size. Specifying your budget range avoids matches that are too small or too large.',
        section_key: 'financial_information',
        impact: 'medium',
      })
    }

    if (docCount === 0) {
      gaps.push({
        id: 'documents',
        label: 'Upload supporting documents',
        description: 'Letters of support, 501(c)(3) determination, or financial statements strengthen your profile and improve proposal readiness.',
        section_key: null, // handled via Documents tab, not a section
        impact: 'medium',
      })
    }

    if (!hasStory) {
      gaps.push({
        id: 'story_narrative',
        label: 'Write your story or narrative',
        description: 'Your story is parsed for keywords that trigger need detection — the more detail you provide, the better the matcher works.',
        section_key: 'narrative',
        impact: 'high',
      })
    }

    // ── Success steps: real-world items needed based on goals/narrative ──
    const successSteps = buildSuccessSteps(profileRow, sections, applicantType)

    res.json({
      profile_id: profileId,
      gaps,
      total_gaps: gaps.length,
      completed: 8 - gaps.length,
      total_items: 8,
      success_steps: successSteps,
    })
  } catch (error) {
    console.error('[matching/matching-gaps]', error)
    res.status(500).json(formatError(error))
  }
})

/**
 * Analyze profile goals/narrative and surface real-world next steps.
 * For example, a food truck business needs: vendor's license, health permit, truck, etc.
 */
function buildSuccessSteps(profile, sections, applicantType) {
  const narrative = sections.narrative ?? {}
  const orgDetails = sections.organization_details ?? {}
  const basic = sections.basic_information ?? {}
  const financial = sections.financial_information ?? {}

  const goal = (
    narrative.primary_goal || narrative.mission || orgDetails.mission ||
    profile.display_name || ''
  ).toLowerCase()

  const story = (narrative.story || narrative.background || narrative.barriers_faced || '').toLowerCase()
  const allText = `${goal} ${story} ${(profile.tags || []).join(' ')} ${(profile.keywords || []).join(' ')}`.toLowerCase()

  const steps = []
  const type = (applicantType || '').toLowerCase()

  // ── Business-related ──
  if (type.includes('business') || type.includes('entrepreneur') || allText.includes('business') || allText.includes('startup')) {
    if (!allText.includes('ein') && !orgDetails.ein) {
      steps.push({ label: 'Obtain an EIN (Employer Identification Number)', category: 'legal', why: 'Required for most business grants and bank accounts' })
    }
    if (!allText.includes('license') && !allText.includes('permit')) {
      steps.push({ label: 'Get a business license / vendor permit', category: 'legal', why: 'Required before operating in most jurisdictions' })
    }
    if (!allText.includes('business plan')) {
      steps.push({ label: 'Write a business plan', category: 'planning', why: 'Most business grants require a formal plan with budget projections' })
    }
  }

  // ── Food truck / restaurant ──
  if (allText.includes('food truck') || allText.includes('food business') || allText.includes('catering') || allText.includes('restaurant')) {
    steps.push({ label: 'Obtain a food handler\'s / health department permit', category: 'legal', why: 'Required before serving food to the public' })
    if (allText.includes('food truck') && !allText.includes('truck')) {
      steps.push({ label: 'Secure a food truck or commercial vehicle', category: 'equipment', why: 'Your primary asset — many grants cover vehicle acquisition' })
    }
    steps.push({ label: 'Get a mobile vendor\'s license', category: 'legal', why: 'Required in most cities for mobile food operations' })
    if (!allText.includes('insurance')) {
      steps.push({ label: 'Obtain commercial liability insurance', category: 'insurance', why: 'Required by most commissary kitchens and event venues' })
    }
  }

  // ── Nonprofit / church ──
  if (type.includes('nonprofit') || type.includes('church') || type.includes('ministry')) {
    if (!orgDetails.ein) {
      steps.push({ label: 'File for 501(c)(3) tax-exempt status', category: 'legal', why: 'Most foundation and government grants require 501(c)(3) determination' })
    }
    if (!orgDetails.sam_gov_registered) {
      steps.push({ label: 'Register on SAM.gov', category: 'compliance', why: 'Required for all federal grant applications' })
    }
    if (!orgDetails.grants_gov_account) {
      steps.push({ label: 'Create a Grants.gov account', category: 'compliance', why: 'Federal grant applications are submitted through Grants.gov' })
    }
  }

  // ── Transportation / vehicle ──
  if (allText.includes('van') || allText.includes('vehicle') || allText.includes('transportation') || allText.includes('bus')) {
    if (!allText.includes('insurance')) {
      steps.push({ label: 'Get commercial vehicle insurance', category: 'insurance', why: 'Required before operating passenger or commercial vehicles' })
    }
    if (allText.includes('passenger') || allText.includes('transport')) {
      steps.push({ label: 'Obtain passenger transport license/permit', category: 'legal', why: 'Required for transporting passengers commercially' })
    }
  }

  // ── Housing / rent ──
  if (allText.includes('housing') || allText.includes('rent') || allText.includes('mortgage') || allText.includes('home repair')) {
    if (!allText.includes('lease') && (allText.includes('rent') || allText.includes('housing'))) {
      steps.push({ label: 'Gather lease or mortgage documentation', category: 'documentation', why: 'Housing assistance programs require proof of your housing situation' })
    }
    if (allText.includes('repair') || allText.includes('renovation')) {
      steps.push({ label: 'Get repair estimates from licensed contractors', category: 'planning', why: 'Grant applications require detailed cost estimates for repairs' })
    }
  }

  // ── Education / student ──
  if (type.includes('student') || allText.includes('tuition') || allText.includes('scholarship') || allText.includes('college')) {
    if (!allText.includes('fafsa')) {
      steps.push({ label: 'Complete the FAFSA application', category: 'financial_aid', why: 'Required for most federal and institutional financial aid' })
    }
    if (!allText.includes('transcript')) {
      steps.push({ label: 'Request official transcripts', category: 'documentation', why: 'Most scholarship applications require academic records' })
    }
  }

  // ── Medical / disability ──
  if (allText.includes('medical') || allText.includes('disability') || allText.includes('equipment') || allText.includes('wheelchair')) {
    if (!allText.includes('prescription') && !allText.includes('doctor')) {
      steps.push({ label: 'Get a physician\'s letter documenting medical need', category: 'documentation', why: 'Medical equipment and disability grants require documented need' })
    }
  }

  // ── General financial need ──
  if (allText.includes('income') || allText.includes('poverty') || allText.includes('financial need') || allText.includes('low income')) {
    if (!financial.household_income) {
      steps.push({ label: 'Document household income (pay stubs, tax returns)', category: 'documentation', why: 'Need-based programs require income verification' })
    }
  }

  // Deduplicate by label
  const seen = new Set()
  return steps.filter(s => {
    if (seen.has(s.label)) return false
    seen.add(s.label)
    return true
  })
}

export default router
