import { getFundingApiKeyPresence } from './apiKeys.js'

/**
 * Canonical registry of official funding data providers (integration-ready).
 * This powers Admin UI "configured vs missing" status without ever returning secret values.
 */

export const FUNDING_SOURCES = Object.freeze([
  {
    id: 'simpler.grants.gov',
    name: 'Simpler.Grants.gov API',
    docs_url: 'https://wiki.simpler.grants.gov/product/api',
    env_vars: ['SIMPLER_GRANTS_API_KEY'],
    key_required: true,
  },
  {
    id: 'sam.gov.opportunities',
    name: 'SAM.gov Get Opportunities Public API',
    docs_url: 'https://open.gsa.gov/api/get-opportunities-public-api/',
    env_vars: ['SAM_GOV_PUBLIC_API_KEY'],
    key_required: true,
  },
  {
    id: 'sam.gov.entity',
    name: 'SAM.gov Entity Management API',
    docs_url: 'https://open.gsa.gov/api/entity-api/',
    env_vars: ['SAM_GOV_PUBLIC_API_KEY'],
    key_required: true,
  },
  {
    id: 'grants.gov',
    name: 'Grants.gov REST APIs (grantsws)',
    docs_url: 'https://www.grants.gov/api/api-guide',
    env_vars: ['GRANTS_GOV_API_KEY'],
    key_required: true,
  },
  {
    id: 'api.data.gov',
    name: 'api.data.gov (GovInfo sample)',
    docs_url: 'https://api.data.gov/docs/developer-manual/',
    env_vars: ['API_DATA_GOV_KEY'],
    key_required: true,
  },
  {
    id: 'nih.reporter',
    name: 'NIH RePORTER API',
    docs_url: 'https://api.reporter.nih.gov/',
    env_vars: [],
    key_required: false,
  },
])

/**
 * Summarize configuration status for Admin UI.
 * Never returns secret values — presence only.
 */
export function getFundingSourceStatus() {
  const presence = getFundingApiKeyPresence()

  return FUNDING_SOURCES.map((src) => {
    const envConfigured =
      (src.env_vars || []).length === 0
        ? true
        : (src.env_vars || []).every((name) => Boolean(presence[name]))

    return {
      ...src,
      configured: envConfigured,
      env_presence: Object.fromEntries((src.env_vars || []).map((k) => [k, Boolean(presence[k])])),
    }
  })
}

