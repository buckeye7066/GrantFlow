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
import { buildProfileFacets, requireFacets, buildIntentTokens } from '../services/profile/profileTaxonomy.js'
import { planCrawlerQueries } from '../services/crawlers/queryPlanner.js'

const router = express.Router()

/**
 * Merge request-provided profile_data into a DB-loaded profile.
 * Goal: crawlers ALWAYS use the most current profile context (sections + signals + top-level fields)
 * even if the DB copy is stale or the UI has just enriched/edited the profile.
 */
function mergeProfileAndData(profile, profileData) {


  if (!profileData) return profile;
  if (!profile || typeof profile !== 'object') return profileData;
  const merged = { ...profile };

  // Prefer newest context
  if (profileData.sections && typeof profileData.sections === 'object') {
    merged.sections = { ...(profile.sections || {}), ...profileData.sections };
  }
  if (profileData.signals && typeof profileData.signals === 'object') {
    merged.signals = { ...(profile.signals || {}), ...profileData.signals };
  }

  // Copy simple fields (state/city/zip/etc.) if provided
  for (const key of Object.keys(profileData)) {
    if (key === 'sections' || key === 'signals') continue;
    if (profileData[key] !== undefined) merged[key] = profileData[key];
  }

  return merged;
}

const STATE_NAME_TO_ABBREV_CRAWLERS = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO',
  montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND',
  ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI',
  'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV',
  wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC',
}

function normalizeStateForCrawler(value) {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (!raw) return null
  const upper = raw.toUpperCase().replace(/[^A-Z]/g, '')
  if (upper.length === 2) return upper
  return STATE_NAME_TO_ABBREV_CRAWLERS[raw.toLowerCase()] ?? null
}

// Crawler types (comprehensive = single pass over all funding sources)
const CRAWLER_TYPES = [
  'comprehensive',
  'local_funding',
  'government_funding',
  'student_grants',
  'health_resources',
  'ecf_benefits',
  'item_matching',
  'special_needs'
]

const COMPREHENSIVE_CRAWLER_IDS = [
  'local_funding',
  'government_funding',
  'student_grants',
  'health_resources',
  'ecf_benefits',
  'special_needs',
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

function isValidHttpUrl(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function bumpRejectionCount(rejections, key) {
  if (!rejections || !key) return
  const k = String(key)
  rejections[k] = (rejections[k] ?? 0) + 1
}

function summarizeUsedFacets(facets) {
  if (!facets || typeof facets !== 'object') return {}
  return {
    profile: {
      primary_profile_type: facets?.profile?.primary_profile_type ?? null,
      applicant_types_count: Array.isArray(facets?.profile?.applicant_types)
        ? facets.profile.applicant_types.length
        : 0,
    },
    geo: {
      state: facets?.geo?.state ?? null,
      zip: facets?.geo?.zip ?? null,
      city: facets?.geo?.city ?? null,
      county: facets?.geo?.county ?? null,
    },
    intent: {
      primary_need_category: facets?.intent?.primary_need_category ?? null,
      keywords_count: Array.isArray(facets?.intent?.keywords) ? facets.intent.keywords.length : 0,
      negative_keywords_count: Array.isArray(facets?.intent?.negative_keywords)
        ? facets.intent.negative_keywords.length
        : 0,
    },
  }
}

function buildAdminDebugMeta({ profileContext, queryPlan, validationRejectionCounts = {} }) {
  return {
    used_facets: summarizeUsedFacets(profileContext?.facets),
    query_plan: queryPlan ?? profileContext?.queryPlan ?? null,
    validation_rejection_counts: validationRejectionCounts,
  }
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

AMBIGUOUS_SINGLE_WORDS
  'food', 'care', 'home', 'house', 'school', 'community',
'child', 'children', 'work', 'service', 'support', 'program',
  'help', 'need', 'general', 'special', 'local', 'national',
  'plan', 'fund', 'grant', 'money', 'bank', 'credit', 'loan',
 'start', 'open', 'build', 'make', 'create',
  ''resource', 'free', 'apply', 'person', 'people',
])

function buildSearchTokens(profileContext) {
  const facets = profileContext?.facets
  const queryPlan = profileContext?.queryPlan

  // Taxonomy-first token generation so fallback DB search uses canonical facets.
  if (facets && typeof facets === 'object') {
    const intentTokens = buildIntentTokens({ facets })
    const fromIntent = [
      ...(Array.isArray(intentTokens.mustTerms) ? intentTokens.mustTerms : []),
      ...(Array.isArray(intentTokens.shouldTerms) ? intentTokens.shouldTerms : []),
    ]
    const fromPlan = [
      ...(Array.isArray(queryPlan?.mustTerms) ? queryPlan.mustTerms : []),
      ...(Array.isArray(queryPlan?.shouldTerms) ? queryPlan.shouldTerms : []),
    ]

    const facetTokens = new Set()
    for (const token of [...fromIntent, ...fromPlan]) {
      const normalized = normalizeString(token)
      if (normalized.length >= 4) facetTokens.add(normalized)
    }
    if (facetTokens.size > 0) {
      return Array.from(facetTokens).slice(0, 14)
    }
  }

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

function normalizeLiveOpportunity(raw, { crawlerType, rejectionCounts = null }) {
  if (!raw || typeof raw !== 'object') {
    bumpRejectionCount(rejectionCounts, 'invalid_object')
    return null
  }

  const title = raw.title ?? raw.name ?? null
  const sponsor = raw.sponsor ?? raw.funder ?? raw.source ?? null
  const rawUrl = raw.url ?? raw.application_url ?? raw.source_url ?? null

  if (!title || typeof title !== 'string') {
    bumpRejectionCount(rejectionCounts, 'missing_title')
    return null
  }

  if (!rawUrl || !isValidHttpUrl(rawUrl)) {
    bumpRejectionCount(rejectionCounts, !rawUrl ? 'missing_url' : 'invalid_url')
    return null
  }

  const opportunityType = normalizeString(raw.opportunity_type || raw.type || raw.grant_type || 'grant') || 'grant'
  if (LOAN_TYPES.has(opportunityType)) {
    bumpRejectionCount(rejectionCounts, 'loan_type_excluded')
    return null
  }

  const existingScore = typeof raw.match_score === 'number' ? raw.match_score : null
  const existingReasons = Array.isArray(raw.match_reasons) ? raw.match_reasons : []
  const recordOriginRaw = normalizeString(raw.record_origin || '')
  const isDirectoryStyle =
    opportunityType === 'program' || recordOriginRaw.includes('directory') || Boolean(raw.is_directory_resource)
  const normalizedDeadline = normalizeDateToIso(raw.deadline ?? null)

  const eligibilityBullets = Array.isArray(raw.eligibility_bullets)
    ? raw.eligibility_bullets
    : typeof raw.eligibility === 'string' && raw.eligibility.trim().length > 0
    ? [raw.eligibility.trim()]
    : []

  const description =
    typeof raw.description === 'string' && raw.description.trim().length > 0
      ? raw.description
      : typeof raw.summary === 'string' && raw.summary.trim().length > 0
      ? raw.summary
      : null

  const matchReasons = mergeReasons(existingReasons, [
    facetsReasonFromRaw(raw),
  ]).filter(Boolean)

  // Preserve sub-crawler source when running comprehensive so UI can show "From N sources".
  const effectiveCrawlerType = raw.crawler_type ?? crawlerType

  return {
    id: raw.id ?? null,
    title,
    sponsor,
    description,
    source: raw.source ?? effectiveCrawlerType,
    source_url: raw.source_url ?? rawUrl,
    application_url: raw.application_url ?? rawUrl,
    url: rawUrl,
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
    eligibility_bullets: eligibilityBullets,
    opportunity_type: opportunityType,
    // Preserve crawler-provided origin when present; directory-style resources must not be treated as volatile live crawls.
    record_origin: recordOriginRaw || (isDirectoryStyle ? 'directory_resource' : 'live_crawl'),
    crawler_type: effectiveCrawlerType,
    ...(existingScore !== null ? { match_score: existingScore } : {}),
    ...(matchReasons.length ? { match_reasons: matchReasons } : {}),
    ...(isDirectoryStyle ? { is_directory_resource: true } : {}),
  }
}

function facetsReasonFromRaw(raw) {
  const reasons = Array.isArray(raw?.match_reasons) ? raw.match_reasons : []
  if (reasons.length > 0) return ''
  if (raw?.match_reason && typeof raw.match_reason === 'string') return raw.match_reason
  return ''
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

function buildFacetReasons(facets) {
  const reasons = []
  const primaryType = facets?.profile?.primary_profile_type
  const state = facets?.geo?.state
  const need = facets?.intent?.primary_need_category
  if (primaryType) reasons.push(`Profile type: ${String(primaryType).replace(/_/g, ' ')}`)
  if (state) reasons.push(`State context: ${String(state).toUpperCase()}`)
  if (need && String(need) !== 'unknown') reasons.push(`Intent category: ${String(need).replace(/_/g, ' ')}`)
  return reasons
}

async function runLiveCrawler({ crawlerType, profileContext, itemRequest, minMatchScore }) {
  const startedAt = Date.now()
  const effectiveContext =
    profileContext && typeof profileContext === 'object' && profileContext.profile
      ? profileContext
      : {
          profile: profileContext ?? {},
          sections: profileContext?.sections ?? {},
          signals: profileContext?.signals ?? null,
          facets: profileContext?.facets ?? {},
          trace: profileContext?.trace ?? {},
        }
  const profile = effectiveContext.profile

  // Validate profile before attempting to crawl
  if (!profile || typeof profile !== 'object') {
    return {
      ok: false,
      duration_ms: Date.now() - startedAt,
      error: 'Invalid profile data - profile is required',
      opportunities: [],
    }
  }

  const queryPlan = planCrawlerQueries({
    crawlerType,
    facets: effectiveContext?.facets ?? {},
    location: effectiveContext?.facets?.geo ?? effectiveContext?.signals?.location ?? {},
  })
  const options = { min_match_score: minMatchScore, query_plan: queryPlan }
  const rejectionCounts = {}
  const facetReasons = buildFacetReasons(effectiveContext?.facets ?? {})

  try {
    let rawResults = []
    if (crawlerType === 'comprehensive') {
      const results = await Promise.all(
        COMPREHENSIVE_CRAWLER_IDS.map((id) =>
          (async () => {
            try {
              switch (id) {
                case 'local_funding':
                  return await withTimeout(crawlLocalFunding(effectiveContext, options), LIVE_CRAWL_TIMEOUT_MS, id)
                case 'government_funding':
                  return await withTimeout(crawlGovernmentFunding(effectiveContext, options), LIVE_CRAWL_TIMEOUT_MS, id)
                case 'student_grants':
                  return await withTimeout(crawlStudentGrants(effectiveContext, options), LIVE_CRAWL_TIMEOUT_MS, id)
                case 'health_resources':
                  return await withTimeout(crawlHealthResources(effectiveContext, options), LIVE_CRAWL_TIMEOUT_MS, id)
                case 'special_needs':
                  return await withTimeout(crawlSpecialNeeds(effectiveContext, options), LIVE_CRAWL_TIMEOUT_MS, id)
                case 'ecf_benefits':
                  return await withTimeout(crawlECFBenefits(effectiveContext, options), LIVE_CRAWL_TIMEOUT_MS, id)
                default:
                  return []
              }
            } catch (err) {
              console.warn(`[RealCrawlers] comprehensive: ${id} failed:`, err?.message || err)
              return []
            }
          })(),
        ),
      )
      rawResults = results.flat()
    } else {
      switch (crawlerType) {
        case 'local_funding':
          rawResults = await withTimeout(
            crawlLocalFunding(effectiveContext, options),
            LIVE_CRAWL_TIMEOUT_MS,
            'local_funding',
          )
          break
        case 'government_funding':
          rawResults = await withTimeout(
            crawlGovernmentFunding(effectiveContext, options),
            LIVE_CRAWL_TIMEOUT_MS,
            'government_funding',
          )
          break
        case 'student_grants':
          rawResults = await withTimeout(
            crawlStudentGrants(effectiveContext, options),
            LIVE_CRAWL_TIMEOUT_MS,
            'student_grants',
          )
          break
        case 'health_resources':
          rawResults = await withTimeout(
            crawlHealthResources(effectiveContext, options),
            LIVE_CRAWL_TIMEOUT_MS,
            'health_resources',
          )
          break
        case 'special_needs':
          rawResults = await withTimeout(
            crawlSpecialNeeds(effectiveContext, options),
            LIVE_CRAWL_TIMEOUT_MS,
            'special_needs',
          )
          break
        case 'item_matching':
          rawResults = await withTimeout(
            crawlItemFunding(effectiveContext, { ...options, item_request: itemRequest }),
            LIVE_CRAWL_TIMEOUT_MS,
            'item_matching',
          )
          break
        case 'ecf_benefits':
          rawResults = await withTimeout(
            crawlECFBenefits(effectiveContext, options),
            LIVE_CRAWL_TIMEOUT_MS,
            'ecf_benefits',
          )
          break
        default:
          return {
            ok: false,
            duration_ms: Date.now() - startedAt,
            error: `No live crawler implementation for ${crawlerType}`,
            opportunities: [],
          }
      }
    }

    const normalized = (Array.isArray(rawResults) ? rawResults : [])
      .map((row) => normalizeLiveOpportunity(row, { crawlerType, rejectionCounts }))
      .filter(Boolean)
      .filter((row) => {
        const text =
          `${row?.title || ''} ${row?.description || ''} ${(row?.keywords || []).join(' ')} ${(row?.categories || []).join(' ')}`.toLowerCase()
        const blocked = Array.isArray(queryPlan?.mustNotTerms)
          ? queryPlan.mustNotTerms.some((term) => normalizeString(term) && text.includes(normalizeString(term)))
          : false
        if (blocked) bumpRejectionCount(rejectionCounts, 'query_plan_must_not')
        return !blocked
      })

    // Score with the FULL profile context (signals + sections + facets) so we use all datapoints consistently.
    const profileContextForScoring = {
      profile,
      sections: effectiveContext.sections ?? profile.sections ?? {},
      signals: effectiveContext.signals ?? profile.signals ?? null,
      facets: effectiveContext.facets ?? {},
    }

    const current = normalized.filter(isOpportunityCurrent)

    // Score all opportunities uniformly using the profile context.
    // Directory resources are no longer given preferential treatment — they must
    // earn their relevance through the same matching criteria as every other result.
    const rescored = current.map((row) => {
      const { score: computedScore, reasons: computedReasons } = calculateMatchScore(profileContextForScoring, row)
      const existingScore = typeof row.match_score === 'number' ? row.match_score : null

      const mergedScore = existingScore === null ? computedScore : Math.max(existingScore, computedScore)
      const mergedReasons = mergeReasons(row.match_reasons, mergeReasons(computedReasons, facetReasons))

      return { ...row, match_score: mergedScore, match_reasons: mergedReasons }
    })

    const included = rescored
      .filter((row) => {
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
      query_plan: queryPlan,
      validation_rejection_counts: rejectionCounts,
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
      query_plan: queryPlan,
      validation_rejection_counts: rejectionCounts,
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

  // Geography: expand outward. Do NOT hard-filter by state—let scoring surface best fits.
  // Profile state is used by matchingEngine for ranking; mismatches reduce score, not exclude.
  // Exception: local_funding must scope to profile state so a WV profile does not get DC-only opportunities.
  const profileStateForGeo =
    profileContext?.facets?.geo?.state ??
    profileContext?.signals?.location?.state ??
    profileContext?.profile?.state
  const normalizedProfileState =
    profileStateForGeo && String(profileStateForGeo).trim().length === 2
      ? String(profileStateForGeo).trim().toUpperCase()
      : null
  if ((crawlerType === 'local_funding' || crawlerType === 'comprehensive') && normalizedProfileState) {
    conditions.push(
      isPostgres
        ? `(state IS NULL OR TRIM(UPPER(state)) = ? OR is_national = TRUE OR LOWER(COALESCE(is_national::text, '')) = 'true')`
        : "(state IS NULL OR TRIM(UPPER(state)) = ? OR is_national = 1 OR LOWER(COALESCE(is_national, '')) = 'true')",
    )
    params.push(normalizedProfileState)
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

  // Intent-driven explicit exclusions (must-not terms).
  // Used only for clear disambiguation (for example: food truck business vs food bank assistance).
  const mustNotTerms = Array.isArray(profileContext?.queryPlan?.mustNotTerms)
    ? profileContext.queryPlan.mustNotTerms
    : []
  if (mustNotTerms.length > 0) {
    const mustNotClauses = mustNotTerms
      .slice(0, 12)
      .map(
        () =>
          '(LOWER(title) NOT LIKE ? AND LOWER(description) NOT LIKE ? AND LOWER(keywords) NOT LIKE ? AND LOWER(categories) NOT LIKE ?)',
      )
      .join(' AND ')
    conditions.push(`(${mustNotClauses})`)
    mustNotTerms.slice(0, 12).forEach((term) => {
      const pattern = `%${normalizeString(term)}%`
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
    min_match_score = 60, // Aligned with crawler defaults; use 100% of profile signals
  } = req.body
  const adminDebugRequested = String(req.query?.admin ?? req.body?.admin ?? '').toLowerCase() === 'true'
  
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
        profile = mergeProfileAndData(profile, profile_data);


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

    let profileContext =
      profile && profile.sections && profile.signals
        ? { profile, sections: profile.sections, signals: profile.signals }
        : { profile, sections: profile?.sections ?? {}, signals: profile?.signals ?? null }

    profileContext = buildProfileFacets(profileContext)
    // Never block crawlers on missing facets — run with best-effort context (strict: false).
    try {
      profileContext = requireFacets(profileContext, { strict: false })
    } catch (taxonomyError) {
      const statusCode = Number(taxonomyError?.status || 400)
      return res.status(statusCode).json({
        success: false,
        error: taxonomyError?.code || 'PROFILE_CONTEXT_INCOMPLETE',
        message:
          taxonomyError?.message ||
          'Profile context could not be built. Update your profile and try again.',
        crawler_type,
        opportunities: [],
        details: taxonomyError?.details ?? null,
      })
    }

    // CRITICAL: Use DB-backed profile location as single source of truth for crawlers.
    // Ensures WV profile never gets DC (or other) geography from facets/signals that failed to populate.
    const profileState = normalizeStateForCrawler(profile?.state) || null
    const profileZip = (profile?.zip_code && String(profile.zip_code).trim()) || (profile?.postal_code && String(profile.postal_code).trim()) || null
    const profileCity = (profile?.city && String(profile.city).trim()) || null
    if (profileState || profileZip || profileCity) {
      if (!profileContext.facets) profileContext.facets = {}
      if (!profileContext.facets.geo) profileContext.facets.geo = {}
      if (!profileContext.facets.geo.state && profileState) profileContext.facets.geo.state = profileState
      if (!profileContext.facets.geo.zip && profileZip) profileContext.facets.geo.zip = /^\d{5}/.test(profileZip) ? profileZip.replace(/\D/g, '').slice(0, 5) : profileZip
      if (!profileContext.facets.geo.city && profileCity) profileContext.facets.geo.city = profileCity
      if (profileContext.signals && profileContext.signals.location) {
        if (!profileContext.signals.location.state && profileState) profileContext.signals.location.state = profileContext.facets.geo.state
        if (!profileContext.signals.location.zip && profileZip) profileContext.signals.location.zip = profileContext.facets.geo.zip
        if (!profileContext.signals.location.city && profileCity) profileContext.signals.location.city = profileCity
      }
      console.log('[RealCrawlers] Profile location (authoritative):', { state: profileContext.facets.geo.state, zip: profileContext.facets.geo.zip, city: profileContext.facets.geo.city })
    }

    const coveragePct =
      profileContext?.coverage?.field_map_coverage?.signal_coverage_pct ??
      profileContext?.coverage?.field_map_coverage?.pct ??
      profileContext?.signals?.coverage?.pct ??
      0
    const sectionCount = profileContext?.sections ? Object.keys(profileContext.sections).length : 0
    const keywordCount =
      typeof profileContext?.signals?.keywordSet?.size === 'number'
        ? profileContext.signals.keywordSet.size
        : Array.isArray(profileContext?.signals?.keywords)
        ? profileContext.signals.keywords.length
        : Array.isArray(profileContext?.facets?.intent?.keywords)
        ? profileContext.facets.intent.keywords.length
        : 0
    const zip = profileContext?.facets?.geo?.zip ?? profileContext?.signals?.location?.zip ?? profile?.zip_code ?? null
    const state = profileContext?.facets?.geo?.state ?? profileContext?.signals?.location?.state ?? profile?.state ?? null

    const canonicalSectionsPresent = Number(
      profileContext?.coverage?.field_map_coverage?.canonical_sections_present ?? 0,
    )
    const profileContextIncomplete =
      sectionCount === 0 || (canonicalSectionsPresent === 0 && Number(coveragePct) < 1)
    if (profileContextIncomplete) {
      console.warn('[RealCrawlers] Profile has sparse context - running anyway for directory + DB fallback', {
        section_count: sectionCount,
        coverage_pct: coveragePct,
        canonical_sections_present: canonicalSectionsPresent,
        has_zip: Boolean(zip),
        has_state: Boolean(state),
        keyword_count: keywordCount,
      })
    }
    
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
    
    const routeQueryPlan = planCrawlerQueries({
      crawlerType: crawler_type,
      facets: profileContext?.facets ?? {},
      location: profileContext?.facets?.geo ?? profileContext?.signals?.location ?? {},
    })
    profileContext.queryPlan = routeQueryPlan

    // 1) Try live crawler first (real web sources), then fall back to DB matching.
    const startTime = Date.now()
    const debug = {
      used_live: false,
      used_db_fallback: false,
      live: null,
      db: null,
      query_plan: routeQueryPlan,
      has_zip: Boolean(zip),
      has_state: Boolean(state),
      keyword_count: keywordCount,
      coverage_pct: coveragePct,
      section_count: sectionCount,
      profile_context_incomplete: profileContextIncomplete,
      required_missing: profileContext?.coverage?.required_missing ?? [],
    }

    const live = await runLiveCrawler({
      crawlerType: crawler_type,
      profileContext,
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
              record_origin: o.record_origin ?? 'live_crawl',
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
        query_plan: live.query_plan ?? routeQueryPlan,
        validation_rejection_counts: live.validation_rejection_counts ?? {},
      }

      // If live results are solid, skip fallback; otherwise optionally augment with DB.
      const shouldSkipFallback = live.opportunities.length >= MIN_LIVE_RESULTS_BEFORE_SKIP_FALLBACK
      if (shouldSkipFallback) {
        const duration = Date.now() - startTime
        const debugMeta = adminDebugRequested
          ? buildAdminDebugMeta({
              profileContext,
              queryPlan: routeQueryPlan,
              validationRejectionCounts: live.validation_rejection_counts ?? {},
            })
          : undefined
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
          ...(debugMeta ? { debug_meta: debugMeta } : {}),
        })
      }
    } else {
      debug.used_live = false
      debug.live = {
        ok: Boolean(live.ok),
        duration_ms: live.duration_ms,
        returned: 0,
        error: live.error || null,
        query_plan: live.query_plan ?? routeQueryPlan,
        validation_rejection_counts: live.validation_rejection_counts ?? {},
      }
    }

    // 2) DB matching fallback (fast, stable, always uses full profile data).
    let candidates = []
    
    try {
      const tokens = buildSearchTokens(profileContext)
      let { sql, params } = buildCandidateOpportunityQuery({
        crawlerType: crawler_type,
        profileContext,
        tokens,
        itemRequest: item_request,
        dialect: db?.dialect,
      })
      candidates = (await db.prepare(sql).all(...params)).map(formatDbOpportunity).filter(Boolean)

      // Relax: if token narrowing yielded 0, retry without tokens so directory-style and broad matches survive.
      if (candidates.length === 0 && ENABLE_TOKEN_NARROWING && tokens.length > 0) {
        console.log('[RealCrawlers] Token narrowing returned 0; retrying DB fallback without token filter')
        const broad = buildCandidateOpportunityQuery({
          crawlerType: crawler_type,
          profileContext,
          tokens: [],
          itemRequest: item_request,
          dialect: db?.dialect,
        })
        candidates = (await db.prepare(broad.sql).all(...broad.params)).map(formatDbOpportunity).filter(Boolean)
      }
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
    // All opportunities scored uniformly — directory resources earn relevance through matching.
    const scored = currentCandidates.map((row) => {
      const { score, reasons } = calculateMatchScore(profileContext, row)

      return {
        ...row,
        match_score: score,
        match_reasons: reasons,
        // Normalize sponsor/title for UI
        sponsor: row.sponsor ?? row.funder ?? null,
      }
    })

    const totalFound = scored.length

    // Filter by minimum match score (default lowered; UI can adjust).
    let filteredOpportunities = scored
      .filter((opp) => {
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
        .filter((o) => typeof o?.match_score === 'number')
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
    const debugMeta = adminDebugRequested
      ? buildAdminDebugMeta({
          profileContext,
          queryPlan: routeQueryPlan,
          validationRejectionCounts: live?.validation_rejection_counts ?? {},
        })
      : undefined
    
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
      ...(debugMeta ? { debug_meta: debugMeta } : {}),
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

  let profileContextBase =
    profile && profile.sections && profile.signals
      ? { profile, sections: profile.sections, signals: profile.signals }
      : { profile, sections: profile?.sections ?? {}, signals: profile?.signals ?? null }

  profileContextBase = buildProfileFacets(profileContextBase)
  try {
    profileContextBase = requireFacets(profileContextBase, { strict: false })
  } catch (taxonomyError) {
    return res.status(Number(taxonomyError?.status || 400)).json({
      error: taxonomyError?.code || 'PROFILE_CONTEXT_INCOMPLETE',
      message: taxonomyError?.message || 'Profile context could not be built',
      details: taxonomyError?.details ?? null,
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
      const profileContext = {
        ...profileContextBase,
        queryPlan: planCrawlerQueries({
          crawlerType,
          facets: profileContextBase?.facets ?? {},
          location: profileContextBase?.facets?.geo ?? profileContextBase?.signals?.location ?? {},
        }),
      }
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
          profileContext,
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
          return { ...row, match_score: score, match_reasons: reasons }
        })

      const totalFoundForCrawler = scored.length

      // Filter by minimum match score.
      // If 0 included but we had results, fall back to best-scoring items.
      let filtered = scored
        .filter((opp) => {
          return typeof opp.match_score === 'number' && opp.match_score >= Number(min_match_score)
        })
        .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
        .slice(0, 50)

      if (filtered.length === 0 && totalFoundForCrawler > 0) {
        filtered = scored
          .filter((o) => typeof o?.match_score === 'number')
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
