const RESOURCE_OPPORTUNITY_KINDS = new Set([
  'DIRECTORY',
  'PAST_AWARD_INTEL',
  'SCHOOL_PORTAL',
  'REFERRAL',
])

/**
 * Return true when a surfaced row is a locator, directory, referral, or other
 * resource rather than a direct funding opportunity.
 *
 * The explicit flags remain supported for normalized callers, while the kind
 * check protects presentation paths that receive raw catalog rows. Keeping the
 * classification here prevents the match engine and the owner-facing totals
 * from developing different definitions again.
 */
export function isFundingResource(source = {}) {
  if (source?.is_directory === true || source?.is_resource === true) return true

  const kind = String(
    source?.opportunity_kind ??
    source?.opportunity_type ??
    source?.type ??
    '',
  ).trim().toUpperCase()

  return RESOURCE_OPPORTUNITY_KINDS.has(kind)
}

/**
 * Partition a profile's surfaced results into direct funding and resources.
 * Resources remain visible, but never inflate the owner's funding-source count
 * or the general `sources` collection. The `directories` response key is kept
 * for API compatibility and contains all non-direct resources.
 */
export function partitionFundingSources(sources = []) {
  const list = Array.isArray(sources) ? sources : []
  const directories = list.filter(isFundingResource)
  const directSources = list.filter((source) => !isFundingResource(source))

  return {
    total: directSources.length,
    sources: directSources,
    best_matches: directSources.filter(
      (source) => String(source?.match_decision || '').toLowerCase() === 'accept',
    ),
    worth_reviewing: directSources.filter(
      (source) => String(source?.match_decision || '').toLowerCase() === 'review',
    ),
    directories,
    resource_count: directories.length,
  }
}

export default { isFundingResource, partitionFundingSources }
