import schema from './applicationSchema.json' assert { type: 'json' }

// REQUIRED_FOR_CRAWLING includes:
// - primary_profile_type
// - geo.state_or_zip
// - need.primary_need
// - need.category
//
// Crawlers must call requireFacets(profileContext)
// If facets missing or required fields missing => throw hard (fail fast instead of returning junk).

export function buildProfileFacets(profileContext) {
  // 1) normalize sections
  // 2) extract fields using schema ids + heuristics
  // 3) write to facets via facet_path
  // 4) compute coverage.required_missing
  // 5) return { facets, coverage, trace }
}

export function requireFacets(profileContext) {
  // throws if facets/coverage missing OR required_missing present
}

export function buildIntentPhrases({ facets }) {
  // returns strong intent phrases for DB fallback narrowing
}