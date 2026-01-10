/**
 * National Funding & Benefits Crawler - Source Registry (curated + extensible).
 *
 * IMPORTANT:
 * - Registry is source-of-truth for crawl scope selection.
 * - SMOKE_MODE must use a tiny curated subset and strict limits.
 * - Parsing is modular by source_family (no one-off parsing in orchestrator).
 */

export const SOURCE_FAMILIES = {
  AGENCY_HTML: 'agency_html',
  PDF_PAGE: 'pdf_page',
  MOCK: 'mock',
  FILE: 'file',
}

/**
 * Smoke-safe sources: known-200 public pages only.
 * Used ONLY by crawler:smoke to guarantee a 100% success run.
 */
export const SMOKE_SAFE_SOURCES = [
  {
    source_id: 'smoke-safe-fed-cms-waivers',
    name: 'HUD Rental Assistance (federal)',
    jurisdiction: 'federal',
    state: null,
    county: null,
    source_family: SOURCE_FAMILIES.AGENCY_HTML,
    base_url: 'https://www.hud.gov',
    seed_urls: ['https://www.hud.gov/topics/rental_assistance'],
    enabled: 1,
    tags: ['smoke_safe'],
    configuration: {
      track_hints: ['TRACK_A'],
      agency: 'U.S. Department of Housing and Urban Development (HUD)',
    },
  },
  {
    source_id: 'smoke-safe-fed-cms-provider-enrollment',
    name: 'CMS Provider Enrollment and Certification (federal provider support)',
    jurisdiction: 'federal',
    state: null,
    county: null,
    source_family: SOURCE_FAMILIES.AGENCY_HTML,
    base_url: 'https://www.cms.gov',
    seed_urls: ['https://www.cms.gov/medicare/provider-enrollment-and-certification'],
    enabled: 1,
    tags: ['smoke_safe'],
    configuration: {
      track_hints: ['TRACK_B'],
      agency: 'Centers for Medicare & Medicaid Services (CMS)',
    },
  },
  {
    source_id: 'smoke-safe-state-tn-tenncare',
    name: 'TennCare (TN Medicaid overview)',
    jurisdiction: 'state',
    state: 'TN',
    county: null,
    source_family: SOURCE_FAMILIES.AGENCY_HTML,
    base_url: 'https://www.tn.gov',
    seed_urls: ['https://www.tn.gov/tenncare.html'],
    enabled: 1,
    tags: ['smoke_safe'],
    configuration: {
      track_hints: ['TRACK_A'],
      agency: 'TennCare',
    },
  },
  {
    source_id: 'smoke-safe-county-nyc-rental-assistance',
    name: 'NYC Rental Assistance (municipal/county example)',
    jurisdiction: 'county',
    state: 'NY',
    county: 'New York City',
    source_family: SOURCE_FAMILIES.AGENCY_HTML,
    base_url: 'https://www.nyc.gov',
    seed_urls: ['https://www.nyc.gov/site/hra/help/rental-assistance.page'],
    enabled: 1,
    tags: ['smoke_safe'],
    configuration: {
      track_hints: ['TRACK_A'],
      agency: 'NYC Human Resources Administration',
    },
  },
  {
    source_id: 'smoke-safe-tribal-cherokee-housing-authority',
    name: 'Cherokee Nation Housing Authority (tribal example)',
    jurisdiction: 'tribal',
    state: 'OK',
    county: null,
    source_family: SOURCE_FAMILIES.AGENCY_HTML,
    base_url: 'https://www.cherokee.org',
    seed_urls: ['https://www.cherokee.org/all-services/housing-authority/'],
    enabled: 1,
    tags: ['smoke_safe'],
    configuration: {
      track_hints: ['TRACK_A'],
      agency: 'Cherokee Nation',
    },
  },
]

export function getSmokeSafeSources() {
  return SMOKE_SAFE_SOURCES.map((s) => ({ ...s }))
}

/**
 * Curated, minimal smoke set.
 * For stability in tests/doctor, these can be file:// fixtures.
 * For live crawling, set CRAWLER_USE_LIVE_SOURCES=true to use https URLs.
 */
export function buildRegistry({ useLive = false, fixtureBaseUrl = null } = {}) {
  const file = (name) => {
    if (!fixtureBaseUrl) throw new Error('fixtureBaseUrl required for file fixtures')
    return `${fixtureBaseUrl}/${name}`
  }

  const fedUrl = useLive ? 'https://www.ssa.gov/benefits/' : file('federal-ssa-benefits.html')
  const stateUrl = useLive ? 'https://www.tn.gov/tenncare/long-term-services-supports/ecf-choices.html' : file('state-tn-ecf-choices.html')
  // NOTE: live URLs should be verified stable; fixtures are used for offline smoke/tests.
  const countyUrl = useLive
    ? 'https://www.nyc.gov/site/hra/help/rental-assistance.page'
    : file('county-king-housing-assistance.html')
  const tribalUrl = useLive
    ? 'https://www.cherokee.org/all-services/housing-authority/'
    : file('tribal-cherokee-health.html')
  const mcoUrl = useLive ? null : 'mock://mco-portal-example'

  return [
    {
      source_id: 'fed-ssa-benefits',
      name: 'SSA Benefits Overview',
      jurisdiction: 'federal',
      state: null,
      county: null,
      source_family: SOURCE_FAMILIES.AGENCY_HTML,
      base_url: useLive ? 'https://www.ssa.gov' : fixtureBaseUrl,
      seed_urls: [fedUrl],
      enabled: 1,
      tags: ['smoke', 'national'],
      configuration: {
        track_hints: ['TRACK_A'],
        agency: 'Social Security Administration',
      },
    },
    {
      source_id: 'state-tn-ecf-choices',
      name: 'TennCare ECF CHOICES',
      jurisdiction: 'state',
      state: 'TN',
      county: null,
      source_family: SOURCE_FAMILIES.AGENCY_HTML,
      base_url: useLive ? 'https://www.tn.gov' : fixtureBaseUrl,
      seed_urls: [stateUrl],
      enabled: 1,
      tags: ['smoke', 'state', 'national'],
      configuration: {
        track_hints: ['TRACK_A', 'TRACK_B'],
        agency: 'TennCare / Tennessee Department of Human Services',
      },
    },
    {
      source_id: 'county-king-housing-assistance',
      name: 'Municipal/County Housing Assistance (NYC HRA - example)',
      jurisdiction: 'county',
      state: useLive ? 'NY' : 'WA',
      county: useLive ? 'New York City' : 'King',
      source_family: SOURCE_FAMILIES.AGENCY_HTML,
      base_url: useLive ? 'https://www.nyc.gov' : fixtureBaseUrl,
      seed_urls: [countyUrl],
      enabled: 1,
      tags: ['smoke', 'county', 'national'],
      configuration: {
        track_hints: ['TRACK_A'],
        agency: useLive ? 'NYC Human Resources Administration' : 'King County',
      },
    },
    {
      source_id: 'tribal-cherokee-health',
      name: 'Cherokee Nation Housing Authority (example tribal)',
      jurisdiction: 'tribal',
      state: 'OK',
      county: null,
      source_family: SOURCE_FAMILIES.AGENCY_HTML,
      base_url: useLive ? 'https://www.cherokee.org' : fixtureBaseUrl,
      seed_urls: [tribalUrl],
      enabled: 1,
      tags: ['smoke', 'tribal', 'national'],
      configuration: {
        track_hints: ['TRACK_A'],
        agency: 'Cherokee Nation',
      },
    },
    {
      source_id: 'mco-mock-portal',
      name: 'MCO Contractor Portal (mock)',
      jurisdiction: 'mco',
      state: null,
      county: null,
      source_family: SOURCE_FAMILIES.MOCK,
      base_url: null,
      seed_urls: mcoUrl ? [mcoUrl] : [],
      enabled: mcoUrl ? 1 : 0,
      tags: ['smoke', 'mco', 'national'],
      configuration: {
        track_hints: ['TRACK_B'],
        agency: 'Example MCO',
        mock_payload: {
          program_name: 'Provider Workforce Retention Stipend',
          program_type: 'grant',
          eligible_population: ['Direct support professionals', 'Provider agencies'],
          covered_services: ['Workforce retention', 'Training reimbursement'],
          provider_requirements: { notes: 'Must be an enrolled provider' },
          application_method: 'Online portal',
          application_url: 'mock://mco-portal-example/apply',
          source_url: 'mock://mco-portal-example',
        },
      },
    },
  ]
}

