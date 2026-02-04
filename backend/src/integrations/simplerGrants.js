import { requestJson } from './httpClient.js'
import { loadFundingApiKeys } from '../config/apiKeys.js'
import { toNumberOrNull, toTrimmedStringOrNull } from './types.js'

const SIMPLER_SEARCH_URL = 'https://api.simpler.grants.gov/v1/opportunities/search'
const SIMPLER_OPPORTUNITY_URL = 'https://simpler.grants.gov/opportunity/'

/**
 * Simpler.Grants.gov opportunity search.
 *
 * Auth: `X-API-Key: <key>`
 *
 * @param {Object=} query
 * @param {string=} query.query - free-text query string
 * @param {number=} query.pageOffset - 1-based page offset per Simpler docs
 * @param {number=} query.pageSize
 * @returns {Promise<Array<import('./types.js').FundingOpportunity>>}
 */
export async function fetchOpportunities(query = {}) {
  const { SIMPLER_GRANTS_API_KEY } = loadFundingApiKeys()
  if (!SIMPLER_GRANTS_API_KEY) {
    const err = new Error(
      'Missing SIMPLER_GRANTS_API_KEY (required for Simpler.Grants.gov API).',
    )
    err.code = 'MISSING_API_KEY'
    throw err
  }

  const { query: q = '', pageOffset = 1, pageSize = 25 } = query

  const body = {
    pagination: {
      page_offset: pageOffset,
      page_size: pageSize,
      sort_order: [{ order_by: 'post_date', sort_direction: 'descending' }],
    },
    ...(q ? { query: q } : {}),
  }

  /** @type {any} */
  const data = await requestJson({
    provider: 'simpler.grants.gov',
    url: SIMPLER_SEARCH_URL,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': SIMPLER_GRANTS_API_KEY,
    },
    data: body,
    timeoutMs: 25_000,
    maxRetries: 3,
  })

  const rows = Array.isArray(data?.opportunities) ? data.opportunities : []
  return rows.map((row) => normalizeSimplerOpportunity(row))
}

function normalizeSimplerOpportunity(row) {
  const opportunityId =
    toTrimmedStringOrNull(row?.opportunity_id) ||
    toTrimmedStringOrNull(row?.opportunityId) ||
    toTrimmedStringOrNull(row?.id) ||
    'unknown'

  const title =
    toTrimmedStringOrNull(row?.opportunity_title) ||
    toTrimmedStringOrNull(row?.title) ||
    'Grant Opportunity'

  const agency =
    toTrimmedStringOrNull(row?.agency_name) ||
    toTrimmedStringOrNull(row?.agency) ||
    null

  const closeDate =
    toTrimmedStringOrNull(row?.close_date) ||
    toTrimmedStringOrNull(row?.closeDate) ||
    null

  const awardFloor = toNumberOrNull(row?.amount_min) ?? toNumberOrNull(row?.awardFloor)
  const awardCeiling = toNumberOrNull(row?.amount_max) ?? toNumberOrNull(row?.awardCeiling)

  const synopsis = toTrimmedStringOrNull(row?.synopsis) || toTrimmedStringOrNull(row?.summary)
  const category = toTrimmedStringOrNull(row?.funding_category) || toTrimmedStringOrNull(row?.category)

  /** @type {import('./types.js').FundingOpportunity} */
  return {
    title,
    sponsor: agency,
    source: 'simpler.grants.gov',
    source_id: opportunityId,
    source_url: opportunityId !== 'unknown' ? `${SIMPLER_OPPORTUNITY_URL}${opportunityId}` : null,
    application_url: opportunityId !== 'unknown' ? `${SIMPLER_OPPORTUNITY_URL}${opportunityId}` : null,
    description: synopsis || null,
    amount_min: awardFloor,
    amount_max: awardCeiling,
    amount_description: null,
    deadline: closeDate,
    deadline_type: closeDate ? 'fixed' : null,
    is_national: true,
    state: 'nationwide',
    categories: [category, 'federal', 'government'].filter(Boolean),
    keywords: ['simpler.grants.gov', 'grants.gov', 'federal', 'grant'].filter(Boolean),
    eligibility_bullets: [],
    opportunity_type: 'grant',
    type: 'OPPORTUNITY',
    last_verified_at: null,
    record_origin: 'funding_api',
    requires_501c3: false,
    requires_match: false,
  }
}

