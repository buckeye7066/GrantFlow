/**
 * crawlerActivationPolicy.js — the only interpretation of crawler run requests.
 *
 * Funding-source activation belongs to crawler-os/planner.js, which evaluates
 * the complete profile thesis against sourceRegistry.js. Historical UI crawler
 * names are accepted only as compatibility labels; they never select an
 * independent engine or override the profile-derived plan.
 */

export const PROFILE_PLANNED_CRAWLER_ALIASES = Object.freeze([
  'crawler-os',
  'comprehensive',
  'curated_benefits',
  'local_funding',
  'government_funding',
  'student_grants',
  'health_resources',
  'ecf_benefits',
  'state_waiver_benefits',
  'special_needs',
  'housing_funding',
])

export const ITEM_SEARCH_CRAWLER_TYPE = 'item_matching'

export const CRAWLER_REQUEST_TYPES = Object.freeze([
  ...PROFILE_PLANNED_CRAWLER_ALIASES,
  ITEM_SEARCH_CRAWLER_TYPE,
])

export function resolveCrawlerActivation(type) {
  const requested = String(type || '').trim()
  if (requested === ITEM_SEARCH_CRAWLER_TYPE) {
    return {
      valid: true,
      mode: 'item_search',
      requested,
      activation_authority: 'itemNeedSearch',
    }
  }
  if (PROFILE_PLANNED_CRAWLER_ALIASES.includes(requested)) {
    return {
      valid: true,
      mode: 'profile_planned',
      requested,
      activation_authority: 'crawler-os/planner',
      // Deliberately null: planner.js selects sources from the full profile.
      only_source_ids: null,
    }
  }
  return {
    valid: false,
    mode: null,
    requested,
    activation_authority: 'crawler-os/planner',
  }
}

export default {
  PROFILE_PLANNED_CRAWLER_ALIASES,
  ITEM_SEARCH_CRAWLER_TYPE,
  CRAWLER_REQUEST_TYPES,
  resolveCrawlerActivation,
}
