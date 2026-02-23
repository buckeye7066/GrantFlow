/**
 * Helper functions for all crawlers
 * Provides common utilities for loading profile context and scoring opportunities
 * 
 * CRITICAL: All crawlers MUST use 100% of profile data via the signals object.
 * Do NOT use shallow profile fields - use profileContext.signals for all matching.
 */

import { loadProfileContext, extractStateFromContext, extractZipFromContext, extractCityFromContext, summarizeProfileSignals } from '../profileHelpers.js'

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

  // CRITICAL FIX: Ensure signals.location is always populated with derived location data.
  // The buildProfileSignals function may leave signals.location with null values if sections
  // are structured differently. This guarantees crawlers get the correct location from sections.
  if (context.signals) {
    if (!context.signals.location) {
      context.signals.location = {};
    }
    // Patch signals.location with derivedLocation values (section-based) as fallback
    context.signals.location.state = context.signals.location.state || derivedLocation.state || organization?.state || null;
    context.signals.location.city = context.signals.location.city || derivedLocation.city || organization?.city || null;
    context.signals.location.zip = context.signals.location.zip || derivedLocation.zip_code || organization?.zip || null;
    console.log('[crawlerHelpers] Location resolved:', JSON.stringify(context.signals.location));
  }
  // Log profile signals summary for debugging
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
 * 
 * @param {Object} opportunity - The funding opportunity to score
 * @param {Object} profile - Profile object with signals attached
 * @returns {Object} { score: number, reasons: string[], matchedSignals: string[] }
 */
export function calculateMatchScore(opportunity, profile) {
  const signals = profile.signals
  const reasons = []
  const matchedSignals = []
  let score = 0

  const normalizedOppState = normalizeState(opportunity.state || '')
  const normalizedProfileState = normalizeState(signals?.location?.state || profile.state || '')

  // Build searchable text from opportunity
  const oppText = [
    opportunity.title,
    opportunity.description,
    opportunity.eligibility,
    opportunity.eligibility_criteria,
    JSON.stringify(opportunity.eligibility_bullets || []),
    JSON.stringify(opportunity.categories || []),
    JSON.stringify(opportunity.keywords || []),
    opportunity.sponsor,
  ].filter(Boolean).join(' ').toLowerCase()

  const oppKeywords = new Set([
    ...(opportunity.keywords || []).map(k => k.toLowerCase()),
    ...(opportunity.categories || []).map(c => c.toLowerCase()),
  ])

  // ============ GEOGRAPHIC MATCH (0-20 pts) ============
  const profileState = signals?.location?.state || profile.state
  const isNationwide = String(opportunity.state || '').toLowerCase().trim() === 'nationwide'
  if (opportunity.is_national || isNationwide) {
    score += 15
    reasons.push('National eligibility')
  } else if (normalizedOppState && normalizedProfileState) {
    if (normalizedOppState === normalizedProfileState) {
      score += 20
      reasons.push(`State match: ${profileState}`)
      matchedSignals.push(`location:${profileState}`)
    } else {
      // State mismatch - significant penalty (e.g. TN vs CA)
      score -= 20
      reasons.push(`State mismatch: opp=${opportunity.state}, profile=${profileState}`)
    }
  }

  // ============ APPLICANT TYPE MATCH (0-20 pts) ============
  if (signals?.applicantTypes?.size) {
    for (const appType of signals.applicantTypes) {
      if (oppText.includes(appType) || checkKeywordMatch(appType, oppKeywords)) {
        score += 20
        reasons.push(`Applicant type match: ${appType}`)
        matchedSignals.push(`type:${appType}`)
        break
      }
    }
  }

  // ============ DEMOGRAPHIC MATCH (0-15 pts) ============
  if (signals?.demographics?.size) {
    let demoMatches = 0
    for (const demo of signals.demographics) {
      const demoStr = demo.replace(/_/g, ' ')
      if (oppText.includes(demoStr) || checkKeywordMatch(demoStr, oppKeywords)) {
        demoMatches++
        matchedSignals.push(`demographic:${demo}`)
      }
    }
    if (demoMatches > 0) {
      score += Math.min(15, demoMatches * 5)
      reasons.push(`Demographic match (${demoMatches} signals)`)
    }
  }

  // ============ MILITARY STATUS MATCH (0-20 pts) ============
  if (signals?.military?.size) {
    let milMatches = 0
    for (const mil of signals.military) {
      const milStr = mil.replace(/_/g, ' ')
      if (oppText.includes(milStr) || oppText.includes('veteran') || checkKeywordMatch(milStr, oppKeywords)) {
        milMatches++
        matchedSignals.push(`military:${mil}`)
      }
    }
    if (milMatches > 0) {
      score += Math.min(20, milMatches * 7)
      reasons.push(`Military status match (${milMatches} signals)`)
    }
  } else {
    // Profile has NO military flags - check if opportunity is military-specific
    const militaryKeywords = ['veteran', 'military', 'va ', 'gi bill', 'vr&e', 'armed forces', 'service member']
    const isMilitaryOpp = militaryKeywords.some(mk => oppText.includes(mk))
    if (isMilitaryOpp) {
      score -= 25
      reasons.push('Military-only opportunity but profile has no military flags')
    }
  }

  // ============ HEALTH/DISABILITY MATCH (0-15 pts) ============
  if (signals?.health?.size) {
    let healthMatches = 0
    for (const h of signals.health) {
      const hStr = h.replace(/_/g, ' ')
      if (oppText.includes(hStr) || checkKeywordMatch(hStr, oppKeywords)) {
        healthMatches++
        matchedSignals.push(`health:${h}`)
      }
    }
    if (healthMatches > 0) {
      score += Math.min(15, healthMatches * 5)
      reasons.push(`Health/disability match (${healthMatches} signals)`)
    }
  }

  // ============ ASSISTANCE PROGRAM MATCH (0-15 pts) ============
  if (signals?.assistance?.size) {
    let assistMatches = 0
    for (const assist of signals.assistance) {
      const assistStr = assist.replace(/_/g, ' ')
      if (oppText.includes(assistStr) || checkKeywordMatch(assistStr, oppKeywords)) {
        assistMatches++
        matchedSignals.push(`assistance:${assist}`)
      }
    }
    if (assistMatches > 0) {
      score += Math.min(15, assistMatches * 5)
      reasons.push(`Assistance program match (${assistMatches} signals)`)
    }
  }

  // ============ FAMILY SITUATION MATCH (0-10 pts) ============
  if (signals?.family?.size) {
    let famMatches = 0
    for (const fam of signals.family) {
      const famStr = fam.replace(/_/g, ' ')
      if (oppText.includes(famStr) || checkKeywordMatch(famStr, oppKeywords)) {
        famMatches++
        matchedSignals.push(`family:${fam}`)
      }
    }
    if (famMatches > 0) {
      score += Math.min(10, famMatches * 5)
      reasons.push(`Family situation match (${famMatches} signals)`)
    }
  }

  // ============ OCCUPATION MATCH (0-10 pts) ============
  if (signals?.occupation?.size) {
    let occMatches = 0
    for (const occ of signals.occupation) {
      const occStr = occ.replace(/_/g, ' ')
      if (oppText.includes(occStr) || checkKeywordMatch(occStr, oppKeywords)) {
        occMatches++
        matchedSignals.push(`occupation:${occ}`)
      }
    }
    if (occMatches > 0) {
      score += Math.min(10, occMatches * 5)
      reasons.push(`Occupation match (${occMatches} signals)`)
    }
  }

  // ============ INTEREST/KEYWORD MATCH (0-15 pts) ============
  if (signals?.interests?.size) {
    let interestMatches = 0
    for (const interest of signals.interests) {
      if (oppText.includes(interest) || checkKeywordMatch(interest, oppKeywords)) {
        interestMatches++
        matchedSignals.push(`interest:${interest}`)
      }
    }
    if (interestMatches > 0) {
      score += Math.min(15, interestMatches * 3)
      reasons.push(`Interest/keyword match (${interestMatches} signals)`)
    }
  }

  // ============ GLOBAL KEYWORD MATCH (0-10 pts) ============

  if (signals?.keywordSet?.size) {
    let kwMatches = 0
    // Cap evaluation for performance/noise.
    const sample = Array.from(signals.keywordSet).slice(0, 120)
    for (const kw of sample) {
      if (!kw || typeof kw !== 'string') continue
      const token = kw.toLowerCase()
      if (token.length < 4) continue
      if (oppText.includes(token) || checkKeywordMatch(token, oppKeywords)) {
        kwMatches++
        if (kwMatches <= 5) matchedSignals.push(`kw:${token}`)
      }
    }
    if (kwMatches > 0) {
      score += Math.min(10, kwMatches * 2)
      reasons.push(`Broad keyword overlap (${kwMatches} tokens)`)
    }
  }

  // ============ PHRASE MATCH (0-10 pts) ============
  if (signals?.phrases?.size) {
    let phraseMatches = 0
    for (const phrase of signals.phrases) {
      if (phrase.length > 5 && oppText.includes(phrase)) {
        phraseMatches++
        if (phraseMatches <= 3) matchedSignals.push(`phrase:${phrase}`)
      }
    }
    if (phraseMatches > 0) {
      score += Math.min(10, phraseMatches * 2)
      reasons.push(`Phrase match (${phraseMatches} signals)`)
    }
  }

  // ============ ACADEMIC REQUIREMENTS (bonus/penalty) ============
  if (signals?.academics) {
    // Check if opportunity has GPA requirements
    const gpaMatch = oppText.match(/(\d+\.\d+)\s*gpa/i)
    if (gpaMatch && signals.academics.gpa) {
      const requiredGpa = parseFloat(gpaMatch[1])
      if (signals.academics.gpa >= requiredGpa) {
        score += 5
        reasons.push(`Meets GPA requirement (${signals.academics.gpa} >= ${requiredGpa})`)
        matchedSignals.push(`gpa:${signals.academics.gpa}`)
      } else {
        score -= 10
        reasons.push(`Below GPA requirement (${signals.academics.gpa} < ${requiredGpa})`)
      }
    }
  }

  // ============ FUNDING AMOUNT ALIGNMENT ============
  if (signals?.financial?.fundingAmountNeeded && opportunity.amount_max) {
    const needed = signals.financial.fundingAmountNeeded
    const available = opportunity.amount_max
    if (available >= needed * 0.5) {
      score += 5
      reasons.push('Funding amount in range')
    }
  }

  // ============ DEADLINE CHECK ============
  if (opportunity.deadline) {
    const deadline = new Date(opportunity.deadline)
    const now = new Date()
    const daysUntil = Math.floor((deadline - now) / (1000 * 60 * 60 * 24))
    if (daysUntil < 0) {
      score -= 50
      reasons.push('EXPIRED deadline')
    } else if (daysUntil <= 30) {
      score += 5
      reasons.push(`Urgent: ${daysUntil} days until deadline`)
    }
  }

  // ============ LOAN/MATCH PENALTY ============
  if (opportunity.is_loan) {
    score -= 20
    reasons.push('Is a loan (not grant)')
  }
  if (opportunity.requires_match) {
    score -= 10
    reasons.push(`Requires matching funds (${opportunity.match_percentage || '?'}%)`)
  }


    // ============ CATEGORY MISMATCH PENALTY ============
      // Penalize opportunities from assistance/charity categories when the profile
        // is looking for business funding (e.g., food bank results for food truck queries).
          const businessSignals = ['small_business', 'food truck', 'food_truck', 'startup', 'entrepreneur', 'business funding', 'mobile food', 'food vendor', 'catering']
            const assistanceCategories = ['food bank', 'food pantry', 'food assistance', 'soup kitchen', 'hunger relief', 'meals on wheels', 'snap benefits']
              const profileIsBusinessOriented = businessSignals.some(sig =>
                    (signals?.interests?.has?.(sig)) ||
                        (signals?.keywordSet?.has?.(sig)) ||
                            (signals?.applicantTypes?.has?.(sig)) ||
                                (signals?.occupation?.has?.(sig))
              )
                if (profileIsBusinessOriented) {
                      const isAssistanceOpp = assistanceCategories.some(cat => oppText.includes(cat))
                          if (isAssistanceOpp) {
                                  score -= 30
                                        reasons.push('Assistance/charity mismatch (profile seeks business funding)')
                          }
                        }
                        
  // ============ MULTI-CATEGORY BONUS ============
  const categoryCount = new Set(matchedSignals.map(s => s.split(':')[0])).size
  if (categoryCount >= 5) {
    score += 15
    reasons.push(`Strong multi-category match (${categoryCount} categories)`)
  } else if (categoryCount >= 3) {
    score += 10
    reasons.push(`Good multi-category match (${categoryCount} categories)`)
  }

  // ============ STRONG EVIDENCE BONUS (helps relevant directory resources reach 70%+) ============
  // When multiple signals align (keywords, interests, categories, location), add modest boost.
  const hasSubstantiveMatch = reasons.some(r =>
    /keyword|interest|category|location|phrase|geographic/i.test(String(r))
  )
  if (matchedSignals.length >= 3 && hasSubstantiveMatch && score < 75) {
    score += 8
    reasons.push('Multiple profile signals align with this opportunity')
  }

  // Clamp score
  const finalScore = Math.max(0, Math.min(100, score))

  return {
    score: finalScore,
    reasons: reasons.length > 0 ? reasons : ['No specific matches found'],
    matchedSignals,
  }
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
