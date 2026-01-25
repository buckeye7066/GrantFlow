import { requestJson } from './httpClient.js'
import { loadFundingApiKeys } from '../config/apiKeys.js'
import { toTrimmedStringOrNull } from './types.js'

// SAM.gov Entity Management API docs:
// https://open.gsa.gov/api/entity-api/
//
// NOTE:
// The exact entity API path/shape can vary by API version. This client is intentionally
// narrow and safe: it provides a canonical request wrapper + key handling and can be
// extended as we adopt more endpoints.
//
// We use the commonly documented base host `api.sam.gov/entity-information` and pass the
// public key as `api_key` query param (consistent with other SAM public APIs).
const SAM_ENTITY_SEARCH_URL = 'https://api.sam.gov/entity-information/v4/entities'

/**
 * Search entities by UEI (Unique Entity Identifier).
 *
 * Auth: `api_key` query parameter (Public API Key).
 *
 * @param {Object} query
 * @param {string} query.uei
 * @param {number=} query.limit
 * @param {number=} query.offset
 * @returns {Promise<{ entities: any[], raw: any }>}
 */
export async function searchEntitiesByUei({ uei, limit = 1, offset = 0 } = {}) {
  const { SAM_GOV_PUBLIC_API_KEY } = loadFundingApiKeys()
  if (!SAM_GOV_PUBLIC_API_KEY) {
    const err = new Error('Missing SAM_GOV_PUBLIC_API_KEY (required for SAM.gov entity API).')
    err.code = 'MISSING_API_KEY'
    throw err
  }

  const normalized = toTrimmedStringOrNull(uei)
  if (!normalized) {
    const err = new Error('uei is required')
    err.status = 400
    throw err
  }

  const params = {
    api_key: SAM_GOV_PUBLIC_API_KEY,
    ueiSAM: normalized,
    limit: String(limit),
    offset: String(offset),
  }

  /** @type {any} */
  const raw = await requestJson({
    provider: 'sam.gov.entity',
    url: SAM_ENTITY_SEARCH_URL,
    method: 'GET',
    params,
    timeoutMs: 25_000,
    maxRetries: 3,
  })

  // Response shapes vary; normalize the most common "entityData"/"entities" container.
  const entities =
    (Array.isArray(raw?.entityData) && raw.entityData) ||
    (Array.isArray(raw?.entities) && raw.entities) ||
    []

  return { entities, raw }
}

