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
import {
  enforceOpportunityPolicy,
  getPolicyRejectionCounts,
  resetPolicyRejectionCounts,
} from '../services/crawlers/opportunityPolicy.js'
import { getWithRetry, postWithRetry } from '../services/crawlers/httpClient.js'

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
    // HARDENED: Do NOT merge profileData.signals over DB-loaded signals.
    // DB-loaded signals (from loadProfileContext) contain properly constructed Sets;
    // profileData.signals from req.body may contain JSON arrays that overwrite them.
    // Keep profile.signals as the authoritative source.
    if (profile.signals) {
          merged.signals = profile.signals;
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
// Railway env had stale 12000 which kills crawlers. Default 60s; allow env override for tests (e.g. 1ms to force DB fallback).
const LIVE_CRAWL_TIMEOUT_MS = Math.max(1, Number.parseInt(process.env.LIVE_CRAWL_TIMEOUT_MS ?? '60000', 10) || 60000)
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
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    // Reject placeholder/example domains per product rules.
    const host = (parsed.hostname || '').toLowerCase()
    if (
      host === 'example.com' ||
      host.endsWith('.example.com') ||
      host === 'example.org' ||
      host.endsWith('.example.org') ||
      host === 'example.gov' ||
      host.endsWith('.example.gov') ||
      host === 'placeholder' ||
      host.endsWith('.placeholder')
    )
      return false
    return true
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

const AMBIGUOUS_SINGLE_WORDS = new Set([
  'food', 'care', 'home', 'house', 'school', 'community',
  
  'child', 'children', 'work', 'service', 'support', 'program',
  'help', 'need', 'general', 'special', 'local', 'national',
  'plan', 'fund', 'grant', 'money', 'bank', 'credit', 'loan',
  'start', 'open', 'build', 'make', 'create',
  'resource', 'free', 'apply', 'person', 'people',
]);
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

  // Apply unified opportunity policy (URL, placeholder, loan, matching-funds).
  const policyResult = enforceOpportunityPolicy(raw, { rejectionCounts })
  if (!policyResult.ok) return null

  const title = raw.title ?? raw.name ?? null
  const sponsor = raw.sponsor ?? raw.funder ?? raw.source ?? null
  const rawUrl = raw.url ?? raw.application_url ?? raw.source_url ?? null

  if (!title || typeof title !== 'string') {
    bumpRejectionCount(rejectionCounts, 'missing_title')
    return null
  }

  const opportunityType = normalizeString(raw.opportunity_type || raw.type || raw.grant_type || 'grant') || 'grant'

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
  // CRITICAL: Pass min_match_score=0 to sub-crawlers so they return ALL results.
    // Sub-crawlers' calculateMatchScore now delegates to the canonical matchingEngine scorer,
    // but we keep min_match_score=0 to let the route-level rescoring apply the user's threshold.
  const options = { min_match_score: 0, query_plan: queryPlan }
  const rejectionCounts = {}
  resetPolicyRejectionCounts()
  const facetReasons = buildFacetReasons(effectiveContext?.facets ?? {})

  try {
    let rawResults = []
    if (crawlerType === 'comprehensive') {
      const subcrawlerErrors = {}
      const subcrawlerCounts = {}
      const results = await Promise.all(
        COMPREHENSIVE_CRAWLER_IDS.map((id) =>
          (async () => {
            const subcrawlerStart = Date.now()
            try {
              let res
              switch (id) {
                case 'local_funding':
                  res = await withTimeout(crawlLocalFunding(effectiveContext, options), LIVE_CRAWL_TIMEOUT_MS, id)
                  break
                case 'government_funding':
                  res = await withTimeout(crawlGovernmentFunding(effectiveContext, options), LIVE_CRAWL_TIMEOUT_MS, id)
                  break
                case 'student_grants':
                  res = await withTimeout(crawlStudentGrants(effectiveContext, options), LIVE_CRAWL_TIMEOUT_MS, id)
                  break
                case 'health_resources':
                  res = await withTimeout(crawlHealthResources(effectiveContext, options), LIVE_CRAWL_TIMEOUT_MS, id)
                  break
                case 'special_needs':
                  res = await withTimeout(crawlSpecialNeeds(effectiveContext, options), LIVE_CRAWL_TIMEOUT_MS, id)
                  break
                case 'ecf_benefits':
                  res = await withTimeout(crawlECFBenefits(effectiveContext, options), LIVE_CRAWL_TIMEOUT_MS, id)
                  break
                default:
                  res = []
              }
              const arr = Array.isArray(res) ? res : []
              subcrawlerCounts[id] = { found: arr.length, duration_ms: Date.now() - subcrawlerStart }
              return arr
            } catch (err) {
              const msg = err?.message || String(err)
              console.warn(`[RealCrawlers] comprehensive: ${id} failed:`, msg)
              subcrawlerErrors[id] = {
                error: msg,
                code: err?.code || null,
                duration_ms: Date.now() - subcrawlerStart,
              }
              return []
            }
          })(),
        ),
      )
      // Attach subcrawler diagnostics for the response
      options.__subcrawler_errors = subcrawlerErrors
      options.__subcrawler_counts = subcrawlerCounts
      console.log(`[RealCrawlers] COMPREHENSIVE SUBCRAWLER RESULTS:`, JSON.stringify(subcrawlerCounts))
      if (Object.keys(subcrawlerErrors).length > 0) {
        console.error(`[RealCrawlers] SUBCRAWLER ERRORS:`, JSON.stringify(subcrawlerErrors))
      }
      // De-duplicate across sub-crawlers: the same grants.gov opportunity can be
      // returned by government_funding, health_resources, special_needs, etc.
      const seenCrossKeys = new Set()
      rawResults = results.flat().filter((row) => {
        const key = String(
          row?.url || row?.application_url || row?.source_url || row?.title || '',
        )
          .toLowerCase()
          .trim()
        if (!key) return true // keep items with no key (rare)
        if (seenCrossKeys.has(key)) return false
        seenCrossKeys.add(key)
        return true
      })
      console.log(`[RealCrawlers] Cross-dedup: ${results.flat().length} total → ${rawResults.length} unique`)
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

    let normalized = (Array.isArray(rawResults) ? rawResults : [])
      .map((row) => normalizeLiveOpportunity(row, { crawlerType, rejectionCounts }))
      .filter(Boolean)
    normalized = normalized.filter((row) => {
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
      // Canonical score: the matchingEngine is the single source of truth.
      const mergedReasons = mergeReasons(row.match_reasons, mergeReasons(computedReasons, facetReasons))
      return { ...row, match_score: computedScore, match_reasons: mergedReasons }
    })
    // Policy was already enforced in normalizeLiveOpportunity(); no second check needed.
        // Guardrail: directory resources are curated, verified entries that crawlers intentionally
        // included (e.g. consent-gated trials, community directories). Apply a minimum score floor
        // so they survive the min_match_score filter even when the profile has sparse signals.
        const DIRECTORY_SCORE_FLOOR = 50
        for (const row of rescored) {
                if (row.is_directory_resource && typeof row.match_score === 'number' && row.match_score < DIRECTORY_SCORE_FLOOR) {
                          row.match_score = DIRECTORY_SCORE_FLOOR
                          if (!row.match_reasons) row.match_reasons = []
                          row.match_reasons.push('Directory resource score floor applied')
                }
        }
    

    let included = rescored
      .filter((row) => {
        return typeof row.match_score === 'number' && row.match_score >= Number(minMatchScore)
      })
      .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
      .slice(0, 50)

    console.log(`[RealCrawlers] Scoring: ${rawResults.length} raw → ${normalized.length} normalized → ${current.length} current → ${rescored.length} scored → ${included.length} above threshold (min=${minMatchScore})`)

    // Guardrail: real URL sources must not all be dropped when min_match_score is strict.
    // If we have scored results but 0 passed threshold, return top-scoring so profile still gets relevant, URL-verified opps.
    let fallbackApplied = false
    if (included.length === 0 && rescored.length > 0) {
      included = rescored
        .filter((o) => typeof o?.match_score === 'number')
        .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
        .slice(0, 50)
      fallbackApplied = true
      console.log(
        `[RealCrawlers] ${crawlerType} live: slider fallback applied — all ${rescored.length} results below min_match_score=${minMatchScore}; returning top ${included.length}`,
      )
    }

    return {
      ok: true,
      duration_ms: Date.now() - startedAt,
      total_found: current.length,
      filtered_count: included.length,
      opportunities: included,
      error: null,
      query_plan: queryPlan,
      validation_rejection_counts: { ...rejectionCounts, ...getPolicyRejectionCounts() },
      ...(fallbackApplied
        ? {
            score_fallback_applied: true,
            threshold_fallback_message: `No results met your threshold of ${minMatchScore}%. Showing best available matches.`,
          }
        : {}),
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

function formatDbOpportunity(row, rejectionCounts = null) {
  if (!row) return null
  const keywords = safeParseJSON(row.keywords, [])
  const categories = safeParseJSON(row.categories, [])
  const eligibility_bullets = safeParseJSON(row.eligibility_bullets, [])
  const match_reasons = safeParseJSON(row.match_reasons, [])

  const formatted = {
    ...row,
    keywords,
    categories,
    eligibility_bullets,
    match_reasons,
    url: row.application_url ?? row.source_url ?? null,
  }

  const policyResult = enforceOpportunityPolicy(formatted, { rejectionCounts })
  if (!policyResult.ok) return null

  return formatted
}

function buildCandidateOpportunityQuery({ crawlerType, profileContext, tokens, itemRequest, dialect }) {
  const isPostgres = dialect === 'postgres'
  const conditions = [isPostgres ? 'is_active = TRUE' : 'is_active = 1']
  const params = []

  // Hard-exclude loans (unconditional per product rules).
  conditions.push("(opportunity_type IS NULL OR LOWER(TRIM(opportunity_type)) NOT IN ('loan','loan_program','microloan'))")
  if (isPostgres) {
    conditions.push('(is_loan IS NULL OR is_loan = FALSE)')
  } else {
    conditions.push('(is_loan IS NULL OR is_loan = 0)')
  }
  // Hard-exclude matching-funds/cost-share requirements (unconditional per product rules).
  conditions.push(
    isPostgres
      ? '(requires_match IS NULL OR requires_match = FALSE)'
      : "(requires_match IS NULL OR requires_match = 0 OR requires_match = '0' OR requires_match = 'false')",
  )
  conditions.push(
    isPostgres
      ? '(match_percentage IS NULL OR match_percentage = 0)'
      : "(match_percentage IS NULL OR match_percentage = 0 OR match_percentage = '0')",
  )

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
    min_match_score: bodyMinScore,
  } = req.body
  // Slider is law (master prompt): use Discover Grants slider when provided (0–100); default 50
  let min_match_score = 50
  if (typeof bodyMinScore === 'number' && bodyMinScore >= 0 && bodyMinScore <= 100) min_match_score = bodyMinScore
  else if (typeof bodyMinScore === 'string' && /^\d+$/.test(bodyMinScore)) min_match_score = Math.min(100, Math.max(0, parseInt(bodyMinScore, 10)))
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

    // ── Route-level consent gating for clinicaltrials.gov ──────────────
    // The health crawler filters these in its own return, but the DB fallback
    // path can re-introduce them from a prior consent-true run.  This helper
    // strips them from ANY final opportunity array when consent is absent.
    const _consentForTrials = (() => {
      if (crawler_type !== 'health_resources') return true          // only gate health
      const health = profileContext?.sections?.health_medical ?? {}
      return (
        String(req.body?.include_trials ?? '').toLowerCase() === 'true' ||
        req.body?.include_trials === true ||
        Boolean(health.consent_for_studies)
      )
    })()
    const applyConsentGating = (opps) => {
      if (_consentForTrials) return opps
      return opps.filter((row) => {
        const urls = [row.url, row.source_url, row.application_url]
          .filter(Boolean).join(' ').toLowerCase()
        return !urls.includes('clinicaltrials.gov')
      })
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
      // Policy: only persist policy-compliant opportunities so forbidden records never enter the database.
      if (LIVE_CRAWL_PERSIST_OPPS) {
        try {
          const toPersist = live.opportunities.filter((o) => enforceOpportunityPolicy(o).ok)
          const insertedIds = await bulkUpsertFundingOpportunities(
            db,
            toPersist.map((o) => ({
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
        subcrawler_errors: live.subcrawler_errors ?? null,
        subcrawler_counts: live.subcrawler_counts ?? null,
      }

      // If live results include enough REAL (non-directory) results, skip fallback.
      // Directory resources (United Way locator, Benefits.gov, HUD, etc.) are static links
      // that always return — they must NOT count toward the "we have enough" threshold,
      // otherwise the DB catalog (which may contain actual grants) is never queried.
      const nonDirectoryLiveResults = live.opportunities.filter(o => !isDirectoryResource(o))
      debug.live.non_directory_count = nonDirectoryLiveResults.length
      debug.live.directory_count = live.opportunities.length - nonDirectoryLiveResults.length
      if (nonDirectoryLiveResults.length === 0 && live.opportunities.length > 0) {
        console.warn(
          `[RealCrawlers] ${crawler_type}: all ${live.opportunities.length} live results are directory resources — live API calls returned 0 actual grants. DB catalog will be queried.`,
          { subcrawler_errors: live.subcrawler_errors, subcrawler_counts: live.subcrawler_counts },
        )
      }
      const shouldSkipFallback = nonDirectoryLiveResults.length >= MIN_LIVE_RESULTS_BEFORE_SKIP_FALLBACK
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
          opportunities: applyConsentGating(live.opportunities),
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
        subcrawler_errors: live.subcrawler_errors ?? null,
        subcrawler_counts: live.subcrawler_counts ?? null,
      }
    }

    // 2) DB matching fallback (fast, stable, always uses full profile data).
    let candidates = []
    const dbRejectionCounts = {}

    try {
      const tokens = buildSearchTokens(profileContext)
      let { sql, params } = buildCandidateOpportunityQuery({
        crawlerType: crawler_type,
        profileContext,
        tokens,
        itemRequest: item_request,
        dialect: db?.dialect,
      })
      candidates = (await db.prepare(sql).all(...params))
        .map((row) => formatDbOpportunity(row, dbRejectionCounts))
        .filter(Boolean)

      if (candidates.length === 0 && ENABLE_TOKEN_NARROWING && tokens.length > 0) {
        console.log('[RealCrawlers] Token narrowing returned 0; retrying DB fallback without token filter')
        const broad = buildCandidateOpportunityQuery({
          crawlerType: crawler_type,
          profileContext,
          tokens: [],
          itemRequest: item_request,
          dialect: db?.dialect,
        })
        candidates = (await db.prepare(broad.sql).all(...broad.params))
          .map((row) => formatDbOpportunity(row, dbRejectionCounts))
          .filter(Boolean)
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

    const scored = currentCandidates
      .map((row) => {
        const { score, reasons } = calculateMatchScore(profileContext, row)
        return {
          ...row,
          match_score: score,
          match_reasons: reasons,
          sponsor: row.sponsor ?? row.funder ?? null,
        }
      })
      .filter((row) => {
        const p = enforceOpportunityPolicy(row, { rejectionCounts: dbRejectionCounts })
        return p.ok
      })
    const scoredPolicyOk = scored
    if (Object.keys(dbRejectionCounts).length > 0) {
      debug.policy_rejections_db = { ...dbRejectionCounts }
    }


        // Guardrail: directory resources (opportunity_type=program, curated entries) get a score floor
        // so they survive the min_match_score filter. Mirrors the live-crawler directory score floor.
        const DB_DIRECTORY_SCORE_FLOOR = 50
        for (const row of scoredPolicyOk) {
                if (isDirectoryResource(row) && typeof row.match_score === 'number' && row.match_score < DB_DIRECTORY_SCORE_FLOOR) {
                          row.match_score = DB_DIRECTORY_SCORE_FLOOR
                          if (!row.match_reasons) row.match_reasons = []
                          row.match_reasons.push('Directory resource score floor applied')
                }
        }
    const totalFound = scoredPolicyOk.length

    // Filter by minimum match score (default lowered; UI can adjust).
    let filteredOpportunities = scoredPolicyOk
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
      policy_rejection_counts: getPolicyRejectionCounts(),
    }

    // Guardrail: if something is being found but everything is filtered out, include score diagnostics.
    // This is additive (does not change the existing response shape); the UI can ignore it.
    if (initiallyIncludedCount === 0 && totalFound > 0) {
      const scores = scoredPolicyOk
        .map((o) => (typeof o?.match_score === 'number' ? o.match_score : null))
        .filter((v) => typeof v === 'number')
      const minScore = scores.length ? Math.min(...scores) : null
      const maxScore = scores.length ? Math.max(...scores) : null
      const avgScore = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null
      const topScores = scoredPolicyOk
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
          directory_present: scoredPolicyOk.some((row) => isDirectoryResource(row)),
        },
      }
    }

    let thresholdFallbackMessage = null
    if (initiallyIncludedCount === 0 && totalFound > 0) {
      filteredOpportunities = scoredPolicyOk
        .filter((o) => typeof o?.match_score === 'number')
        .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
        .slice(0, 50)
      debug.db.returned = filteredOpportunities.length
      debug.db.fallback_applied = filteredOpportunities.length > 0 ? true : undefined
      if (filteredOpportunities.length > 0) {
        thresholdFallbackMessage = `No results met your threshold of ${min_match_score}%. Showing best available matches.`
      }
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
    
    const fallbackMessage =
      thresholdFallbackMessage ??
      (live?.threshold_fallback_message && live.opportunities?.length > 0 ? live.threshold_fallback_message : null)
    res.json({
      success: true,
      crawler_type,
      count: merged.length,
      total_found: totalFound,
      filtered_count: merged.length,
      min_match_score,
      duration,
      opportunities: applyConsentGating(merged),
      used_live: Boolean(debug.used_live),
      used_db_fallback: Boolean(debug.used_db_fallback),
      debug,
      ...(fallbackMessage ? { threshold_fallback_message: fallbackMessage } : {}),
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
  let profile = await getProfileWithLocation(db, profile_id)
  if (!profile) {
    return res.status(404).json({
      error: 'Profile not found',
      message: `Profile with ID ${profile_id} does not exist`,
    })
  }
  profile = mergeProfileAndData(profile, req.body?.profile_data ?? null)

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

  // Use DB-backed profile location as single source of truth (same as POST /run).
  const profileState = normalizeStateForCrawler(profile?.state) || null
  const profileZip = (profile?.zip_code && String(profile.zip_code).trim()) || (profile?.postal_code && String(profile.postal_code).trim()) || null
  const profileCity = (profile?.city && String(profile.city).trim()) || null
  if (profileState || profileZip || profileCity) {
    if (!profileContextBase.facets) profileContextBase.facets = {}
    if (!profileContextBase.facets.geo) profileContextBase.facets.geo = {}
    if (!profileContextBase.facets.geo.state && profileState) profileContextBase.facets.geo.state = profileState
    if (!profileContextBase.facets.geo.zip && profileZip) profileContextBase.facets.geo.zip = /^\d{5}/.test(profileZip) ? profileZip.replace(/\D/g, '').slice(0, 5) : profileZip
    if (!profileContextBase.facets.geo.city && profileCity) profileContextBase.facets.geo.city = profileCity
    if (profileContextBase.signals && profileContextBase.signals.location) {
      if (!profileContextBase.signals.location.state && profileState) profileContextBase.signals.location.state = profileContextBase.facets.geo.state
      if (!profileContextBase.signals.location.zip && profileZip) profileContextBase.signals.location.zip = profileContextBase.facets.geo.zip
      if (!profileContextBase.signals.location.city && profileCity) profileContextBase.signals.location.city = profileContextBase.facets.geo.city
    }
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
        // Same threshold as /run: skip DB fallback only when we have enough non-directory live results.
        const nonDirectoryLiveResults = live.opportunities.filter((o) => !isDirectoryResource(o))
        const shouldSkipFallback = nonDirectoryLiveResults.length >= MIN_LIVE_RESULTS_BEFORE_SKIP_FALLBACK
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
      const scoredRaw = candidates
        .filter((row) => isOpportunityCurrent(row))
        .map((row) => {
          const { score, reasons } = calculateMatchScore(profileContext, row)
          return { ...row, match_score: score, match_reasons: reasons }
        })
      const scored = scoredRaw.filter((row) => {
        const p = enforceOpportunityPolicy(row)
        return p.ok
      })

      const totalFoundForCrawler = scored.length

      let filtered = scored
        .filter((opp) => typeof opp.match_score === 'number' && opp.match_score >= Number(min_match_score))
        .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
        .slice(0, 50)

      if (filtered.length === 0 && totalFoundForCrawler > 0) {
        filtered = scored
          .filter((o) => typeof o?.match_score === 'number')
          .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
          .slice(0, 50)
      }

      let merged = filtered
      if (live?.ok && Array.isArray(live.opportunities) && live.opportunities.length > 0) {
        const livePolicyOk = live.opportunities.filter((o) => enforceOpportunityPolicy(o).ok)
        const seen = new Set()
        const keyOf = (o) => String(o?.url || o?.application_url || o?.source_url || o?.title || '').toLowerCase()
        merged = [...livePolicyOk, ...filtered].filter((o) => {
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
    local_funding: 'Searches for funding opportunities within 25 miles of your location',
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

/**
 * Admin health check: test external API connectivity.
 * GET /api/real-crawlers/health-check
 * Returns { ok, checks: [{ source, reachable, latency_ms, error }], env?: object }
 */
router.get('/health-check', async (req, res) => {
  try {
    const { testConnectivity } = await import('../services/crawlers/grantsGovClient.js')
    const apiChecks = await testConnectivity()

    // Also test NIH RSS
    const nihStart = Date.now()
    let nihCheck
    try {
      const nihResp = await getWithRetry('https://grants.nih.gov/grants/guide/newsfeed/fundingopps.xml', {}, { timeoutMs: 10000, retries: 0 })
      const hasItems = typeof nihResp?.data === 'string' && nihResp.data.includes('<item>')
      nihCheck = { source: 'NIH Grants RSS', reachable: true, latency_ms: Date.now() - nihStart, hit_count: hasItems ? 1 : 0, error: null }
    } catch (err) {
      nihCheck = { source: 'NIH Grants RSS', reachable: false, latency_ms: Date.now() - nihStart, hit_count: 0, error: err?.message || String(err) }
    }

    const checks = [...apiChecks, nihCheck]
    const allReachable = checks.every((c) => c.reachable)
    res.json({ ok: allReachable, checks, env: { LIVE_CRAWL_TIMEOUT_MS, LIVE_CRAWL_PERSIST_OPPS, MIN_LIVE_RESULTS_BEFORE_SKIP_FALLBACK } })
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) })
  }
})

/**
 * Raw grants.gov API test — no auth required.
 * GET /api/real-crawlers/test-grants-api
 * Calls grants.gov search2 with a simple query and returns the raw response.
 */
router.get('/test-grants-api', async (req, res) => {
  const keyword = req.query.q || 'health'
  const results = { keyword, legacy: null, simpler: null, timestamp: new Date().toISOString() }

  // Test legacy API
  try {
    const start = Date.now()
    const response = await postWithRetry(
      'https://api.grants.gov/v1/api/search2',
      { keyword, oppStatuses: 'posted', rows: 3 },
      { headers: { 'Content-Type': 'application/json' } },
      { timeoutMs: 20000, retries: 1 },
    )
    const latency = Date.now() - start
    const data = response?.data
    const topKeys = data && typeof data === 'object' ? Object.keys(data) : []
    const dataKeys = data?.data && typeof data.data === 'object' ? Object.keys(data.data) : []
    const hitCount = data?.data?.hitCount ?? data?.hitCount ?? null
    const oppHits = data?.data?.oppHits ?? data?.oppHits ?? []
    const sampleHit = Array.isArray(oppHits) && oppHits.length > 0 ? oppHits[0] : null

    results.legacy = {
      ok: true,
      status: response?.status,
      latency_ms: latency,
      top_keys: topKeys,
      data_keys: dataKeys,
      hit_count: hitCount,
      opp_hits_count: Array.isArray(oppHits) ? oppHits.length : 0,
      sample_hit: sampleHit,
      errorcode: data?.errorcode ?? data?.errorCode ?? null,
      msg: data?.msg ?? data?.message ?? null,
      raw_snippet: JSON.stringify(data).slice(0, 800),
    }
  } catch (err) {
    results.legacy = {
      ok: false,
      error: err?.message || String(err),
      code: err?.code || err?.response?.status || null,
      response_snippet: err?.response?.data ? JSON.stringify(err.response.data).slice(0, 400) : null,
    }
  }

  // Test Simpler API
  try {
    const start = Date.now()
    const response = await postWithRetry(
      'https://api.simpler.grants.gov/v1/opportunities/search',
      {
        query: keyword,
        filters: { opportunity_status: { one_of: ['posted', 'forecasted'] } },
        pagination: { page_size: 3, page_offset: 1, order_by: 'relevancy', sort_direction: 'descending' },
      },
      { headers: { 'Content-Type': 'application/json' } },
      { timeoutMs: 20000, retries: 1 },
    )
    const latency = Date.now() - start
    const data = response?.data
    const topKeys = data && typeof data === 'object' ? Object.keys(data) : []
    const items = data?.data ?? data?.items ?? data?.opportunities ?? data?.results ?? []
    const sampleItem = Array.isArray(items) && items.length > 0 ? items[0] : null

    results.simpler = {
      ok: true,
      status: response?.status,
      latency_ms: latency,
      top_keys: topKeys,
      items_count: Array.isArray(items) ? items.length : 0,
      sample_item: sampleItem ? { title: sampleItem.opportunity_title ?? sampleItem.title, id: sampleItem.opportunity_id ?? sampleItem.id } : null,
      raw_snippet: JSON.stringify(data).slice(0, 800),
    }
  } catch (err) {
    results.simpler = {
      ok: false,
      error: err?.message || String(err),
      code: err?.code || err?.response?.status || null,
      response_snippet: err?.response?.data ? JSON.stringify(err.response.data).slice(0, 400) : null,
    }
  }

  res.json(results)
})

/**
 * DIAGNOSTIC: Find profile IDs by name.
 * GET /api/real-crawlers/find-profile?name=melissa
 * No auth required (temporary for debugging).
 */
router.get('/find-profile', async (req, res) => {
  const name = req.query.name || ''
  if (!name || name.length < 2) return res.json({ error: 'Provide ?name=... (at least 2 chars)' })
  try {
    const db = req.db
    if (!db || typeof db.prepare !== 'function') {
      return res.status(500).json({ error: 'Database not available' })
    }
    const pattern = `%${String(name).trim()}%`
    const rows = await db.prepare(
      'SELECT id, name, display_name, state, primary_type, applicant_type, city, zip_code FROM profiles WHERE name LIKE ? OR display_name LIKE ? LIMIT 10',
    ).all(pattern, pattern)
    res.json({ count: rows.length, profiles: rows })
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) })
  }
})

/**
 * DIAGNOSTIC: Full pipeline trace — no DB, no auth.
 * GET /api/real-crawlers/diagnose?state=WV&type=individual_need&need=disability_support
 * Tests: strategy building, API calls, scoring — with simulated profile.
 */
router.get('/diagnose', async (req, res) => {
  const startTime = Date.now()
  const state = req.query.state || 'WV'
  const profileType = req.query.type || 'individual_need'
  const need = req.query.need || 'disability_support'
  const extra = req.query.keywords || ''
  const diagnostics = { params: { state, type: profileType, need, extra }, steps: {} }

  try {
    // Build a simulated profile with signals matching Melissa's profile
    const signals = {
      location: { state, city: null, zip: null },
      applicantTypes: new Set([profileType]),
      interests: new Set(need ? [need.replace(/_/g, ' ')] : []),
      demographics: new Set(),
      health: new Set(need === 'disability_support' ? ['disability', 'special needs'] : []),
      assistance: new Set(['government assistance']),
      family: new Set(),
      military: new Set(),
      occupation: new Set(),
      phrases: new Set(),
      keywordSet: new Set([
        ...(need ? need.split('_') : []),
        ...(extra ? extra.split(',').map(s => s.trim()) : []),
        'grant', 'assistance', 'support',
      ]),
      profileType,
    }
    const fakeProfile = {
      state,
      primary_type: profileType,
      applicant_type: profileType,
      signals,
      sections: {},
    }

    diagnostics.steps.simulated_signals = {
      location: signals.location,
      applicantTypes: Array.from(signals.applicantTypes),
      interests: Array.from(signals.interests),
      health: Array.from(signals.health),
      assistance: Array.from(signals.assistance),
      keywordSet_size: signals.keywordSet.size,
      keywordSet: Array.from(signals.keywordSet),
    }

    // Step 1: Build strategies
    const { buildExhaustiveStrategies } = await import('../services/crawlers/governmentFundingCrawler.js')
    const strategies = buildExhaustiveStrategies(fakeProfile)
    diagnostics.steps.strategies = {
      count: strategies.length,
      list: strategies.map(s => ({ label: s.label, query: s.query })),
    }

    // Step 2: Run first 3 strategies against grants.gov
    const { searchGrants } = await import('../services/crawlers/grantsGovClient.js')
    const apiResults = []
    for (const strategy of strategies.slice(0, 3)) {
      const result = await searchGrants(strategy.query, { rows: 5 })
      apiResults.push({
        label: strategy.label,
        query: strategy.query,
        ok: result.ok,
        count: result.opportunities.length,
        legacy_ok: result.diagnostics?.legacy?.ok,
        legacy_count: result.diagnostics?.legacy?.count,
        legacy_hit_count: result.diagnostics?.legacy?.hit_count,
        legacy_error: result.diagnostics?.legacy?.error,
        simpler_error: result.diagnostics?.simpler?.error,
        titles: result.opportunities.slice(0, 3).map(o => o.title),
      })
    }
    diagnostics.steps.api_results = apiResults

    // Step 3: Score sample results
    const allOpps = []
    for (const strategy of strategies.slice(0, 3)) {
      const result = await searchGrants(strategy.query, { rows: 5 })
      allOpps.push(...result.opportunities)
    }

    if (allOpps.length > 0) {
      // Deduplicate
      const seen = new Set()
      const unique = []
      for (const opp of allOpps) {
        const key = (opp.title || '').toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        unique.push(opp)
      }

      const profileContext = {
        profile: fakeProfile,
        signals,
        facets: {
          geo: { state },
          intent: { primary_need_category: need, keywords: Array.from(signals.keywordSet) },
          profile: { primary_profile_type: profileType, applicant_types: [profileType] },
        },
      }

      const scored = unique.slice(0, 10).map(opp => {
        const { score, reasons } = calculateMatchScore(profileContext, opp)
        return { title: opp.title, score, reasons, sponsor: opp.sponsor }
      })
      scored.sort((a, b) => b.score - a.score)
      diagnostics.steps.scoring = scored
    }

    diagnostics.ok = true
    diagnostics.total_duration_ms = Date.now() - startTime
    res.json(diagnostics)
  } catch (err) {
    diagnostics.error = err?.message || String(err)
    diagnostics.stack = err?.stack?.split('\n').slice(0, 8)
    diagnostics.total_duration_ms = Date.now() - startTime
    res.status(500).json(diagnostics)
  }
})

export default router
