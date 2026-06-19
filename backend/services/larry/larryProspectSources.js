/**
 * Yana — registry of public prospect sources (legacy filename `larryProspectSources.js`).
 *
 * Public, well-known directories where likely GrantFlow CLIENTS can be found.
 * The registry is intentionally read-only data; the actual fetching logic is
 * implemented by adapters injected at runtime so this file stays purely
 * declarative and unit-testable.
 *
 * Notes on selection:
 *   - Every entry is a *public* directory or registry; nothing requires a
 *     login or paid subscription to land on the registry. Adapters MAY use
 *     paid/auth APIs at runtime, but the registry itself is open data.
 *   - We classify by `applicant_type` so the orchestrator can pick a
 *     balanced set of sources per run instead of hammering one family.
 */

export const LARRY_SOURCE_TYPES = Object.freeze({
  IRS_BMF: 'irs_bmf',
  CANDID: 'candid_directory',
  NCES: 'nces',
  USFA: 'usfa_fire_dept_registry',
  STATE_NONPROFIT: 'state_nonprofit_registry',
  STATE_BUSINESS: 'state_business_registry',
  CITY_OPEN_DATA: 'city_open_data',
  CHURCH_DIRECTORY: 'church_directory',
  GUIDESTAR_PUBLIC: 'guidestar_public',
  FIND_HELP: 'find_help_directory',
  DOMAIN_DIRECTORY: 'domain_directory',
  COMMUNITY_FOUNDATION_GRANTEE: 'community_foundation_grantee_list',
  STATE_GRANT_AWARDS: 'state_grant_awards',
  FEDERAL_AWARDS: 'federal_assistance_awards',
})

/**
 * Curated public directories. Each entry is intentionally generic enough to be
 * reused across geographies; the adapter is responsible for the per-state /
 * per-city expansion.
 */
export const LARRY_PUBLIC_PROSPECT_SOURCES = Object.freeze([
  Object.freeze({
    id: 'irs_bmf',
    name: 'IRS Tax Exempt Organization Search (BMF)',
    url: 'https://www.irs.gov/charities-non-profits/tax-exempt-organization-search',
    source_type: LARRY_SOURCE_TYPES.IRS_BMF,
    applicant_types: ['nonprofit', 'church', 'religious', 'school', 'community_foundation'],
    coverage: 'national',
    trust_score: 95,
    public: true,
    description: 'Authoritative US registry of 501(c)(3) and other tax-exempt organizations.',
    typical_fields: ['ein', 'organization_name', 'city', 'state', 'classification', 'ruling_date'],
  }),
  Object.freeze({
    id: 'usaspending_assistance',
    name: 'USAspending.gov assistance awards',
    url: 'https://api.usaspending.gov/api/v2/search/spending_by_award/',
    source_type: LARRY_SOURCE_TYPES.FEDERAL_AWARDS,
    applicant_types: ['nonprofit', 'small_business', 'school', 'state', 'local_government'],
    coverage: 'national',
    trust_score: 92,
    public: true,
    description: 'Past federal grant recipients — strong signal that an org actively seeks grants.',
    typical_fields: ['recipient_name', 'recipient_state', 'awarding_agency', 'award_amount'],
  }),
  Object.freeze({
    id: 'nces_school_search',
    name: 'NCES Common Core of Data — school search',
    url: 'https://nces.ed.gov/ccd/schoolsearch/',
    source_type: LARRY_SOURCE_TYPES.NCES,
    applicant_types: ['school', 'school_district'],
    coverage: 'national',
    trust_score: 95,
    public: true,
    description: 'Public/private K–12 school registry with addresses and contact info.',
    typical_fields: ['school_name', 'district', 'city', 'state', 'enrollment'],
  }),
  Object.freeze({
    id: 'usfa_fire_departments',
    name: 'USFA National Fire Department Registry',
    url: 'https://apps.usfa.fema.gov/registry/',
    source_type: LARRY_SOURCE_TYPES.USFA,
    applicant_types: ['volunteer_fire_department', 'fire_department', 'ems'],
    coverage: 'national',
    trust_score: 92,
    public: true,
    description: 'Public registry of US fire departments — staffing model, address, county.',
    typical_fields: ['department_name', 'department_type', 'staffing', 'state', 'city'],
  }),
  Object.freeze({
    id: 'candid_directory',
    name: 'Candid (Foundation Directory) public org pages',
    url: 'https://candid.org/',
    source_type: LARRY_SOURCE_TYPES.CANDID,
    applicant_types: ['nonprofit', 'community_foundation'],
    coverage: 'national',
    trust_score: 88,
    public: true,
    description: 'Public organization profiles linked off Candid; can corroborate IRS BMF data.',
    typical_fields: ['organization_name', 'website', 'mission', 'ein'],
  }),
  Object.freeze({
    id: 'state_nonprofit_registry',
    name: 'State Secretary of State nonprofit registries',
    url: null,
    source_type: LARRY_SOURCE_TYPES.STATE_NONPROFIT,
    applicant_types: ['nonprofit', 'church'],
    coverage: 'state',
    trust_score: 85,
    public: true,
    description: 'Per-state nonprofit corporation lookup. Adapter expands per-state URL.',
    typical_fields: ['organization_name', 'status', 'incorporation_date', 'registered_agent'],
  }),
  Object.freeze({
    id: 'find_help_directory',
    name: 'findhelp.org local social services directory',
    url: 'https://www.findhelp.org/',
    source_type: LARRY_SOURCE_TYPES.FIND_HELP,
    applicant_types: ['nonprofit', 'food_bank', 'shelter', 'community_clinic'],
    coverage: 'local',
    trust_score: 75,
    public: true,
    description: 'Local nonprofits offering direct services — strong fit signal for GrantFlow.',
    typical_fields: ['organization_name', 'service_categories', 'address', 'phone'],
  }),
  Object.freeze({
    id: 'community_foundation_grantee_lists',
    name: 'Community foundation public grantee lists',
    url: null,
    source_type: LARRY_SOURCE_TYPES.COMMUNITY_FOUNDATION_GRANTEE,
    applicant_types: ['nonprofit', 'church', 'school'],
    coverage: 'local',
    trust_score: 90,
    public: true,
    description: 'Past grant recipients listed by community foundations — proven grant-seekers.',
    typical_fields: ['organization_name', 'grant_amount', 'award_year'],
  }),
])

/**
 * Group sources by applicant type so the orchestrator can ask "give me 5
 * sources for nonprofits" without re-implementing the filter every time.
 */
export function getSourcesForApplicantTypes(applicantTypes = []) {
  if (!Array.isArray(applicantTypes) || applicantTypes.length === 0) {
    return [...LARRY_PUBLIC_PROSPECT_SOURCES]
  }
  const wanted = new Set(applicantTypes.map((s) => String(s).toLowerCase()))
  return LARRY_PUBLIC_PROSPECT_SOURCES.filter((src) =>
    src.applicant_types.some((t) => wanted.has(String(t).toLowerCase())),
  )
}

export function getSourceById(id) {
  return LARRY_PUBLIC_PROSPECT_SOURCES.find((s) => s.id === id) || null
}

/**
 * Pure trust scoring used to break ties when more candidates are returned
 * than `maxProspectsPerRun` allows. Higher = better.
 */
export function computeProspectTrustScore(prospect) {
  if (!prospect) return 0
  let score = 0
  if (prospect.ein) score += 25
  if (prospect.website_url) score += 15
  if (prospect.primary_contact_email) score += 15
  if (prospect.primary_contact_name) score += 10
  if (prospect.address || (prospect.city && prospect.state)) score += 10
  if (prospect.programs_json && Array.isArray(prospect.programs_json) && prospect.programs_json.length > 0) score += 10
  if (prospect.organization_legal_name) score += 5
  if (prospect.applicant_type) score += 5
  if (prospect.signals_json && typeof prospect.signals_json === 'object') {
    if (prospect.signals_json.recent_grant_history) score += 5
  }
  return Math.min(100, score)
}
