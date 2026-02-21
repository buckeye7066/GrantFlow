/**
 * Deterministic Match Scoring Engine
 * Replaces all Math.random() scoring with explainable, reproducible algorithm
 * Same input always produces same output for auditability
 */

import { safeParseArrayField } from './profileHelpers.js'
import { buildProfileSignals } from './profileHelpers.js'

/**
 * Calculate deterministic match score between profile and opportunity
 * @param {Object} profile - User/organization profile
 * @param {Object} opportunity - Funding opportunity
 * @returns {Object} { score: number (0-100), reasons: string[] }
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

  const reasons = [];
  let score = 0;
  
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

  if (profileZip && oppZip && String(profileZip).trim() === String(oppZip).trim()) {
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
  } else if (profileState && oppState && String(oppState).trim().toUpperCase() === String(profileState).trim().toUpperCase()) {
    geoTier = 'state'
    geoPoints = 18
  } else if (oppIsNational) {
    geoTier = 'national'
    geoPoints = 12
  } else if (!profileZip && !profileCounty && !profileCity && !profileState) {
    geoTier = 'unknown'
    geoPoints = 0
  } else {
    // Known profile location but no match signal on the opportunity.
    geoTier = 'mismatch'
    geoPoints = -5
  }

  score += geoPoints
  if (geoTier === 'zip') reasons.push('Geography: ZIP match')
  else if (geoTier === 'county') reasons.push('Geography: County match')
  else if (geoTier === 'city') reasons.push('Geography: City match (text)')
  else if (geoTier === 'state') reasons.push('Geography: State match')
  else if (geoTier === 'national') reasons.push('National eligibility')
  else if (geoTier === 'unknown') reasons.push('Location unknown (neutral)')
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
  
  return { 
    score: Math.max(0, Math.min(100, score)), 
    reasons: reasons.length > 0 ? reasons : ['No specific matches found']
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

function applicantTypeSetHas(applicantTypesSet, values = []) {
  if (!applicantTypesSet || applicantTypesSet.size === 0) return false
  return values.some((v) => applicantTypesSet.has(String(v).toLowerCase()))
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
    'small_business': ['small business', 'business', 'enterprise', 'company', 'smb'],
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

  const AMBIGUOUS_SINGLE_WORDS = new Set([
    'food', 'health', 'care', 'home', 'house', 'school', 'community',
    'family', 'child', 'children', 'work', 'service', 'support', 'program',
    'help', 'assist', 'need', 'general', 'special', 'local', 'national',
    'plan', 'fund', 'grant', 'money', 'bank', 'credit', 'loan',
    'start', 'open', 'build', 'make', 'create', 'medical', 'business',
    'assistance', 'resource', 'free', 'apply', 'person', 'people',
  ]);

  const allTerms = [
    ...intentPhraseSet,
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
  if (intentPhraseStrings.size > 0 && matchedIntentPhrases.size === 0) {
    matches -= 10;
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
      matches += 0.25;
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
      } else if (pcLower.includes(ocLower) || ocLower.includes(pcLower)) {
        matches += 2; // Partial match
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
