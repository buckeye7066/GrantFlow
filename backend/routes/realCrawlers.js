/**
 * Real Web Crawler API Routes
 * Handles execution of specialized funding crawlers
 * Production version - uses only real data sources
 */

import express from 'express'
import { ensureAuth } from '../middleware/auth.js'
import { getProfileWithLocation } from '../services/crawlers/crawlerHelpers.js'
import { calculateMatchScore } from '../services/matchingEngine.js'
import { bulkUpsertFundingOpportunities } from '../services/opportunityInserter.js'
import { normalizeDateToIso } from '../services/dateNormalization.js'
import { crawlLocalFunding } from '../services/crawlers/localFundingCrawler.js'
import { crawlGovernmentFunding } from '../services/crawlers/governmentFundingCrawler.js'
import { crawlStudentGrants } from '../services/crawlers/studentGrantsCrawler.js'
import { crawlHealthResources } from '../services/crawlers/healthResourcesCrawler.js'
import { crawlSpecialNeeds } from '../services/crawlers/specialNeedsCrawler.js'
import { crawlItemFunding } from '../services/crawlers/itemFundingCrawler.js'
import { crawlECFBenefits, evaluateEcfUnlockEligibility } from '../services/crawlers/ecfBenefitsCrawler.js'
import { requireTierCapability, TIER_CAPABILITIES } from '../utils/tierGating.js'
import { ensureProfileAccess } from '../utils/accessControl.js'

const router = express.Router()

// Crawler types
const CRAWLER_TYPES = [
  'local_funding',
  'government_funding', 
  'student_grants',
  'health_resources',
  'ecf_benefits',
  'item_matching',
  'special_needs'
]

const LOAN_TYPES = new Set(['loan', 'loan_program', 'microloan'])
const LIVE_CRAWL_TIMEOUT_MS = Number.parseInt(process.env.LIVE_CRAWL_TIMEOUT_MS ?? '12000', 10) || 12000
const MIN_LIVE_RESULTS_BEFORE_SKIP_FALLBACK = Number.parseInt(process.env.MIN_LIVE_RESULTS_BEFORE_SKIP_FALLBACK ?? '3', 10) || 3
const LIVE_CRAWL_PERSIST_OPPS = String(process.env.LIVE_CRAWL_PERSIST_OPPS ?? 'true').toLowerCase() !== 'false'

// Reversible safety toggles: default to SOFT matching (prefer penalties over exclusions).
const HARD_FILTER_REQUIRES_MATCH = String(process.env.HARD_FILTER_REQUIRES_MATCH ?? '').toLowerCase() === 'true'
const HARD_FILTER_MATCH_PERCENTAGE = String(process.env.HARD_FILTER_MATCH_PERCENTAGE ?? '').toLowerCase() === 'true'
// Token narrowing uses profile-derived keywords to pre-filter DB candidates (OR-based, soft match).
// Default ON so crawlers use profile information for relevance. Set env ENABLE_TOKEN_NARROWING=false to disable.
const ENABLE_TOKEN_NARROWING = String(process.env.ENABLE_TOKEN_NARROWING ?? 'true').toLowerCase() === 'true'
// Reversible: allow temporarily disabling ECF eligibility gating if needed.
const DISABLE_ECF_UNLOCK_GATING = String(process.env.DISABLE_ECF_UNLOCK_GATING ?? '').toLowerCase() === 'true'

function normalizeString(value) {
  if (typeof value !== 'string') return ''
  return value.trim().toLowerCase()
}

function safeParseJSON(value, fallback) {
  if (value === null || value === undefined) return fallback
  if (Array.isArray(value)) return value
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

const AMBIGUOUS_SINGLE_WORDS = new Set([
  'food', 'health', 'care', 'home', 'house', 'school', 'community',
  'family', 'child', 'children', 'work', 'service', 'support', 'program',
  'help', 'assist', 'need', 'general', 'special', 'local', 'national',
  'plan', 'fund', 'grant', 'money', 'bank', 'credit', 'loan',
  'start', 'open', 'build', 'make', 'create', 'medical', 'business',
  'assistance', 'resource', 'free', 'apply', 'person', 'people',
])

function buildSearchTokens(profileContext) {
  const signals = profileContext?.signals
  const profile = profileContext?.profile
  const phraseTokens = new Set()
  const singleTokens = new Set()

  // Priority 1: intent phrases (multi-word, high priority)
  if (signals?.intentPhrases && typeof signals.intentPhrases[Symbol.iterator] === 'function') {
    for (const phrase of signals.intentPhrases) {
      const normalized = normalizeString(String(phrase))
      if (normalized.length >= 6 && normalized.includes(' ')) phraseTokens.add(normalized)
    }
  }

  // Priority 2: phrases (multi-word, deduplicated)
  if (signals?.phrases && typeof signals.phrases[Symbol.iterator] === 'function') {
    for (const phrase of signals.phrases) {
      const normalized = normalizeString(String(phrase))
      if (normalized.length >= 6 && normalized.includes(' ') && !phraseTokens.has(normalized)) {
        phraseTokens.add(normalized)
      }
    }
  }

  // Priority 3: applicant types (phrase if multi-word, single if not)
  if (signals?.applicantTypes && typeof signals.applicantTypes[Symbol.iterator] === 'function') {
    for (const val of signals.applicantTypes) {
      const normalized = normalizeString(String(val).replace(/_/g, ' '))
      if (normalized.length < 4) continue
      if (normalized.includes(' ')) phraseTokens.add(normalized)
      else singleTokens.add(normalized)
    }
  }

  // Priority 4: signal sets (interests, demographics, health, assistance, occupation, military)
  const signalSets = [
    signals?.interests,
    signals?.demographics,
    signals?.health,
    signals?.assistance,
    signals?.occupation,
    signals?.military,
  ]
  for (const signalSet of signalSets) {
    if (signalSet && typeof signalSet[Symbol.iterator] === 'function') {
      for (const val of signalSet) {
        const normalized = normalizeString(String(val).replace(/_/g, ' '))
        if (normalized.length >= 4) {
          if (normalized.includes(' ')) phraseTokens.add(normalized)
          else singleTokens.add(normalized)
        }
      }
    }
  }

  // Priority 5: keyword set (single tokens only)
  if (signals?.keywordSet && typeof signals.keywordSet[Symbol.iterator] === 'function') {
    for (const kw of signals.keywordSet) {
      const normalized = normalizeString(String(kw))
      if (normalized.length >= 4 && !normalized.includes(' ')) singleTokens.add(normalized)
    }
  }

  // Priority 6: profile tags
  if (Array.isArray(profile?.tags)) {
    for (const value of profile.tags) {
      const normalized = normalizeString(String(value))
      if (normalized.length >= 4) {
        if (normalized.includes(' ')) phraseTokens.add(normalized)
        else singleTokens.add(normalized)
      }
    }
  }

  // Assemble: phrase tokens first (up to 14 total), then single tokens (max 4)
  const finalTokens = new Set()
  for (const p of phraseTokens) {
    if (finalTokens.size >= 14) break
    finalTokens.add(p)
  }
  const phraseTokenArray = Array.from(phraseTokens)
  let singleCount = 0
  for (const s of singleTokens) {
    if (finalTokens.size >= 14 || singleCount >= 4) break
    if (AMBIGUOUS_SINGLE_WORDS.has(s)) continue
    if (phraseTokenArray.some((p) => p.includes(s))) continue
    finalTokens.add(s)
    singleCount++
  }

  return Array.from(finalTokens).slice(0, 14)
}

function isOpportunityCurrent(row) {
  const deadlineType = normalizeString(row?.deadline_type)
  if (deadlineType === 'rolling' || deadlineType === 'ongoing') return true

  const deadline = row?.deadline
  if (!deadline) return true

  const parsed = new Date(deadline)
  if (Number.isNaN(parsed.getTime())) {
    // Unknown format; don't exclude automatically.
    return true
  }

  const now = new Date()
  // Expired deadlines are not relevant in 2026 (unless rolling/ongoing).
  return parsed >= new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

function normalizeLiveOpportunity(raw, { crawlerType }) {
  if (!raw || typeof raw !== 'object') return null

  const title = raw.title ?? raw.name ?? null
  const sponsor = raw.sponsor ?? raw.funder ?? raw.source ?? null
  const url = raw.url ?? raw.application_url ?? raw.source_url ?? null

  if (!title || typeof title !== 'string') return null

  const opportunityType = normalizeString(raw.opportunity_type || raw.type || raw.grant_type || 'grant') || 'grant'
  if (LOAN_TYPES.has(opportunityType)) return null

  const existingScore = typeof raw.match_score === 'number' ? raw.match_score : null
  const existingReasons = Array.isArray(raw.match_reasons) ? raw.match_reasons : []
  const recordOriginRaw = normalizeString(raw.record_origin || '')
  const isDirectoryStyle = opportunityType === 'program' || recordOriginRaw.includes('directory') || Boolean(raw.is_directory_resource)
  const normalizedDeadline = normalizeDateToIso(raw.deadline ?? null)

  return {
    id: raw.id ?? null,
    title,
    sponsor,
    description: raw.description ?? null,
    source: raw.source ?? crawlerType,
    source_url: raw.source_url ?? url,
    application_url: raw.application_url ?? url,
    url,
    amount_min: raw.amount_min ?? null,
    amount_max: raw.amount_max ?? null,
    amount_description: raw.amount_description ?? null,
    // Normalize deadline to ISO so SQLite DATE comparisons work (avoids false "expired" filtering).
    deadline: normalizedDeadline,
    deadline_type: raw.deadline_type ?? (normalizedDeadline ? 'fixed' : 'rolling'),
    is_national: Boolean(raw.is_national ?? true),
    state: raw.state ?? null,
    categories: Array.isArray(raw.categories) ? raw.categories : [],
    keywords: Array.isArray(raw.keywords) ? raw.keywords : [],
    eligibility_bullets: Array.isArray(raw.eligibility_bullets) ? raw.eligibility_bullets : [],
    opportunity_type: opportunityType,
    // Preserve crawler-provided origin when present; directory-style resources must not be treated as volatile live crawls.
    record_origin: recordOriginRaw || (isDirectoryStyle ? 'directory_resource' : 'live_crawl'),
    crawler_type: crawlerType,
    ...(existingScore !== null ? { match_score: existingScore } : {}),
    ...(existingReasons.length ? { match_reasons: existingReasons } : {}),
    ...(isDirectoryStyle ? { is_directory_resource: true } : {}),
  }
}

function mergeReasons(a, b) {
  const out = []
  const seen = new Set()
  for (const src of [a, b]) {
    if (!Array.isArray(src)) continue
    for (const r of src) {
      const s = typeof r === 'string' ? r.trim() : ''
      if (!s) continue
      const key = s.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(s)
    }
  }
  return out
}

function isDirectoryResource(row) {
  if (!row || typeof row !== 'object') return false
  const origin = normalizeString(row.record_origin || '')
  const oppType = normalizeString(row.opportunity_type || '')
  return (
    oppType === 'program' ||
    origin === 'directory' ||
    origin === 'directory_resource' ||
    origin.includes('directory') ||
    Boolean(row.is_directory_resource)
  )
}

async function withTimeout(promise, ms, label) {
  let timeoutId = null
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const err = new Error(`${label} timed out after ${ms}ms`)
      err.code = 'TIMEOUT'
      reject(err)
    }, ms)
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

async function runLiveCrawler({ crawlerType, profile, itemRequest, minMatchScore }) {
  const startedAt = Date.now()
  const options = { min_match_score: minMatchScore }

  // Validate profile before attempting to crawl
  if (!profile || typeof profile !== 'object') {
    return {
      ok: false,
      duration_ms: Date.now() - startedAt,
      error: 'Invalid profile data - profile is required',
      opportunities: [],
    }
  }

  try {
    let rawResults = []
    switch (crawlerType) {
      case 'local_funding':
        rawResults = await withTimeout(crawlLocalFunding(profile, options), LIVE_CRAWL_TIMEOUT_MS, 'local_funding')
        break
      case 'government_funding':
        rawResults = await withTimeout(crawlGovernmentFunding(profile, options), LIVE_CRAWL_TIMEOUT_MS, 'government_funding')
        break
      case 'student_grants':
        rawResults = await withTimeout(crawlStudentGrants(profile, options), LIVE_CRAWL_TIMEOUT_MS, 'student_grants')
        break
      case 'health_resources':
        rawResults = await withTimeout(crawlHealthResources(profile, options), LIVE_CRAWL_TIMEOUT_MS, 'health_resources')
        break
      case 'special_needs':
        rawResults = await withTimeout(crawlSpecialNeeds(profile, options), LIVE_CRAWL_TIMEOUT_MS, 'special_needs')
        break
      case 'item_matching':
        rawResults = await withTimeout(
          crawlItemFunding(profile, { item_request: itemRequest }),
          LIVE_CRAWL_TIMEOUT_MS,
          'item_matching',
        )
        break
      case 'ecf_benefits':
        // NOTE: crawler currently yields mostly link-style benefit records.
        rawResults = await withTimeout(crawlECFBenefits(profile, options), LIVE_CRAWL_TIMEOUT_MS, 'ecf_benefits')
        break
      default:
        return {
          ok: false,
          duration_ms: Date.now() - startedAt,
          error: `No live crawler implementation for ${crawlerType}`,
          opportunities: [],
        }
    }

    const normalized = (Array.isArray(rawResults) ? rawResults : [])
      .map((row) => normalizeLiveOpportunity(row, { crawlerType }))
      .filter(Boolean)

    // Score with the FULL profile context (signals + sections) so we use all datapoints consistently.
    const profileContextForScoring =
      profile && typeof profile === 'object' && profile.sections
        ? { profile, sections: profile.sections ?? {}, signals: profile.signals ?? null }
        : profile

    const current = normalized.filter(isOpportunityCurrent)

    // Preserve crawler-provided match_score when present (directory-style resources often pre-score themselves),
    // and only add our computed score on top.
    const rescored = current.map((row) => {
      const { score: computedScore, reasons: computedReasons } = calculateMatchScore(profileContextForScoring, row)
      const existingScore = typeof row.match_score === 'number' ? row.match_score : null
      const isDirectory = isDirectoryResource(row)

      const mergedScore =
        existingScore === null ? computedScore : Math.max(existingScore, computedScore)
      const mergedReasons = mergeReasons(row.match_reasons, computedReasons)

      // Guarantee directory resources survive the user's min threshold (they're entry points, not competitive matches).
      const finalScore = isDirectory ? Math.max(Number(minMatchScore), mergedScore) : mergedScore
      const finalReasons = isDirectory
        ? mergeReasons(mergedReasons, [`Directory resource (always included at ${Number(minMatchScore)}%+ threshold)`])
        : mergedReasons

      return { ...row, match_score: finalScore, match_reasons: finalReasons }
    })

    const included = rescored
      .filter((row) => {
        if (isDirectoryResource(row)) return true
        return typeof row.match_score === 'number' && row.match_score >= Number(minMatchScore)
      })
      .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
      .slice(0, 50)

    return {
      ok: true,
      duration_ms: Date.now() - startedAt,
      total_found: current.length,
      filtered_count: included.length,
      opportunities: included,
      error: null,
    }
  } catch (error) {
    const errorMsg = error?.message || String(error)
    const errorCode = error?.code

    // Provide more specific error messages
    let friendlyError = errorMsg
    if (errorCode === 'TIMEOUT') {
      friendlyError = `${crawlerType} crawler timed out after ${LIVE_CRAWL_TIMEOUT_MS}ms`
    } else if (errorMsg.includes('ENOTFOUND') || errorMsg.includes('ETIMEDOUT')) {
      friendlyError = `Network error: Unable to reach external data sources for ${crawlerType}`
    } else if (errorMsg.includes('API key') || errorMsg.includes('SAM_GOV_API_KEY')) {
      friendlyError = `API configuration missing for ${crawlerType} crawler`
    }

    console.error(`[RealCrawlers] ${crawlerType} live crawler error:`, errorMsg)
    if (error?.stack) {
      console.error(`[RealCrawlers] ${crawlerType} stack trace:\n`, error.stack)
    }
    
    return {
      ok: false,
      duration_ms: Date.now() - startedAt,
      error: friendlyError,
      opportunities: [],
    }
  }
}

function formatDbOpportunity(row) {
  if (!row) return null
  const keywords = safeParseJSON(row.keywords, [])
  const categories = safeParseJSON(row.categories, [])
  const eligibility_bullets = safeParseJSON(row.eligibility_bullets, [])
  const match_reasons = safeParseJSON(row.match_reasons, [])

  return {
    ...row,
    keywords,
    categories,
    eligibility_bullets,
    match_reasons,
    // Normalize url fields used by frontend.
    url: row.application_url ?? row.source_url ?? null,
  }
}

function buildCandidateOpportunityQuery({ crawlerType, profileContext, tokens, itemRequest, dialect }) {
  const isPostgres = dialect === 'postgres'
  const conditions = [isPostgres ? 'is_active = TRUE' : 'is_active = 1']
  const params = []

  // Avoid obviously non-grant programs by default.
  // IMPORTANT:
  // Matching-funds requirements are NOT exclusive. Do not hard-exclude them by default — penalize in scoring instead.
  if (HARD_FILTER_REQUIRES_MATCH) {
    conditions.push(
      isPostgres
        ? '(requires_match IS NULL OR requires_match = FALSE)'
        : "(requires_match IS NULL OR requires_match = 0 OR requires_match = '0' OR requires_match = 'false')",
    )
  }
  if (HARD_FILTER_MATCH_PERCENTAGE) {
    conditions.push(
      isPostgres
        ? '(match_percentage IS NULL OR match_percentage = 0)'
        : "(match_percentage IS NULL OR match_percentage = 0 OR match_percentage = '0')",
    )
  }
  conditions.push("(opportunity_type IS NULL OR LOWER(opportunity_type) NOT IN ('loan','loan_program','microloan'))")

  // Exclude expired deadlines by default (rolling/ongoing/NULL are allowed).
  conditions.push(
    isPostgres
      ? "(deadline_type IN ('rolling','ongoing') OR deadline IS NULL OR deadline >= CURRENT_DATE)"
      : "(deadline_type IN ('rolling','ongoing') OR deadline IS NULL OR deadline >= date('now'))",
  )

  // Geography: state + national.
  const state = profileContext?.signals?.location?.state ?? profileContext?.profile?.state ?? null
  if (state && typeof state === 'string' && state.trim().length === 2) {
    conditions.push(isPostgres ? '(state = ? OR is_national = TRUE OR state IS NULL)' : '(state = ? OR is_national = 1 OR state IS NULL)')
    params.push(state.trim().toUpperCase())
  }

  // Crawler-type hints (lightweight pre-filter).
  if (crawlerType === 'student_grants') {
    conditions.push(
      "(LOWER(source) = 'student_grants' OR LOWER(opportunity_type) IN ('scholarship','grant') OR LOWER(title) LIKE '%scholar%' OR LOWER(description) LIKE '%scholar%')",
    )
  }
  if (crawlerType === 'ecf_benefits') {
    conditions.push(
      "(LOWER(source) IN ('ecf_benefits','ecf_choices_discovery') OR LOWER(title) LIKE '%ecf%' OR LOWER(description) LIKE '%ecf%')",
    )
  }
  if (crawlerType === 'special_needs') {
    conditions.push(
      "(LOWER(source) = 'special_needs' OR LOWER(title) LIKE '%disab%' OR LOWER(description) LIKE '%disab%' OR LOWER(title) LIKE '%cancer%' OR LOWER(description) LIKE '%cancer%')",
    )
  }
  if (crawlerType === 'government_funding') {
    conditions.push(
      "(LOWER(source) IN ('government_funding','grants.gov','usaspending.gov','grants_gov','usa_spending','state_portal','hud_cdbg','liheap','snap_et') OR LOWER(title) LIKE '%federal%' OR LOWER(description) LIKE '%federal%')",
    )
  }

  // Keyword narrowing from profile (kept small to avoid huge SQL).
  // IMPORTANT: profile-derived tokens should improve ranking, not eliminate results.
  // We keep this as an opt-in optimization for very large datasets.
  if (ENABLE_TOKEN_NARROWING && tokens.length > 0) {
    const tokenClauses = tokens
      .map(() => '(LOWER(title) LIKE ? OR LOWER(description) LIKE ? OR LOWER(keywords) LIKE ? OR LOWER(categories) LIKE ?)')
      .join(' OR ')
    conditions.push(`(${tokenClauses})`)
    tokens.forEach((token) => {
      const pattern = `%${token}%`
      params.push(pattern, pattern, pattern, pattern)
    })
  }

  // Item-specific narrowing if provided.
  if (crawlerType === 'item_matching' && itemRequest && typeof itemRequest === 'string') {
    const itemTokens = itemRequest
      .split(/[^a-z0-9]+/gi)
      .map((t) => normalizeString(t))
      .filter((t) => t.length >= 3)
      .slice(0, 6)
    if (itemTokens.length > 0) {
      const itemClauses = itemTokens
        .map(() => '(LOWER(title) LIKE ? OR LOWER(description) LIKE ? OR LOWER(keywords) LIKE ?)')
        .join(' OR ')
      conditions.push(`(${itemClauses})`)
      itemTokens.forEach((token) => {
        const pattern = `%${token}%`
        params.push(pattern, pattern, pattern)
      })
    }
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  // Prefer recent/updated opportunities so we don’t “drift” back into 2024-only data.
  // IMPORTANT: Postgres `deadline` is a DATE column; comparing it to '' throws:
  // "invalid input syntax for type date: \"\"".
  const deadlineNullSort = isPostgres ? 'deadline IS NULL' : "deadline IS NULL OR deadline = ''"
  const sql = `
    SELECT *
    FROM funding_opportunities
    ${where}
    ORDER BY
      CASE WHEN ${deadlineNullSort} THEN 1 ELSE 0 END,
      deadline ASC,
      updated_at DESC
    LIMIT 1500
  `

  return { sql, params }
}

/**
 * Run a specific crawler
 * POST /api/real-crawlers/run
 */
router.post('/run', ensureAuth, async (req, res) => {
  const {
    crawler_type,
    profile_id,
    profile_data,
    item_request,
    min_match_score = 50, // Lowered to 50; crawlers now use 100% of profile signals
  } = req.body
  
  if (!crawler_type || !CRAWLER_TYPES.includes(crawler_type)) {
    return res.status(400).json({ 
      error: 'Invalid crawler type',
      message: `Invalid crawler type: ${crawler_type}`,
      available_crawlers: CRAWLER_TYPES
    })
  }
  
  // Hard guard: we will not run crawlers unless we can load the full profile context
  // (all profile_sections + derived signals) from the database.
  if (!profile_id) {
    return res.status(400).json({
      error: 'Profile ID required',
      message: 'Crawler runs require a profile_id so we can use 100% of the profile sections/signals.',
    })
  }

  // Enforce profile access (prevents running crawlers for arbitrary profiles via direct API calls).
  if (!(await ensureProfileAccess(req, res, String(profile_id)))) return

  // Tier gating: item matching is a paid feature (ITEM_FUNDING).
  if (crawler_type === 'item_matching') {
    if (!(await requireTierCapability(req, res, String(profile_id), TIER_CAPABILITIES.ITEM_FUNDING))) return
  }
  
  try {
    const db = req.db
    
    // Prefer DB-backed profile_id so we always use the full 22-page profile_sections context.
    let profile = null
    if (profile_id) {
      try {
        profile = await getProfileWithLocation(db, profile_id)
      } catch (profileError) {
        console.error('[RealCrawlers] Error loading profile:', profileError)
        return res.status(200).json({
          success: false,
          error: 'Profile loading failed',
          message: `Could not load profile: ${profileError?.message || 'Unknown error'}`,
          crawler_type,
          opportunities: [],
        })
      }
    } else {
      profile = profile_data
    }

    if (!profile) {
      return res.status(404).json({
        error: 'Profile not found',
        message: `Profile with ID ${profile_id} does not exist`,
      })
    }
    
    // Validate profile has required data
    if (!profile.signals && !profile.sections) {
      console.warn('[RealCrawlers] Profile missing signals and sections - results may be limited')
    }

    const profileContext =
      profile && profile.sections && profile.signals
        ? { profile, sections: profile.sections, signals: profile.signals }
        : { profile, sections: profile?.sections ?? {}, signals: profile?.signals ?? null }

    const coveragePct = profileContext?.signals?.coverage?.pct ?? 0
    const sectionCount = profileContext?.sections ? Object.keys(profileContext.sections).length : 0
    const keywordCount =
      typeof profileContext?.signals?.keywordSet?.size === 'number'
        ? profileContext.signals.keywordSet.size
        : Array.isArray(profileContext?.signals?.keywords)
        ? profileContext.signals.keywords.length
        : 0
    const zip =
      profileContext?.signals?.location?.zip ??
      profile?.zip_code ??
      profile?.postal_code ??
      null
    const state =
      profileContext?.signals?.location?.state ??
      profile?.state ??
      null

    const profileContextIncomplete = sectionCount === 0 || coveragePct < 1
    
    console.log(`[RealCrawlers] Running ${crawler_type} for profile ${profile_id || 'custom'}`)

    // Hard lock: ECF crawler only runs for ECF CHOICES participants or their caretakers/providers.
    if (crawler_type === 'ecf_benefits' && !DISABLE_ECF_UNLOCK_GATING) {
      const ecf = evaluateEcfUnlockEligibility(profile)
      if (!ecf.eligibleIndividual && !ecf.eligibleSupport) {
        console.warn('[RealCrawlers] ECF crawler locked for profile', {
          profile_id,
          eligibleIndividual: ecf.eligibleIndividual,
          eligibleSupport: ecf.eligibleSupport,
          supportType: ecf.supportType,
        })
        return res.status(200).json({
          success: false,
          error: 'ECF_ELIGIBILITY',
          message:
            'ECF CHOICES Benefits crawler is only available for ECF CHOICES participants or their caretakers/providers.',
          crawler_type,
          count: 0,
          total_found: 0,
          filtered_count: 0,
          min_match_score,
          opportunities: [],
          debug: {
            ecf_unlock: ecf,
          },
        })
      }
    }
    
    // 1) Try live crawler first (real web sources), then fall back to DB matching.
    const startTime = Date.now()
    const debug = {
      used_live: false,
      used_db_fallback: false,
      live: null,
      db: null,
      has_zip: Boolean(zip),
      has_state: Boolean(state),
      keyword_count: keywordCount,
      coverage_pct: coveragePct,
      section_count: sectionCount,
      profile_context_incomplete: profileContextIncomplete,
    }

    const live = await runLiveCrawler({
      crawlerType: crawler_type,
      profile,
      itemRequest: item_request,
      minMatchScore: Number(min_match_score),
    })

    if (live.ok && live.opportunities.length > 0) {
      // Persist discovered opportunities for browsing (even if user doesn't add to pipeline).
      // This makes the Opportunities page a canonical backlog of crawler discoveries.
      if (LIVE_CRAWL_PERSIST_OPPS) {
        try {
          const insertedIds = await bulkUpsertFundingOpportunities(
            db,
            live.opportunities.map((o) => ({
              ...o,
              // Keep these as global opportunities (not tied to a single profile).
              profile_id: null,
              record_origin: 'live_crawl',
              source: crawler_type,
              source_id: o.source_id ?? o.id ?? o.url ?? o.application_url ?? o.source_url ?? null,
              source_url: o.source_url ?? o.url ?? o.application_url ?? null,
              application_url: o.application_url ?? o.url ?? o.source_url ?? null,
            })),
          )
          debug.live = { ...(debug.live || {}), persisted_inserted: insertedIds.length }
        } catch (persistError) {
          debug.live = { ...(debug.live || {}), persist_error: persistError?.message || String(persistError) }
        }
      }

      debug.used_live = true
      debug.live = {
        ok: true,
        duration_ms: live.duration_ms,
        returned: live.opportunities.length,
        total_found: live.total_found ?? live.opportunities.length,
      }

      // If live results are solid, skip fallback; otherwise optionally augment with DB.
      const shouldSkipFallback = live.opportunities.length >= MIN_LIVE_RESULTS_BEFORE_SKIP_FALLBACK
      if (shouldSkipFallback) {
        const duration = Date.now() - startTime
        return res.json({
          success: true,
          crawler_type,
          count: live.opportunities.length,
          total_found: live.total_found ?? live.opportunities.length,
          filtered_count: live.opportunities.length,
          min_match_score,
          duration,
          opportunities: live.opportunities,
          used_live: true,
          used_db_fallback: false,
          debug,
        })
      }
    } else {
      debug.used_live = false
      debug.live = { ok: Boolean(live.ok), duration_ms: live.duration_ms, returned: 0, error: live.error || null }
    }

    // 2) DB matching fallback (fast, stable, always uses full profile data).
    let candidates = []
    
    try {
      const tokens = buildSearchTokens(profileContext)
      const { sql, params } = buildCandidateOpportunityQuery({
        crawlerType: crawler_type,
        profileContext,
        tokens,
        itemRequest: item_request,
        dialect: db?.dialect,
      })
      candidates = (await db.prepare(sql).all(...params)).map(formatDbOpportunity).filter(Boolean)
    } catch (crawlerError) {
      console.error(`[RealCrawlers] Crawler ${crawler_type} failed:`, crawlerError)
      
      // Return detailed error information
      let errorMessage = crawlerError.message || 'Unknown crawler error'
      let errorDetails = null
      
      // Check for common error patterns and provide helpful messages
      if (errorMessage.includes('SAM_GOV_API_KEY') || errorMessage.includes('API key')) {
        errorMessage = 'SAM_GOV_API_KEY missing - government funding crawler requires API configuration'
      } else if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('network')) {
        errorMessage = 'Network error - unable to reach external funding sources'
      } else if (errorMessage.includes('timeout')) {
        errorMessage = 'Request timeout - external service is not responding'
      }
      
      // IMPORTANT: return 200 so the frontend doesn't treat this as a network/resource failure.
      // The UI will surface `success: false` + message for this specific crawler instead.
      return res.status(200).json({
        success: false,
        error: 'Crawler execution failed',
        message: errorMessage,
        crawler_type,
        count: 0,
        total_found: 0,
        min_match_score,
        opportunities: [],
        status: 500,
        timestamp: new Date().toISOString(),
        details: errorDetails,
      })
    }
    
    const duration = Date.now() - startTime
    
    const currentCandidates = candidates.filter((row) => isOpportunityCurrent(row))
    const expiredExcluded = Math.max(0, candidates.length - currentCandidates.length)

    // Score all candidates using the deterministic engine (uses full sections/signals).
    // CRITICAL INVARIANT:
    // - Directory-style resources must survive filtering (they are entry points, not competitive matches).
    // - When total_found > 0, do not return included === 0 unless this is a fatal error.
    const scored = currentCandidates.map((row) => {
      const { score, reasons } = calculateMatchScore(profileContext, row)
      const isDirectory = isDirectoryResource(row)
      const finalScore = isDirectory ? Math.max(Number(min_match_score), score) : score
      const finalReasons = isDirectory
        ? mergeReasons(reasons, [
            `Directory resource (always included at ${Number(min_match_score)}%+ threshold)`,
          ])
        : reasons

      return {
        ...row,
        match_score: finalScore,
        match_reasons: finalReasons,
        // Normalize sponsor/title for UI
        sponsor: row.sponsor ?? row.funder ?? null,
      }
    })

    const totalFound = scored.length

    // Filter by minimum match score (default lowered; UI can adjust).
    let filteredOpportunities = scored
      .filter((opp) => {
        if (isDirectoryResource(opp)) return true
        return typeof opp.match_score === 'number' && opp.match_score >= Number(min_match_score)
      })
      .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
      .slice(0, 50)
    const initiallyIncludedCount = filteredOpportunities.length

    debug.used_db_fallback = true
    debug.db = {
      candidates: candidates.length,
      current: currentCandidates.length,
      expired_excluded: expiredExcluded,
      returned: filteredOpportunities.length,
    }

    // Guardrail: if something is being found but everything is filtered out, include score diagnostics.
    // This is additive (does not change the existing response shape); the UI can ignore it.
    if (initiallyIncludedCount === 0 && totalFound > 0) {
      const scores = scored
        .map((o) => (typeof o?.match_score === 'number' ? o.match_score : null))
        .filter((v) => typeof v === 'number')
      const minScore = scores.length ? Math.min(...scores) : null
      const maxScore = scores.length ? Math.max(...scores) : null
      const avgScore = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null
      const topScores = scored
        .filter((o) => typeof o?.match_score === 'number')
        .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
        .slice(0, 5)
        .map((o) => ({
          title: o.title ?? null,
          sponsor: o.sponsor ?? o.funder ?? null,
          score: o.match_score,
          record_origin: o.record_origin ?? null,
          opportunity_type: o.opportunity_type ?? null,
        }))

      let primaryReason = 'filtered_below_min_match_score'
      if (scores.length === 0) primaryReason = 'no_scores_generated'
      else if (maxScore !== null && maxScore < Number(min_match_score)) primaryReason = 'all_below_min_match_score'

      debug.filter_diagnostics = {
        min_match_score: Number(min_match_score),
        score_stats: { min: minScore, max: maxScore, avg: avgScore },
        top_5: topScores,
        primary_reason: primaryReason,
        removed_summary: {
          expired_excluded: expiredExcluded,
          below_min_match_score: totalFound,
          directory_present: scored.some((row) => isDirectoryResource(row)),
        },
      }
    }

    // Guardrail: "0 results" is a failure state.
    // If we scored anything but filtered everything away, fall back to returning the best-scoring options.
    // This preserves the response shape while preventing "total_found > 0, included === 0".
    if (initiallyIncludedCount === 0 && totalFound > 0) {
      filteredOpportunities = scored
        .filter((o) => typeof o?.match_score === 'number' || isDirectoryResource(o))
        .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
        .slice(0, 50)
      debug.db.returned = filteredOpportunities.length
      debug.db.fallback_applied = filteredOpportunities.length > 0 ? true : undefined
    }

    // If live had *some* results, merge + dedupe by URL/title so users see real results first.
    let merged = filteredOpportunities
    if (live.ok && Array.isArray(live.opportunities) && live.opportunities.length > 0) {
      debug.used_live = true
      debug.used_db_fallback = true
      const seen = new Set()
      const keyOf = (o) => String(o?.url || o?.application_url || o?.source_url || o?.title || '').toLowerCase()
      merged = [...live.opportunities, ...filteredOpportunities].filter((o) => {
        const key = keyOf(o)
        if (!key) return true
        if (seen.has(key)) return false
        seen.add(key)
        return true
      }).slice(0, 50)
    }

    console.log(
      `[RealCrawlers] ${crawler_type} evaluated ${totalFound} candidates; returning ${merged.length} (min_score=${min_match_score}) in ${duration}ms`,
    )
    
    res.json({
      success: true,
      crawler_type,
      count: merged.length,
      total_found: totalFound,
      filtered_count: merged.length,
      min_match_score,
      duration,
      opportunities: merged,
      used_live: Boolean(debug.used_live),
      used_db_fallback: Boolean(debug.used_db_fallback),
      debug,
    })
    
  } catch (error) {
    console.error(`[RealCrawlers] Error in ${crawler_type}:`, error)
    // Same principle: avoid 500s that show as "Failed to load resource" in the browser.
    res.status(200).json({ 
      success: false,
      error: 'Crawler execution failed',
      message: error?.message || String(error),
      crawler_type,
      opportunities: [],
    })
  }
})

/**
 * Get all available crawlers
 * GET /api/real-crawlers/list
 */
router.get('/list', ensureAuth, (req, res) => {
  const crawlers = CRAWLER_TYPES.map(type => ({
    id: type,
    name: type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
    description: getCrawlerDescription(type),
    available: true
  }))
  
  res.json({
    crawlers,
    total: crawlers.length
  })
})

/**
 * Run multiple crawlers for a profile
 * POST /api/real-crawlers/run-multiple
 */
router.post('/run-multiple', ensureAuth, async (req, res) => {
  const { profile_id, crawler_types, min_match_score = 60 } = req.body
  
  if (!profile_id) {
    return res.status(400).json({ 
      error: 'Profile ID required',
      message: 'profile_id is required for running multiple crawlers'
    })
  }

  // Enforce profile access (prevents bypass via direct API calls).
  if (!(await ensureProfileAccess(req, res, String(profile_id)))) return

  // Tier gating: item matching is a paid feature (ITEM_FUNDING).
  if (Array.isArray(crawler_types) && crawler_types.includes('item_matching')) {
    if (!(await requireTierCapability(req, res, String(profile_id), TIER_CAPABILITIES.ITEM_FUNDING))) return
  }
  
  if (!crawler_types || !Array.isArray(crawler_types)) {
    return res.status(400).json({ 
      error: 'Crawler types array required',
      message: 'crawler_types must be an array of crawler type strings'
    })
  }
  
  const db = req.db
  const profile = await getProfileWithLocation(db, profile_id)
  
  if (!profile) {
    return res.status(404).json({ 
      error: 'Profile not found',
      message: `Profile with ID ${profile_id} does not exist`
    })
  }
  
  const succeeded = []
  const failed = []
  let totalFound = 0
  let totalInserted = 0

  const profileContextBase =
    profile && profile.sections && profile.signals
      ? { profile, sections: profile.sections, signals: profile.signals }
      : { profile, sections: profile?.sections ?? {}, signals: profile?.signals ?? null }

  const coveragePct = profileContextBase?.signals?.coverage?.pct ?? 0
  if (!profileContextBase?.sections || Object.keys(profileContextBase.sections).length === 0 || coveragePct < 1) {
    return res.status(400).json({
      error: 'Profile context incomplete',
      message:
        'Refusing to run: crawlers require 100% profile coverage (all sections loaded and included in signals). Please complete/save the profile sections and retry.',
      coverage: profileContextBase?.signals?.coverage ?? null,
    })
  }
  
  for (const crawlerType of crawler_types) {
    if (!CRAWLER_TYPES.includes(crawlerType)) {
      failed.push({
        crawler: crawlerType,
        error: 'Invalid crawler type',
        status: 400
      })
      continue
    }
    
    try {
      const profileContext = profileContextBase
      const startAt = Date.now()

      if (crawlerType === 'ecf_benefits' && !DISABLE_ECF_UNLOCK_GATING) {
        const ecf = evaluateEcfUnlockEligibility(profile)
        if (!ecf.eligibleIndividual && !ecf.eligibleSupport) {
          failed.push({
            crawler: crawlerType,
            error:
              'ECF CHOICES Benefits crawler is only available for ECF CHOICES participants or their caretakers/providers.',
            status: 403,
            debug: { ecf_unlock: ecf },
          })
          continue
        }
      }

      // Live-first: mirror /run behavior (real web sources), then fall back to DB matching.
      // This prevents DB-only limitations (e.g., older ingested rows, deadline formatting) from collapsing counts.
      let live = null
      try {
        live = await runLiveCrawler({
          crawlerType,
          profile,
          itemRequest: req.body?.item_request ?? null,
          minMatchScore: Number(min_match_score),
        })
      } catch (liveError) {
        live = { ok: false, opportunities: [], error: liveError?.message || String(liveError) }
      }

      if (live?.ok && Array.isArray(live.opportunities) && live.opportunities.length > 0) {
        // Same threshold as /run: if live is "solid", skip DB fallback for this crawler.
        const shouldSkipFallback = live.opportunities.length >= MIN_LIVE_RESULTS_BEFORE_SKIP_FALLBACK
        if (shouldSkipFallback) {
          totalFound += Number(live.total_found ?? live.opportunities.length)
          totalInserted += live.opportunities.length
          succeeded.push({
            crawler: crawlerType,
            found: Number(live.total_found ?? live.opportunities.length),
            inserted: live.opportunities.length,
            duration_ms: Date.now() - startAt,
            used_live: true,
            used_db_fallback: false,
          })
          continue
        }
      }

      const tokens = buildSearchTokens(profileContext)
      const { sql, params } = buildCandidateOpportunityQuery({
        crawlerType,
        profileContext,
        tokens,
        dialect: db?.dialect,
      })

      const candidates = (await db.prepare(sql).all(...params)).map(formatDbOpportunity).filter(Boolean)
      const scored = candidates
        .filter((row) => isOpportunityCurrent(row))
        .map((row) => {
          const { score, reasons } = calculateMatchScore(profileContext, row)
          const isDirectory = isDirectoryResource(row)
          const finalScore = isDirectory ? Math.max(Number(min_match_score), score) : score
          const finalReasons = isDirectory
            ? mergeReasons(reasons, [
                `Directory resource (always included at ${Number(min_match_score)}%+ threshold)`,
              ])
            : reasons
          return { ...row, match_score: finalScore, match_reasons: finalReasons }
        })

      const totalFoundForCrawler = scored.length

      // Filtering with guardrails:
      // - Directory resources always survive.
      // - "0 included" is a failure state when total_found > 0; fall back to best-scoring items.
      let filtered = scored
        .filter((opp) => {
          if (isDirectoryResource(opp)) return true
          return typeof opp.match_score === 'number' && opp.match_score >= Number(min_match_score)
        })
        .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
        .slice(0, 50)

      if (filtered.length === 0 && totalFoundForCrawler > 0) {
        filtered = scored
          .filter((o) => typeof o?.match_score === 'number' || isDirectoryResource(o))
          .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
          .slice(0, 50)
      }

      // If live had *some* results, merge + dedupe so users get real results first.
      // Note: response shape is preserved; we only adjust counts.
      let merged = filtered
      if (live?.ok && Array.isArray(live.opportunities) && live.opportunities.length > 0) {
        const seen = new Set()
        const keyOf = (o) => String(o?.url || o?.application_url || o?.source_url || o?.title || '').toLowerCase()
        merged = [...live.opportunities, ...filtered].filter((o) => {
          const key = keyOf(o)
          if (!key) return true
          if (seen.has(key)) return false
          seen.add(key)
          return true
        }).slice(0, 50)
      }

      totalFound += live?.ok ? Number(live.total_found ?? 0) + scored.length : scored.length
      totalInserted += merged.length
      
      succeeded.push({
        crawler: crawlerType,
        found: live?.ok ? Number(live.total_found ?? 0) + scored.length : scored.length,
        inserted: merged.length,
        duration_ms: Date.now() - startAt,
        used_live: Boolean(live?.ok && Array.isArray(live.opportunities) && live.opportunities.length > 0),
        used_db_fallback: true,
      })
    } catch (error) {
      console.error(`[RealCrawlers] Error in ${crawlerType}:`, error)
      
      // Provide helpful error messages
      let errorMessage = error.message || 'Unknown error'
      if (errorMessage.includes('SAM_GOV_API_KEY')) {
        errorMessage = 'SAM_GOV_API_KEY missing'
      } else if (errorMessage.includes('network') || errorMessage.includes('ENOTFOUND')) {
        errorMessage = 'Network error - unable to reach external sources'
      }
      
      failed.push({
        crawler: crawlerType,
        error: errorMessage,
        status: 500
      })
    }
  }
  
  res.json({
    totalSelected: crawler_types.length,
    succeeded,
    failed,
    totalFound,
    totalInserted
  })
})

/**
 * Get crawler description
 */
function getCrawlerDescription(type) {
  const descriptions = {
    local_funding: 'Searches for funding opportunities within 50 miles of your location',
    government_funding: 'Finds federal, state, and local government grants and programs',
    student_grants: 'Discovers scholarships, grants, and financial aid for students',
    ecf_benefits: 'Locates ECF CHOICES benefits and disability support services',
    item_matching: 'Matches specific item requests with funding sources',
    special_needs: 'Identifies funding for special needs, disabilities, and unique circumstances'
  }
  
  return descriptions[type] || 'Specialized funding crawler'
}

/**
 * Save opportunities to database
 */
// NOTE:
// We intentionally do not write crawler matches back into funding_opportunities here.
// funding_opportunities is maintained by the ingestion pipeline; "crawler runs" should
// query + score existing live opportunities for the selected profile.

export default router
