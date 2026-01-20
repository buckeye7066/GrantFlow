/**
 * Feature Flags Configuration
 * Allows gating heavy or experimental features.
 */

export const FEATURES = {
  GEO_CRAWL: process.env.FEATURE_GEO_CRAWL !== 'false', // Enabled by default
  ANYA_TOOLS: process.env.FEATURE_ANYA_TOOLS !== 'false', // Enabled by default
  AUTO_REPAIR: process.env.FEATURE_AUTO_REPAIR === 'true', // Disabled by default
  DETAILED_MATCHING: process.env.FEATURE_DETAILED_MATCHING !== 'false', // Enabled by default
  CRAWLER_RETRIES: process.env.FEATURE_CRAWLER_RETRIES !== 'false', // Enabled by default
};

/**
 * Check if a feature is enabled
 * @param {string} featureName 
 * @returns {boolean}
 */
export function isEnabled(featureName) {
  return FEATURES[featureName] === true;
}
