import { requestJson } from './httpClient.js'
import { loadFundingApiKeys } from '../config/apiKeys.js'
import { toTrimmedStringOrNull } from './types.js'

const SAM_OPPORTUNITIES_SEARCH_URL = 'https://api.sam.gov/opportunities/v2/search'

function pad2(n) {
  return String(n).padStart(2, '0')
}

/**
 * SAM.gov Opportunities API requires postedFrom/postedTo as MM/dd/yyyy.
 * @param {Date} d
 */
function formatSamDate(d) {
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${d.getFullYear()}`
}

function daysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d
}

/**
 * SAM.gov Get Opportunities Public API: search opportunities.
 *
 * Auth: `api_key` query parameter (Public API Key).
 *
 * @param {Object=} query
 * @param {string=} query.keyword
 * @param {string=} query.postedFrom - MM/dd/yyyy (default: 30 days ago)
 * @param {string=} query.postedTo - MM/dd/yyyy (default: today)
 * @param {number=} query.limit
 * @param {number=} query.offset
 * @param {string=} query.ptype - defaults to 'o' (solicitation)
 * @returns {Promise<Array<import('./types.js').FundingOpportunity>>}
 */
export async function fetchOpportunities(query = {}) {
  const { SAM_GOV_PUBLIC_API_KEY } = loadFundingApiKeys()
  if (!SAM_GOV_PUBLIC_API_KEY) {
    const err = new Error('Missing SAM_GOV_PUBLIC_API_KEY (required for SAM.gov opportunities API).')
    err.code = 'MISSING_API_KEY'
    throw err
  }

  const {
    keyword = '',
    postedFrom = formatSamDate(daysAgo(30)),
    postedTo = formatSamDate(new Date()),
    limit = 25,
    offset = 0,
    ptype = 'o',
  } = query

  const params = {
    api_key: SAM_GOV_PUBLIC_API_KEY,
    postedFrom,
    postedTo,
    limit: String(limit),
    offset: String(offset),
    ptype,
  }

  if (keyword) params.keyword = keyword

  /** @type {any} */
  const data = await requestJson({
    provider: 'sam.gov',
    url: SAM_OPPORTUNITIES_SEARCH_URL,
    method: 'GET',
    params,
    timeoutMs: 25_000,
    maxRetries: 3,
  })

  const rows = Array.isArray(data?.opportunitiesData) ? data.opportunitiesData : []
  return rows.map((row) => normalizeSamOpportunity(row))
}

function normalizeSamOpportunity(row) {
  const noticeId =
    toTrimmedStringOrNull(row?.noticeId) ||
    toTrimmedStringOrNull(row?.notice_id) ||
    toTrimmedStringOrNull(row?.solicitationNumber) ||
    'unknown'

  const title = toTrimmedStringOrNull(row?.title) || 'SAM.gov Opportunity'
  const dept = toTrimmedStringOrNull(row?.deptName) || toTrimmedStringOrNull(row?.department) || null
  const subTier = toTrimmedStringOrNull(row?.subTier) || toTrimmedStringOrNull(row?.subTierName) || null
  const sponsor = dept || subTier

  const url =
    toTrimmedStringOrNull(row?.uiLink) ||
    toTrimmedStringOrNull(row?.link) ||
    (noticeId !== 'unknown'
      ? `https://sam.gov/opp/${encodeURIComponent(noticeId)}/view`
      : null)

  const postedDate = toTrimmedStringOrNull(row?.postedDate) || null
  const responseDeadLine = toTrimmedStringOrNull(row?.responseDeadLine) || toTrimmedStringOrNull(row?.responseDeadline) || null

  /** @type {import('./types.js').FundingOpportunity} */
  return {
    title,
    sponsor,
    source: 'sam.gov',
    source_id: noticeId,
    source_url: url,
    application_url: url,
    description: toTrimmedStringOrNull(row?.description) || null,
    amount_min: null,
    amount_max: null,
    amount_description: null,
    deadline: responseDeadLine,
    deadline_type: responseDeadLine ? 'fixed' : null,
    is_national: true,
    state: 'nationwide',
    categories: ['federal', 'government', 'procurement'],
    keywords: [
      'sam.gov',
      'procurement',
      toTrimmedStringOrNull(row?.type)?.toLowerCase(),
      toTrimmedStringOrNull(row?.naicsCode),
    ].filter(Boolean),
    eligibility_bullets: postedDate ? [`Posted: ${postedDate}`] : [],
    opportunity_type: 'contract',
    type: 'OPPORTUNITY',
    last_verified_at: null,
    record_origin: 'funding_api',
    requires_501c3: false,
    requires_match: false,
  }
}

