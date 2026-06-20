import { getFundingApiKeyPresence } from './apiKeys.js'

/**
 * Canonical registry of official funding data providers (integration-ready).
 * Powers the admin "configured vs missing" status AND the in-app setup guide
 * (signup links + steps + caveats) without ever returning secret values.
 *
 * Long-form setup guide: docs/API_KEYS_ONBOARDING.md
 */

export const FUNDING_SOURCES = Object.freeze([
  {
    id: 'grants.gov',
    name: 'Grants.gov REST APIs (grantsws)',
    docs_url: 'https://www.grants.gov/api/api-guide',
    env_vars: ['GRANTS_GOV_API_KEY'],
    key_required: false,
    ingests: true,
    setup: {
      required: false,
      self_service: true,
      est_minutes: 0,
      signup_url: 'https://www.grants.gov/api',
      steps: [
        'No key needed — search2 works without one.',
        'Optional: request an X-API-Key via the Help Desk (https://www.grants.gov/support) for rate priority.',
      ],
      caveats: null,
    },
  },
  {
    id: 'nih.reporter',
    name: 'NIH RePORTER API',
    docs_url: 'https://api.reporter.nih.gov/',
    env_vars: [],
    key_required: false,
    ingests: true,
    setup: {
      required: false,
      self_service: true,
      est_minutes: 0,
      signup_url: 'https://api.reporter.nih.gov/',
      steps: ['No key required — public API. Ingests research awards automatically.'],
      caveats: 'Returns historical funded awards, not open solicitations.',
    },
  },
  {
    id: 'propublica.990',
    name: 'ProPublica Nonprofit Explorer (990 / foundations)',
    docs_url: 'https://projects.propublica.org/nonprofits/api/',
    env_vars: [],
    key_required: false,
    ingests: true,
    setup: {
      required: false,
      self_service: true,
      est_minutes: 0,
      signup_url: 'https://projects.propublica.org/nonprofits/api/',
      steps: ['No key required — public API. Surfaces real 501(c)(3) grantmakers.'],
      caveats: null,
    },
  },
  {
    id: 'nsf.awards',
    name: 'NSF Awards API (National Science Foundation)',
    docs_url: 'https://resources.research.gov/common/webapi/awardapisearch-v1.htm',
    env_vars: [],
    key_required: false,
    ingests: true,
    setup: {
      required: false,
      self_service: true,
      est_minutes: 0,
      signup_url: 'https://api.nsf.gov/',
      steps: ['No key required — public API. Surfaces NSF science/engineering/education funding for research profiles.'],
      caveats: 'Returns funded awards (historical), not open solicitations.',
    },
  },
  {
    id: 'federal.register',
    name: 'Federal Register API (cross-agency NOFOs)',
    docs_url: 'https://www.federalregister.gov/developers/documentation/api/v1',
    env_vars: [],
    key_required: false,
    ingests: true,
    setup: {
      required: false,
      self_service: true,
      est_minutes: 0,
      signup_url: 'https://www.federalregister.gov/developers/documentation/api/v1',
      steps: ['No key required — public API. Surfaces real Notices of Funding Opportunity across all federal agencies (hard-filtered to funding notices).'],
      caveats: 'Only ingested for organization/government profiles, not individuals.',
    },
  },
  {
    id: 'usaspending.gov',
    name: 'USASpending.gov Awards API',
    docs_url: 'https://api.usaspending.gov/docs/',
    env_vars: [],
    key_required: false,
    ingests: true,
    setup: {
      required: false,
      self_service: true,
      est_minutes: 0,
      signup_url: 'https://api.usaspending.gov/',
      steps: ['No key required — public API. Surfaces real federal grant awards (who funds what) as funder leads.'],
      caveats: 'Returns historical awards, not open solicitations — used for funder discovery.',
    },
  },
  {
    id: 'state.portals',
    name: 'State Grant Portals (public)',
    docs_url: 'https://www.usa.gov/state-government',
    env_vars: [],
    key_required: false,
    ingests: true,
    setup: {
      required: false,
      self_service: true,
      est_minutes: 0,
      signup_url: 'https://www.usa.gov/state-government',
      steps: ['No key required — public state portals. Coverage expands by state over time.'],
      caveats: 'Per-state availability varies; not every state exposes a machine-readable feed.',
    },
  },
  {
    id: 'simpler.grants.gov',
    name: 'Simpler.Grants.gov API',
    docs_url: 'https://wiki.simpler.grants.gov/product/api',
    env_vars: ['SIMPLER_GRANTS_API_KEY'],
    key_required: true,
    ingests: true,
    setup: {
      required: true,
      self_service: true,
      est_minutes: 5,
      signup_url: 'https://simpler.grants.gov/developers',
      steps: [
        'Open https://simpler.grants.gov/developers and Sign in with Login.gov.',
        'Open "Manage API Keys" → Create API key (e.g. grantflow-prod).',
        'Set SIMPLER_GRANTS_API_KEY in local .env and Railway.',
      ],
      caveats: null,
    },
  },
  {
    id: 'sam.gov.opportunities',
    name: 'SAM.gov Assistance Listings + Opportunities Public API',
    docs_url: 'https://open.gsa.gov/api/assistance-listings-api/',
    env_vars: ['SAM_GOV_PUBLIC_API_KEY'],
    key_required: true,
    ingests: true,
    setup: {
      required: false,
      self_service: false,
      est_minutes: 20,
      signup_url: 'https://sam.gov/profile/details',
      steps: [
        'Sign in to https://sam.gov/ (Login.gov identity verification).',
        'Go to https://sam.gov/profile/details → reveal "Public API Key" (one-time password to your email).',
        'Set SAM_GOV_PUBLIC_API_KEY in local .env and Railway.',
      ],
      caveats:
        'Identity-bound — cannot be automated. Personal keys without a SAM entity role are throttled to 10 requests/day and expire every 90 days. api.data.gov keys do NOT work here.',
    },
  },
  {
    id: 'sam.gov.entity',
    name: 'SAM.gov Entity Management API',
    docs_url: 'https://open.gsa.gov/api/entity-api/',
    env_vars: ['SAM_GOV_PUBLIC_API_KEY'],
    key_required: true,
    ingests: false,
    setup: {
      required: false,
      self_service: false,
      est_minutes: 0,
      signup_url: 'https://sam.gov/profile/details',
      steps: ['Uses the same SAM_GOV_PUBLIC_API_KEY as SAM.gov opportunities (see above).'],
      caveats: 'Used for entity enrichment, not opportunity ingest.',
    },
  },
  {
    id: 'api.data.gov',
    name: 'api.data.gov (shared GSA key)',
    docs_url: 'https://api.data.gov/docs/developer-manual/',
    env_vars: ['API_DATA_GOV_KEY'],
    key_required: true,
    ingests: false,
    setup: {
      required: false,
      self_service: true,
      est_minutes: 2,
      signup_url: 'https://api.data.gov/signup/',
      steps: [
        'Sign up at https://api.data.gov/signup/ (name + email; key emailed instantly).',
        'Set API_DATA_GOV_KEY.',
      ],
      caveats: 'Enrichment only — does NOT authenticate SAM.gov APIs.',
    },
  },
])

/**
 * Summarize configuration status for the Admin UI.
 * Never returns secret values — presence + setup guidance only.
 */
export function getFundingSourceStatus() {
  const presence = getFundingApiKeyPresence()

  return FUNDING_SOURCES.map((src) => {
    const envConfigured =
      src.key_required === false
        ? true
        : (src.env_vars || []).length === 0
          ? true
          : (src.env_vars || []).every((name) => Boolean(presence[name]))

    return {
      ...src,
      configured: envConfigured,
      env_presence: Object.fromEntries((src.env_vars || []).map((k) => [k, Boolean(presence[k])])),
    }
  })
}
