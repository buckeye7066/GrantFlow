/**
 * strategyRegistry.js
 *
 * Maps each crawler_type to a concrete strategy that controls:
 *   - candidateSources: which datasets to load
 *   - scoringWeights: emphasis adjustments per domain
 *   - hardGates: required intents (profile must have these or strategy is "gated")
 *   - intentBoost: extra score for intent-aligned programs
 *   - negativeRules: anti-match categories to suppress
 *   - urlPolicy: strict (funding only) vs relaxed (directories OK)
 *   - needEmphasis: need categories to prioritise
 */

const STRATEGIES = {
  comprehensive: {
    id: 'comprehensive',
    label: 'Comprehensive Search',
    candidateSources: ['federal', 'state', 'national', 'business', 'scholarships', 'schoolCards', 'prescription', 'senior', 'property_tax', 'utility_assistance'],
    hardGates: [],
    needEmphasis: [],
    intentBoost: {},
    urlPolicy: 'standard',
    maxResults: 100,
    minScore: 25,
  },

  local_funding: {
    id: 'local_funding',
    label: 'Local & State Funding',
    candidateSources: ['state', 'national', 'senior', 'property_tax', 'utility_assistance'],
    hardGates: [],
    needEmphasis: ['housing', 'utilities', 'food', 'cash_assistance', 'childcare', 'transportation', 'property_tax_relief'],
    intentBoost: { locality: 15 },
    urlPolicy: 'standard',
    maxResults: 60,
    minScore: 25,
  },

  government_funding: {
    id: 'government_funding',
    label: 'Government Benefits',
    candidateSources: ['federal', 'state', 'senior', 'property_tax', 'utility_assistance'],
    hardGates: [],
    needEmphasis: ['utilities', 'housing', 'food', 'healthcare', 'cash_assistance', 'disability', 'employment',
      'certification_assistance', 'workforce_training', 'license_reinstatement_support',
      'workforce_reentry_training', 'property_tax_relief'],
    intentBoost: {},
    urlPolicy: 'strict',
    maxResults: 60,
    minScore: 25,
  },

  student_grants: {
    id: 'student_grants',
    label: 'Student Grants & Scholarships',
    candidateSources: ['federal', 'scholarships', 'national', 'schoolCards'],
    hardGates: ['education'],
    needEmphasis: ['scholarship', 'education'],
    intentBoost: { education: 20 },
    urlPolicy: 'standard',
    maxResults: 80,
    minScore: 20,
  },

  health_resources: {
    id: 'health_resources',
    label: 'Health & Medical Assistance',
    candidateSources: ['federal', 'state', 'national', 'prescription', 'senior'],
    hardGates: ['healthcare'],
    needEmphasis: ['healthcare', 'mental_health', 'disability', 'substance_recovery', 'prescription_assistance'],
    intentBoost: { healthcare: 20, prescription_assistance: 15 },
    urlPolicy: 'standard',
    maxResults: 60,
    minScore: 25,
    categoryFilter: ['healthcare', 'mental_health', 'substance_recovery', 'disability', 'prescription_assistance'],
  },

  special_needs: {
    id: 'special_needs',
    label: 'Special Needs & Disability',
    candidateSources: ['federal', 'state', 'national'],
    hardGates: ['special_needs'],
    needEmphasis: ['disability', 'healthcare'],
    intentBoost: { special_needs: 20 },
    urlPolicy: 'standard',
    maxResults: 60,
    minScore: 25,
    categoryFilter: ['disability', 'healthcare', 'employment', 'transportation', 'housing'],
  },

  ecf_benefits: {
    id: 'ecf_benefits',
    label: 'ECF / CHOICES / Waiver Benefits',
    candidateSources: ['federal', 'state'],
    hardGates: ['special_needs'],
    needEmphasis: ['disability', 'healthcare'],
    intentBoost: { special_needs: 15 },
    urlPolicy: 'standard',
    maxResults: 40,
    minScore: 20,
    categoryFilter: ['disability', 'healthcare'],
  },

  curated_benefits: {
    id: 'curated_benefits',
    label: 'Curated Benefits',
    candidateSources: ['federal', 'state', 'national'],
    hardGates: [],
    needEmphasis: [],
    intentBoost: {},
    urlPolicy: 'standard',
    maxResults: 80,
    minScore: 25,
  },

  license_reinstatement: {
    id: 'license_reinstatement',
    label: 'License Reinstatement & Professional Remediation',
    candidateSources: ['federal', 'state', 'national', 'scholarships'],
    hardGates: [],
    needEmphasis: ['license_reinstatement_support', 'professional_remediation_funding',
      'nursing_reentry_support', 'workforce_reentry_training', 'employment',
      'education', 'healthcare'],
    intentBoost: { license_reinstatement: 25, healthcare: 15, employment: 15, education: 10 },
    urlPolicy: 'standard',
    maxResults: 80,
    minScore: 20,
    categoryFilter: ['license_reinstatement_support', 'professional_remediation_funding',
      'nursing_reentry_support', 'workforce_reentry_training', 'employment',
      'education', 'healthcare', 'disability'],
  },

  certification_training: {
    id: 'certification_training',
    label: 'Certification & Training Assistance',
    candidateSources: ['federal', 'state', 'national', 'scholarships'],
    hardGates: [],
    needEmphasis: ['certification_assistance', 'cpr_first_aid_training', 'workforce_training',
      'community_health_training', 'volunteer_training_support', 'employment', 'education',
      'license_reinstatement_support', 'professional_remediation_funding'],
    intentBoost: { employment: 15, education: 15, community_health_training: 20, license_reinstatement: 15 },
    urlPolicy: 'standard',
    maxResults: 80,
    minScore: 20,
    categoryFilter: ['certification_assistance', 'cpr_first_aid_training', 'employment',
      'education', 'workforce_training', 'community_health_training', 'volunteer_training_support',
      'healthcare', 'childcare', 'license_reinstatement_support', 'professional_remediation_funding',
      'nursing_reentry_support', 'workforce_reentry_training'],
  },

  item_matching: {
    id: 'item_matching',
    label: 'Item / Specific Need Matching',
    candidateSources: ['federal', 'state', 'national', 'business'],
    hardGates: [],
    needEmphasis: [],
    intentBoost: {},
    urlPolicy: 'strict',
    maxResults: 30,
    minScore: 20,
  },

  nonprofit_org: {
    id: 'nonprofit_org',
    label: 'Nonprofit & Community Organization Grants',
    candidateSources: ['federal', 'state', 'national'],
    hardGates: [],
    needEmphasis: ['capacity_building', 'program_funding', 'community_development', 'education', 'healthcare', 'housing'],
    intentBoost: { nonprofit: 20, community: 15, organization: 15 },
    urlPolicy: 'standard',
    maxResults: 80,
    minScore: 20,
    categoryFilter: ['capacity_building', 'program_funding', 'community_development', 'education',
      'healthcare', 'housing', 'employment', 'cash_assistance'],
  },

  volunteer_fire: {
    id: 'volunteer_fire',
    label: 'Volunteer Fire & EMS Grants',
    candidateSources: ['federal', 'state', 'national'],
    hardGates: [],
    needEmphasis: ['equipment', 'certification_assistance', 'volunteer_training_support', 'cpr_first_aid_training'],
    intentBoost: { volunteer_fire: 25, firefighter: 20, ems: 20, certification: 15 },
    urlPolicy: 'standard',
    maxResults: 60,
    minScore: 20,
    categoryFilter: ['equipment', 'certification_assistance', 'volunteer_training_support',
      'cpr_first_aid_training', 'employment', 'community_development'],
  },
};

/**
 * Get a strategy by crawler_type. Falls back to comprehensive.
 */
export function getStrategy(crawlerType) {
  return STRATEGIES[crawlerType] || STRATEGIES.comprehensive;
}

/**
 * Check whether a strategy's hard gates are satisfied by profile intents.
 * Returns { gated: false } if OK, or { gated: true, reason } if blocked.
 */
/**
 * Check whether a strategy's hard gates are satisfied by profile intents.
 * A strategy is gated only when EVERY hard gate is missing from the profile.
 * If at least one gate is present, the strategy proceeds (partial match is
 * better than full suppression â final decisions belong to computeMatchDecision).
 * Returns { gated: false } if OK, or { gated: true, reason, missingGates } if blocked.
 *
 * Goals served: 3 (legitimate hard-reject only), 5 (intent set from full profile),
 *               7 (recall over suppression), 8 (reason logged for observability).
 */
/**
 * Check whether a strategy's hard gates are satisfied by profile intents.
 * Returns { gated: false } if OK, or { gated: true, reason, missingGates } if blocked.
 *
 * IMPORTANT: gated:true means the STRATEGY is skipped at the crawler/pipeline level.
 * Per-opportunity filtering remains the responsibility of relevanceFilter and
 * computeMatchDecision (Goals 3, 4). This gate is ONLY applied when the profile
 * has NO signal whatsoever for the strategy domain AND the intents Set is non-empty
 * (i.e., the profile was actually evaluated â an empty intents Set means the profile
 * was not fully processed and gating must be skipped to avoid suppressing due to
 * incomplete extraction).
 *
 * Goals served: 3, 5, 7, 8.
 */
export function checkGates(strategy, intents) {
  if (!strategy.hardGates || strategy.hardGates.length === 0) {
    return { gated: false };
  }

  // If the intents Set is empty, the profile may not have been fully extracted.
  // Do NOT gate on an empty profile â surface results so the user can see options
  // and improve their profile (Goals 7, 10).
  if (!intents || intents.size === 0) {
    return { gated: false };
  }

  const missingGates = strategy.hardGates.filter(gate => !intents.has(gate));

  // Only gate when ALL required intents are absent AND the profile has other intents
  // (proving the profile was evaluated but genuinely lacks this domain).
  // Defer final eligibility judgment to the match engine for all per-opportunity decisions.
  if (missingGates.length === strategy.hardGates.length) {
    const reason =
      `Strategy "${strategy.id}" requires at least one of [${strategy.hardGates.join(', ')}] ` +
      `but profile has none. Profile intents: [${[...intents].join(', ')}]. ` +
      `Strategy skipped â per-opportunity filtering remains with relevanceFilter/computeMatchDecision (Goals 3, 4, 7).`;
    return {
      gated: true,
      missingGates,
      reason,
    };
  }

  return { gated: false };
}

/**
 * List all available strategies.
 */
export function listStrategies() {
  return Object.values(STRATEGIES).map(s => ({
    id: s.id,
    label: s.label,
    hardGates: s.hardGates,
  }));
}

/**
 * Returns true only if the decision engine's score meets the strategy floor.
 * MUST be called AFTER computeMatchDecision() â never before.
 * Using this as a pre-engine filter violates Goals 4 and 7.
 */
export function meetsMinScore(strategy, engineScore) {
  if (typeof engineScore !== 'number') return true; // unknown score â do not suppress (Goal 7)
  return engineScore >= (strategy.minScore ?? 0);
}

export default { getStrategy, checkGates, listStrategies, meetsMinScore, STRATEGIES };
