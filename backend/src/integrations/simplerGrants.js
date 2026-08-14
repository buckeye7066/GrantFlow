import { requestJson } from './httpClient.js'
import { loadFundingApiKeys } from '../config/apiKeys.js'
import { toNumberOrNull, toTrimmedStringOrNull } from './types.js'

const SIMPLER_SEARCH_URL = 'https://api.simpler.grants.gov/v1/opportunities/search'
const SIMPLER_OPPORTUNITY_URL = 'https://simpler.grants.gov/opportunity/'

/**
 * Simpler.Grants.gov opportunity search.
 *
 * Auth: `X-API-Key: <key>`
 * Ref:  https://github.com/HHS/simpler-grants-gov  (api/openapi.generated.yml)
 *
 * @param {Object=} query
 * @param {string=} query.query - free-text query string (1-100 chars)
 * @param {'AND'|'OR'=} query.queryOperator - boolean operator for multi-word queries
 * @param {number=} query.pageOffset - 1-based page offset per Simpler docs
 * @param {number=} query.pageSize
 * @param {Object=} query.filters - per HHS/simpler-grants-gov search schema
 * @param {Object=} query.filters.opportunity_status - {one_of: ['posted','forecasted']}
 * @param {Object=} query.filters.funding_instrument - {one_of: [...]}
 * @param {Object=} query.filters.funding_category - {one_of: [...]}
 * @param {Object=} query.filters.applicant_type - {one_of: [...]}
 * @param {Object=} query.filters.agency - {one_of: [...]}
 * @param {Object=} query.filters.is_cost_sharing - {one_of: [true/false]}
 * @param {Object=} query.filters.award_floor - {min, max}
 * @param {Object=} query.filters.award_ceiling - {min, max}
 * @param {Object=} query.filters.estimated_total_program_funding - {min, max}
 * @param {Object=} query.filters.post_date - {start_date, end_date}
 * @param {Object=} query.filters.close_date - {start_date, end_date}
 * @param {Object=} query.filters.assistance_listing_number - {one_of: [...]}
 * @param {Object=} query.filters.top_level_agency - {one_of: [...]}
 * @param {string=} query.sortBy - sort field (default: 'post_date')
 * @param {string=} query.sortDirection - 'ascending' | 'descending' (default: 'descending')
 * @returns {Promise<{opportunities: Array<import('./types.js').FundingOpportunity>, pagination: Object}>}
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

  const {
    query: q = '',
    queryOperator,
    pageOffset = 1,
    pageSize = 25,
    filters = {},
    sortBy = 'post_date',
    sortDirection = 'descending',
  } = query

  const body = {
    pagination: {
      page_offset: pageOffset,
      page_size: pageSize,
      sort_order: [{ order_by: sortBy, sort_direction: sortDirection }],
    },
    ...(q ? { query: q } : {}),
    ...(queryOperator ? { query_operator: queryOperator } : {}),
  }

  // Attach only non-empty filter objects
  const filterEntries = Object.entries(filters).filter(
    ([, v]) => (v !== null && v !== undefined) && Object.keys(v).length > 0,
  )
  if (filterEntries.length > 0) {
    body.filters = Object.fromEntries(filterEntries)
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

  const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data?.opportunities) ? data.opportunities : []
  const opportunities = rows.map((row) => normalizeSimplerOpportunity(row))

  return {
    opportunities,
    pagination: data?.pagination_info || data?.pagination || null,
  }
}

/**
 * Normalize a Simpler.Grants.gov opportunity row.
 *
 * HHS response nests most fields under `summary`:
 *   { opportunity_id, opportunity_title, agency_name, agency_code,
 *     top_level_agency_name, opportunity_status, category, summary: { ... } }
 */
function normalizeSimplerOpportunity(row) {
  const summary = row?.summary || {}

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
    toTrimmedStringOrNull(row?.top_level_agency_name) ||
    toTrimmedStringOrNull(row?.agency) ||
    null

  // Close date lives under summary per HHS schema
  const closeDate =
    toTrimmedStringOrNull(summary?.close_date) ||
    toTrimmedStringOrNull(row?.close_date) ||
    toTrimmedStringOrNull(row?.closeDate) ||
    null

  // Award amounts are nested under summary
  const awardFloor =
    toNumberOrNull(summary?.award_floor) ??
    toNumberOrNull(row?.award_floor) ??
    toNumberOrNull(row?.amount_min)
  const awardCeiling =
    toNumberOrNull(summary?.award_ceiling) ??
    toNumberOrNull(row?.award_ceiling) ??
    toNumberOrNull(row?.amount_max)

  const description =
    toTrimmedStringOrNull(summary?.summary_description) ||
    toTrimmedStringOrNull(row?.synopsis) ||
    toTrimmedStringOrNull(row?.summary?.summary_description) ||
    null

  // Categories from summary arrays
  const fundingCategories = Array.isArray(summary?.funding_categories)
    ? summary.funding_categories
    : []
  const category =
    toTrimmedStringOrNull(row?.category) ||
    toTrimmedStringOrNull(fundingCategories[0]) ||
    null
  const categories = [
    ...new Set([category, ...fundingCategories, 'federal', 'government'].filter(Boolean)),
  ]

  // Eligibility from applicant_types + description
  const applicantTypes = Array.isArray(summary?.applicant_types) ? summary.applicant_types : []
  const eligibilityDesc = toTrimmedStringOrNull(summary?.applicant_eligibility_description)
  const eligibilityBullets = [
    ...applicantTypes.map((t) => String(t).replace(/_/g, ' ')),
    ...(eligibilityDesc ? [eligibilityDesc] : []),
  ]

  // Funding instruments
  const fundingInstruments = Array.isArray(summary?.funding_instruments)
    ? summary.funding_instruments
    : []

  const additionalUrl = toTrimmedStringOrNull(summary?.additional_info_url)
  const isForecast = summary?.is_forecast === true
  const postDate = toTrimmedStringOrNull(summary?.post_date) || toTrimmedStringOrNull(row?.post_date)

  /** @type {import('./types.js').FundingOpportunity} */
  return {
    title,
    sponsor: agency,
    source: 'simpler.grants.gov',
    source_id: opportunityId,
    source_url: opportunityId !== 'unknown' ? `${SIMPLER_OPPORTUNITY_URL}${opportunityId}` : null,
    application_url: additionalUrl || (opportunityId !== 'unknown' ? `${SIMPLER_OPPORTUNITY_URL}${opportunityId}` : null),
    description,
    amount_min: awardFloor,
    amount_max: awardCeiling,
    // NOT `funding_category_description` (2026-08-14). That field is HHS's
    // free-text note about the funding CATEGORY (the "Other" category blurb),
    // not an award figure — but `amount_description` is an AMOUNT channel:
    // `resolveOpportunityAmounts` runs the award extractor over
    // `title + amount_description + description`, and when nothing else is
    // found it promotes a short `amount_description` straight into the row's
    // displayed `amount_text` and can flip `amount_status` to
    // `varies`/`contact_required` on words inside it. So a category blob
    // mentioning a program total became this row's per-award answer — and it
    // bit hardest exactly when the API published NO award_floor/award_ceiling,
    // i.e. the case where a fabricated amount most damages the amount-answer
    // census. The category text already reaches the row through
    // `funding_categories` -> `categories` below, where it belongs. This API
    // publishes no per-award prose field, so the honest value is null.
    amount_description: null,
    deadline: closeDate,
    // Canonical deadline_type set is fixed|rolling|ongoing|unknown (DB CHECK
    // constraint). A forecasted opportunity has no firm deadline yet, so it
    // maps to 'unknown' — the forecast signal is preserved in keywords below.
    // (Previously emitted 'forecasted', which violated the constraint and made
    // every forecasted record get skipped on insert.)
    deadline_type: isForecast ? 'unknown' : closeDate ? 'fixed' : null,
    is_national: true,
    state: 'nationwide',
    categories,
    keywords: [
      'simpler.grants.gov', 'grants.gov', 'federal', 'grant',
      ...(isForecast ? ['forecasted'] : []),
      ...fundingInstruments.map((fi) => String(fi).replace(/_/g, ' ')),
    ].filter(Boolean),
    eligibility_bullets: eligibilityBullets,
    opportunity_type: fundingInstruments.includes('grant') ? 'grant' : fundingInstruments[0] || 'grant',
    type: 'OPPORTUNITY',
    last_verified_at: null,
    record_origin: 'funding_api',
    requires_501c3: false,
    requires_match: summary?.is_cost_sharing === true,
    // Extended fields (available for downstream enrichment)
    _extended: {
      opportunity_number: toTrimmedStringOrNull(row?.opportunity_number),
      opportunity_status: toTrimmedStringOrNull(row?.opportunity_status),
      legacy_opportunity_id: row?.legacy_opportunity_id ?? null,
      agency_code: toTrimmedStringOrNull(row?.agency_code),
      top_level_agency_name: toTrimmedStringOrNull(row?.top_level_agency_name),
      post_date: postDate,
      archive_date: toTrimmedStringOrNull(summary?.archive_date),
      estimated_total_program_funding: toNumberOrNull(summary?.estimated_total_program_funding),
      expected_number_of_awards: toNumberOrNull(summary?.expected_number_of_awards),
      is_forecast: isForecast,
      is_cost_sharing: summary?.is_cost_sharing ?? null,
      agency_email: toTrimmedStringOrNull(summary?.agency_email_address),
      agency_contact: toTrimmedStringOrNull(summary?.agency_contact_description),
      close_date_description: toTrimmedStringOrNull(summary?.close_date_description),
      fiscal_year: summary?.fiscal_year ?? null,
      applicant_types: applicantTypes,
      funding_instruments: fundingInstruments,
      funding_categories: fundingCategories,
    },
  }
}

