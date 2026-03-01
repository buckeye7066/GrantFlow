/**
 * Helper functions for all crawlers
 * Provides common utilities for loading profile context and scoring opportunities
 * 
 * CRITICAL: All crawlers MUST use 100% of profile data via the signals object.
 * Do NOT use shallow profile fields - use profileContext.signals for all matching.
 */

import { loadProfileContext, extractStateFromContext, extractZipFromContext, extractCityFromContext, summarizeProfileSignals } from '../profileHelpers.js'
import { calculateMatchScore as _canonicalMatchScore } from '../matchingEngine.js'

/**
 * Load complete profile context including ALL profile sections and derived signals.
 * Crawlers MUST use the returned signals object for search queries and scoring.
 */
export async function getProfileWithLocation(db, profileId) {
  // Load the full profile context (profile + all profile_sections + derived signals).
  // IMPORTANT: Do not fabricate fallback location data; missing location should be treated as missing data.
  const context = await loadProfileContext(db, profileId)

  let organization = null
  if (context?.profile?.organization_id) {
    const orgId = context.profile.organization_id
    // Backwards-compatible org lookup: some DBs have `type`, some have `organization_type`, some have neither.
    try {
      organization = await db
        .prepare('SELECT id, name, type, city, state, zip FROM organizations WHERE id = ?')
        .get(orgId)
    } catch (error) {
      try {
        organization = await db
          .prepare('SELECT id, name, organization_type AS type, city, state, zip FROM organizations WHERE id = ?')
          .get(orgId)
      } catch {
        organization = await db
          .prepare('SELECT id, name, city, state, zip FROM organizations WHERE id = ?')
          .get(orgId)
      }
    }
  }

  const derivedLocation = {
    state: extractStateFromContext({ profile: context.profile, sections: context.sections }),
    city: extractCityFromContext({ profile: context.profile, sections: context.sections }),
    zip_code: extractZipFromContext({ profile: context.profile, sections: context.sections }),
  }

  // Foolproof: ensure signals always exist and location is always populated for crawlers.
  if (!context.signals || typeof context.signals !== 'object') {
    context.signals = {
      location: {},
      keywordSet: new Set(),
      keywords: [],
      applicantTypes: new Set(),
      demographics: new Set(),
      military: new Set(),
      health: new Set(),
      assistance: new Set(),
      interests: new Set(),
      phrases: new Set(),
      intentPhrases: new Set(),
    }
  }
  if (!context.signals.location || typeof context.signals.location !== 'object') {
    context.signals.location = {}
  }
  context.signals.location.state = context.signals.location.state || derivedLocation.state || organization?.state || context.profile?.state || null
  context.signals.location.city = context.signals.location.city || derivedLocation.city || organization?.city || context.profile?.city || null
  context.signals.location.zip = context.signals.location.zip || derivedLocation.zip_code || organization?.zip || context.profile?.postal_code || context.profile?.zip_code || null
  if (!context.signals.keywordSet && (context.profile?.primary_type || (Array.isArray(context.profile?.tags) && context.profile.tags.length > 0))) {
    context.signals.keywordSet = new Set()
    if (context.profile.primary_type) context.signals.keywordSet.add(String(context.profile.primary_type).toLowerCase())
    if (Array.isArray(context.profile.tags)) context.profile.tags.forEach((t) => t && context.signals.keywordSet.add(String(t).toLowerCase().trim()))
    context.signals.keywords = Array.from(context.signals.keywordSet)
  }
  console.log('[crawlerHelpers] Location resolved:', JSON.stringify(context.signals.location))
  console.log(`[crawlerHelpers] Profile ${profileId} signals: ${summarizeProfileSignals(context.signals)}`)
  console.log(`[crawlerHelpers] Keywords: ${context.signals.keywordSet?.size || 0}, Demographics: ${context.signals.demographics?.size || 0}, Military: ${context.signals.military?.size || 0}, Health: ${context.signals.health?.size || 0}, Assistance: ${context.signals.assistance?.size || 0}`)

  return {
    ...context.profile,
    // Attach full context for crawlers - THIS IS THE CRITICAL DATA
    sections: context.sections,
    signals: context.signals,
    // Keep legacy location keys expected by crawler implementations.
    state: derivedLocation.state ?? organization?.state ?? null,
    city: derivedLocation.city ?? organization?.city ?? null,
    zip_code: derivedLocation.zip_code ?? organization?.zip ?? null,
    organization_name: organization?.name ?? null,
    organization_type: organization?.type ?? null,
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

/**
 * Build search keywords from ALL profile signals.
 * Returns an array of the most relevant keywords for API searches.
  * @deprecated Prefer buildSearchTokens() in realCrawlers.js (taxonomy-first, canonical).
   * This signals-first variant is used by live crawlers but should be consolidated.
 */
export function buildSearchKeywords(profile, maxKeywords = 25) {
  const signals = profile.signals
  if (!signals) {
    console.warn('[crawlerHelpers] No signals in profile - using fallback keywords')
    return [profile.primary_type, ...(profile.tags || [])].filter(Boolean).slice(0, 5)
  }

  const keywords = new Set()
  const looksUseful = (value) => {
    if (!value) return false
    const s = String(value).trim()
    if (s.length < 3) return false
    // Avoid tokens that are just numbers (IDs, etc.)
    if (/^\d+(\.\d+)?$/.test(s)) return false
    return true
  }

  // Priority 1: Intent phrases
  if (signals.intentPhrases?.size) {
    for (const phrase of signals.intentPhrases) {
      if (looksUseful(phrase)) keywords.add(phrase)
    }
  }

  // Priority 2: Multi-word phrases from signals.phrases
  if (signals.phrases?.size) {
    const multiWordPhrases = Array.from(signals.phrases)
      .filter((p) => looksUseful(p) && String(p).includes(' '))
      .slice(0, 15)
    for (const p of multiWordPhrases) keywords.add(p)
  }

  // Priority 3: Applicant types
  if (signals.applicantTypes?.size) {
    for (const type of signals.applicantTypes) keywords.add(type)
  }

  // Priority 4: Signal sets
  if (signals.demographics?.size) {
    for (const demo of signals.demographics) keywords.add(demo.replace(/_/g, ' '))
  }
  if (signals.military?.size) {
    for (const mil of signals.military) keywords.add(mil.replace(/_/g, ' '))
  }
  if (signals.health?.size) {
    for (const h of signals.health) keywords.add(h.replace(/_/g, ' '))
  }
  if (signals.assistance?.size) {
    for (const assist of signals.assistance) keywords.add(assist.replace(/_/g, ' '))
  }
  if (signals.family?.size) {
    for (const fam of signals.family) keywords.add(fam.replace(/_/g, ' '))
  }
  if (signals.occupation?.size) {
    for (const occ of signals.occupation) keywords.add(occ.replace(/_/g, ' '))
  }

  // Priority 5: Interests (filter out AMBIGUOUS_SINGLE_WORDS)
  if (signals.interests?.size) {
    for (const interest of signals.interests) {
      const norm = String(interest).toLowerCase()
      if (AMBIGUOUS_SINGLE_WORDS.has(norm)) continue
      if (looksUseful(interest)) keywords.add(interest)
    }
  }

  // Priority 6: Single keywords from keywordSet (filtered, cap 6)
  const phraseStrings = Array.from(keywords).map((k) => String(k).toLowerCase())
  let singleKeywordCount = 0
  if (signals.keywordSet?.size) {
    for (const kw of signals.keywordSet) {
      if (singleKeywordCount >= 6) break
      const norm = String(kw).toLowerCase().trim()
      if (!looksUseful(kw)) continue
      if (norm.includes(' ')) continue
      if (AMBIGUOUS_SINGLE_WORDS.has(norm)) continue
      if (phraseStrings.some((p) => p.includes(norm))) continue
      keywords.add(kw)
      singleKeywordCount++
    }
  }

  return Array.from(keywords).slice(0, maxKeywords)
}

const STATE_MAPPING = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS',
  kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA',
  michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT',
  nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC',
  'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA',
  'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA',
  washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  'district of columbia': 'DC',
}

function normalizeState(value) {
  if (!value) return ''
  const s = String(value).toLowerCase().trim()
  if (STATE_MAPPING[s]) return STATE_MAPPING[s].toUpperCase()
  const sanitized = s.replace(/[^a-z]/g, '')
  return sanitized.length === 2 ? sanitized.toUpperCase() : sanitized.toUpperCase()
}

/**
 * Comprehensive match scoring using 100% of profile signals.
 * This function MUST be used by all crawlers for scoring opportunities.
  * @deprecated Now delegates to the canonical calculateMatchScore in matchingEngine.js.
   * The old duplicate scoring logic has been removed. See git history for the original implementation.
 * 
 * @param {Object} opportunity - The funding opportunity to score
 * @param {Object} profile - Profile object with signals attached
 * @returns {Object} { score: number, reasons: string[], matchedSignals: string[] }
 */
export function calculateMatchScore(opportunity, profile) {
  // DELEGATION: Use the canonical scorer from matchingEngine.js (note: args are swapped)
  const result = _canonicalMatchScore(profile, opportunity)
  // Build matchedSignals from keyword hits (canonical scorer does not track these)
  const matchedSignals = []
  const keywordSet = profile.signals?.keywordSet || new Set()
  const oppText = [opportunity.title, opportunity.description].filter(Boolean).join(' ').toLowerCase()
  for (const kw of keywordSet) {
    if (oppText.includes(String(kw).toLowerCase())) {
      matchedSignals.push(`kw:${kw}`)
    }
  }
  return { score: result.score, reasons: result.reasons || [], matchedSignals }
}

/**
 * Check if a keyword matches any item in a set (partial match)
 */
function checkKeywordMatch(keyword, keywordSet) {
  const kw = keyword.toLowerCase()
  for (const item of keywordSet) {
    if (item.includes(kw) || kw.includes(item)) return true
  }
  return false
}

/**
 * Format opportunity with match score using full profile signals
 */
export function formatOpportunity(opp, profile) {
  const { score, reasons, matchedSignals } = calculateMatchScore(opp, profile)
  
  return {
    title: opp.title,
    description: opp.description,
    amount: opp.amount || opp.amount_max,
    amount_min: opp.amount_min,
    amount_max: opp.amount_max,
    sponsor: opp.sponsor,
    deadline: opp.deadline,
    url: opp.url || opp.application_url || opp.source_url,
    eligibility_criteria: opp.eligibility || opp.eligibility_criteria,
    match_score: score,
    match_reasons: reasons,
    matched_signals: matchedSignals,
    source: opp.source || 'crawler',
    state: opp.state || profile.signals?.location?.state || profile.state,
    is_loan: opp.is_loan || false,
    requires_match: opp.requires_match || false,
  }
}

/**
 * Filter opportunities to exclude expired deadlines (unless rolling/ongoing)
 */
export function filterByDeadline(opportunities, allowExpired = false) {
  const now = new Date()
  return opportunities.filter(opp => {
    // Allow if no deadline or rolling/ongoing
    if (!opp.deadline || opp.deadline_type === 'rolling' || opp.deadline_type === 'ongoing') {
      return true
    }
    // Check if expired
    const deadline = new Date(opp.deadline)
    if (isNaN(deadline.getTime())) return true // Invalid date, keep it
    return allowExpired || deadline >= now
  })
}

export default {
  getProfileWithLocation,
  buildSearchKeywords,
  calculateMatchScore,
  formatOpportunity,
  filterByDeadline,
}
