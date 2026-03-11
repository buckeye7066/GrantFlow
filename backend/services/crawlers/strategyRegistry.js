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
    candidateSources: ['federal', 'state', 'national', 'business', 'scholarships', 'schoolCards'],
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
    candidateSources: ['state', 'national'],
    hardGates: [],
    needEmphasis: ['housing', 'utilities', 'food', 'cash_assistance', 'childcare', 'transportation'],
    intentBoost: { locality: 15 },
    urlPolicy: 'standard',
    maxResults: 60,
    minScore: 25,
  },

  government_funding: {
    id: 'government_funding',
    label: 'Government Benefits',
    candidateSources: ['federal', 'state'],
    hardGates: [],
    needEmphasis: ['utilities', 'housing', 'food', 'healthcare', 'cash_assistance', 'disability', 'employment',
      'certification_assistance', 'workforce_training', 'license_reinstatement_support',
      'workforce_reentry_training'],
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
    candidateSources: ['federal', 'state', 'national'],
    hardGates: ['healthcare'],
    needEmphasis: ['healthcare', 'mental_health', 'disability', 'substance_recovery'],
    intentBoost: { healthcare: 20 },
    urlPolicy: 'standard',
    maxResults: 60,
    minScore: 25,
    categoryFilter: ['healthcare', 'mental_health', 'substance_recovery', 'disability'],
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
export function checkGates(strategy, intents) {
  if (!strategy.hardGates || strategy.hardGates.length === 0) {
    return { gated: false };
  }
  for (const gate of strategy.hardGates) {
    if (!intents.has(gate)) {
      return {
        gated: true,
        reason: `Strategy "${strategy.id}" requires intent "${gate}" but profile lacks it. ` +
          `Profile intents: [${[...intents].join(', ')}]`,
      };
    }
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

export default { getStrategy, checkGates, listStrategies, STRATEGIES };
