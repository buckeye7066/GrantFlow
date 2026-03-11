/**
 * Deterministic Match Scoring Engine
 *
 * Goal: Surface real, relatable funding sources for the profile's needs.
 * - Score reflects fit: opportunity eligibility/title/description must align with profile
 *   (applicant type, keywords, geography, category, amount). Higher score = more relatable.
 * - Penalties (geography mismatch, intent phrase miss) are soft so semantically related
 *   opportunities (e.g. "small business" grant for a food-truck profile) are not discarded.
 * - No randomness; same profile + opportunity always yields same score (auditability).
 */

import { safeParseArrayField } from './profileHelpers.js'
import { buildProfileSignals } from './profileHelpers.js'

const PRO_BONO_OPPORTUNITY_TYPES = new Set([
  'pro_bono', 'in_kind', 'charity_care', 'training_paid',
  'legal_aid', 'clinic_service', 'equipment_donation',
])
const SERVICE_FUNDING_TYPES = new Set(['service', 'cost_coverage', 'referral'])

const AMBIGUOUS_SINGLE_WORDS = new Set([
  'food', 'care', 'home', 'house', 'school', 'community',
  'child', 'children', 'work', 'service', 'support', 'program',
  'help', 'need', 'general', 'special', 'local', 'national',
  'plan', 'fund', 'grant', 'money', 'bank', 'credit', 'loan',
  'start', 'open', 'build', 'make', 'create',
  'resource', 'free', 'apply', 'person', 'people',
])

/**
 * Calculate deterministic match score between profile and opportunity
 * @param {Object} profile - User/organization profile
 * @param {Object} opportunity - Funding opportunity
 * @returns {Object} { score: number (0-100), reasons: string[], match_explain: object }
 */
export function calculateMatchScore(profile, opportunity) {
  // Allow passing a full profileContext { profile, sections, signals } for richer matching.
  const profileContext =
    profile && typeof profile === 'object' && profile.profile && profile.sections
      ? profile
      : null
  const effectiveProfile = profileContext?.profile ?? profile
  const effectiveSignals =
    profileContext?.signals ??
    (profileContext?.sections ? buildProfileSignals({ profile: effectiveProfile, sections: profileContext.sections }) : null)
  const effectiveFacets = profileContext?.facets ?? null

  const reasons = [];
  let score = 0;
  const oppText = `${opportunity?.title || ''} ${opportunity?.description || ''} ${opportunity?.sponsor || ''}`.toLowerCase()
  
  // Geographic match (expand outward: ZIP → county → state → national)
  // IMPORTANT: location mismatches reduce score; they must NOT exclude results.
  const profileLocation = effectiveSignals?.location || {}
  const profileZip =
    profileLocation?.zip ??
    effectiveProfile?.postal_code ??
    effectiveProfile?.zip_code ??
    null
  const profileCounty = profileLocation?.county ?? null
  const profileCity = profileLocation?.city ?? effectiveProfile?.city ?? null
  const profileState =
    profileLocation?.state ??
    effectiveProfile?.state ??
    null

  const oppState = opportunity?.state ?? null
  const oppZip = opportunity?.geo_zip ?? null
  const oppCounty = opportunity?.geo_county ?? null
  const oppIsNational =
    Boolean(opportunity?.is_national) ||
    String(oppState || '').toLowerCase() === 'nationwide'

  // Best-match tier (max 25)
  let geoTier = null // zip|city|county|state|national|unknown
  let geoPoints = 0

  // Check unknown profile location first — no location data means we cannot verify
  // geographic eligibility for any opportunity, including national ones.
  if (!profileZip && !profileCounty && !profileCity && !profileState) {
    geoTier = 'unknown'
    geoPoints = -5
  } else if (profileZip && oppZip && String(profileZip).trim() === String(oppZip).trim()) {
    geoTier = 'zip'
    geoPoints = 25
  } else if (profileCounty && oppCounty && normalizeCounty(oppCounty) === normalizeCounty(profileCounty)) {
    geoTier = 'county'
    geoPoints = 22
  } else if (
    profileCity &&
    typeof profileCity === 'string' &&
    typeof opportunity?.description === 'string' &&
    normalizeString(opportunity.description).includes(normalizeString(profileCity))
  ) {
    // City is not a canonical column today (we sometimes only see it in text).
    geoTier = 'city'
    geoPoints = 20
  } else if (profileState && oppState && normalizeState(oppState) === normalizeState(profileState)) {
    geoTier = 'state'
    geoPoints = 18
  } else if (oppIsNational) {
    geoTier = 'national'
    geoPoints = 8
  } else if (profileState && oppState && normalizeState(oppState) !== normalizeState(profileState)) {
    // State mismatch (e.g. TN vs CA) — stronger penalty
    geoTier = 'mismatch'
    geoPoints = -20
  } else {
    // Known profile location but no match signal on the opportunity. Soft penalty only.
    geoTier = 'mismatch'
    geoPoints = -2
  }

  score += geoPoints
  if (geoTier === 'zip') reasons.push('Geography: ZIP match')
  else if (geoTier === 'county') reasons.push('Geography: County match')
  else if (geoTier === 'city') reasons.push('Geography: City match (text)')
  else if (geoTier === 'state') reasons.push('Geography: State match')
  else if (geoTier === 'national') reasons.push('National eligibility')
  else if (geoTier === 'unknown') reasons.push('Location unknown — cannot verify geographic eligibility')
  else if (geoTier === 'mismatch') reasons.push('Geography mismatch (soft penalty)')
  
  // Applicant type match (25 pts)
  const applicantTypesSet =
    effectiveSignals?.applicantTypes && typeof effectiveSignals.applicantTypes[Symbol.iterator] === 'function'
      ? new Set(Array.from(effectiveSignals.applicantTypes).map((v) => String(v).toLowerCase()))
      : null
  const profileType = effectiveProfile?.primary_type || effectiveProfile?.applicant_type || null
  const hasApplicantTypeSignals = Boolean(profileType) || Boolean(applicantTypesSet?.size)

  if (hasApplicantTypeSignals && eligibilityMatchesApplicantType(opportunity, effectiveSignals ?? effectiveProfile)) {
    score += 25
    reasons.push('Applicant type match')
  } else if (!hasApplicantTypeSignals) {
    reasons.push('Applicant type unknown (no penalty)')
  }
  
  // Keyword overlap (up to 25 pts)
  const keywordScore = calculateKeywordOverlap(effectiveSignals ?? effectiveProfile, opportunity);
  score += keywordScore;
  if (keywordScore > 0) {
    reasons.push(`Keyword match (${keywordScore} pts)`);
  }
  
  // Category match (up to 20 pts)
  const categoryScore = calculateCategoryMatch(effectiveSignals ?? effectiveProfile, opportunity);
  score += categoryScore;
  if (categoryScore > 0) {
    reasons.push(`Category match (${categoryScore} pts)`);
  }

  // Facet alignment (intent + profile attributes) with explicit reasons.
  const facetAdjustments = calculateFacetAdjustments({
    facets: effectiveFacets,
    opportunity,
    oppText,
  })
  score += facetAdjustments.points
  reasons.push(...facetAdjustments.reasons)
  
  // Amount eligibility (10 pts)
  if (amountInRange(effectiveProfile?.funding_amount_needed, opportunity)) {
    score += 10;
    reasons.push('Amount eligibility');
  }
  
  // Deadline urgency bonus (up to 5 pts)
  const deadlineScore = calculateDeadlineUrgency(opportunity);
  score += deadlineScore;
  if (deadlineScore > 0) {
    reasons.push(`Deadline urgency (${deadlineScore} pts)`);
  }
  
  // Requirements penalties
  const ein = effectiveProfile?.ein ?? effectiveProfile?.uei ?? null
  const applicantTypeNormalized = String(profileType || '').toLowerCase()
  const isOrgLike =
    applicantTypeSetHas(applicantTypesSet, ['organization', 'nonprofit', 'small_business', 'government']) ||
    ['organization', 'nonprofit', 'small_business', 'government'].includes(applicantTypeNormalized)

  if (opportunity.requires_501c3 && isOrgLike && !ein) {
    score -= 15
    reasons.push('Requires 501(c)(3) status (EIN/UEI missing)')
  } else if (opportunity.requires_501c3 && !isOrgLike) {
    // For individuals/students, do not penalize: it likely just isn't applicable.
    reasons.push('501(c)(3) requirement not applicable to profile type')
  }
  
  if (opportunity.requires_match) {
    score -= 10;
    reasons.push(`Requires matching funds (${opportunity.match_percentage || '?'}%)`);
  }

  // Preserve anti-loan/credit-repair filtering as score penalties (never hard exclusion here).
  const opportunityType = String(opportunity?.opportunity_type || opportunity?.type || '').toLowerCase()
  if (['loan', 'loan_program', 'microloan'].includes(opportunityType) || /\bloan\b/.test(oppText)) {
    score -= 30
    reasons.push('Loan program penalty (grants prioritized)')
  }
  if (/\bcredit repair\b|\bcredit counseling\b|\bdebt consolidation\b/.test(oppText)) {
    score -= 25
    reasons.push('Credit repair/counseling penalty')
  }

  // ── PRO BONO / IN-KIND SCORING ──
  const isProBono = PRO_BONO_OPPORTUNITY_TYPES.has(opportunityType)
  const fundingType = normalizeString(opportunity?.funding_type || '')
  const isServiceType = SERVICE_FUNDING_TYPES.has(fundingType)
  const matchedNeeds = []
  const matchedSignals = []

  if (isProBono || isServiceType) {
    // Pro bono/in-kind: full credit even when amount is null (it's a service, not cash)
    if (opportunity.amount_min == null && opportunity.amount_max == null) {
      score += 5
      reasons.push('Pro bono/in-kind: service value (no cash amount required)')
    }

    // Service specificity bonus: direct intake URL > general info > directory
    const appUrl = normalizeString(opportunity?.application_url || '')
    const srcUrl = normalizeString(opportunity?.source_url || '')
    const hasDirectIntake = /apply|intake|enroll|request|sign.?up|register/i.test(appUrl) || /apply|intake|enroll/i.test(srcUrl)
    const isDirectory = /directory|finder|find-|search|lookup|look-up/i.test(appUrl) || /directory|finder/i.test(srcUrl)

    if (hasDirectIntake) {
      score += 5
      reasons.push('Service specificity: direct intake/application URL (+5)')
    } else if (!isDirectory) {
      score += 2
      reasons.push('Service specificity: program-specific URL (+2)')
    } else {
      score -= 3
      reasons.push('Service specificity: directory page only (-3)')
    }

    // Pro bono needs alignment check
    const proBonoTermsOnProfile = effectiveSignals?.proBonoTerms ?? new Set()
    if (proBonoTermsOnProfile.size > 0) {
      let proBonoHits = 0
      for (const term of proBonoTermsOnProfile) {
        if (oppText.includes(normalizeString(term))) {
          proBonoHits++
          matchedNeeds.push(term)
        }
      }
      if (proBonoHits > 0) {
        const boost = Math.min(15, proBonoHits * 5)
        score += boost
        reasons.push(`Pro bono need alignment (${proBonoHits} needs matched, +${boost})`)
      }
    }

    // Penalty for mismatched pro bono (e.g. medical copay shown to non-medical profiles)
    const proBonoMismatchTokens = {
      pro_bono: ['legal', 'attorney', 'court', 'eviction', 'tenant'],
      charity_care: ['medical', 'patient', 'copay', 'clinic', 'hospital', 'health'],
      clinic_service: ['clinic', 'health center', 'primary care'],
      training_paid: ['training', 'wioa', 'workforce', 'vocational', 'certification'],
      equipment_donation: ['equipment', 'computer', 'assistive', 'technology'],
    }
    const mismatchTokens = proBonoMismatchTokens[opportunityType] || []
    if (mismatchTokens.length > 0 && proBonoTermsOnProfile.size === 0) {
      const oppHasSpecificFocus = mismatchTokens.some(t => oppText.includes(t))
      const profileHasMatchingSignals = mismatchTokens.some(t => {
        const kws = effectiveSignals?.keywordSet ?? new Set()
        return kws.has(t)
      })
      if (oppHasSpecificFocus && !profileHasMatchingSignals) {
        score -= 8
        reasons.push('Pro bono mismatch: service focus does not match profile signals (-8)')
      }
    }
  }

  // Collect matched signals for match_explain
  if (geoTier && geoTier !== 'mismatch' && geoTier !== 'unknown') matchedSignals.push(`geo:${geoTier}`)
  if (hasApplicantTypeSignals && eligibilityMatchesApplicantType(opportunity, effectiveSignals ?? effectiveProfile))
    matchedSignals.push('applicant_type')
  if (keywordScore > 0) matchedSignals.push('keywords')
  if (categoryScore > 0) matchedSignals.push('category')
  if (isProBono) matchedSignals.push(`opportunity_type:${opportunityType}`)
  if (isServiceType) matchedSignals.push(`funding_type:${fundingType}`)

  const finalScore = Math.max(0, Math.min(100, score))

  const match_explain = {
    matchedNeeds: matchedNeeds.length > 0 ? matchedNeeds : undefined,
    matchedSignals,
    scoreBreakdown: {
      geo: geoPoints,
      applicant_type: hasApplicantTypeSignals && eligibilityMatchesApplicantType(opportunity, effectiveSignals ?? effectiveProfile) ? 25 : 0,
      keyword: keywordScore,
      category: categoryScore,
      facet: facetAdjustments.points,
      amount: amountInRange(effectiveProfile?.funding_amount_needed, opportunity) ? 10 : 0,
      deadline: deadlineScore,
      pro_bono: isProBono ? (finalScore - Math.max(0, Math.min(100, score - (isProBono ? 0 : 0)))) : 0,
      total: finalScore,
    },
    reasons: reasons.length > 0 ? reasons : ['No specific matches found'],
  }

  return { 
    score: finalScore, 
    reasons: reasons.length > 0 ? reasons : ['No specific matches found'],
    match_explain,
  };
}

function normalizeString(value) {
  if (typeof value !== 'string') return ''
  return value.trim().toLowerCase()
}

function normalizeCounty(value) {
  const s = normalizeString(String(value || ''))
  // Make "X County" comparisons stable.
  return s.replace(/\bcounty\b/g, '').replace(/\s+/g, ' ').trim()
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

function applicantTypeSetHas(applicantTypesSet, values = []) {
  if (!applicantTypesSet || applicantTypesSet.size === 0) return false
  return values.some((v) => applicantTypesSet.has(String(v).toLowerCase()))
}

function ensureArray(value) {
  if (Array.isArray(value)) return value
  if (value === null || value === undefined) return []
  return [value]
}

function tokenizeFacetTerms(values = []) {
  const AMBIGUOUS_SINGLE_WORDS = new Set([
 'food', 'care', 'home', 'house', 'school', 'community',
'child', 'children', 'work', 'service', 'support', 'program',
'help', 'need', 'general', 'special', 'local', 'national',
'plan', 'fund', 'grant', 'money', 'bank', 'credit', 'loan',
'start', 'open', 'build', 'make', 'create',
'resource', 'free', 'apply', 'person', 'people',
  ])
  return ensureArray(values)
    .map((v) => normalizeString(String(v || '')))
    .filter((v) => {
      if (!v) return false
      if (v.includes(' ')) return v.length >= 6
      if (v.length < 4) return false
      if (AMBIGUOUS_SINGLE_WORDS.has(v)) return false
      return true
    })
}

function textIncludesToken(text, token) {
  const needle = normalizeString(token)
  if (!needle) return false
  if (needle.includes(' ')) return text.includes(needle)
  return new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)
}

function countTokenMatches(text, tokens = []) {
  let count = 0
  for (const token of tokens) {
    if (textIncludesToken(text, token)) count++
  }
  return count
}

function humanizeEnum(value) {
  const normalized = normalizeString(value)
  if (!normalized) return 'unknown'
  return normalized.replace(/_/g, ' ')
}

function calculateFacetAdjustments({ facets, opportunity, oppText }) {
  if (!facets || typeof facets !== 'object' || !opportunity || typeof opportunity !== 'object') {
    return { points: 0, reasons: [] }
  }

  const reasons = []
  let points = 0
  const oppCorpus = normalizeString(
    `${oppText || ''} ${(safeParseArrayField(opportunity?.keywords, []) || []).join(' ')} ${
      (safeParseArrayField(opportunity?.categories, []) || []).join(' ')
    } ${(safeParseArrayField(opportunity?.eligibility_bullets, []) || []).join(' ')}`,
  )

  const intentCategory = normalizeString(facets?.intent?.primary_need_category || '')
  const intentKeywords = tokenizeFacetTerms(facets?.intent?.keywords || [])
  const intentNegativeKeywords = tokenizeFacetTerms(facets?.intent?.negative_keywords || [])
  const applicantTypes = ensureArray(facets?.profile?.applicant_types).map((v) => normalizeString(v)).filter(Boolean)
  const primaryType = normalizeString(facets?.profile?.primary_profile_type || '')

  const categoryTokens = {
    business_startup: ['small business', 'startup', 'entrepreneur', 'sba', 'microenterprise', 'food truck'],
    education: ['student', 'scholarship', 'tuition', 'classroom', 'college', 'school', 'nclex', 'licensure'],
    disability_support: ['disability', 'special needs', 'assistive', 'accessible', 'autism', 'blind', 'deaf'],
    healthcare_support: ['healthcare', 'medical', 'patient', 'hospital', 'treatment', 'copay', 'rx', 'charity care', 'free clinic', 'sliding scale'],
    housing_stability: ['housing', 'rent', 'eviction', 'shelter', 'utility', 'homeless', 'tenant rights'],
    veteran_support: ['veteran', 'military', 'va', 'service member'],
    food_security: ['food assistance', 'nutrition', 'food bank', 'food pantry', 'meal'],
    transportation_access: ['transportation', 'vehicle', 'transit', 'bus pass', 'mobility'],
    legal_aid: ['legal aid', 'pro bono', 'legal clinic', 'eviction defense', 'attorney', 'court'],
    charity_care: ['charity care', 'patient assistance', 'free clinic', 'copay', 'sliding scale', 'financial assistance policy'],
    workforce_training: ['workforce', 'wioa', 'etpl', 'vocational', 'apprenticeship', 'job training', 'certification'],
    general_assistance: ['grant', 'assistance', 'support'],
  }
  const allCategoryKeys = Object.keys(categoryTokens)

  if (intentCategory && intentCategory !== 'unknown') {
    const tokens = categoryTokens[intentCategory] || []
    const sameCategoryHits = countTokenMatches(oppCorpus, tokens)
    if (sameCategoryHits > 0) {
      const boost = Math.min(9, 3 + sameCategoryHits)
      points += boost
      reasons.push(`Facet intent alignment: ${humanizeEnum(intentCategory)} (+${boost})`)
    } else {
      // Soft mismatch penalty only when another category has strong evidence.
      let strongestAlt = null
      let strongestAltHits = 0
      for (const key of allCategoryKeys) {
        if (key === intentCategory) continue
        const hits = countTokenMatches(oppCorpus, categoryTokens[key] || [])
        if (hits > strongestAltHits) {
          strongestAlt = key
          strongestAltHits = hits
        }
      }
      if (strongestAlt && strongestAltHits >= 2) {
        points -= 4
        reasons.push(
          `Facet intent mismatch (soft): profile=${humanizeEnum(intentCategory)}, opportunity≈${humanizeEnum(
            strongestAlt,
          )} (-4)`,
        )
      }
    }
  }

  if (intentKeywords.length > 0) {
    const matches = intentKeywords.filter((kw) => textIncludesToken(oppCorpus, kw))
    if (matches.length > 0) {
      const boost = Math.min(12, matches.length * 2)
      points += boost
      reasons.push(`Facet keyword overlap (${matches.length}) (+${boost})`)
    } else if (intentKeywords.length >= 2) {
      points -= 3
      reasons.push('Facet keyword overlap missing (soft penalty -3)')
    }
  }

  if (intentNegativeKeywords.length > 0) {
    const blockedHits = intentNegativeKeywords.filter((kw) => textIncludesToken(oppCorpus, kw))
    if (blockedHits.length > 0) {
      const penalty = Math.min(18, blockedHits.length * 6)
      points -= penalty
      reasons.push(`Facet negative keyword conflict (${blockedHits.length}) (-${penalty})`)
    }
  }

  const hasStudentSignals =
    primaryType.includes('student') ||
    applicantTypes.some((t) => t.includes('student')) ||
    facets?.education?.gpa !== null && facets?.education?.gpa !== undefined
  if (hasStudentSignals && countTokenMatches(oppCorpus, ['student', 'scholarship', 'tuition', 'college']) > 0) {
    points += 5
    reasons.push('Facet profile alignment: student (+5)')
  } else if (hasStudentSignals && /not for students|non[-\s]?student/i.test(oppCorpus)) {
    points -= 5
    reasons.push('Facet profile mismatch (student exclusion signal) (-5)')
  }

  const hasBusinessSignals =
    primaryType.includes('business') ||
    applicantTypes.some((t) => t.includes('business')) ||
    facets?.occupation?.small_business_owner === true
  if (hasBusinessSignals && countTokenMatches(oppCorpus, ['small business', 'startup', 'entrepreneur', 'sba']) > 0) {
    points += 5
    reasons.push('Facet profile alignment: small business (+5)')
  }

  const hasVeteranSignals = facets?.military?.veteran === true || facets?.military?.disabled_veteran === true
  if (hasVeteranSignals && countTokenMatches(oppCorpus, ['veteran', 'military', 'va']) > 0) {
    points += 5
    reasons.push('Facet profile alignment: veteran (+5)')
  }

  const hasDisabilitySignals =
    (Array.isArray(facets?.health?.disability_types) && facets.health.disability_types.length > 0) ||
    facets?.health?.visual_impairment === true ||
    facets?.health?.hearing_impairment === true
  if (hasDisabilitySignals && countTokenMatches(oppCorpus, ['disability', 'special needs', 'accessible', 'assistive']) > 0) {
    points += 5
    reasons.push('Facet profile alignment: disability support (+5)')
  }

  const hasLowIncomeSignals =
    facets?.financial?.low_income === true ||
    facets?.assistance?.snap_recipient === true ||
    facets?.assistance?.tanf_recipient === true ||
    facets?.assistance?.section8_housing === true
  if (hasLowIncomeSignals && countTokenMatches(oppCorpus, ['low income', 'hardship', 'household', 'public assistance']) > 0) {
    points += 4
    reasons.push('Facet profile alignment: low-income assistance (+4)')
  }

  // Keep facet adjustments bounded so facets re-rank, not dominate.
  const bounded = Math.max(-35, Math.min(35, points))
  if (bounded !== points) {
    reasons.push(`Facet adjustment capped (${points} -> ${bounded})`)
  }

  if (String(process.env.MATCHING_ENGINE_FACET_DEBUG || '').toLowerCase() === 'true') {
    console.log('[matchingEngine] facet adjustments', {
      title: opportunity?.title ?? null,
      points: bounded,
      reasons,
      intent_category: intentCategory || null,
    })
  }

  return { points: bounded, reasons }
}

/**
 * Check if opportunity eligibility matches profile applicant type
 */
function eligibilityMatchesApplicantType(opportunity, profile) {
  const eligibility = safeParseArrayField(opportunity.eligibility_bullets, []);
  const applicantTypesSet =
    profile?.applicantTypes && typeof profile.applicantTypes[Symbol.iterator] === 'function'
      ? new Set(Array.from(profile.applicantTypes).map((v) => String(v).toLowerCase()))
      : null
  const profileType = profile.primary_type || profile.applicant_type || '';
  
  if ((!profileType || profileType.length === 0) && (!applicantTypesSet || applicantTypesSet.size === 0)) return false;
  
  const typeKeywords = {
    'individual_need': ['individual', 'person', 'resident', 'household'],
    'family': ['family', 'household', 'parent', 'families'],
    'organization': ['organization', 'org', 'agency', 'entity'],
    'nonprofit': ['nonprofit', 'non-profit', '501(c)(3)', 'charity', 'charitable'],
    'small_business': ['small business', 'enterprise', 'microenterprise', 'startup', 'entrepreneur', 'sba', 'smb'],
    'student': ['student', 'scholar', 'undergraduate', 'graduate', 'college'],
    'college_student': ['college student', 'undergraduate', 'university student'],
    'high_school_student': ['high school', 'secondary student', 'k-12'],
    'medical_assistance': ['medical', 'health', 'healthcare', 'patient'],
    'government': ['government', 'municipal', 'state', 'local government', 'public sector']
  };
  
  const profileTypesToCheck = applicantTypesSet?.size
    ? Array.from(applicantTypesSet)
    : [profileType]

  const keywords = profileTypesToCheck
    .flatMap((t) => typeKeywords[t] || [t])
    .filter(Boolean)
    .map((t) => String(t))

  // For individual_need profiles, also match grants that SERVE individuals even
  // when the grant recipient is an organization (state, nonprofit, health center).
  // Most grants.gov opportunities fund organizations that provide services to individuals.
  // Only include terms that strongly indicate the grant DIRECTLY serves individuals,
    // not generic words that appear in almost every federal grant.
    const individualServesKeywords = [
      'individual assistance', 'personal grant', 'household assistance',
      'direct cash', 'direct payment', 'individual benefit',
    ]
  const isIndividualType = profileTypesToCheck.some(t =>
    t === 'individual_need' || t === 'individual' || t === 'family' ||
    t === 'medical_assistance' || t === 'student' || t === 'college_student' ||
    t === 'high_school_student'
  )
  if (isIndividualType) {
    keywords.push(...individualServesKeywords)
  }

  const eligibilityText = eligibility.join(' ').toLowerCase();
  const oppText = `${opportunity.title || ''} ${opportunity.description || ''}`.toLowerCase();
  
  return keywords.some(keyword => 
    eligibilityText.includes(keyword.toLowerCase()) || 
    oppText.includes(keyword.toLowerCase())
  );
}

/**
 * Calculate keyword overlap score (-10 to 25 points)
 * Scoring tiers:
 * - Intent phrase match = 5 pts
 * - Multi-word phrase = 3 pts
 * - Exact keyword = 1.5 pts
 * - Single-word text match = 0.25 pts
 * - Intent mismatch penalty = -10 pts
 */
function calculateKeywordOverlap(profile, opportunity) {
  const intentPhraseSet =
    profile?.intentPhrases && typeof profile.intentPhrases[Symbol.iterator] === 'function'
      ? Array.from(profile.intentPhrases)
      : []
  const keywordSet =
    profile?.keywordSet && typeof profile.keywordSet[Symbol.iterator] === 'function'
      ? Array.from(profile.keywordSet)
      : []
  const phraseSet =
    profile?.phrases && typeof profile.phrases[Symbol.iterator] === 'function'
      ? Array.from(profile.phrases)
      : []
  const interestSet =
    profile?.interests && typeof profile.interests[Symbol.iterator] === 'function'
      ? Array.from(profile.interests)
      : []
  const demographicSet =
    profile?.demographics && typeof profile.demographics[Symbol.iterator] === 'function'
      ? Array.from(profile.demographics)
      : []
  const militarySet =
    profile?.military && typeof profile.military[Symbol.iterator] === 'function'
      ? Array.from(profile.military)
      : []
  const assistanceSet =
    profile?.assistance && typeof profile.assistance[Symbol.iterator] === 'function'
      ? Array.from(profile.assistance)
      : []
  const genderSet =
    profile?.genders && typeof profile.genders[Symbol.iterator] === 'function'
      ? Array.from(profile.genders)
      : []
  const applicantTypes =
    profile?.applicantTypes && typeof profile.applicantTypes[Symbol.iterator] === 'function'
      ? Array.from(profile.applicantTypes)
      : []

  const profileKeywords = safeParseArrayField(profile.keywords, []);
  const focusAreas = safeParseArrayField(profile.focus_areas, []);
  const programAreas = safeParseArrayField(profile.program_areas, []);

  const allTerms = [
    ...phraseSet,
    ...interestSet,
    ...demographicSet,
    ...militarySet,
    ...assistanceSet,
    ...genderSet,
    ...applicantTypes,
    ...keywordSet,
    ...profileKeywords,
    ...focusAreas,
    ...programAreas,
  ]
    .map(k => String(k).toLowerCase().trim())
    .filter(k => k.length > 0);

  if (allTerms.length === 0) return 0;

  const oppKeywords = safeParseArrayField(opportunity.keywords, []);
  const oppCategories = safeParseArrayField(opportunity.categories, []);
  const oppText = `${opportunity.title || ''} ${opportunity.description || ''}`.toLowerCase();

  const intentPhraseStrings = new Set(intentPhraseSet.map((p) => String(p).toLowerCase()).filter((p) => p.length >= 4));
  const phraseSetStrings = new Set(
    [...phraseSet, ...interestSet]
      .map((p) => String(p).toLowerCase().trim())
      .filter((p) => p.length >= 6 && p.includes(' '))
  );

  let matches = 0;
  const matchedIntentPhrases = new Set();

  // Tier 1: Score intent phrases first
  for (const phrase of intentPhraseSet) {
    const phraseLower = String(phrase).toLowerCase();
    if (phraseLower.length < 4) continue;
    if (oppText.includes(phraseLower) || oppKeywords.some((ok) => String(ok).toLowerCase().includes(phraseLower))) {
      matches += 5;
      matchedIntentPhrases.add(phraseLower);
    }
  }
  // Soft penalty only: missing intent phrase reduces score but must not zero out.
  // Profile may say "food truck business" while opportunity says "small business" or "microenterprise" — still a match.
  if (intentPhraseStrings.size > 0 && matchedIntentPhrases.size === 0) {
    matches -= 2;
  }

  // Tier 2: Score other multi-word phrases
  for (const phrase of [...phraseSet, ...interestSet]) {
    const phraseLower = String(phrase).toLowerCase().trim();
    if (phraseLower.length < 6 || !phraseLower.includes(' ')) continue;
    if (intentPhraseStrings.has(phraseLower)) continue;
    if (oppText.includes(phraseLower)) {
      matches += 3;
    }
  }

  // Tier 3: Score single keywords
  const allPhraseStrings = [...intentPhraseStrings, ...phraseSetStrings];
  for (const keyword of allTerms) {
    const kw = keyword.toLowerCase();
    if (AMBIGUOUS_SINGLE_WORDS.has(kw)) continue;
    if (kw.includes(' ')) continue; // already handled in Tier 2
    if (allPhraseStrings.some((p) => p.includes(kw))) continue;
    if (oppKeywords.some((ok) => String(ok).toLowerCase().includes(kw))) {
      matches += 1.5;
      continue;
    }
    if (oppCategories.some((oc) => String(oc).toLowerCase().includes(kw))) {
      matches += 1.5;
      continue;
    }
    if (oppText.includes(kw)) {
      matches += 0.5
    }
  }

  return Math.max(-10, Math.min(25, Math.floor(matches)));
}

/**
 * Calculate category match score (0-20 points)
 */
function calculateCategoryMatch(profile, opportunity) {
  const profileCategories = [
    ...safeParseArrayField(profile.program_areas, []),
    ...(profile?.interests && typeof profile.interests[Symbol.iterator] === 'function'
      ? Array.from(profile.interests)
      : []),
  ];
  const oppCategories = safeParseArrayField(opportunity.categories, []);
  
  if (profileCategories.length === 0 || oppCategories.length === 0) return 0;
  
  let matches = 0;
  profileCategories.forEach(pc => {
    const pcLower = String(pc).toLowerCase();
    oppCategories.forEach(oc => {
      const ocLower = String(oc).toLowerCase();
      if (pcLower === ocLower) {
        matches += 5; // Exact match
      } else if (pcLower.length > 5 && ocLower.length > 5 && (pcLower.includes(ocLower) || ocLower.includes(pcLower))) {
        matches += 2; // Partial match — only for multi-word/long terms
      }
    });
  });
  
  return Math.min(20, matches);
}

/**
 * Check if funding amount is in range for profile
 */
function amountInRange(profileAmount, opportunity) {
  if (!profileAmount) return true; // No preference specified
  
  // Parse profile amount (could be "$50,000" or "50000" or "$25,000 - $100,000")
  const amountStr = String(profileAmount).replace(/[$,]/g, '');
  const amountMatch = amountStr.match(/(\d+)/);
  if (!amountMatch) return true;
  
  const requestedAmount = parseInt(amountMatch[1], 10);
  
  const minAmount = opportunity.amount_min || 0;
  const maxAmount = opportunity.amount_max || Infinity;
  
  // If opportunity has no limits, it matches
  if (!opportunity.amount_min && !opportunity.amount_max) return true;
  
  // Check if requested amount falls within opportunity range
  return requestedAmount >= minAmount && requestedAmount <= maxAmount;
}

/**
 * Calculate deadline urgency score (0-5 points)
 * Rewards opportunities with near-term deadlines
 */
function calculateDeadlineUrgency(opportunity) {
  if (!opportunity.deadline || opportunity.deadline_type === 'rolling' || opportunity.deadline_type === 'ongoing') {
    return 0; // No urgency for rolling deadlines
  }
  
  try {
    const deadline = new Date(opportunity.deadline);
    const now = new Date();
    const daysUntil = Math.floor((deadline - now) / (1000 * 60 * 60 * 24));
    
    if (daysUntil < 0) return -5; // Expired
    if (daysUntil <= 30) return 5;  // Very urgent
    if (daysUntil <= 60) return 3;  // Urgent
    if (daysUntil <= 90) return 1;  // Moderate urgency
    return 0;
  } catch {
    return 0;
  }
}


export default {
  calculateMatchScore
}
