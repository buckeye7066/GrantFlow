import { requestJson } from './httpClient.js'
import { toNumberOrNull, toTrimmedStringOrNull } from './types.js'

// Grants.gov public search2 endpoint (POST JSON, unauthenticated).
const GRANTS_GOV_SEARCH_URL = 'https://api.grants.gov/v1/api/search2'
const GRANTS_GOV_VIEW_URL = 'https://www.grants.gov/search-results-detail/'

/**
 * Grants.gov (grantsws) opportunity search.
 *
 * Notes:
 * - Many endpoints are public; some endpoints require an API key obtained via Help Desk ticket.
 * - When an API key is used for grantsws endpoints, Grants.gov docs commonly show:
 *   `Authorization: APIKEY=<your_api_key>`
 *
 * @param {Object=} query
 * @param {string=} query.keyword
 * @param {string=} query.oppStatuses - posted|forecasted|closed|archived
 * @param {number=} query.rows
 * @param {number=} query.startRecordNum
 * @returns {Promise<Array<import('./types.js').FundingOpportunity>>}
 */
export async function fetchOpportunities(query = {}) {
  const {
    keyword = '',
    oppStatuses = 'posted',
    rows = 25,
    startRecordNum = 0,
  } = query

  const body = {
    keyword,
    oppStatuses,
    rows,
    startRecordNum,
    // Keep optional search2 params blank by default for broad coverage.
    agencies: '',
    fundingCategories: '',
  }

  /** @type {any} */
  const data = await requestJson({
    provider: 'grants.gov',
    url: GRANTS_GOV_SEARCH_URL,
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    data: body,
    timeoutMs: 25_000,
    maxRetries: 3,
  })

  const hitsNode = data?.data?.oppHits ? data.data : data?.data?.data?.oppHits ? data.data.data : data
  const hits = Array.isArray(hitsNode?.oppHits) ? hitsNode.oppHits : []
  return hits.map((opp) => normalizeGrantsGovOpportunity(opp))
}

function normalizeGrantsGovOpportunity(opp) {
  const sourceId =
    // De-dupe by opportunity number when present.
    toTrimmedStringOrNull(opp?.number) ||
    toTrimmedStringOrNull(opp?.oppNum) ||
    toTrimmedStringOrNull(opp?.oppNumber) ||
    toTrimmedStringOrNull(opp?.opportunityNumber) ||
    'unknown'

  const title =
    toTrimmedStringOrNull(opp?.title) ||
    toTrimmedStringOrNull(opp?.opportunityTitle) ||
    'Federal Grant Opportunity'

  const sponsor =
    toTrimmedStringOrNull(opp?.agencyName) ||
    toTrimmedStringOrNull(opp?.agency) ||
    'Federal Agency'

  const closeDate =
    toTrimmedStringOrNull(opp?.closeDate) || toTrimmedStringOrNull(opp?.closingDate)

  const awardFloor = toNumberOrNull(opp?.awardFloor)
  const awardCeiling = toNumberOrNull(opp?.awardCeiling)

  const category = toTrimmedStringOrNull(opp?.categoryOfFunding)
  const opportunityCategory = toTrimmedStringOrNull(opp?.opportunityCategory)
  const cfda = toTrimmedStringOrNull(opp?.cfda)
  const eligibleApplicants = toTrimmedStringOrNull(opp?.eligibleApplicants)
  const costSharing = toTrimmedStringOrNull(opp?.costSharing)
  const agencyCode = toTrimmedStringOrNull(opp?.agencyCode)
  const openDate = toTrimmedStringOrNull(opp?.openDate)
  const oppStatus = toTrimmedStringOrNull(opp?.oppStatus)
  const alnlist = opp?.alnlist

  /** @type {import('./types.js').FundingOpportunity} */
  const normalized = {
    title,
    sponsor,
    source: 'grants.gov',
    source_id: sourceId,
    source_url: sourceId !== 'unknown' ? `${GRANTS_GOV_VIEW_URL}${sourceId}` : null,
    application_url: sourceId !== 'unknown' ? `${GRANTS_GOV_VIEW_URL}${sourceId}` : null,
    description:
      toTrimmedStringOrNull(opp?.synopsis) ||
      toTrimmedStringOrNull(opp?.description) ||
      null,
    amount_min: awardFloor,
    amount_max: awardCeiling,
    amount_description: null,
    deadline: closeDate,
    deadline_type: closeDate ? 'fixed' : null,
    is_national: true,
    state: 'nationwide',
    categories: [category, opportunityCategory, 'federal', 'government'].filter(Boolean),
    keywords: [
      category?.toLowerCase(),
      sponsor?.toLowerCase(),
      opportunityCategory?.toLowerCase(),
      agencyCode?.toLowerCase(),
      oppStatus?.toLowerCase(),
      openDate,
      'grants.gov',
      'federal',
      'grant',
    ].filter(Boolean),
    eligibility_bullets: [
      eligibleApplicants ? `Eligible: ${eligibleApplicants}` : null,
      cfda ? `CFDA: ${cfda}` : null,
      costSharing === 'Yes' ? 'Cost sharing/matching may be required' : null,
      alnlist ? `ALN list: ${Array.isArray(alnlist) ? alnlist.join(', ') : String(alnlist)}` : null,
      'Apply through Grants.gov',
    ].filter(Boolean),
    opportunity_type: 'grant',
    type: 'OPPORTUNITY',
    last_verified_at: null,
    record_origin: 'funding_api',
    requires_501c3: false,
    requires_match: costSharing === 'Yes',
  }

  return normalized
}

