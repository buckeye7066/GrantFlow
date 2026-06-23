import express from 'express'
import { formatError } from '../middleware/errorHandler.js'
import { computeMatchDecision, normalizeProfile } from '../services/matchDecisionEngine.js'
import { loadPreferenceSignals } from '../services/matchEngine.js'
import { loadProfileContext, buildProfileSignalAudit } from '../services/profileHelpers.js'
import { buildProfileFacets } from '../services/profile/profileTaxonomy.js'
import { ensureProfileAccess } from '../utils/accessControl.js'
import { getDataReadiness } from '../services/dataReadinessService.js'
import { checkProfileReadiness } from '../services/profileReadinessService.js'
import { getProfileFieldPrompts } from '../services/profileFieldPrompts.js'
import { trustedOriginClause, trustedSourceClause } from '../utils/recordOrigins.js'
import { isJunkOpportunity } from '../services/contentFilter.js'
import {
  interpretFundingIntent,
  sanitizeSearchTerm,
  detectPrimaryCategory,
  INCOME_SUPPORT_CATEGORIES,
} from '../services/smartMatcherIntent.js'
import { createOpenAIClient } from '../utils/openaiClient.js'
import { assessOpportunityTrust } from '../services/opportunityTrust.js'
import { DEFAULT_MIN_SCORE } from '../config/matchThresholds.js'
import {
  applyFundableOpportunityNormalization,
  evaluateFundableOpportunity,
} from '../services/matching/qualityGate.js'
import { deriveMatchReasonCodes, MATCH_REASON_CODES } from '../services/matching/reasons.js'
import { normalizeOpportunityState, normalizeState } from '../utils/stateNormalization.js'
import { assembleFundingResults, TIERS as ZERO_RESULT_TIERS } from '../services/zeroResultLadder.js'
import { evaluatePipelineSource } from '../config/pipelineAllowedSources.js'
import { evaluateApplicantTypeEligibility } from '../services/applicantTypeGate.js'
import { filterOutPipelineMembers, dedupeOpportunityList } from '../services/pipelineExclusion.js'
import {
  detectProfessionalDevelopmentIntent,
  loadCuratedProfessionalDevelopmentPrograms,
  applyProfessionalDevelopmentQueryPolicy,
  recordLowCoverageEvent,
} from '../services/matching/professionalDevelopmentPolicy.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:matching')

const router = express.Router()

router.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'matching',
    status: 'healthy',
    checked_at: new Date().toISOString(),
  })
})

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
 * Map a raw source / record_origin token to a USER-FRIENDLY source family
 * label for the Discover guidance band. Keeps jargon (geo_crawl,
 * grants_gov, foundation_990, web_search…) out of the UI. Anything we don't
 * recognize collapses to a sensible generic bucket so the band never shows a
 * snake_case blob.
 *
 * @param {string} source
 * @param {string} recordOrigin
 * @returns {string} friendly family label
 */
function friendlySourceFamily(source, recordOrigin) {
  const raw = `${String(source ?? '')} ${String(recordOrigin ?? '')}`.toLowerCase()
  if (!raw.trim()) return 'Other programs'
  if (/grants?[._-]?gov|federal|nih|sam|usaspending|fed_/.test(raw)) return 'Federal grants'
  if (/foundation|990|philanthrop/.test(raw)) return 'Foundation grants'
  if (/scholarship|school|student|college|university|education/.test(raw)) return 'Scholarships & student aid'
  if (/web[._-]?search|web_|duckduckgo|brave|live/.test(raw)) return 'Web-discovered leads'
  if (/state|local|geo|county|city|directory|curated|benefit/.test(raw)) return 'Local programs & benefits'
  return 'Other programs'
}

/**
 * Build a score histogram from ALL scored opportunities (BEFORE the slider's
 * min-score filter) so the frontend can render a data-driven guidance band
 * across the 0–80 range. Each bucket reports its [min,max) range, how many
 * scored opportunities fell in it, and the dominant friendly source family.
 * The 0–80 cap mirrors the slider's realistic strong-match ceiling; anything
 * scored above 80 folds into the top bucket so no result is invisible.
 *
 * @param {Array<{ match_score?: number, source?: string, record_origin?: string }>} scoredList
 * @param {{ bucketSize?: number, max?: number }} [opts]
 * @returns {Array<{ min: number, max: number, count: number, top_source: string|null }>}
 */
function buildScoreHistogram(scoredList, { bucketSize = 20, max = 80 } = {}) {
  if (!Array.isArray(scoredList) || scoredList.length === 0) return []
  const bucketCount = Math.max(1, Math.ceil(max / bucketSize))
  const buckets = Array.from({ length: bucketCount }, (_, i) => ({
    min: i * bucketSize,
    max: i === bucketCount - 1 ? max : (i + 1) * bucketSize,
    count: 0,
    _families: new Map(),
  }))
  for (const opp of scoredList) {
    const score = Number(opp?.match_score)
    if (!Number.isFinite(score)) continue
    let idx = Math.floor(score / bucketSize)
    if (idx >= bucketCount) idx = bucketCount - 1
    if (idx < 0) idx = 0
    const bucket = buckets[idx]
    bucket.count++
    const family = friendlySourceFamily(opp?.source, opp?.record_origin)
    bucket._families.set(family, (bucket._families.get(family) || 0) + 1)
  }
  return buckets.map((b) => {
    let topSource = null
    let topCount = -1
    for (const [family, n] of b._families) {
      if (n > topCount) { topCount = n; topSource = family }
    }
    return { min: b.min, max: b.max, count: b.count, top_source: topSource }
  })
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
router.get('/profile/:profileId/grants', async (req, res, next) => {
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
      // RC-17: pass documents so extracted_text from uploaded files folds
      // into the canonical need vocabulary.
      const rawProfileForGrants = profileContext?.profile ?? profileContext
      const profileSectionsForGrants = profileContext?.sections ?? null
      const profileDocumentsForGrants = profileContext?.documents ?? null
      const profileNormForDecision = normalizeProfile(
        rawProfileForGrants,
        profileSectionsForGrants,
        profileContext?.signals ?? null,
        profileDocumentsForGrants,
      )

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
                                     const matchReasons = deriveMatchReasonCodes(decision, candidate)
                                     if (matchReasons.length === 0) return null
              return {
                        grant_id: row.grant_id,
                        title: row.grant_title,
                        funder: row.grant_funder,
                        status: row.grant_status,
                        deadline: row.grant_deadline,
                        funding_opportunity_id: row.funding_opportunity_id ?? null,
                        match_score: decision.score,
                        match_reasons: matchReasons,
                        match_decision: decision.decision,
                        match_explanation: decision.explanation,
              }
      })
      .filter((m) => m !== null)

      matches.sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
                   res.json(matches)
             } catch (error) {
                   // Delegate to the global errorHandler choke point: it records
                   // the error (G1 observability) and maps transient DB
                   // contention -> retryable 503, real faults -> 500. One place.
                   next(error)
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
router.get('/profile/:profileId/opportunities', async (req, res, next) => {
    const profileId = req.params.profileId
    const auth = await requireProfileAccess(req, res, profileId)
    if (!auth) return

             try {
                   const profileRow = await req.db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId)
                   if (!profileRow) {
                           return res.status(404).json({ error: 'Profile not found' })
                   }

      // ── Discovery-pending gate ───────────────────────────────────────────
      // NOTHING from the (global) catalog is surfaced for a profile until
      // discovery has actually RUN for it. `profiles.last_discovery_at` is the
      // per-profile signal (stamped by triggerAutoDiscoveryCrawlers + the
      // realCrawlers POST handlers). When it is NULL, return a 200 with an
      // EMPTY list + discovery_pending:true + a friendly message instead of
      // querying the catalog — so a fresh profile shows a "run discovery"
      // empty state, not pre-loaded global results. Admin/debug callers can
      // bypass with ?ignore_discovery_gate=1. Tolerant: if the column is
      // missing on an older DB the read throws and we fall through to normal
      // behavior (the boot invariant adds it).
      if (req.query.ignore_discovery_gate !== '1') {
        let discoveryStamp
        try {
          discoveryStamp = profileRow.last_discovery_at
        } catch {
          discoveryStamp = undefined
        }
        const discoveryHasRun = discoveryStamp !== null && discoveryStamp !== undefined
        if (discoveryStamp !== undefined && !discoveryHasRun) {
          // Even before discovery has run, tell the user which high-value
          // profile fields — if filled — would unlock/improve their matches
          // (Architecture P1). Additive + tolerant: never blocks the response.
          const profileFieldPrompts = await getProfileFieldPrompts(req.db, profileId)
          return res.json({
            profile_id: profileId,
            discovery_pending: true,
            message: 'Run discovery to find funding for this profile.',
            opportunities: [],
            referrals: [],
            returned: 0,
            qualified_count: 0,
            total_scored: 0,
            score_histogram: [],
            profile_field_prompts: profileFieldPrompts,
          })
        }
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

      // ── Crawler OS first: serve canonical per-profile matches ────────────
      // The Crawler OS is the single matching authority. When it has scored this
      // profile (profile_opportunity_matches rows with matcher_version
      // 'crawler-os'), serve those — mapped to the response shape, pipeline
      // members excluded — instead of recomputing with the legacy scorer. The
      // legacy path below remains as a reversible fallback (?legacy_matching=1)
      // and for profiles the OS has not yet scored.
      if (req.query.legacy_matching !== '1') {
        let osRows = []
        try {
          osRows = await req.db
            .prepare(
              `SELECT o.*, m.match_score AS os_match_score, m.match_decision AS os_match_decision,
                      m.match_explanation AS os_match_explanation, m.match_reasons AS os_match_reasons
                 FROM profile_opportunity_matches m
                 JOIN funding_opportunities o ON o.id = m.opportunity_id
                WHERE m.profile_id = ? AND m.matcher_version = 'crawler-os'
                  AND (o.is_active IS NULL OR o.is_active = 1)
                  AND (o.is_hidden IS NULL OR o.is_hidden = 0)
                ORDER BY m.match_score DESC`,
            )
            .all(profileId)
        } catch {
          osRows = []
        }
        if (osRows.length > 0) {
          const osMin = Number.isFinite(Number.parseInt(req.query.min_score, 10))
            ? Number.parseInt(req.query.min_score, 10)
            : 50
          let mapped = osRows.map((o) => {
            const kind = String(o.opportunity_kind ?? '').toUpperCase()
            const isDirectory = kind === 'DIRECTORY' || kind === 'PAST_AWARD_INTEL'
            let reasons = []
            try { reasons = JSON.parse(o.os_match_reasons || '[]') } catch { reasons = [] }
            return {
              ...o,
              match_score: o.os_match_score,
              match_decision: o.os_match_decision,
              match_explanation: o.os_match_explanation,
              match_reasons: reasons,
              is_directory: isDirectory,
              trust_tier: o.source_trust_tier ?? null,
              url: o.application_url ?? o.apply_url ?? o.source_url ?? null,
              actionable_url: o.application_url ?? o.apply_url ?? o.source_url ?? null,
              engine: 'crawler-os',
            }
          })
          // dedupeOpportunityList / filterOutPipelineMembers return { results, ... }
          mapped = dedupeOpportunityList(mapped).results
          mapped = (await filterOutPipelineMembers(req.db, profileId, mapped)).results
          const qualified = mapped.filter((o) => Number(o.match_score) >= osMin)
          const profileFieldPrompts = await getProfileFieldPrompts(req.db, profileId)
          return res.json({
            profile_id: profileId,
            engine: 'crawler-os',
            min_score: osMin,
            total_scored: mapped.length,
            returned: qualified.length,
            qualified_count: qualified.length,
            score_histogram: [],
            opportunities: qualified,
            referrals: [],
            profile_field_prompts: profileFieldPrompts,
          })
        }
      }

      const minScore = Number.parseInt(req.query.min_score ?? String(DEFAULT_MIN_SCORE), 10)
      // When strict=1 (Discover slider), do not relax threshold — honor the user's minimum match %.
      const strictMin =
        req.query.strict === '1' ||
        req.query.allow_relax === '0' ||
        String(req.query.relax ?? '1') === '0'
      const limit = Math.min(Math.max(Number.parseInt(req.query.limit ?? '2000', 10) || 2000, 1), 5000)
      const sortBy = req.query.sort_by ?? 'match_score' // match_score | deadline | amount | recently_added
      const searchTerms = collectSearchTermsFromQuery(req)
      const freeTextNeed = typeof req.query.need_text === 'string' ? req.query.need_text.trim() : ''

      // ── Primary-category routing (spec §3, §4) ────────────────────────────
      // The frontend passes primary_category from interpretFundingIntent.
      // We also re-detect server-side from the search terms so older clients
      // and direct API callers get the same protection (defense in depth).
      const queryPrimaryCategory = typeof req.query.primary_category === 'string'
        ? String(req.query.primary_category).toLowerCase().trim()
        : ''
      const explicitlyIncludeIncomeSupport =
        req.query.include_income_support === '1' || req.query.allow_income_support === '1'

      const detectedCat = detectPrimaryCategory(searchTerms.join(' '), searchTerms)
      const effectivePrimaryCategory = queryPrimaryCategory || detectedCat.primary_category
      const queryExcluded = String(req.query.excluded_categories ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
      const excludedCategories = new Set([
        ...queryExcluded,
        ...(detectedCat.excluded_categories || []),
        ...(effectivePrimaryCategory === 'professional_development'
          ? INCOME_SUPPORT_CATEGORIES
          : []),
      ])

      // Spec §3: when professional_development is the intent, hard-exclude
      // means-tested cash-assistance programs from the SQL candidate set
      // (NOT just from the score). This is the rule "exclude general
      // means-tested cash-assistance programs unless explicitly requested."
      const applyProfDevExclusion =
        effectivePrimaryCategory === 'professional_development' &&
        !explicitlyIncludeIncomeSupport

      const baseContext = await loadProfileContext(req.db, profileId)
                   const profileContext = buildProfileFacets(baseContext)

      // Normalize the profile once, up front, so the geographic pre-filter can
      // read ALL of the profile's states (primary + secondary address +
      // multi-state arrays). Reused below for the per-opportunity decision so
      // we never normalize twice. RC-17: pass documents so uploaded extracted
      // text folds into the canonical need vocabulary.
      const profileNormForGeo = normalizeProfile(
        profileContext?.profile ?? profileContext,
        profileContext?.sections ?? null,
        profileContext?.signals ?? null,
        profileContext?.documents ?? null,
      )

      const pdIntent = detectProfessionalDevelopmentIntent({
        searchTerms,
        freeText: freeTextNeed,
        profileContext,
      })

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

      // ── Spec §3: hard-exclude cash-assistance / income-support programs
      // when the user's intent is professional development. Without this
      // SSI/SNAP/TANF rows enter the candidate set and (because their
      // categories often include words like "training" or "financial") leak
      // through scoring. Tracked separately from the score-cap below so we
      // can honor `include_income_support=1` callers (e.g., Anya admin tools).
      if (applyProfDevExclusion) {
        const exclusionTerms = [
          'income_support', 'cash_assistance', 'food_assistance', 'income_assistance',
          'general_assistance', 'tanf', 'ssi', 'ssdi', 'snap', 'wic',
          'general assistance', 'cash assistance', 'food assistance',
        ]
        const orParts = exclusionTerms
          .map(() => '(LOWER(COALESCE(categories, \'\')) NOT LIKE ? AND LOWER(COALESCE(title, \'\')) NOT LIKE ?)')
          .join(' AND ')
        conditions.push(`(${orParts})`)
        for (const term of exclusionTerms) {
          const pattern = `%${term}%`
          params.push(pattern, pattern)
        }
        routeLogger.info(`[matching] prof-dev intent: excluding ${exclusionTerms.length} cash-assistance categories from candidate set`)
      }

      // Profile isolation: only global catalog entries (profile_id IS NULL) or this profile's own crawl results.
      conditions.push('(profile_id IS NULL OR profile_id = ?)')
      params.push(profileId)

      // Geographic pre-filter: only load opps in ANY of the profile's normalized
      // states (primary + secondary address + multi-state `states[]`), national
      // opportunities, or unspecified rows. A two-address profile (home in one
      // state, school in another) must match LOCAL opportunities in BOTH states.
      // If the profile has no real state, do not show specific-state rows unless
      // explicitly requested.
      //
      // Multi-source, deduped: signals.states (primary + secondary, ZIP-enriched)
      // + profileNorm.states (also folds the multi-state arrays). The primary
      // (signals.location.state) is preserved for back-compat with consumers that
      // still read the singular value.
      const primaryProfileState = normalizeState(profileContext?.signals?.location?.state || profileContext?.profile?.state)
      const profileStateList = []
      const _pushState = (raw) => {
        const norm = normalizeState(raw)
        if (norm && !profileStateList.includes(norm)) profileStateList.push(norm)
      }
      _pushState(primaryProfileState)
      for (const s of (Array.isArray(profileContext?.signals?.states) ? profileContext.signals.states : [])) _pushState(s)
      for (const s of (Array.isArray(profileNormForGeo?.states) ? profileNormForGeo.states : [])) _pushState(s)
      // Back-compat alias: many later branches read `profileState` as the single
      // primary. Keep it pointing at the primary so single-address behavior and
      // diagnostics are unchanged.
      const profileState = primaryProfileState
      const includeOtherStates = req.query.include_other_states === '1'
      if (profileStateList.length > 0) {
        const natVal = isPostgres ? 'TRUE' : '1'
        const placeholders = profileStateList.map(() => '?').join(', ')
        conditions.push(`(UPPER(state) IN (${placeholders}) OR LOWER(state) = 'nationwide' OR state IS NULL OR is_national = ${natVal})`)
        params.push(...profileStateList)
      } else if (!includeOtherStates) {
        const natVal = isPostgres ? 'TRUE' : '1'
        conditions.push(`(LOWER(state) = 'nationwide' OR state IS NULL OR is_national = ${natVal})`)
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
          routeLogger.info(`[matching] catalog filter: ${searchTerms.length} OR search terms (smart matcher / multi-keyword)`)
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

      const rawCandidates = await req.db
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

      // Resolve profile applicant type once for the hard eligibility gate
      // below. Mirrors the resolution used by /matching-gaps so we read the
      // same source of truth.
      const basicSection = profileContext?.sections?.basic_information ?? {}
      const profileApplicantType =
        profileRow.applicant_type ??
        profileRow.primary_type ??
        profileRow.primary_profile_type ??
        basicSection.profile_category ??
        null

      const rejectStats = {
        quality: 0,
        wrongState: 0,
        junk: 0,
        reject: 0,
        rejectDirectoryPreserved: 0,
        trust: 0,
        noReason: 0,
        sourceNotAllowed: 0,
        ineligibleApplicantType: 0,
      }
      const qualityDropReasons = {}
      const sourceDropReasons = {}
      const eligibilityDropReasons = {}
      const referralTemplates = new Map()
      const candidates = []
      for (const rawCandidate of rawCandidates) {
        const quality = evaluateFundableOpportunity(rawCandidate)
        if (!quality.ok) {
          rejectStats.quality++
          qualityDropReasons[quality.reason] = (qualityDropReasons[quality.reason] || 0) + 1
          continue
        }
        const normalized = applyFundableOpportunityNormalization(rawCandidate, quality)
        const candidateState = normalizeOpportunityState(normalized.state)
        // Multi-state aware: keep the opportunity if its state matches ANY of
        // the profile's states (primary + secondary + states[]), not just the
        // primary. A two-address profile must see local opportunities in BOTH.
        if (
          !includeOtherStates &&
          candidateState &&
          candidateState !== 'nationwide' &&
          profileStateList.length > 0 &&
          !profileStateList.includes(String(candidateState).toUpperCase())
        ) {
          rejectStats.wrongState++
          continue
        }
        normalized.state = candidateState

        // GATE 1: pipeline-source policy. If an opportunity won't survive
        // saveToProfilePipeline / POST /api/grants/from-opportunity (denylist
        // or untrusted record_origin), it must not be surfaced here either.
        // Symmetry between matcher and writer is the project rule.
        const sourceGate = evaluatePipelineSource({
          source: normalized.source ?? rawCandidate.source ?? null,
          record_origin: normalized.record_origin ?? rawCandidate.record_origin ?? null,
        })
        if (!sourceGate.allowed) {
          rejectStats.sourceNotAllowed++
          sourceDropReasons[sourceGate.reason] = (sourceDropReasons[sourceGate.reason] || 0) + 1
          continue
        }

        // GATE 2: hard applicant-type eligibility. Drops opportunities whose
        // text or applicant_types array EXCLUDES this profile's bucket
        // (e.g. NSF research-institution programs against an individual
        // profile). Soft mismatches still flow through and get a scoring
        // penalty inside computeMatchDecision.
        const eligDecision = evaluateApplicantTypeEligibility(normalized, profileApplicantType)
        if (eligDecision.decision === 'mismatch') {
          rejectStats.ineligibleApplicantType++
          eligibilityDropReasons[eligDecision.reason] = (eligibilityDropReasons[eligDecision.reason] || 0) + 1
          continue
        }
        if (eligDecision.decision === 'review') {
          // Surface but flag — computeMatchDecision will emit a REVIEW score.
          normalized.eligibility_unknown = true
        }

        if (quality.kind === 'referral_template') {
          if (!referralTemplates.has(quality.referralKey)) {
            referralTemplates.set(quality.referralKey, {
              ...normalized,
              type: 'referral',
              opportunity_type: 'referral',
              referral_key: quality.referralKey,
              excluded_from_grant_scoring: true,
              actionable_url: normalized.application_url ?? normalized.source_url ?? rawCandidate.application_url ?? null,
              url: normalized.application_url ?? normalized.source_url ?? rawCandidate.application_url ?? null,
            })
          }
          continue
        }
        candidates.push(normalized)
      }

      if (pdIntent.active) {
        // Profile-aware: only inject curated programs whose declared targeting
        // (state / occupation / student / heritage) fits THIS profile, so we
        // stop surfacing e.g. Texas-nurse or WV-only or API-heritage programs to
        // an unrelated profile.
        const curatedPd = loadCuratedProfessionalDevelopmentPrograms(profileContext)
        const seenCurated = new Set(candidates.map((c) => String(c.id || c.title || '').toLowerCase()))
        for (const opp of curatedPd) {
          const key = String(opp.id || opp.title || '').toLowerCase()
          if (!key || seenCurated.has(key)) continue
          seenCurated.add(key)
          candidates.push(opp)
        }
        routeLogger.info(`[matching] PD intent active — injected ${curatedPd.length} curated professional-development programs`)
      }

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

      // Reuse the single profile normalization computed up front for the geo
      // pre-filter (avoids re-running normalizeProfile per request). Sections
      // are still needed below for scoreOpportunity's signal building.
      const profileSectionsForDecision = profileContext?.sections ?? null
      const profileNormForDecision = profileNormForGeo

      // Directory-style / general funding resources must always survive
      // filtering unless explicitly excluded (project rule). However, they
      // are NOT direct grants and must not score higher than real funding
      // opportunities — see `applyDirectoryScoreCap` below.
      const isDirectoryRecord = (opp) => Boolean(
        opp?.is_directory_resource ||
        opp?.excluded_from_grant_scoring ||
        String(opp?.source || '').startsWith('directory') ||
        String(opp?.source || '').includes('local_directory') ||
        String(opp?.record_origin || '').startsWith('directory') ||
        String(opp?.type || '').toUpperCase() === 'DIRECTORY' ||
        String(opp?.opportunity_type || '').toUpperCase() === 'DIRECTORY' ||
        String(opp?.opportunity_type || '').toLowerCase() === 'referral' ||
        String(opp?.type || '').toLowerCase() === 'referral' ||
        String(opp?.funding_type || '').toLowerCase() === 'referral' ||
        String(opp?.funding_type || '').toLowerCase() === 'referral_service',
      )

      // Cap the displayed match score for directory / referral entries.
      //   • A directory points the user at a place to call/search — it is
      //     not, itself, a grant. Letting one hit 100 would put it above
      //     a real direct grant in the same list.
      //   • Per project rule "Counts displayed in the UI must map 1:1 to
      //     backend response fields", we communicate this via the score
      //     itself rather than a hidden tier so the strict slider works
      //     intuitively (e.g. a slider at 85% should not bury direct
      //     grants underneath inflated directory rows).
      // 70 places directory entries firmly in REVIEW tier (below ACCEPT)
      // while keeping them visible at moderate slider positions (≤70%).
      const DIRECTORY_SCORE_CAP = 70
      const applyDirectoryScoreCap = (score, isDirectory) => {
        if (!isDirectory) return score
        if (typeof score !== 'number' || !Number.isFinite(score)) return score
        return Math.min(score, DIRECTORY_SCORE_CAP)
      }

      // ── Spec §4: cross-category score cap. When the user's intent is
      // professional development and the opportunity's category does not
      // overlap (e.g., income support, food, utilities), cap the match score
      // at 25 so the result falls below the default 50% threshold. We never
      // touch directory entries (they keep their soft 70 cap) and we never
      // touch opportunities tagged as professional_development / education /
      // employment / healthcare since those legitimately overlap.
      const CROSS_CATEGORY_CAP = 25
      const PROF_DEV_OVERLAP_KEYWORDS = [
        'professional_development', 'continuing_education', 'continuing education',
        'cme', 'ceu', 'license', 'licensure', 'certification', 'credentialing',
        'workforce', 'wioa', 'training', 'scholarship', 'tuition', 'education',
        'employment', 'career', 'vocational', 'apprentic', 'reentry', 're-entry',
        'remediation', 'recertification', 'healthcare', 'health workforce',
        'nurse', 'nursing', 'physician', 'social work', 'mental health',
        'allied health', 'professional', 'fellowship', 'residency',
      ]
      // Student-aid overlap keywords — the same idea applied to the
      // student_aid primary category. An opportunity with any of these
      // tokens is "in scope" for an off-campus / cost-of-attendance / room-
      // and-board / FAFSA / Pell / state-student-aid query and keeps its
      // full score. Anything else (general adult homelessness, SNAP, LIHEAP,
      // etc.) gets the 25-point cap so it does not crowd out real student
      // aid in the slider — but it remains in the result set per the user
      // rule "directory-style resources must always survive filtering" and
      // "Population / eligibility mismatches must reduce score, not discard
      // results".
      const STUDENT_AID_OVERLAP_KEYWORDS = [
        'student_aid', 'student aid', 'scholarship', 'grant', 'tuition',
        'fafsa', 'pell', 'fseog', 'work-study', 'work study',
        'cost of attendance', 'cost_of_attendance', 'coa',
        'room and board', 'room_and_board',
        'student housing', 'student_housing',
        'off-campus', 'off campus', 'off_campus',
        'on-campus', 'on campus', 'on_campus',
        'dorm', 'residence hall', 'residence_hall',
        'college', 'university', 'undergrad', 'graduate',
        'campus', 'institutional aid', 'institutional_aid',
        'completion grant', 'emergency aid', 'emergency_aid',
        'student emergency aid', 'student_emergency_aid',
        'student living', 'student_living',
        'education', 'student',
        'forensic', 'stem', 'women in stem', 'heritage',
        'veteran', 'military',
      ]
      // Strict-equality nullish coercion. Repo policy is
      // `eqeqeq: ['error', 'always']`, so we spell out the
      // null-or-undefined check explicitly: empty string for nullish,
      // joined array for arrays, String(v) otherwise.
      const stringifyForOverlap = (v) => {
        if (v === null || v === undefined) return ''
        if (Array.isArray(v)) return v.join(' ')
        return String(v)
      }
      const opportunityHasProfDevOverlap = (opp) => {
        const haystack = [
          opp?.categories,
          opp?.title,
          opp?.description,
          opp?.keywords,
          opp?.eligibility_criteria,
          opp?.tags,
        ]
          .map(stringifyForOverlap)
          .join(' ')
          .toLowerCase()
        if (!haystack) return false
        return PROF_DEV_OVERLAP_KEYWORDS.some((kw) => haystack.includes(kw))
      }
      const opportunityHasStudentAidOverlap = (opp) => {
        const haystack = [
          opp?.categories,
          opp?.title,
          opp?.description,
          opp?.keywords,
          opp?.eligibility_criteria,
          opp?.tags,
        ]
          .map(stringifyForOverlap)
          .join(' ')
          .toLowerCase()
        if (!haystack) return false
        return STUDENT_AID_OVERLAP_KEYWORDS.some((kw) => haystack.includes(kw))
      }
      const applyCrossCategoryCap = (score, opp) => {
        if (typeof score !== 'number' || !Number.isFinite(score)) return score
        if (effectivePrimaryCategory === 'professional_development') {
          if (opportunityHasProfDevOverlap(opp)) return score
          return Math.min(score, CROSS_CATEGORY_CAP)
        }
        if (effectivePrimaryCategory === 'student_aid') {
          if (opportunityHasStudentAidOverlap(opp)) return score
          return Math.min(score, CROSS_CATEGORY_CAP)
        }
        if (!profileNormForDecision.isStudent && opportunityHasStudentAidOverlap(opp)) {
          return Math.min(score, CROSS_CATEGORY_CAP)
        }
        return score
      }

      const trustDropReasons = {}
      // Soft user-behavior preference signals (saves/applies/dismisses) — loaded
      // ONCE per request and applied as a small bounded nudge inside the canonical
      // decision engine. No-op (zero change) when the profile has no activity.
      const preferenceSignals = await loadPreferenceSignals(req.db, profileId).catch(() => null)
      const allScored = candidates
                     .map((opp) => {
                                  const isDirectory = isDirectoryRecord(opp)
                                  if (isJunkOpportunity(opp, filterHints) && !isDirectory) { rejectStats.junk++; return null }

                                  // Canonical consumer-side trust check. Mirrors discovery.js so
                                  // both surfaces hide the same placeholder/loan/expired/untrusted
                                  // rows. Directory rows stay (allowDirectory=true) to respect the
                                  // "directory-style resources must always survive" mission rule.
                                  const trust = assessOpportunityTrust(opp, {
                                    allowDirectory: true,
                                    allowExpired: false,
                                  })
                                  if (!trust.display) {
                                    rejectStats.trust++
                                    for (const r of trust.reasons) {
                                      trustDropReasons[r] = (trustDropReasons[r] || 0) + 1
                                    }
                                    return null
                                  }

                                  // Run v2.0.0 engine: filter hard ineligibles (REJECT) before surfacing.
                                  // Pass sections + signals so scoreOpportunity can build keyword/facet
                                  // signals — otherwise keyword-matching opps score identically to generic ones.
                                  const decision = computeMatchDecision(profileNormForDecision, opp, {
                                    profileSections: profileSectionsForDecision,
                                    signals: profileContext?.signals ?? null,
                                    preferenceSignals,
                                  })
                                  if (decision.decision === 'REJECT') {
                                    if (!isDirectory) { rejectStats.reject++; return null }
                                    rejectStats.rejectDirectoryPreserved++
                                    decision.decision = 'REVIEW'
                                    decision.explanation = (decision.explanation || '') + ' (directory preserved as REVIEW)'
                                  }
                                  // Derive reason codes for explainability. If the decision passed
                                  // (not REJECT) but no specific signal codes fired, that is a fact
                                  // about EXPLAINABILITY, not a fact about FIT — Goal #2 (match,
                                  // don't eliminate) and Goal #8 (avoid zero-result UX) require us
                                  // to keep the row, attribute it to the decision shape, and let
                                  // scoring rank it. Previously this branch silently dropped
                                  // every "passes scoring but no labelled signals" candidate, which
                                  // contributed directly to the 0-included-of-N problem on
                                  // sparse-profile users.
                                  let matchReasons = deriveMatchReasonCodes(decision, opp, trust)
                                  if (matchReasons.length === 0) {
                                    rejectStats.noReason++
                                    matchReasons =
                                      decision?.decision === 'ACCEPT'
                                        ? [MATCH_REASON_CODES.STRONG_SCORE]
                                        : [MATCH_REASON_CODES.REVIEW_SCORE]
                                  }

                                  // Soft downgrade for stale/non-official rows.
                                  const downgradedScore = trust.downgrade
                                    ? Math.max(0, (decision.score ?? 0) - 5)
                                    : decision.score
                                  // Cap directory/referral entries (Goal: don't let
                                  // a place-to-call outrank a direct grant on the
                                  // user's match-score slider).
                                  const directoryCappedScore = applyDirectoryScoreCap(downgradedScore, isDirectory)
                                  const directoryCapped = isDirectory && typeof downgradedScore === 'number' && downgradedScore > DIRECTORY_SCORE_CAP

                                  // Spec §4: cross-category cap (e.g., SSI for a
                                  // PROBE ethics CE search, or generic homeless-shelter
                                  // rows for a "off-campus living expenses at MTSU"
                                  // student-aid search) — if the opportunity has no
                                  // overlap with the primary category, cap at 25 so it
                                  // falls below the default 50% threshold.
                                  const crossCategoryApplied =
                                    typeof directoryCappedScore === 'number' &&
                                    directoryCappedScore > CROSS_CATEGORY_CAP &&
                                    ((effectivePrimaryCategory === 'professional_development' &&
                                      !opportunityHasProfDevOverlap(opp)) ||
                                     (effectivePrimaryCategory === 'student_aid' &&
                                      !opportunityHasStudentAidOverlap(opp)))
                                  const adjustedScore = applyCrossCategoryCap(directoryCappedScore, opp)

                               return {
                                           ...opp,
                                           match_score: adjustedScore,
                                           is_directory: isDirectory,
                                           directory_score_capped: directoryCapped || undefined,
                                           directory_score_cap: isDirectory ? DIRECTORY_SCORE_CAP : undefined,
                                           directory_uncapped_score: directoryCapped ? downgradedScore : undefined,
                                           cross_category_capped: crossCategoryApplied || undefined,
                                           cross_category_cap: crossCategoryApplied ? CROSS_CATEGORY_CAP : undefined,
                                           cross_category_uncapped_score: crossCategoryApplied ? directoryCappedScore : undefined,
                                           match_reasons: matchReasons,
                                           match_decision: decision.decision,
                                           match_explanation: decision.explanation,
                                           trust_tier: trust.trustTier,
                                           source_trust: trust.sourceTrust,
                                           trust_flags: trust.flags,
                                           trust_reasons: Array.isArray(trust.reasons) ? trust.reasons.slice(0, 10) : [],
                                           trust_downgrade: Boolean(trust.downgrade),
                                           trust_downgrade_reason: trust.downgrade
                                             ? (Array.isArray(trust.reasons) ? trust.reasons : []).find((r) =>
                                                 r === 'link_marked_broken' ||
                                                 r === 'non_actionable_primary_url' ||
                                                 String(r).startsWith('untrusted_origin'),
                                               ) || 'lower_trust_source'
                                             : null,
                                           actionable_url: trust.primaryUrl ?? null,
                                           url: trust.primaryUrl ?? opp.application_url ?? opp.source_url ?? null,
                               }
                     })
                     .filter((opp) => opp !== null)

      if (pdIntent.active) {
        const adjusted = applyProfessionalDevelopmentQueryPolicy(allScored, pdIntent)
        allScored.length = 0
        allScored.push(...adjusted)
        allScored.sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
      }

      if (rejectStats.quality || rejectStats.wrongState || rejectStats.junk || rejectStats.reject || rejectStats.rejectDirectoryPreserved || rejectStats.trust || rejectStats.noReason) {
        routeLogger.info(`[matching] candidates=${rawCandidates.length} quality_candidates=${candidates.length} scored=${allScored.length} referrals=${referralTemplates.size} drops=${JSON.stringify(rejectStats)} quality_reasons=${JSON.stringify(qualityDropReasons)} trust_reasons=${JSON.stringify(trustDropReasons)}`)
      }

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

      // Zero-results fallback: progressively lower threshold so users see something.
      // Skipped when strict=1 (Discover page) so the UI min-match slider is honored.
      // When relaxation occurs, include guidance so the UI can prompt profile improvement.
      let effectiveMinScore = minScore
      let relaxedReason = null
      if (!strictMin && scored.length === 0 && allScored.length > 0) {
        // Mild relaxation only (30, then 15). We deliberately DROPPED the
        // threshold-to-zero dump and the top-20 "LAST RESORT" — those returned
        // irrelevant rows and, worse, superseded the canonical staged
        // zero-result ladder below. When nothing scores >= 15, `scored` stays
        // empty so assembleFundingResults() provides the proper, clearly
        // LABELED fallback (relaxed-direct → directory → geo-expand → profile
        // gaps → honest zero). (Mission System 5, RC-12.)
        const fallbackThresholds = [30, 15]
        for (const threshold of fallbackThresholds) {
          scored = allScored.filter((opp) => (opp.match_score ?? 0) >= threshold)
          if (scored.length > 0) {
            effectiveMinScore = threshold
            relaxedReason =
              'No strong matches found. These results are lower-confidence. Complete your profile (location, needs, organization type) to improve match quality.'
            routeLogger.info(`[matching] Zero results at min_score=${minScore}; relaxed to ${threshold} (${scored.length} results)`)
            break
          }
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
        routeLogger.info(`[matching] strict min_score=${minScore} — no relax; returning 0 of ${allScored.length} scored (best=${bestScore}, suggest=${suggestedThreshold})`)
      }

      const MAX_RESPONSE = 500
      let capped = scored.length > MAX_RESPONSE ? scored.slice(0, MAX_RESPONSE) : scored

      // Mission rule (Phase 6): run the canonical zero-result fallback
      // ladder so every funding-result envelope carries the same
      // diagnostics (tier, tier_attempts, directory_only, geo_expanded,
      // profile_gaps) AND so per-card threshold_relaxed/relaxed_reason
      // flags reach the canonical FundingResultCard.
      const ladderProfileGaps = []
      try {
        const sig = profileContext?.signals ?? {}
        if (!sig?.location?.state && !sig?.location?.zip) ladderProfileGaps.push('location')
        if (!sig?.entityType && !profileContext?.profile?.primary_type) ladderProfileGaps.push('profile_type')
        if (!sig?.interests?.size && !sig?.demographics?.size) ladderProfileGaps.push('interests')
      } catch { /* ignore — best-effort gap signal */ }

      const ladder = assembleFundingResults(allScored, {
        minScore: Number.isFinite(minScore) ? minScore : 50,
        maxResults: MAX_RESPONSE,
        profileGaps: ladderProfileGaps,
        strictMinScore: strictMin,
      })

      // If the existing pipeline produced no items but the ladder found
      // a usable tier (RELAXED_DIRECT, DIRECTORY, GEO_EXPAND), surface
      // the ladder's items so the user never sees a blank page.
      //
      // strict=1 (Discover slider, admin batch runs at a fixed min_score)
      // must NOT have its threshold relaxed by the ladder fallback —
      // otherwise the UI slider value (and admin queries like
      // ?min_score=70&strict=1) silently return items below the requested
      // threshold (the score_hint still tells the caller the best score so
      // they can lower the slider deliberately).
      if (
        !strictMin &&
        capped.length === 0 &&
        Array.isArray(ladder.opportunities) &&
        ladder.opportunities.length > 0
      ) {
        capped = ladder.opportunities
        if (ladder.threshold_relaxed_reason) {
          relaxedReason = relaxedReason || ladder.threshold_relaxed_reason
        }
      } else if (!strictMin && ladder.threshold_relaxed) {
        // Annotate every shown item with the per-card relaxed flags so
        // FundingResultCard renders the honest "lower-confidence" banner.
        capped = capped.map((o) => ({
          ...o,
          threshold_relaxed: true,
          relaxed_reason: o.relaxed_reason || ladder.threshold_relaxed_reason,
        }))
      }

      // ── Hard min-score floor (strict mode) ───────────────────────────────
      // When the caller is strict (the Discover/SmartMatcher slider, admin
      // batch runs at a fixed min_score), the user's minimum match % is an
      // absolute floor: nothing below it may ever appear. Belt-and-suspenders
      // over the per-path filters above so no fallback/ladder/annotation step
      // can reintroduce a sub-threshold row. (User directive: "if the slider
      // is at 70, no results below 70 should show — globally & permanently.")
      if (strictMin && Number.isFinite(minScore)) {
        capped = capped.filter((opp) => (opp.match_score ?? 0) >= minScore)
      }

      // ── Intra-list dedup ─────────────────────────────────────────────────
      // Collapse rows that refer to the same underlying award (same
      // opportunity_id OR fingerprint OR normalized title+funder), keeping the
      // best copy. matching.js merges catalog rows with curated PD programs, so
      // the same scholarship can arrive twice under different source labels
      // (e.g. "national_pd_program" + "national_pd_scholarship"); without this
      // the user sees the same award twice. Display-only (no DB writes).
      let duplicateCollapsedCount = 0
      try {
        const dd = dedupeOpportunityList(capped)
        duplicateCollapsedCount = dd.removed
        capped = dd.results
      } catch (dedupeErr) {
        routeLogger.warn(`[matching] result dedup skipped: ${dedupeErr?.message || dedupeErr}`)
      }

      // ── Pipeline exclusion ───────────────────────────────────────────────
      // Never re-surface an opportunity the user already acted on: anything in
      // THIS profile's pipeline (any stage) or carrying a dismissal tombstone
      // is removed. Profile-scoped, so it also guarantees no cross-profile
      // bleed-over. Admin/debug callers can opt out with ?include_pipeline=1.
      // (User directive: "crawlers still return results already in the
      // pipeline — fix this globally and permanently.")
      let pipelineExcludedCount = 0
      if (req.query.include_pipeline !== '1') {
        try {
          const filtered = await filterOutPipelineMembers(req.db, profileId, capped)
          pipelineExcludedCount = filtered.excluded
          capped = filtered.results
        } catch (exclErr) {
          // Recall over suppression — a filter failure must not blank results.
          routeLogger.warn(`[matching] pipeline exclusion skipped: ${exclErr?.message || exclErr}`)
        }
      }

      // Mission rule (Phase 3): every match output must carry a
      // profile_signal_audit so users/Anya/tests can answer "what facts from
      // my profile did the matcher actually use?".
      let signalAudit = null
      try {
        signalAudit = buildProfileSignalAudit(profileContext)
      } catch (auditErr) {
        signalAudit = { error: auditErr?.message ?? String(auditErr) }
      }

      const qualifiedCount = capped.filter((o) => (o.match_score ?? 0) >= minScore).length
      if (qualifiedCount < 3) {
        try {
          routeLogger.warn(`[matching][low-coverage] profile=${profileId} qualified=${qualifiedCount} returned=${capped.length} candidates=${rawCandidates.length} primary_category=${effectivePrimaryCategory || 'none'} terms=${JSON.stringify(searchTerms.slice(0, 12))}`)
          // Best-effort persistence so admins can build a coverage dashboard.
          // Wrapped in try/catch — failure must not block the matching response.
          await req.db
            .prepare(
              `INSERT INTO low_coverage_events (profile_id, primary_category, search_terms, qualified_count, returned_count, candidate_count, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ${isPostgres ? 'NOW()' : "datetime('now')"})`,
            )
            .run(
              profileId,
              effectivePrimaryCategory || null,
              JSON.stringify(searchTerms.slice(0, 32)),
              qualifiedCount,
              capped.length,
              rawCandidates.length,
            )
            .catch?.(() => {})
        } catch (telemetryErr) {
          // Table may not exist on older deploys; log once at debug level.
          routeLogger.debug?.(`[matching][low-coverage] persistence skipped: ${telemetryErr?.message || telemetryErr}`)
        }
      }
      if (qualifiedCount < 3 && (searchTerms.length > 0 || pdIntent.active)) {
        void recordLowCoverageEvent(req.db, {
          profileId,
          searchTerms,
          freeText: freeTextNeed,
          qualifiedCount,
          minScore,
          intent: pdIntent,
        })
      }

      // Guidance band data: bucketed score distribution computed from ALL
      // scored opportunities (BEFORE the slider's min-score filter), with the
      // dominant friendly source family per bucket. Drives the color-coded,
      // notched band the Discover/SmartMatcher slider renders above itself.
      const scoreHistogram = buildScoreHistogram(allScored)

      // Architecture P1: surface the high-value profile fields that, if filled,
      // would unlock/improve matches. Additive prompts only (never a gate).
      const profileFieldPrompts = await getProfileFieldPrompts(req.db, profileId)

      res.json({
              profile_id: profileId,
              profile_applicant_type: profileApplicantType ?? null,
              profile_field_prompts: profileFieldPrompts,
              primary_category: effectivePrimaryCategory || null,
              excluded_categories: Array.from(excludedCategories),
              min_score: Number.isFinite(effectiveMinScore) ? effectiveMinScore : null,
              total_scored: rawCandidates.length,
              returned: capped.length,
              qualified_count: qualifiedCount,
              score_histogram: scoreHistogram,
              opportunities: capped,
              referrals: Array.from(referralTemplates.values()),
              diagnostics: {
                dropped_for_no_reason: rejectStats.noReason,
                dropped_for_wrong_state: rejectStats.wrongState,
                dropped_source_not_allowed: rejectStats.sourceNotAllowed,
                dropped_ineligible_applicant_type: rejectStats.ineligibleApplicantType,
                source_drop_reasons: sourceDropReasons,
                eligibility_drop_reasons: eligibilityDropReasons,
                professional_development_intent: pdIntent.active || undefined,
                branded_program: pdIntent.branded?.label || undefined,
                income_support_excluded: pdIntent.excludeIncomeSupport || undefined,
                excluded_already_in_pipeline: pipelineExcludedCount || undefined,
                duplicate_results_collapsed: duplicateCollapsedCount || undefined,
              },
              coverage_summary: {
                total_candidates: rawCandidates.length,
                returned: capped.length,
                dropped_quality: rejectStats.quality,
                dropped_wrong_state: rejectStats.wrongState,
                dropped_source_not_allowed: rejectStats.sourceNotAllowed,
                dropped_ineligible_count: rejectStats.ineligibleApplicantType,
                dropped_trust: rejectStats.trust,
                dropped_no_reason: rejectStats.noReason,
              },
              profile_signal_audit: signalAudit,
              score_hint: allScored._scoreHint || null,
              threshold_relaxed: !strictMin && (effectiveMinScore !== minScore || ladder.threshold_relaxed) ? true : undefined,
              threshold_relaxed_reason: !strictMin ? (relaxedReason || ladder.threshold_relaxed_reason || undefined) : undefined,
              result_tier: ladder.tier,
              directory_only: ladder.directory_only || undefined,
              geo_expanded: ladder.geo_expanded || undefined,
              profile_gaps: ladder.profile_gaps?.length ? ladder.profile_gaps : undefined,
              tier_attempts: ladder.tier_attempts,
              tier_explanation: ladder.explanation,
              truncated: scored.length > MAX_RESPONSE ? true : undefined,
      })
             } catch (error) {
                   // A live crawl can saturate the PG pool / IO while this heavy
                   // candidate scan runs, tripping statement_timeout or a pool
                   // acquire timeout — a transient capacity condition, not a
                   // server fault. Delegate to the global errorHandler choke
                   // point, which records the error (G1 observability) and maps
                   // retryable DB contention -> 503 (the Discover UI retries it)
                   // and real faults -> 500. One place, not scattered per-route.
                   next(error)
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
    } catch (err) {
      console.warn(`[matching] profile_sections load failed for profile=${profileId}:`, err?.message || err)
      sectionRows = []
    }

    const sections = sectionRows.reduce((acc, row) => {
      try {
        acc[row.section_key] = row.data ? JSON.parse(row.data) : {}
      } catch (err) {
        console.warn(
          `[matching] profile_sections JSON parse failed profile=${profileId} section=${row.section_key}:`,
          err?.message || err,
        )
        acc[row.section_key] = {}
      }
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
    } catch (err) {
      console.warn(`[matching] documents count failed for profile=${profileId}:`, err?.message || err)
      docCount = 0
    }

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

// ---------------------------------------------------------------------------
// Success-step archetypes — data-driven real-world requirements engine
//
// Each archetype has:
//   keywords   — trigger when any appear in allText (goals + story + tags)
//   types      — trigger when applicantType includes any of these
//   steps      — array of { label, category, why, skip? }
//                skip(allText, sections) is an optional guard to suppress
//                the step when the profile already has it covered
// ---------------------------------------------------------------------------

const SUCCESS_ARCHETYPES = [

  // ── 1. General business ──
  { keywords: ['business', 'startup', 'entrepreneur', 'self-employ', 'sole proprietor', 'llc'],
    types: ['business', 'entrepreneur', 'small_business'],
    steps: [
      { label: 'Obtain an EIN (Employer Identification Number)', category: 'legal', why: 'Required for most business grants, bank accounts, and tax filings', skip: (t, s) => t.includes('ein') || s.organization_details?.ein },
      { label: 'Get a business license / vendor permit', category: 'legal', why: 'Required before operating in most jurisdictions', skip: (t) => t.includes('license') || t.includes('permit') },
      { label: 'Write a business plan', category: 'planning', why: 'Most business grants require a formal plan with financial projections', skip: (t) => t.includes('business plan') },
      { label: 'Open a dedicated business bank account', category: 'financial', why: 'Grant funds must be deposited into a separate account for audit compliance' },
    ],
  },

  // ── 2. Food truck ──
  { keywords: ['food truck', 'mobile food', 'street food'],
    steps: [
      { label: 'Obtain a food handler\'s / health department permit', category: 'legal', why: 'Required before serving food to the public' },
      { label: 'Secure a food truck or commercial vehicle', category: 'equipment', why: 'Your primary asset — many grants cover vehicle acquisition' },
      { label: 'Get a mobile vendor\'s license', category: 'legal', why: 'Required in most cities for mobile food operations' },
      { label: 'Obtain commercial liability insurance', category: 'insurance', why: 'Required by commissary kitchens and event venues', skip: (t) => t.includes('insurance') },
      { label: 'Find a licensed commissary kitchen', category: 'operations', why: 'Most health departments require prep in a certified facility, not at home' },
    ],
  },

  // ── 3. Restaurant / bakery / café ──
  { keywords: ['restaurant', 'bakery', 'café', 'cafe', 'catering', 'food business', 'commercial kitchen'],
    steps: [
      { label: 'Obtain a food handler\'s / health department permit', category: 'legal', why: 'Required before serving food to the public' },
      { label: 'Get a food service establishment license', category: 'legal', why: 'Required by your city or county to operate a fixed-location food business' },
      { label: 'Pass a health department inspection', category: 'compliance', why: 'Inspectors must approve your kitchen before you can open' },
      { label: 'Obtain a liquor license (if serving alcohol)', category: 'legal', why: 'Alcohol licensing has long lead times — apply early', skip: (t) => !t.includes('bar') && !t.includes('alcohol') && !t.includes('wine') && !t.includes('beer') },
      { label: 'Obtain commercial liability insurance', category: 'insurance', why: 'Covers slip-and-fall, foodborne illness, and property damage', skip: (t) => t.includes('insurance') },
    ],
  },

  // ── 4. Nonprofit / 501(c)(3) ──
  { keywords: ['nonprofit', '501c3', '501(c)(3)', 'charitable', 'tax-exempt'],
    types: ['nonprofit', 'organization'],
    steps: [
      { label: 'File for 501(c)(3) tax-exempt status', category: 'legal', why: 'Most foundation and government grants require 501(c)(3) determination', skip: (t, s) => s.organization_details?.ein || s.organization_details?.is_501c3_public_charity },
      { label: 'Register on SAM.gov', category: 'compliance', why: 'Required for all federal grant applications', skip: (t, s) => s.organization_details?.sam_gov_registered },
      { label: 'Create a Grants.gov account', category: 'compliance', why: 'Federal grant applications are submitted through Grants.gov', skip: (t, s) => s.organization_details?.grants_gov_account },
      { label: 'Establish a board of directors', category: 'governance', why: 'Most funders require a functioning board with meeting minutes' },
      { label: 'Develop a fundraising / sustainability plan', category: 'planning', why: 'Funders want to see how you\'ll sustain operations beyond the grant period' },
    ],
  },

  // ── 5. Church / faith-based ministry ──
  { keywords: ['church', 'ministry', 'faith-based', 'congregation', 'parish', 'synagogue', 'mosque'],
    types: ['church', 'ministry'],
    steps: [
      { label: 'Obtain 501(c)(3) determination or church exemption letter', category: 'legal', why: 'Churches are auto-exempt but a determination letter speeds grant applications' },
      { label: 'Register on SAM.gov (for federal grants)', category: 'compliance', why: 'Required even for faith-based organizations applying for federal funds', skip: (t, s) => s.organization_details?.sam_gov_registered },
      { label: 'Document community programs separately from worship activities', category: 'compliance', why: 'Federal funds cannot support religious instruction — show clear separation' },
      { label: 'Prepare audited or reviewed financial statements', category: 'financial', why: 'Funders need to see responsible stewardship of donor and grant dollars' },
    ],
  },

  // ── 6. School / education institution ──
  { keywords: ['school', 'academy', 'charter school', 'private school', 'education program'],
    types: ['school'],
    steps: [
      { label: 'Obtain state accreditation or approval', category: 'compliance', why: 'Most education grants require accreditation or state approval to participate' },
      { label: 'Register on SAM.gov and Grants.gov', category: 'compliance', why: 'Required for Title I, IDEA, and other federal education funding' },
      { label: 'Compile student outcome data (enrollment, graduation, test scores)', category: 'documentation', why: 'Grant reviewers evaluate need and impact through measurable data' },
      { label: 'Identify a fiscal agent or grants administrator', category: 'operations', why: 'Federal grants require compliance with Uniform Guidance (2 CFR 200)' },
    ],
  },

  // ── 7. Student / scholarship seeker ──
  { keywords: ['tuition', 'scholarship', 'college', 'university', 'graduate school', 'undergrad', 'financial aid'],
    types: ['student'],
    steps: [
      { label: 'Complete the FAFSA application', category: 'financial_aid', why: 'Required for most federal and institutional financial aid', skip: (t) => t.includes('fafsa') },
      { label: 'Request official transcripts', category: 'documentation', why: 'Most scholarship applications require academic records' },
      { label: 'Write a personal statement / essay', category: 'documentation', why: 'Nearly every competitive scholarship requires a personal narrative' },
      { label: 'Obtain letters of recommendation', category: 'documentation', why: 'Two to three strong recommendation letters are standard for most applications' },
      { label: 'Research and list deadlines for each scholarship', category: 'planning', why: 'Scholarship windows are narrow — missing a deadline means waiting another year' },
    ],
  },

  // ── 8. Veteran ──
  { keywords: ['veteran', 'military', 'service member', 'va ', 'active duty', 'national guard'],
    types: ['veteran'],
    steps: [
      { label: 'Obtain your DD-214 (Certificate of Release or Discharge)', category: 'documentation', why: 'Primary proof of military service required by nearly all veteran programs' },
      { label: 'Register with the VA (eBenefits or VA.gov)', category: 'compliance', why: 'Gateway to VA healthcare, disability compensation, and education benefits' },
      { label: 'Apply for a VA disability rating (if applicable)', category: 'benefits', why: 'Unlocks additional funding, priority processing, and property tax exemptions' },
      { label: 'Check eligibility for GI Bill or VR&E (Vocational Rehab)', category: 'financial_aid', why: 'Education and training benefits that can be combined with grants' },
    ],
  },

  // ── 9. Farming / agriculture ──
  { keywords: ['farm', 'agriculture', 'crop', 'livestock', 'ranch', 'agribusiness', 'organic farm', 'horticulture'],
    steps: [
      { label: 'Register with your local USDA Service Center', category: 'compliance', why: 'Required for FSA loans, NRCS conservation programs, and crop insurance' },
      { label: 'Obtain a farm number from FSA', category: 'compliance', why: 'Your farm number is required on every USDA application' },
      { label: 'Complete a farm business plan', category: 'planning', why: 'USDA and state ag grants require documented production plans and financials' },
      { label: 'Get soil tests and/or environmental assessments', category: 'documentation', why: 'Conservation and sustainability grants require baseline environmental data' },
      { label: 'Explore USDA Beginning Farmer programs', category: 'financial_aid', why: 'USDA reserves funding for farmers with fewer than 10 years of experience', skip: (t) => !t.includes('beginning') && !t.includes('new farm') && !t.includes('start') },
    ],
  },

  // ── 10. Arts / creative ──
  { keywords: ['art', 'artist', 'gallery', 'studio', 'painter', 'sculptor', 'fine art', 'visual art', 'public art', 'mural'],
    types: ['artist'],
    steps: [
      { label: 'Build a portfolio or artist statement', category: 'documentation', why: 'Juried grants require 10-20 work samples plus a written statement of practice' },
      { label: 'Document past exhibitions, residencies, or public work', category: 'documentation', why: 'Grant reviewers evaluate track record and community engagement' },
      { label: 'Research your state arts council grants', category: 'planning', why: 'State arts agencies distribute NEA funds locally — often less competitive than national grants' },
      { label: 'Obtain a fiscal sponsor if you lack 501(c)(3) status', category: 'legal', why: 'Many arts funders require nonprofit status; a fiscal sponsor lets individuals apply' },
    ],
  },

  // ── 11. Music / performing arts ──
  { keywords: ['music', 'musician', 'band', 'choir', 'orchestra', 'theater', 'theatre', 'performing art', 'dance', 'opera'],
    steps: [
      { label: 'Create a press kit with recordings / performance clips', category: 'documentation', why: 'Performing arts grants require audio/video samples of your work' },
      { label: 'Build a performance history document', category: 'documentation', why: 'List venues, dates, and audience sizes to demonstrate community reach' },
      { label: 'Register with ASCAP, BMI, or SESAC (for musicians)', category: 'legal', why: 'Protects your intellectual property and establishes professional credibility' },
      { label: 'Research your state arts council and NEA grants', category: 'planning', why: 'National Endowment for the Arts funds performing arts through state councils' },
    ],
  },

  // ── 12. Film / media production ──
  { keywords: ['film', 'documentary', 'movie', 'production', 'screenwriting', 'media project', 'video production'],
    steps: [
      { label: 'Write a treatment or project synopsis', category: 'planning', why: 'Film grants require a narrative summary, budget, and production timeline' },
      { label: 'Create a detailed production budget', category: 'financial', why: 'Funders evaluate whether your budget is realistic for the scope of work' },
      { label: 'Secure a fiscal sponsor (if not a production company)', category: 'legal', why: 'Individual filmmakers need a 501(c)(3) sponsor for most documentary grants' },
      { label: 'Compile a work sample reel', category: 'documentation', why: 'Previous work demonstrates your ability to complete the funded project' },
    ],
  },

  // ── 13. Writing / literary ──
  { keywords: ['writing', 'writer', 'author', 'book', 'novel', 'literary', 'publishing', 'poetry', 'memoir'],
    steps: [
      { label: 'Prepare a manuscript sample (20-30 pages)', category: 'documentation', why: 'Literary grants and fellowships require a polished writing sample' },
      { label: 'Write a project description with timeline', category: 'planning', why: 'Funders want to know what you\'ll produce and when during the grant period' },
      { label: 'Research residency programs (Yaddo, MacDowell, Hedgebrook)', category: 'planning', why: 'Residencies provide funded time to write — many cover all expenses' },
      { label: 'Obtain an ISBN for any planned self-publication', category: 'legal', why: 'Required for distribution through bookstores and libraries' },
    ],
  },

  // ── 14. Technology / software startup ──
  { keywords: ['tech', 'software', 'app', 'saas', 'ai ', 'artificial intelligence', 'platform', 'coding', 'developer'],
    steps: [
      { label: 'Build a minimum viable product (MVP) or prototype', category: 'planning', why: 'SBIR/STTR Phase I requires proof of concept; investors expect a working demo' },
      { label: 'File provisional patent or document IP', category: 'legal', why: 'Protects your innovation and strengthens SBIR/STTR applications' },
      { label: 'Explore SBIR/STTR Phase I eligibility', category: 'financial_aid', why: '$150K-$275K in non-dilutive funding for R&D across 11 federal agencies' },
      { label: 'Register on SAM.gov and get a UEI number', category: 'compliance', why: 'Required for all federal SBIR/STTR applications' },
    ],
  },

  // ── 15. Construction / contracting ──
  { keywords: ['construction', 'contractor', 'building', 'renovation', 'remodeling', 'plumbing', 'electrical', 'roofing', 'hvac'],
    steps: [
      { label: 'Obtain a contractor\'s license for your state', category: 'legal', why: 'Required to bid on jobs and qualify for bonding — unlocks public contract opportunities' },
      { label: 'Get bonded and insured', category: 'insurance', why: 'Performance bonds are required for government contracts and most commercial work' },
      { label: 'Register for SBA 8(a) or HUBZone certification', category: 'compliance', why: 'Set-aside programs give certified contractors preference on federal contracts', skip: (t, s) => s.organization_details?.cert_8a || s.organization_details?.cert_hubzone },
      { label: 'Build a portfolio of completed projects with references', category: 'documentation', why: 'Past performance is weighted heavily in government contract evaluations' },
    ],
  },

  // ── 16. Childcare / daycare ──
  { keywords: ['childcare', 'child care', 'daycare', 'day care', 'preschool', 'early childhood', 'after school', 'afterschool'],
    steps: [
      { label: 'Obtain a state childcare license', category: 'legal', why: 'Required before operating — background checks, facility inspections, and ratio compliance' },
      { label: 'Get CPR and first aid certification for all staff', category: 'compliance', why: 'Licensing requirement in all 50 states for anyone supervising children' },
      { label: 'Apply for the Child Care and Development Fund (CCDF)', category: 'financial_aid', why: 'Federal subsidy program that pays you directly for serving low-income families' },
      { label: 'Pass a fire marshal inspection', category: 'compliance', why: 'Required before licensure — egress, alarms, and extinguisher placement' },
      { label: 'Obtain commercial liability insurance with child-specific coverage', category: 'insurance', why: 'Standard business insurance does not cover childcare operations' },
    ],
  },

  // ── 17. Healthcare provider / clinic ──
  { keywords: ['clinic', 'healthcare', 'health care', 'medical practice', 'mental health practice', 'therapy practice', 'counseling', 'telemedicine'],
    steps: [
      { label: 'Obtain a National Provider Identifier (NPI)', category: 'compliance', why: 'Required to bill insurance and apply for HRSA community health grants' },
      { label: 'Credential with insurance panels (Medicaid, Medicare, private)', category: 'compliance', why: 'Credentialing takes 90-120 days — start early to avoid revenue gaps' },
      { label: 'Get malpractice / professional liability insurance', category: 'insurance', why: 'Required for licensure and grant-funded patient care programs' },
      { label: 'Register as a HRSA-eligible site (for FQHC / community health grants)', category: 'compliance', why: 'HRSA Section 330 grants fund community health centers serving underserved areas' },
    ],
  },

  // ── 18. Senior services / elder care ──
  { keywords: ['senior', 'elder', 'aging', 'retirement', 'assisted living', 'home health', 'meals on wheels', 'older adult'],
    steps: [
      { label: 'Connect with your Area Agency on Aging (AAA)', category: 'planning', why: 'AAAs distribute Older Americans Act funds and can help you apply for local grants' },
      { label: 'Document the senior population you serve with demographic data', category: 'documentation', why: 'Aging grants require census-level data on the population your program reaches' },
      { label: 'Obtain a home health agency license (if providing in-home care)', category: 'legal', why: 'Required to bill Medicare/Medicaid and qualify for state aging grants' },
      { label: 'Register as a Medicaid waiver provider (if applicable)', category: 'compliance', why: 'HCBS Medicaid waivers fund in-home and community services for seniors' },
    ],
  },

  // ── 19. Housing development / affordable housing ──
  { keywords: ['affordable housing', 'housing development', 'low-income housing', 'lihtc', 'section 8', 'public housing', 'community development'],
    steps: [
      { label: 'Apply for LIHTC (Low-Income Housing Tax Credits)', category: 'financial_aid', why: 'Primary funding mechanism for affordable housing development in the US' },
      { label: 'Register with your state Housing Finance Agency (HFA)', category: 'compliance', why: 'HFAs allocate LIHTC credits and administer HOME/CDBG-funded programs' },
      { label: 'Conduct a market study and community needs assessment', category: 'planning', why: 'HUD and state HFAs require evidence of housing demand in your target area' },
      { label: 'Secure site control (option, contract, or deed)', category: 'legal', why: 'You must demonstrate control of the land before applying for development funds' },
    ],
  },

  // ── 20. Housing assistance / rent help (individual) ──
  { keywords: ['rent', 'mortgage', 'eviction', 'homeless', 'housing assistance', 'utility assistance', 'home repair'],
    steps: [
      { label: 'Gather lease or mortgage documentation', category: 'documentation', why: 'Housing assistance programs require proof of your current housing situation' },
      { label: 'Get repair estimates from licensed contractors', category: 'planning', why: 'Grant applications require detailed cost estimates for repairs', skip: (t) => !t.includes('repair') && !t.includes('renovation') },
      { label: 'Contact your local Community Action Agency', category: 'planning', why: 'CAAs administer LIHEAP, weatherization, and emergency rental assistance' },
      { label: 'Document household income (pay stubs, tax returns)', category: 'documentation', why: 'Need-based housing programs require income verification at or below 200% FPL' },
    ],
  },

  // ── 21. Transportation / vehicle ──
  { keywords: ['van', 'vehicle', 'transportation', 'bus', 'shuttle', 'fleet', 'passenger van'],
    steps: [
      { label: 'Get commercial vehicle insurance', category: 'insurance', why: 'Required before operating passenger or commercial vehicles', skip: (t) => t.includes('insurance') },
      { label: 'Obtain a CDL (Commercial Driver\'s License) if required', category: 'legal', why: 'Required for vehicles over 26,001 lbs or carrying 16+ passengers' },
      { label: 'Obtain passenger transport license/permit', category: 'legal', why: 'Required for transporting passengers commercially', skip: (t) => !t.includes('passenger') && !t.includes('transport') && !t.includes('shuttle') },
      { label: 'Register with FTA (Federal Transit Administration) for 5310 program', category: 'compliance', why: 'Section 5310 provides capital funding for vehicles serving seniors and people with disabilities', skip: (t) => !t.includes('senior') && !t.includes('disab') && !t.includes('elderly') },
    ],
  },

  // ── 22. Medical / disability needs (individual) ──
  { keywords: ['medical', 'disability', 'wheelchair', 'prosthetic', 'durable medical', 'assistive technology', 'hearing aid'],
    steps: [
      { label: 'Get a physician\'s letter documenting medical need', category: 'documentation', why: 'Medical equipment and disability grants require documented need' },
      { label: 'Apply for Medicaid / Medicare if not enrolled', category: 'benefits', why: 'Government insurance often covers equipment at 80% — grants can cover the gap' },
      { label: 'Request a functional needs assessment from your provider', category: 'documentation', why: 'DME grants require professional assessment of what equipment is medically necessary' },
      { label: 'Contact your state Assistive Technology program', category: 'planning', why: 'Every state has an AT Act program that provides loans, demos, and funding referrals' },
    ],
  },

  // ── 23. Mental health / substance abuse ──
  { keywords: ['mental health', 'substance abuse', 'addiction', 'recovery', 'behavioral health', 'counseling center', 'sober living', 'rehab'],
    steps: [
      { label: 'Obtain state behavioral health licensure', category: 'legal', why: 'Required to operate a treatment facility and bill Medicaid/insurance' },
      { label: 'Apply for SAMHSA block grant funding', category: 'financial_aid', why: 'SAMHSA distributes $4B+/year through state agencies for prevention and treatment' },
      { label: 'Get CARF or Joint Commission accreditation', category: 'compliance', why: 'Accreditation is required or preferred by most payers and state contracts' },
      { label: 'Document outcome metrics (completion rates, readmission rates)', category: 'documentation', why: 'Grant reviewers increasingly require evidence-based outcome data' },
    ],
  },

  // ── 24. Environmental / conservation ──
  { keywords: ['environment', 'conservation', 'sustainability', 'clean energy', 'recycling', 'watershed', 'wildlife', 'climate', 'renewable', 'solar'],
    steps: [
      { label: 'Conduct a baseline environmental assessment', category: 'documentation', why: 'EPA, NOAA, and state agencies require documented baseline conditions' },
      { label: 'Map your project area with GIS data', category: 'planning', why: 'Conservation grants increasingly require geospatial data for evaluation' },
      { label: 'Identify matching fund sources (land trusts, state agencies)', category: 'financial', why: 'Most federal environmental grants require 25-50% match' },
      { label: 'Form partnerships with universities or government agencies', category: 'planning', why: 'Collaborative proposals score higher — especially for NSF, EPA, and NOAA grants' },
    ],
  },

  // ── 25. Clean energy / solar ──
  { keywords: ['solar', 'wind energy', 'clean energy', 'energy efficiency', 'weatherization', 'green building', 'ev charging', 'electric vehicle'],
    steps: [
      { label: 'Get a professional energy audit', category: 'documentation', why: 'DOE and utility programs require documented energy baseline and savings projections' },
      { label: 'Explore DOE Loan Programs Office (LPO) eligibility', category: 'financial_aid', why: 'LPO offers loan guarantees up to $400B for clean energy projects' },
      { label: 'Apply for IRA/Inflation Reduction Act tax credits', category: 'financial', why: 'ITC (30%) and PTC cover solar, wind, EV, and efficiency — stackable with grants' },
      { label: 'Check state renewable portfolio standard incentives', category: 'planning', why: 'SRECs, rebates, and net metering vary by state and significantly affect project economics' },
    ],
  },

  // ── 26. Research / academic ──
  { keywords: ['research', 'study', 'clinical trial', 'laboratory', 'principal investigator', 'academic', 'dissertation', 'postdoc'],
    types: ['researcher'],
    steps: [
      { label: 'Obtain IRB approval (for human subjects research)', category: 'compliance', why: 'NIH, NSF, and all federal agencies require IRB approval before funding begins' },
      { label: 'Set up an eRA Commons account (for NIH)', category: 'compliance', why: 'Required to submit NIH applications through ASSIST or Grants.gov' },
      { label: 'Register your lab/department on SAM.gov', category: 'compliance', why: 'Your institution must have a UEI and active SAM registration' },
      { label: 'Write a specific aims page', category: 'planning', why: 'The 1-page specific aims page is the most important part of an NIH application' },
    ],
  },

  // ── 27. Bereavement / funeral / emergency travel ──
  { keywords: ['bereavement', 'funeral', 'burial', 'cremation', 'memorial', 'death', 'emergency travel'],
    steps: [
      { label: 'Obtain a death certificate', category: 'documentation', why: 'Required for FEMA Funeral Assistance, insurance claims, and charitable aid applications' },
      { label: 'Contact FEMA Funeral Assistance (if COVID-related or disaster)', category: 'financial_aid', why: 'FEMA reimburses up to $9,000 per funeral for qualifying deaths' },
      { label: 'Request an itemized funeral home invoice', category: 'documentation', why: 'Charitable organizations and government programs require itemized costs' },
      { label: 'Check employer bereavement leave and travel reimbursement policies', category: 'planning', why: 'Many employers offer paid leave and travel assistance that reduces the funding gap' },
    ],
  },

  // ── 28. Domestic violence / survivor ──
  { keywords: ['domestic violence', 'abuse', 'survivor', 'shelter', 'protective order', 'dv ', 'intimate partner'],
    steps: [
      { label: 'Contact the National Domestic Violence Hotline (1-800-799-7233)', category: 'safety', why: 'Immediate safety planning and referrals to local shelters and legal aid' },
      { label: 'Obtain a protective order / restraining order', category: 'legal', why: 'Many assistance programs require or prioritize applicants with active protective orders' },
      { label: 'Document expenses (medical, housing, childcare) related to the situation', category: 'documentation', why: 'Emergency funds from VOCA and local orgs require documented costs' },
      { label: 'Apply for Crime Victims Compensation in your state', category: 'financial_aid', why: 'Every state has a VOCA-funded program that reimburses victims for out-of-pocket costs' },
    ],
  },

  // ── 29. Foster youth / aging out ──
  { keywords: ['foster', 'foster youth', 'aging out', 'foster care', 'emancipat', 'independent living'],
    steps: [
      { label: 'Apply for the Education and Training Voucher (ETV) program', category: 'financial_aid', why: 'Up to $5,000/year for college or vocational training for current/former foster youth' },
      { label: 'Contact your state Independent Living program', category: 'planning', why: 'Chafee Foster Care Independence Program funds housing, education, and employment support' },
      { label: 'Gather court documents or state custody records', category: 'documentation', why: 'Foster youth grants require proof of foster care status — request records before they age out' },
      { label: 'Complete the FAFSA as an independent student', category: 'financial_aid', why: 'Former foster youth qualify as independent on FAFSA regardless of age — no parent income required' },
    ],
  },

  // ── 30. Immigrant / refugee ──
  { keywords: ['immigrant', 'refugee', 'resettlement', 'asylum', 'daca', 'asylee', 'newcomer'],
    steps: [
      { label: 'Obtain employment authorization document (EAD)', category: 'legal', why: 'Required before you can work or apply for most employment-linked grants' },
      { label: 'Connect with a local resettlement agency (IRC, USCRI, CWS)', category: 'planning', why: 'Resettlement agencies administer ORR funds for housing, employment, and English classes' },
      { label: 'Enroll in English language classes if needed', category: 'education', why: 'ESL completion unlocks additional vocational and education funding streams' },
      { label: 'Get foreign credentials evaluated (WES, ECE)', category: 'documentation', why: 'Credential evaluation is required for licensing in healthcare, engineering, teaching, etc.' },
    ],
  },

  // ── 31. Single parent ──
  { keywords: ['single parent', 'single mom', 'single mother', 'single dad', 'single father', 'solo parent'],
    steps: [
      { label: 'Apply for TANF (Temporary Assistance for Needy Families)', category: 'financial_aid', why: 'Cash assistance plus work support and childcare subsidies' },
      { label: 'Check eligibility for WIC (if children under 5)', category: 'benefits', why: 'WIC provides food, nutrition counseling, and healthcare referrals' },
      { label: 'Apply for childcare subsidies through your state', category: 'financial_aid', why: 'CCDF subsidies can cover 80-90% of childcare costs while you work or attend school' },
      { label: 'Explore Pell Grant + additional parent-specific scholarships', category: 'financial_aid', why: 'Pell Grants don\'t have to be repaid and can be combined with parent-focused awards' },
    ],
  },

  // ── 32. Caregiver ──
  { keywords: ['caregiver', 'caregiving', 'caring for', 'home care', 'family caregiver', 'respite'],
    steps: [
      { label: 'Contact the National Family Caregiver Support Program', category: 'planning', why: 'NFCSP provides respite care, training, and supplemental services through your local AAA' },
      { label: 'Document caregiving hours and expenses', category: 'documentation', why: 'Caregiver tax credits and grants require proof of caregiving responsibilities' },
      { label: 'Apply for Medicaid HCBS waiver (to be a paid caregiver)', category: 'financial_aid', why: 'Many states allow family members to be paid caregivers through Medicaid waivers' },
      { label: 'Get a medical assessment of the care recipient\'s needs', category: 'documentation', why: 'ADL/IADL assessments determine eligibility levels for state and federal caregiver programs' },
    ],
  },

  // ── 33. Disaster recovery / emergency ──
  { keywords: ['disaster', 'hurricane', 'tornado', 'flood', 'fire', 'earthquake', 'storm damage', 'fema', 'emergency'],
    steps: [
      { label: 'Register with FEMA (DisasterAssistance.gov)', category: 'compliance', why: 'FEMA registration is step one — it triggers SBA loan offers, housing assistance, and other programs' },
      { label: 'Document all damage with photos and video', category: 'documentation', why: 'Required for FEMA, SBA, insurance claims, and charitable disaster relief applications' },
      { label: 'File an insurance claim immediately', category: 'insurance', why: 'Most disaster grants are "last resort" — you must exhaust insurance first' },
      { label: 'Contact your local Long-Term Recovery Group (LTRG)', category: 'planning', why: 'LTRGs coordinate unmet needs across FEMA, Red Cross, and faith-based organizations' },
    ],
  },

  // ── 34. Trucking / freight / logistics ──
  { keywords: ['trucking', 'freight', 'logistics', 'cdl', 'owner operator', 'semi truck', 'long haul', 'delivery service'],
    steps: [
      { label: 'Obtain a CDL (Commercial Driver\'s License)', category: 'legal', why: 'Required for operating any commercial vehicle over 26,001 lbs' },
      { label: 'Get your USDOT number and MC authority', category: 'compliance', why: 'Required by FMCSA to operate as a motor carrier for hire' },
      { label: 'Obtain BOC-3 process agent designation', category: 'compliance', why: 'Required for interstate carriers — designates a legal agent in each state you operate' },
      { label: 'Get commercial truck insurance (liability + cargo)', category: 'insurance', why: '$750K-$1M minimum liability required by FMCSA for interstate carriers' },
    ],
  },

  // ── 35. Beauty / salon / barbershop ──
  { keywords: ['salon', 'barber', 'beauty', 'cosmetology', 'hair', 'nail', 'spa', 'esthetician'],
    steps: [
      { label: 'Obtain a cosmetology or barbering license', category: 'legal', why: 'State board licensure is required before providing any beauty services' },
      { label: 'Get a salon/shop establishment license', category: 'legal', why: 'The physical location needs its own license separate from your personal license' },
      { label: 'Pass a state board health and sanitation inspection', category: 'compliance', why: 'Required before opening — covers sterilization, ventilation, and workspace standards' },
      { label: 'Obtain commercial liability insurance', category: 'insurance', why: 'Covers chemical reactions, burns, allergic reactions, and slip-and-fall incidents' },
    ],
  },

  // ── 36. Fitness / gym / personal training ──
  { keywords: ['gym', 'fitness', 'personal training', 'yoga studio', 'crossfit', 'martial arts', 'dance studio', 'athletic'],
    steps: [
      { label: 'Obtain personal trainer or instructor certification (ACE, NASM, etc.)', category: 'legal', why: 'Certification is required by most insurers and adds credibility for grant applications' },
      { label: 'Get professional liability insurance', category: 'insurance', why: 'Covers injuries during training sessions — required by most facility leases' },
      { label: 'Obtain CPR/AED certification', category: 'compliance', why: 'Required by all major certification bodies and by law in many states for fitness facilities' },
      { label: 'Register with your city for a health/fitness facility permit', category: 'legal', why: 'Zoning and health department approvals are required for gyms and studios' },
    ],
  },

  // ── 37. Cleaning / janitorial service ──
  { keywords: ['cleaning', 'janitorial', 'maid service', 'housekeeping', 'pressure washing', 'carpet cleaning'],
    steps: [
      { label: 'Get a general business license', category: 'legal', why: 'Required in most jurisdictions before soliciting cleaning contracts' },
      { label: 'Obtain general liability insurance', category: 'insurance', why: 'Covers property damage and injuries — required by most commercial clients' },
      { label: 'Get bonded (surety bond)', category: 'insurance', why: 'Clients want assurance against theft or damage — bonding is standard in the industry' },
      { label: 'Obtain hazardous materials handling certification (if using chemicals)', category: 'compliance', why: 'OSHA requires training for workers using industrial cleaning chemicals' },
    ],
  },

  // ── 38. Real estate / property management ──
  { keywords: ['real estate', 'property management', 'rental property', 'landlord', 'real estate invest', 'flip', 'rehab property'],
    steps: [
      { label: 'Get a real estate license (if brokering or managing for others)', category: 'legal', why: 'Required in all 50 states to conduct real estate transactions for compensation' },
      { label: 'Obtain landlord insurance / rental property coverage', category: 'insurance', why: 'Standard homeowner\'s insurance does not cover rental or investment properties' },
      { label: 'Research HUD Community Development Block Grants (CDBG)', category: 'financial_aid', why: 'CDBG funds can be used for property rehabilitation in low-income areas' },
      { label: 'Create a property condition report for each unit', category: 'documentation', why: 'Rehabilitation grants require baseline documentation of property conditions' },
    ],
  },

  // ── 39. Landscaping / lawn care ──
  { keywords: ['landscaping', 'lawn care', 'tree service', 'lawn maintenance', 'garden service', 'irrigation'],
    steps: [
      { label: 'Obtain a pesticide applicator license (if using chemicals)', category: 'legal', why: 'EPA and state agencies require certification for commercial pesticide application' },
      { label: 'Get commercial general liability insurance', category: 'insurance', why: 'Covers property damage from equipment — a single broken window can cost thousands' },
      { label: 'Get a commercial vehicle registration and DOT number (if needed)', category: 'compliance', why: 'Trucks and trailers over 10,001 lbs require USDOT registration' },
      { label: 'Obtain a contractor\'s license (required in some states)', category: 'legal', why: 'Some states classify landscaping over a dollar threshold as contracting' },
    ],
  },

  // ── 40. Pet care / animal services ──
  { keywords: ['pet', 'dog', 'animal', 'veterinary', 'kennel', 'grooming', 'pet sitting', 'animal rescue', 'animal shelter'],
    steps: [
      { label: 'Obtain a kennel or boarding facility license', category: 'legal', why: 'Required by your city or county before housing animals commercially' },
      { label: 'Get commercial liability insurance with animal-specific coverage', category: 'insurance', why: 'Standard policies exclude animal bites and property damage from animals' },
      { label: 'Pass a facility inspection (zoning, sanitation, ventilation)', category: 'compliance', why: 'Animal control and health departments inspect before issuing permits' },
      { label: 'Obtain 501(c)(3) status (for rescues/shelters)', category: 'legal', why: 'Required to receive Petco Foundation, ASPCA, and most animal welfare grants', skip: (t) => !t.includes('rescue') && !t.includes('shelter') && !t.includes('animal welfare') },
    ],
  },

  // ── 41. Agriculture / farmers market / community garden ──
  { keywords: ['farmers market', 'community garden', 'urban farm', 'grow food', 'local food', 'food hub', 'csa', 'community supported agriculture'],
    steps: [
      { label: 'Apply for USDA Farmers Market Promotion Program (FMPP)', category: 'financial_aid', why: 'FMPP grants fund market development, outreach, and infrastructure' },
      { label: 'Get certified as a SNAP/EBT-accepting vendor', category: 'compliance', why: 'Allows low-income customers to shop at your market using SNAP benefits' },
      { label: 'Obtain land-use permits or community garden agreements', category: 'legal', why: 'Urban farming requires zoning approval — some cities have specific urban agriculture zones' },
      { label: 'Apply for USDA organic certification (if applicable)', category: 'compliance', why: 'Organic certification opens premium markets — USDA covers certification costs up to $500', skip: (t) => !t.includes('organic') },
    ],
  },

  // ── 42. Youth programs / mentoring ──
  { keywords: ['youth', 'mentoring', 'after-school', 'teen', 'boys and girls club', 'youth development', 'at-risk youth', 'juvenile'],
    steps: [
      { label: 'Obtain background checks for all staff and volunteers', category: 'compliance', why: 'Required by law for anyone working with minors — most funders verify this' },
      { label: 'Develop a program curriculum with measurable outcomes', category: 'planning', why: 'Youth-serving grants require logic models showing inputs → activities → outcomes' },
      { label: 'Get a fiscal sponsor or 501(c)(3) status', category: 'legal', why: 'OJJDP, DOE, and foundation grants require nonprofit status' },
      { label: 'Register with your state\'s youth-serving organization registry', category: 'compliance', why: 'Many states require registration and annual reporting for organizations serving minors' },
    ],
  },

  // ── 43. Workforce development / job training ──
  { keywords: ['workforce', 'job training', 'vocational', 'apprentice', 'career development', 'employment program', 'job placement', 'skill training'],
    steps: [
      { label: 'Register as an Eligible Training Provider (ETP) with your state', category: 'compliance', why: 'WIOA participants can only use Individual Training Accounts at registered ETPs' },
      { label: 'Connect with your local Workforce Development Board', category: 'planning', why: 'WDBs distribute WIOA funds and can refer participants to your program' },
      { label: 'Develop a competency-based curriculum with industry credentials', category: 'planning', why: 'Programs leading to recognized credentials score higher in DOL grant reviews' },
      { label: 'Track job placement and wage data for past participants', category: 'documentation', why: 'DOL and foundations evaluate programs on employment outcomes, not just enrollment' },
    ],
  },

  // ── 44. Veteran business / service-disabled veteran ──
  { keywords: ['veteran business', 'service-disabled', 'vosb', 'sdvosb', 'veteran-owned', 'military entrepreneur'],
    steps: [
      { label: 'Apply for SBA Veteran Small Business Certification (VOSB/SDVOSB)', category: 'compliance', why: 'Gives access to sole-source and set-aside federal contracts', skip: (t, s) => s.organization_details?.cert_sdvosb },
      { label: 'Register with the VA Center for Verification and Evaluation', category: 'compliance', why: 'VA-verified status is required for VA set-aside contracts' },
      { label: 'Connect with a VBOC (Veterans Business Outreach Center)', category: 'planning', why: 'SBA-funded centers provide free business counseling and help with Boots to Business' },
      { label: 'Explore SBA 8(a) program for service-disabled veterans', category: 'financial_aid', why: '8(a) provides sole-source contracts up to $4.5M (services) or $7M (manufacturing)' },
    ],
  },

  // ── 45. Legal aid / justice ──
  { keywords: ['legal aid', 'legal services', 'justice', 'court', 'expungement', 'reentry', 'criminal record', 'formerly incarcerated'],
    steps: [
      { label: 'Connect with your local Legal Aid Society', category: 'planning', why: 'LSC-funded organizations provide free civil legal help and can refer to expungement programs' },
      { label: 'Gather all court records and disposition documents', category: 'documentation', why: 'Reentry and expungement programs require complete criminal history documentation' },
      { label: 'Apply for record expungement or sealing (if eligible)', category: 'legal', why: 'A clean record unlocks housing, employment, and education grant eligibility' },
      { label: 'Enroll in a DOL-funded reentry program (Ready to Work, etc.)', category: 'financial_aid', why: 'Federal reentry grants provide job training, mentoring, and transitional support' },
    ],
  },

  // ── 46. Food pantry / hunger relief ──
  { keywords: ['food pantry', 'food bank', 'hunger', 'food insecurity', 'meal program', 'soup kitchen', 'feeding', 'food distribution'],
    steps: [
      { label: 'Register with your regional Feeding America food bank', category: 'compliance', why: 'Provides access to donated food, USDA commodities, and Feeding America grants' },
      { label: 'Apply for TEFAP (The Emergency Food Assistance Program)', category: 'financial_aid', why: 'USDA program that provides free commodities to qualifying distribution sites' },
      { label: 'Obtain a food establishment permit from your health department', category: 'legal', why: 'Required even for free food distribution — covers handling, storage, and safety standards' },
      { label: 'Track pounds distributed and households served', category: 'documentation', why: 'USDA and foundations require quantitative impact data in all grant reports' },
    ],
  },

  // ── 47. Tutoring / education services ──
  { keywords: ['tutoring', 'education service', 'test prep', 'learning center', 'reading program', 'literacy', 'stem education', 'coding camp'],
    steps: [
      { label: 'Get background checks for all tutors/instructors', category: 'compliance', why: 'Required for any program working with minors — parents and funders verify this' },
      { label: 'Develop pre/post assessments to measure student growth', category: 'planning', why: 'Education grants require measurable evidence of academic improvement' },
      { label: 'Apply to become an approved 21st Century Community Learning Center provider', category: 'compliance', why: '21st CCLC grants fund afterschool academic enrichment programs — $1.3B annually' },
      { label: 'Obtain liability insurance covering educational services', category: 'insurance', why: 'Covers negligence claims related to student supervision and instruction' },
    ],
  },

  // ── 48. Photography / creative freelance ──
  { keywords: ['photography', 'photographer', 'freelance', 'graphic design', 'illustration', 'creative business', 'design studio'],
    steps: [
      { label: 'Register your business and obtain a business license', category: 'legal', why: 'Required for tax purposes and to open a business bank account' },
      { label: 'Build a professional portfolio website', category: 'documentation', why: 'Arts grants and creative economy programs require documented body of work' },
      { label: 'Obtain professional liability / errors and omissions insurance', category: 'insurance', why: 'Covers contract disputes, copyright issues, and client dissatisfaction claims' },
      { label: 'Research your state and local arts commission grants', category: 'planning', why: 'Local arts councils fund individual artists — competition is lower than national grants' },
    ],
  },

  // ── 49. E-commerce / online retail ──
  { keywords: ['e-commerce', 'ecommerce', 'online store', 'online retail', 'shopify', 'etsy', 'amazon seller', 'dropshipping'],
    steps: [
      { label: 'Obtain a sales tax permit / reseller certificate', category: 'legal', why: 'Required in states with sales tax before collecting tax on online sales' },
      { label: 'Register your business entity (LLC or S-Corp)', category: 'legal', why: 'Separates personal and business liability — required for most business grants' },
      { label: 'Set up a bookkeeping system (QuickBooks, Wave)', category: 'financial', why: 'Grant applications require profit/loss statements and balance sheets' },
      { label: 'Explore SBA microloans and community-based lending', category: 'financial_aid', why: 'SBA microloans up to $50K are designed for small and online businesses' },
    ],
  },

  // ── 50. Community health / public health ──
  { keywords: ['community health', 'public health', 'health education', 'health equity', 'health disparity', 'prevention', 'wellness program', 'health screening'],
    steps: [
      { label: 'Partner with a local health department or FQHC', category: 'planning', why: 'CDC and HRSA grants favor applications with established community health partnerships' },
      { label: 'Conduct a Community Health Needs Assessment (CHNA)', category: 'documentation', why: 'Required by CDC, HRSA, and most health foundations as the basis for your proposal' },
      { label: 'Develop a logic model linking activities to health outcomes', category: 'planning', why: 'The gold standard for public health grants — shows how your program reduces disparities' },
      { label: 'Obtain IRB approval (if collecting participant health data)', category: 'compliance', why: 'Required before any data collection involving human subjects in health programs' },
    ],
  },

  // ── 51. Financial need / low income (individual) ──
  { keywords: ['income', 'poverty', 'financial need', 'low income', 'below poverty', 'financial hardship', 'utility bill', 'electric bill'],
    steps: [
      { label: 'Document household income (pay stubs, tax returns)', category: 'documentation', why: 'Need-based programs require income verification — typically below 200% FPL' },
      { label: 'Apply for LIHEAP (energy assistance)', category: 'financial_aid', why: 'LIHEAP pays heating/cooling bills directly — apply through your Community Action Agency' },
      { label: 'Check eligibility for SNAP, Medicaid, and TANF', category: 'benefits', why: 'Enrollment in these programs automatically qualifies you for additional assistance' },
      { label: 'Contact 211 for local emergency assistance programs', category: 'planning', why: 'Dial 211 or visit 211.org — the national referral system connecting to local aid' },
    ],
  },

  // ── 52. Retail / storefront ──
  { keywords: ['retail', 'storefront', 'shop', 'boutique', 'brick and mortar', 'pop-up shop'],
    steps: [
      { label: 'Obtain a retail business license and sales tax permit', category: 'legal', why: 'Required before you can sell goods to the public and collect sales tax' },
      { label: 'Secure a commercial lease with favorable terms', category: 'planning', why: 'Negotiate tenant improvement allowances — some landlords contribute to buildout costs' },
      { label: 'Get commercial property insurance and liability coverage', category: 'insurance', why: 'Covers inventory damage, customer injuries, and theft — required by most leases' },
      { label: 'Explore SBA Community Advantage loans for underserved areas', category: 'financial_aid', why: 'Mission-focused lenders provide SBA-backed loans up to $350K for community businesses' },
    ],
  },

  // ── 53. Nonprofit health clinic / FQHC ──
  { keywords: ['fqhc', 'community health center', 'free clinic', 'sliding scale clinic', 'safety net'],
    steps: [
      { label: 'Apply for HRSA Section 330 New Access Point funding', category: 'financial_aid', why: 'Primary funding for new FQHCs — covers clinical operations and infrastructure' },
      { label: 'Obtain FTCA (Federal Tort Claims Act) malpractice coverage', category: 'insurance', why: 'HRSA-funded health centers get free federal malpractice coverage' },
      { label: 'Implement a sliding fee discount schedule', category: 'compliance', why: 'Required by HRSA for all Section 330 grantees — no patient turned away for inability to pay' },
      { label: 'Recruit a community-majority board of directors', category: 'governance', why: 'HRSA requires >51% of the board to be active patients of the health center' },
    ],
  },

  // ── 54. Sports / recreation program ──
  { keywords: ['sports', 'recreation', 'league', 'coach', 'athletic program', 'youth sports', 'basketball', 'soccer', 'baseball', 'football program'],
    steps: [
      { label: 'Obtain background checks for all coaches and volunteers', category: 'compliance', why: 'Required by law and by all major youth sports organizations' },
      { label: 'Get participant liability waivers and medical release forms', category: 'legal', why: 'Required before any youth can participate — protects your organization legally' },
      { label: 'Obtain sports accident insurance for participants', category: 'insurance', why: 'Covers participant injuries — separate from your general liability policy' },
      { label: 'Apply for NIKE, Dick\'s Sporting Goods, or local community foundation grants', category: 'financial_aid', why: 'Corporate and community sports grants fund equipment, uniforms, and facility upgrades' },
    ],
  },

  // ── 55. Music ministry / worship team ──
  { keywords: ['worship', 'praise team', 'music ministry', 'gospel', 'choir ministry', 'church music', 'worship band'],
    steps: [
      { label: 'Obtain a CCLI license for your congregation', category: 'legal', why: 'Required to legally project or print copyrighted worship song lyrics' },
      { label: 'Create an equipment wish list with specific model numbers and prices', category: 'planning', why: 'Equipment grants from Sweetwater, Guitar Center, and foundations require itemized requests' },
      { label: 'Document community impact (congregation size, events, outreach)', category: 'documentation', why: 'Arts and music funders evaluate reach and community benefit in grant applications' },
    ],
  },

  // ── 56. Manufacturing / production ──
  { keywords: ['manufacturing', 'factory', 'production', 'fabrication', 'machining', 'assembly', 'industrial'],
    steps: [
      { label: 'Obtain required EPA and OSHA permits', category: 'compliance', why: 'Environmental and workplace safety permits are required before production begins' },
      { label: 'Explore MEP (Manufacturing Extension Partnership) resources', category: 'planning', why: 'NIST-funded MEP centers in every state provide free technical assistance and grant guidance' },
      { label: 'Apply for SBA 504 loans for equipment and facilities', category: 'financial_aid', why: '504 loans provide long-term fixed-rate financing with only 10% down for equipment' },
      { label: 'Get product liability insurance', category: 'insurance', why: 'Covers defective product claims — required by most distributors and retailers' },
    ],
  },

  // ── 57. Counseling / social work ──
  { keywords: ['social work', 'case management', 'family services', 'crisis intervention', 'domestic', 'human services'],
    steps: [
      { label: 'Ensure all staff have appropriate state licensure (LCSW, LPC, LMFT)', category: 'legal', why: 'Licensure is required to provide clinical services and bill insurance' },
      { label: 'Apply for Medicaid provider enrollment', category: 'compliance', why: 'Medicaid is the primary payer for low-income clients — enrollment takes 60-90 days' },
      { label: 'Develop an outcomes tracking system (client progress measures)', category: 'planning', why: 'Funders require evidence-based practice and measurable client outcomes' },
      { label: 'Obtain professional liability insurance for all clinicians', category: 'insurance', why: 'Covers malpractice claims — individual and organizational policies both needed' },
    ],
  },

  // ── 58. Technology / digital inclusion / broadband ──
  { keywords: ['broadband', 'digital inclusion', 'internet access', 'digital literacy', 'computer lab', 'wifi', 'connectivity'],
    steps: [
      { label: 'Apply for FCC E-Rate or Emergency Connectivity Fund', category: 'financial_aid', why: 'E-Rate funds internet and networking for schools and libraries at 20-90% discount' },
      { label: 'Explore NTIA BEAD (Broadband Equity, Access, and Deployment) funding', category: 'financial_aid', why: '$42.45B in federal broadband deployment funds being distributed through states' },
      { label: 'Conduct a community broadband needs assessment', category: 'documentation', why: 'Required for NTIA and USDA broadband grants — document unserved and underserved areas' },
      { label: 'Partner with your state broadband office', category: 'planning', why: 'State broadband offices allocate BEAD funds and provide technical assistance to applicants' },
    ],
  },
]

/**
 * Analyze profile goals/narrative and surface real-world next steps.
 * Data-driven: iterates the SUCCESS_ARCHETYPES array, tests keyword/type triggers,
 * and collects matching steps with optional skip guards.
 */
function buildSuccessSteps(profile, sections, applicantType) {
  const narrative = sections.narrative ?? {}
  const orgDetails = sections.organization_details ?? {}

  const goal = (
    narrative.primary_goal || narrative.mission || orgDetails.mission ||
    profile.display_name || ''
  ).toLowerCase()

  const story = (narrative.story || narrative.background || narrative.barriers_faced || '').toLowerCase()

  // Build full text to match against — profile tags and keywords arrays need safe handling
  const tags = Array.isArray(profile.tags) ? profile.tags : []
  const keywords = Array.isArray(profile.keywords) ? profile.keywords : []
  const allText = `${goal} ${story} ${tags.join(' ')} ${keywords.join(' ')}`.toLowerCase()

  const type = (applicantType || '').toLowerCase()
  const steps = []

  for (const archetype of SUCCESS_ARCHETYPES) {
    // Check if this archetype triggers on keywords or profile type
    const keywordMatch = (archetype.keywords ?? []).some(kw => allText.includes(kw))
    const typeMatch = (archetype.types ?? []).some(t => type.includes(t))

    if (!keywordMatch && !typeMatch) continue

    for (const step of archetype.steps) {
      // Check the optional skip guard
      if (typeof step.skip === 'function') {
        try {
          if (step.skip(allText, sections)) continue
        } catch { /* guard threw — include the step */ }
      }
      steps.push({ label: step.label, category: step.category, why: step.why })
    }
  }

  // Deduplicate by label (multiple archetypes may suggest the same step)
  const seen = new Set()
  const unique = steps.filter(s => {
    if (seen.has(s.label)) return false
    seen.add(s.label)
    return true
  })

  // Cap at 12 steps to keep the UI digestible
  return unique.slice(0, 12)
}

export default router
