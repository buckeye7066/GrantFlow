/**
 * Partition a profile's surfaced results into direct funding and resources.
 * Directories remain visible, but never inflate the owner's funding-source
 * count or the general `sources` collection.
 */
export function partitionFundingSources(sources = []) {
  const list = Array.isArray(sources) ? sources : []
  const directories = list.filter((source) => source?.is_directory === true)
  const directSources = list.filter((source) => source?.is_directory !== true)

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

export default { partitionFundingSources }
