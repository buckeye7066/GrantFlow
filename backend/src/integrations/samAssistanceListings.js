/**
 * SAM.gov Federal Assistance Listings API Integration
 *
 * Provides the full CFDA (Catalog of Federal Domestic Assistance) database —
 * every federal program that provides grants, loans, or other assistance.
 *
 * Endpoint: https://api.sam.gov/assistance-listings/v1/search
 * Requires: SAM_GOV_PUBLIC_API_KEY (same key as SAM opportunities)
 * Docs: https://open.gsa.gov/api/assistance-listings-api/
 */

import { requestJson } from './httpClient.js'
import { toTrimmedStringOrNull, toNumberOrNull } from './types.js'

const SAM_AL_BASE = 'https://api.sam.gov/assistance-listings/v1'

/**
 * Search federal assistance listings (CFDA programs).
 *
 * @param {Object=} query
 * @param {string=} query.keyword - free text search
 * @param {string=} query.assistanceType - grant, loan, insurance, etc.
 * @param {string=} query.applicantType - state, local, nonprofit, individual, etc.
 * @param {number=} query.page - page number (1-based)
 * @param {number=} query.limit - results per page (max 100)
 * @returns {Promise<{ total: number, opportunities: Array<import('./types.js').FundingOpportunity> }>}
 */
export async function fetchAssistanceListings(query = {}) {
  const apiKey = process.env.SAM_GOV_PUBLIC_API_KEY
  if (!apiKey) {
    console.warn('[samAssistanceListings] SAM_GOV_PUBLIC_API_KEY not set — skipping')
    return { total: 0, opportunities: [] }
  }

  const { keyword = '', assistanceType, applicantType, page = 1, limit = 25 } = query

  const params = {
    api_key: apiKey,
    ...(keyword ? { keyword } : {}),
    ...(assistanceType ? { assistanceType } : {}),
    ...(applicantType ? { applicantType } : {}),
    page,
    limit: Math.min(limit, 100),
  }

  const data = await requestJson({
    provider: 'sam.assistance',
    url: `${SAM_AL_BASE}/search`,
    method: 'GET',
    params,
    timeoutMs: 25_000,
    maxRetries: 3,
  })

  // SAM returns { _embedded: { assistanceListings: [...] }, page: { totalElements, ... } }
  const listings = data?._embedded?.assistanceListings ??
    data?.assistanceListings ??
    (Array.isArray(data) ? data : [])
  const total = data?.page?.totalElements ?? listings.length

  return {
    total,
    opportunities: listings.map(normalizeListing),
  }
}

/**
 * Get a single assistance listing by CFDA number.
 *
 * @param {string} cfda - e.g. "10.500"
 * @returns {Promise<import('./types.js').FundingOpportunity|null>}
 */
export async function getAssistanceListing(cfda) {
  const apiKey = process.env.SAM_GOV_PUBLIC_API_KEY
  if (!apiKey) return null

  const data = await requestJson({
    provider: 'sam.assistance',
    url: `${SAM_AL_BASE}/${encodeURIComponent(cfda)}`,
    method: 'GET',
    params: { api_key: apiKey },
    timeoutMs: 15_000,
    maxRetries: 2,
  })

  if (!data) return null
  return normalizeListing(data)
}

function normalizeListing(row) {
  const cfda = toTrimmedStringOrNull(row?.programNumber ?? row?.assistanceListingNumber)
  const title = toTrimmedStringOrNull(row?.title ?? row?.programTitle) || 'Federal Assistance Program'
  const agency = toTrimmedStringOrNull(row?.organizationName ?? row?.agency)
  const objective = toTrimmedStringOrNull(row?.objective ?? row?.programObjective)
  const eligibility = toTrimmedStringOrNull(row?.applicantEligibility ?? row?.eligibility?.applicant)
  const beneficiary = toTrimmedStringOrNull(row?.beneficiaryEligibility ?? row?.eligibility?.beneficiary)
  const assistanceTypes = row?.assistanceTypes ?? row?.typesOfAssistance ?? []
  const url = toTrimmedStringOrNull(row?.websiteUrl ?? row?.url)
  const contact = toTrimmedStringOrNull(row?.contactInfo ?? row?.contact)

  const obligations = row?.obligations ?? row?.financialInformation?.obligations
  let amountMax = null
  if (Array.isArray(obligations) && obligations.length > 0) {
    const latest = obligations[obligations.length - 1]
    amountMax = toNumberOrNull(latest?.amount ?? latest?.obligatedAmount)
  }

  const samUrl = cfda
    ? `https://sam.gov/fal/${encodeURIComponent(cfda)}/view`
    : null

  const categories = ['federal', 'cfda']
  if (Array.isArray(assistanceTypes)) {
    for (const t of assistanceTypes) {
      const label = (typeof t === 'string' ? t : t?.description ?? '').toLowerCase()
      if (label.includes('grant')) categories.push('grant')
      if (label.includes('loan')) categories.push('loan')
      if (label.includes('insurance')) categories.push('insurance')
    }
  }

  const bullets = []
  if (eligibility) bullets.push(`Eligible applicants: ${eligibility.slice(0, 300)}`)
  if (beneficiary) bullets.push(`Beneficiaries: ${beneficiary.slice(0, 300)}`)
  if (Array.isArray(assistanceTypes) && assistanceTypes.length > 0) {
    const typeLabels = assistanceTypes.map(t => typeof t === 'string' ? t : t?.description).filter(Boolean)
    if (typeLabels.length > 0) bullets.push(`Assistance types: ${typeLabels.join(', ')}`)
  }

  /** @type {import('./types.js').FundingOpportunity} */
  return {
    title: cfda ? `${cfda} — ${title}` : title,
    sponsor: agency,
    source: 'sam.assistance',
    source_id: cfda || `sam-al-${Date.now()}`,
    source_url: samUrl || url,
    application_url: url,
    description: objective ? objective.slice(0, 2000) : null,
    amount_min: null,
    amount_max: amountMax,
    amount_description: amountMax ? `Recent obligation: $${amountMax.toLocaleString()}` : null,
    deadline: null,
    deadline_type: 'ongoing',
    is_national: true,
    state: 'nationwide',
    categories,
    keywords: ['federal', 'cfda', cfda, agency?.toLowerCase()].filter(Boolean),
    eligibility_bullets: bullets,
    contact_info: contact ? { notes: contact } : null,
    opportunity_type: categories.includes('loan') ? 'loan' : 'grant',
    type: 'PROGRAM',
    last_verified_at: null,
    record_origin: 'funding_api',
    requires_501c3: false,
    requires_match: false,
  }
}
