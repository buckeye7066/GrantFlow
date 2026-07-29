// Canonical, official state-level funding directories that supplement the
// primary state portal when a state has another distinct government funding
// surface. Entries are stored once per state, never templated once per ZIP.
// This preserves the real-source/no-placeholder doctrine while giving offline
// geo crawls durable, clickable coverage when upstream APIs are unavailable.

const STATE_DIRECTORIES = Object.freeze({
  OH: Object.freeze([
    Object.freeze({
      source_id: 'OH-education-workforce-grants',
      title: 'Ohio Department of Education and Workforce Grant Opportunities',
      sponsor: 'Ohio Department of Education and Workforce',
      description:
        'Official Ohio grant-opportunities directory for school districts, community schools, higher education, community-based organizations, and nonprofit organizations.',
      url: 'https://education.ohio.gov/Topics/Finance-and-Funding/Grants-Administration/Grant-Opportunities',
      categories: Object.freeze(['government', 'directory', 'state_grants', 'education', 'nonprofit']),
      keywords: Object.freeze([
        'ohio grants',
        'education grants',
        'workforce grants',
        'nonprofit grants',
        'community organization funding',
      ]),
    }),
  ]),
})

function normalizeState(value) {
  const state = String(value ?? '').trim().toUpperCase()
  return /^[A-Z]{2}$/.test(state) ? state : null
}

export function buildStateSupplementalDirectories({ state, zip = null } = {}) {
  const normalizedState = normalizeState(state)
  if (!normalizedState) return []

  const entries = STATE_DIRECTORIES[normalizedState] ?? []
  return entries.map((entry) => ({
    title: entry.title,
    sponsor: entry.sponsor,
    description: entry.description,
    url: entry.url,
    application_url: entry.url,
    source_url: entry.url,
    evidence_url: entry.url,
    opportunity_type: 'grant_directory',
    type: 'DIRECTORY',
    requires_match: false,
    match_percentage: 0,
    is_national: false,
    state: normalizedState,
    categories: [...entry.categories],
    keywords: [
      ...entry.keywords,
      normalizedState.toLowerCase(),
      ...(zip ? [String(zip)] : []),
    ],
    source: 'state_supplemental_grants',
    // Deliberately state-level, not ZIP-level, so a nationwide ZIP crawl does
    // not manufacture thousands of duplicate catalog rows.
    source_id: entry.source_id,
    discovered_at: new Date().toISOString(),
  }))
}

export { STATE_DIRECTORIES }
