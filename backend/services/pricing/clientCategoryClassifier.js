/**
 * Client-category classifier (re-export wrapper).
 *
 * The actual rules live in `pricingRules.js` so the classifier and
 * service-recommendation logic can share the same parsing helpers.
 * This file exists because the access-gate / initializer modules want
 * to import classification on its own without pulling in the rest of
 * the rule set.
 */

export { determineClientCategory } from './pricingRules.js'

import { determineClientCategory as _determineClientCategory } from './pricingRules.js'

/**
 * Convenience wrapper that mirrors the spec's signature
 * `determineClientCategory(profile, intakeAnswers)` while still
 * accepting the explicit `organization` arg used by the engine.
 */
export function classifyClient(profile, intakeAnswers, organization) {
  return _determineClientCategory({
    profile: profile || {},
    intakeAnswers: intakeAnswers || {},
    organization: organization || {},
  })
}
