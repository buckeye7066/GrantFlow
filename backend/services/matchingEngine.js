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
  
  // Geographic match (20 pts)
  const profileState =
    effectiveSignals?.location?.state ??
    effectiveProfile?.state ??
    null
  if (opportunity.is_national || (opportunity.state && profileState && opportunity.state === profileState)) {
    score += 20;
    reasons.push(opportunity.is_national ? 'National eligibility' : 'Geographic eligibility');
  } else if (opportunity.state) {
    // State mismatch - significant penalty but not disqualifying
    score -= 10;
    reasons.push(`State mismatch (opportunity in ${opportunity.state}, profile in ${profileState || 'unknown'})`);
  }
  
  // Applicant type match (25 pts)
  if (eligibilityMatchesApplicantType(opportunity, effectiveProfile)) {
    score += 25;
    reasons.push('Applicant type match');
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
  if (opportunity.requires_501c3 && !ein) {
    score -= 15;
    reasons.push('Requires 501(c)(3) status');
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

/**
 * Check if opportunity eligibility matches profile applicant type
 */
function eligibilityMatchesApplicantType(opportunity, profile) {
  const eligibility = safeParseArrayField(opportunity.eligibility_bullets, []);
  const profileType = profile.primary_type || profile.applicant_type || '';
  
  if (!profileType) return false;
  
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
  
  const keywords = typeKeywords[profileType] || [profileType];
  const eligibilityText = eligibility.join(' ').toLowerCase();
  const oppText = `${opportunity.title || ''} ${opportunity.description || ''}`.toLowerCase();
  
  return keywords.some(keyword => 
    eligibilityText.includes(keyword.toLowerCase()) || 
    oppText.includes(keyword.toLowerCase())
  );
}

/**
 * Calculate keyword overlap score (0-25 points)
 */
function calculateKeywordOverlap(profile, opportunity) {
  const profileKeywords = safeParseArrayField(profile.keywords, []);
  const focusAreas = safeParseArrayField(profile.focus_areas, []);
  const programAreas = safeParseArrayField(profile.program_areas, []);
  
  const allProfileKeywords = [...profileKeywords, ...focusAreas, ...programAreas]
    .map(k => String(k).toLowerCase().trim())
    .filter(k => k.length > 0);
  
  if (allProfileKeywords.length === 0) return 0;
  
  const oppKeywords = safeParseArrayField(opportunity.keywords, []);
  const oppCategories = safeParseArrayField(opportunity.categories, []);
  const oppText = `${opportunity.title || ''} ${opportunity.description || ''}`.toLowerCase();
  
  let matches = 0;
  allProfileKeywords.forEach(keyword => {
    // Exact keyword match
    if (oppKeywords.some(ok => String(ok).toLowerCase().includes(keyword))) {
      matches += 2;
      return;
    }
    // Category match
    if (oppCategories.some(oc => String(oc).toLowerCase().includes(keyword))) {
      matches += 2;
      return;
    }
    // Text match (weaker signal)
    if (oppText.includes(keyword)) {
      matches += 0.5;
    }
  });
  
  return Math.min(25, Math.floor(matches));
}

/**
 * Calculate category match score (0-20 points)
 */
function calculateCategoryMatch(profile, opportunity) {
  const profileCategories = safeParseArrayField(profile.program_areas, []);
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
