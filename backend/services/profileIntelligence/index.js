/**
 * Profile Intelligence Module — index.js
 *
 * Entry point for the profile-adaptive funding intelligence system.
 *
 * Phases 1-4:
 *   Phase 1: Profile normalization (profileNormalizerIntel.js)
 *   Phase 2: Needs taxonomy (needsTaxonomy.js)
 *   Phase 3: Need inference engine (needsInferenceEngine.js)
 *   Phase 4: Search plan generator (searchPlanGenerator.js)
 *
 * Usage:
 *   import { buildProfileIntelligence } from './profileIntelligence/index.js'
 *   const intel = buildProfileIntelligence(profile, sections)
 *   // intel.entity_types, intel.likely_needs, intel.search_plans, ...
 */

export { normalizeProfileIntelligence } from './profileNormalizerIntel.js'
export { inferNeeds, annotateWithInferredNeeds } from './needsInferenceEngine.js'
export { generateSearchPlans } from './searchPlanGenerator.js'
export {
  TAXONOMY_VERSION,
  NEEDS_TAXONOMY,
  getNeed,
  getAllNeedCodes,
  isValidNeedCode,
  getNeedsForEntityType,
} from './needsTaxonomy.js'

import { normalizeProfileIntelligence } from './profileNormalizerIntel.js'
import { annotateWithInferredNeeds } from './needsInferenceEngine.js'
import { generateSearchPlans } from './searchPlanGenerator.js'

/**
 * Full pipeline: normalize → infer → plan.
 *
 * @param {Object} profile  - Profile row
 * @param {Object} sections - Profile sections keyed by section name
 * @param {Object} [opts]
 * @param {number} [opts.maxPlans=15]
 * @param {number} [opts.minNeedWeight=0.4]
 * @returns {Object} Complete profile intelligence object
 */
export function buildProfileIntelligence(profile, sections = {}, opts = {}) {
  // Phase 1: normalize
  const baseIntel = normalizeProfileIntelligence(profile, sections)
  // Phase 3: infer needs
  const intelWithNeeds = annotateWithInferredNeeds(baseIntel)
  // Phase 4: generate search plans
  const searchPlans = generateSearchPlans(intelWithNeeds, opts)

  return {
    ...intelWithNeeds,
    search_plans: searchPlans,
  }
}

export default { buildProfileIntelligence }
