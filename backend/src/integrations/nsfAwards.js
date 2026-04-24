/**
 * NSF Awards API Integration (National Science Foundation)
 *
 * Free, public API — no key required.
 * Docs: https://resources.research.gov/common/webapi/awardapisearch-v1.htm
 * Endpoint: https://api.nsf.gov/services/v1/awards.json
 *
 * Returns funded awards — useful as PROGRAM/DIRECTORY items and for
 * understanding what NSF funds in specific areas.
 */

import { requestJson } from './httpClient.js'
import { toTrimmedStringOrNull, toNumberOrNull } from './types.js'

const NSF_AWARDS_URL = 'https://api.nsf.gov/services/v1/awards.json'

/**
 * Search NSF awards by keyword, agency, date range, etc.
 *
 * @param {Object=} query
 * @param {string=} query.keyword - free text search
 * @param {string=} query.fundProgramName - NSF program name
 * @param {string=} query.awardeeStateCode - 2-letter state code
 * @param {string=} query.dateStart - MM/dd/yyyy
 * @param {string=} query.dateEnd - MM/dd/yyyy
 * @param {number=} query.offset - pagination offset (default 1)
 * @param {number=} query.limit - results per page (max 25)
 * @returns {Promise<Array<import('./types.js').FundingOpportunity>>}
 */
export async function fetchOpportunities(query = {}) {
  const {
    keyword = '',
    fundProgramName,
    awardeeStateCode,
    dateStart,
    dateEnd,
    offset = 1,
    limit = 25,
  } = query

  const params = {
    keyword: keyword || undefined,
    fundProgramName: fundProgramName || undefined,
    awardeeStateCode: awardeeStateCode || undefined,
    dateStart: dateStart || undefined,
    dateEnd: dateEnd || undefined,
    offset,
    printFields: [
      'id', 'title', 'agency', 'fundProgramName', 'abstractText',
      'piFirstName', 'piLastName', 'piEmail',
      'awardeeName', 'awardeeStateCode', 'awardeeCity',
      'startDate', 'expDate', 'estimatedTotalAmt',
      'fundsObligatedAmt', 'primaryProgram',
    ].join(','),
  }

  // Clean undefined params
  Object.keys(params).forEach(k => params[k] === undefined && delete params[k])

  const data = await requestJson({
    provider: 'nsf.awards',
    url: NSF_AWARDS_URL,
    method: 'GET',
    params,
    timeoutMs: 25_000,
    maxRetries: 3,
  })

  const response = data?.response ?? data
  const rows = Array.isArray(response?.award) ? response.award : []
  return rows.map(normalizeNsfAward)
}

function normalizeNsfAward(row) {
  const id = toTrimmedStringOrNull(row?.id)
  const title = toTrimmedStringOrNull(row?.title) || 'NSF Award'
  const agency = toTrimmedStringOrNull(row?.agency) || 'NSF'
  const programName = toTrimmedStringOrNull(row?.fundProgramName)
  const abstract = toTrimmedStringOrNull(row?.abstractText)
  const piFirst = toTrimmedStringOrNull(row?.piFirstName) || ''
  const piLast = toTrimmedStringOrNull(row?.piLastName) || ''
  const piEmail = toTrimmedStringOrNull(row?.piEmail)
  const awardee = toTrimmedStringOrNull(row?.awardeeName)
  const state = toTrimmedStringOrNull(row?.awardeeStateCode)
  const city = toTrimmedStringOrNull(row?.awardeeCity)
  const startDate = toTrimmedStringOrNull(row?.startDate)
  const endDate = toTrimmedStringOrNull(row?.expDate)
  const totalAmt = toNumberOrNull(row?.estimatedTotalAmt)
  const obligatedAmt = toNumberOrNull(row?.fundsObligatedAmt)

  const detailUrl = id
    ? `https://www.nsf.gov/awardsearch/showAward?AWD_ID=${encodeURIComponent(id)}`
    : null

  const pi = [piFirst, piLast].filter(Boolean).join(' ')
  const descParts = []
  if (awardee) descParts.push(`Awardee: ${awardee}`)
  if (pi) descParts.push(`PI: ${pi}`)
  if (abstract) descParts.push(abstract.slice(0, 500))

  /** @type {import('./types.js').FundingOpportunity} */
  return {
    title,
    sponsor: [agency, programName].filter(Boolean).join(' — '),
    source: 'nsf.awards',
    source_id: id || `nsf-${Date.now()}`,
    source_url: detailUrl,
    application_url: null,
    description: descParts.join('\n') || null,
    amount_min: null,
    amount_max: totalAmt ?? obligatedAmt,
    amount_description: (totalAmt !== null && totalAmt !== undefined) ? `Estimated total: $${totalAmt.toLocaleString()}` : null,
    deadline: endDate || null,
    deadline_type: null,
    is_national: true,
    state: state || 'nationwide',
    categories: ['nsf', 'research', 'science', 'education'].filter(Boolean),
    keywords: ['nsf', programName?.toLowerCase(), agency?.toLowerCase()].filter(Boolean),
    eligibility_bullets: [
      startDate ? `Award start: ${startDate}` : null,
      endDate ? `Award end: ${endDate}` : null,
      awardee ? `Awardee: ${awardee}` : null,
      pi ? `PI: ${pi}` : null,
      piEmail ? `Contact: ${piEmail}` : null,
    ].filter(Boolean),
    contact_info: piEmail ? { email: piEmail, name: pi || null } : null,
    opportunity_type: 'award',
    type: 'PROGRAM',
    last_verified_at: null,
    record_origin: 'funding_api',
    requires_501c3: false,
    requires_match: false,
  }
}
