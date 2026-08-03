/**
 * Production matching scope.
 *
 * Some records exist to exercise administration or review workflows and must
 * never be sent through Crawler OS, Item Funding, or owner-facing funding
 * presentation. Keep this registry deliberately exact. A broad word such as
 * "admin" or "review" would hide legitimate organizations and applications.
 */

export const INTERNAL_MATCH_PROFILE_NAMES = Object.freeze(new Set([
  'admin vault',
  'play review',
]))

function normalize(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function profileRecord(profileContext = {}) {
  return profileContext?.profile && typeof profileContext.profile === 'object'
    ? profileContext.profile
    : profileContext
}

/**
 * Returns an explicit classification instead of a bare boolean so routes and
 * reports can explain why a profile was excluded without leaking private data.
 */
export function classifyProductionProfile(profileContext = {}) {
  const profile = profileRecord(profileContext) ?? {}
  if (profile.is_test === true || profile.test_profile === true || profile.is_internal === true) {
    return { production: false, reason: 'explicit_internal_or_test_flag' }
  }

  const environment = normalize(profile.environment ?? profile.profile_environment)
  if (['test', 'internal', 'sandbox', 'fixture'].includes(environment)) {
    return { production: false, reason: `profile_environment:${environment}` }
  }

  const name = normalize(
    profile.display_name ??
    profile.name ??
    profile.profile_name ??
    profile.title,
  )
  if (name && INTERNAL_MATCH_PROFILE_NAMES.has(name)) {
    return { production: false, reason: `registered_internal_profile:${name}` }
  }

  return { production: true, reason: null }
}

export function isProductionMatchingProfile(profileContext = {}) {
  return classifyProductionProfile(profileContext).production
}

export default {
  INTERNAL_MATCH_PROFILE_NAMES,
  classifyProductionProfile,
  isProductionMatchingProfile,
}
