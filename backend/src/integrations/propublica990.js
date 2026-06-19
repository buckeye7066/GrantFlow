/**
 * ProPublica Nonprofit Explorer API Integration
 *
 * Free, public API — no key required.
 * Docs: https://projects.propublica.org/nonprofits/api/
 * Base: https://projects.propublica.org/nonprofits/api/v2/
 *
 * Provides access to 1.8M+ nonprofit 990 filings. Powers the
 * Foundation Search feature — equivalent to what GrantWatch charges
 * $249/yr for and Candid charges $1,999/yr for.
 */

import { requestJson } from './httpClient.js'
import { toTrimmedStringOrNull, toNumberOrNull } from './types.js'

const PP_BASE = 'https://projects.propublica.org/nonprofits/api/v2'

// ProPublica's Nonprofit Explorer API groups NTEE codes into 10 numeric MAJOR
// GROUPS. Its search filter (`ntee[id]`) wants that group number (1-10), NOT a
// letter or full code — sending a letter returns HTTP 500. Map letters here.
const NTEE_LETTER_TO_GROUP = {
  A: 1,
  B: 2,
  C: 3, D: 3,
  E: 4, F: 4, G: 4, H: 4,
  I: 5, J: 5, K: 5, L: 5, M: 5, N: 5, O: 5, P: 5,
  Q: 6,
  R: 7, S: 7, T: 7, U: 7, V: 7, W: 7,
  X: 8,
  Y: 9,
  Z: 10,
}

/**
 * Normalize an NTEE filter to ProPublica's numeric major group (1-10).
 * Accepts a letter ("B"), a full code ("B82"), or an already-numeric group.
 * Returns null when it can't be mapped (so the filter is simply omitted).
 */
function nteeToMajorGroup(ntee) {
  if (ntee === null || ntee === undefined || ntee === '') return null
  const raw = String(ntee).trim()
  if (/^\d+$/.test(raw)) {
    const n = Number(raw)
    return n >= 1 && n <= 10 ? n : null
  }
  return NTEE_LETTER_TO_GROUP[raw.charAt(0).toUpperCase()] || null
}

/**
 * Search nonprofits/foundations by name.
 *
 * @param {Object} query
 * @param {string} query.q - search term (name or keyword)
 * @param {number=} query.page - page number (0-based)
 * @param {string=} query.state - 2-letter state code filter
 * @param {string=} query.ntee - NTEE classification code filter
 * @param {string=} query.c_code - IRS subsection code (3 = 501c3)
 * @returns {Promise<{ total_results: number, organizations: Array }>}
 */
export async function searchOrganizations(query = {}) {
  const { q = '', page = 0, state, ntee, c_code } = query
  if (!q.trim()) return { total_results: 0, organizations: [] }

  // ProPublica expects filters as array-style indexed params (state[id],
  // ntee[id], c_code[id]); bare `state=`/`ntee=` make the API 500. axios
  // url-encodes the bracket keys, which ProPublica accepts.
  const params = { q: q.trim(), page }
  if (state) params['state[id]'] = String(state).toUpperCase()
  const nteeId = nteeToMajorGroup(ntee)
  if (nteeId) params['ntee[id]'] = nteeId
  if (c_code) {
    const cc = String(c_code).replace(/\D/g, '')
    if (cc) params['c_code[id]'] = cc
  }

  const data = await requestJson({
    provider: 'propublica.990',
    url: `${PP_BASE}/search.json`,
    method: 'GET',
    params,
    timeoutMs: 15_000,
    maxRetries: 2,
  })

  const orgs = Array.isArray(data?.organizations) ? data.organizations : []
  return {
    total_results: data?.total_results ?? orgs.length,
    organizations: orgs.map(normalizeOrg),
  }
}

/**
 * Get organization details by EIN.
 *
 * @param {string} ein - Employer Identification Number (9 digits)
 * @returns {Promise<Object>}
 */
export async function getOrganization(ein) {
  const cleanEin = String(ein).replace(/\D/g, '')
  if (cleanEin.length !== 9) throw new Error('Invalid EIN: must be 9 digits')

  const data = await requestJson({
    provider: 'propublica.990',
    url: `${PP_BASE}/organizations/${cleanEin}.json`,
    method: 'GET',
    timeoutMs: 15_000,
    maxRetries: 2,
  })

  const org = data?.organization ?? {}
  const filings = Array.isArray(data?.filings_with_data)
    ? data.filings_with_data.map(normalizeFilingDetail)
    : []

  return {
    ...normalizeOrg(org),
    filings,
    raw: org,
  }
}

/**
 * Get 990 filing details.
 *
 * @param {string} ein - EIN
 * @param {string} taxPeriod - e.g. "202012" (YYYYMM)
 * @returns {Promise<Object>}
 */
export async function getFiling(ein, taxPeriod) {
  const cleanEin = String(ein).replace(/\D/g, '')
  const data = await requestJson({
    provider: 'propublica.990',
    url: `${PP_BASE}/organizations/${cleanEin}/${taxPeriod}.json`,
    method: 'GET',
    timeoutMs: 15_000,
    maxRetries: 2,
  })
  return data
}

function normalizeOrg(raw) {
  return {
    ein: toTrimmedStringOrNull(raw?.ein),
    name: toTrimmedStringOrNull(raw?.name) || toTrimmedStringOrNull(raw?.organization?.name) || 'Unknown',
    city: toTrimmedStringOrNull(raw?.city),
    state: toTrimmedStringOrNull(raw?.state),
    ntee_code: toTrimmedStringOrNull(raw?.ntee_code),
    classification: toTrimmedStringOrNull(raw?.classification_codes),
    subsection_code: toTrimmedStringOrNull(raw?.subsection_code),
    ruling_date: toTrimmedStringOrNull(raw?.ruling_date),
    tax_period: toTrimmedStringOrNull(raw?.tax_period),
    asset_amount: toNumberOrNull(raw?.asset_amount),
    income_amount: toNumberOrNull(raw?.income_amount),
    revenue_amount: toNumberOrNull(raw?.revenue_amount),
    total_revenue: toNumberOrNull(raw?.totrevenue),
    grant_amount: toNumberOrNull(raw?.grantamt),
    score: toNumberOrNull(raw?.score),
    // ProPublica profile URL
    profile_url: raw?.ein
      ? `https://projects.propublica.org/nonprofits/organizations/${String(raw.ein).replace(/\D/g, '')}`
      : null,
  }
}

function normalizeFilingDetail(filing) {
  return {
    tax_period: toTrimmedStringOrNull(filing?.tax_prd),
    tax_period_year: toTrimmedStringOrNull(filing?.tax_prd_yr),
    formtype: toTrimmedStringOrNull(filing?.formtype),
    pdf_url: toTrimmedStringOrNull(filing?.pdf_url),
    total_revenue: toNumberOrNull(filing?.totrevenue),
    total_expenses: toNumberOrNull(filing?.totfuncexpns),
    total_assets_eoy: toNumberOrNull(filing?.totassetsend),
    total_liabilities_eoy: toNumberOrNull(filing?.totliabend),
    net_assets: toNumberOrNull(filing?.totnetassetend),
    grants_paid: toNumberOrNull(filing?.grantamt ?? filing?.totgrantsorcontribpd),
    officer_compensation: toNumberOrNull(filing?.compnsatncurrofcr),
    num_employees: toNumberOrNull(filing?.noabordings ?? filing?.totemployee),
    num_volunteers: toNumberOrNull(filing?.totvolunteers),
  }
}

/**
 * Convert a ProPublica org into a FundingOpportunity-shaped object
 * (for when we want to surface foundations as potential funders).
 *
 * @param {Object} org - normalized org from searchOrganizations
 * @returns {import('./types.js').FundingOpportunity}
 */
export function orgToFundingOpportunity(org) {
  const grantAmt = org.grant_amount ?? org.income_amount
  return {
    title: `${org.name} — Foundation/Grantmaker`,
    sponsor: org.name,
    source: 'propublica.990',
    source_id: org.ein || `pp-${Date.now()}`,
    source_url: org.profile_url,
    application_url: null,
    description: [
      org.city && org.state ? `Location: ${org.city}, ${org.state}` : null,
      org.ntee_code ? `NTEE: ${org.ntee_code}` : null,
      grantAmt ? `Grants paid: $${grantAmt.toLocaleString()}` : null,
      org.asset_amount ? `Total assets: $${org.asset_amount.toLocaleString()}` : null,
    ].filter(Boolean).join(' | '),
    amount_min: null,
    amount_max: grantAmt,
    amount_description: grantAmt ? `Grants paid: $${grantAmt.toLocaleString()}` : null,
    deadline: null,
    deadline_type: 'rolling',
    is_national: true,
    state: org.state || 'nationwide',
    categories: ['foundation', '990', 'grantmaker'],
    keywords: ['foundation', 'grantmaker', org.ntee_code?.toLowerCase()].filter(Boolean),
    eligibility_bullets: [],
    opportunity_type: 'grant',
    type: 'DIRECTORY',
    last_verified_at: null,
    record_origin: 'funding_api',
    funding_source_type: 'foundation',
    requires_501c3: false,
    requires_match: false,
  }
}
