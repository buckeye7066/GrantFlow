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
  const countyUrl = useLive ? 'https://www.kingcounty.gov/en/dept/dchs/housing-services/housing-assistance' : file('county-king-housing-assistance.html')
  const tribalUrl = useLive ? 'https://www.cherokee.org/all-services/health/' : file('tribal-cherokee-health.html')
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
      name: 'King County Housing Assistance (example municipal/county)',
      jurisdiction: 'county',
      state: 'WA',
      county: 'King',
      source_family: SOURCE_FAMILIES.AGENCY_HTML,
      base_url: useLive ? 'https://www.kingcounty.gov' : fixtureBaseUrl,
      seed_urls: [countyUrl],
      enabled: 1,
      tags: ['smoke', 'county', 'national'],
      configuration: {
        track_hints: ['TRACK_A'],
        agency: 'King County',
      },
    },
    {
      source_id: 'tribal-cherokee-health',
      name: 'Cherokee Nation Health Services (example tribal)',
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

