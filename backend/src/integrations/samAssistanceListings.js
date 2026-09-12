/**
 * SAM.gov Federal Assistance Listings (CFDA) search.
 *
 * Endpoint: https://sam.gov/api/prod/sgs/v1/search?index=cfda — SAM.gov's own
 * site search, the same service crawler-os/adapters/samGovAdapter.js reads.
 * Contract verified live from production on 2026-09-12:
 * - KEYLESS; requires `Accept: application/hal+json` (else 406).
 * - Free-text `q` (an empty `q` returns every listing), 0-based `page`, `size`
 *   up to 100 (size=100 answered 200 in ~0.2s).
 * - `is_active=true` restricts to active listings: q=housing returned 571 total
 *   without it and 242 with it, with no inactive rows. `isActive=true` is ignored.
 * - Response: `{ _embedded: { results: [...] }, page: { totalElements,
 *   totalPages, number } }`. Results carry `programNumber`, `title`, `objective`,
 *   `website`, `organizationHierarchy[]`, `assistanceTypes[].hierarchy[]`,
 *   `eligibility.{applicant,beneficiary}.types[]`, `financial.obligations[]`,
 *   `contacts`, `isActive` and `_id` (the FAL deep-link id).
 *
 * Why not api.sam.gov/assistance-listings/v1 (used until 2026-09-12): it has no
 * keyword search, its live API rejects pageSize above 100 (its own parameter
 * table says 1000; the request failed with 400 "PageSize and pageNumber values
 * must be greater than zero"), and the public key allows 10 requests a day. The
 * active catalog is 2,872 listings (29 pages at 100), so the daily download that
 * client depended on could never fit the quota.
 */

import { requestJson } from './httpClient.js'
import { toTrimmedStringOrNull, toNumberOrNull } from './types.js'

const SAM_SEARCH_URL = 'https://sam.gov/api/prod/sgs/v1/search'
const SAM_SEARCH_HEADERS = Object.freeze({ Accept: 'application/hal+json' })
const MAX_PAGE_SIZE = 100

/** Assistance type words used by callers → SAM assistance type codes. */
const ASSISTANCE_TYPE_CODES = Object.freeze({
  grant: ['F001', 'F002'],
  grants: ['F001', 'F002'],
  project_grant: ['F001'],
  cooperative_agreement: ['F002'],
  loan: ['F003', 'F004'],
  loans: ['F003', 'F004'],
  direct_loan: ['F003'],
  loan_guarantee: ['F004'],
  insurance: ['F005'],
  direct_payment: ['F006', 'F007'],
  property: ['F009', 'N001'],
  services: ['N002', 'N003', 'N004', 'N005'],
  training: ['N005'],
})

const ASSISTANCE_TYPE_CODE_RX = /^[FN]\d{3}$/i

function normText(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function resultsOf(data) {
  const rows = data?._embedded?.results
  return Array.isArray(rows) ? rows : []
}

function firstOf(value) {
  if (Array.isArray(value)) return value[0] ?? null
  if (value && typeof value === 'object') return value[0] ?? value['0'] ?? null
  return null
}

async function searchListings({ q, page, size, activeOnly = true }) {
  const params = { index: 'cfda', q, page, size }
  if (activeOnly) params.is_active = 'true'
  const data = await requestJson({
    provider: 'sam.assistance',
    url: SAM_SEARCH_URL,
    method: 'GET',
    headers: SAM_SEARCH_HEADERS,
    params,
    timeoutMs: 20_000,
    maxRetries: 2,
  })
  return { rows: resultsOf(data), total: toNumberOrNull(data?.page?.totalElements) }
}

/** Assistance types from the search hierarchy, plus any named on obligations. */
function assistanceTypes(row) {
  const out = []
  const add = (code, name) => {
    const c = String(code ?? '').trim().toUpperCase()
    const n = toTrimmedStringOrNull(name)
    if (!c && !n) return
    if (c && out.some((t) => t.code === c)) return
    out.push({ code: c, name: n })
  }
  for (const entry of Array.isArray(row?.assistanceTypes) ? row.assistanceTypes : []) {
    const levels = Array.isArray(entry?.hierarchy) ? entry.hierarchy : []
    const leaf = levels.find((level) => ASSISTANCE_TYPE_CODE_RX.test(String(level?.code ?? ''))) ?? levels[levels.length - 1]
    if (leaf) add(leaf.code, leaf.value ?? leaf.name)
  }
  for (const obligation of Array.isArray(row?.financial?.obligations) ? row.financial.obligations : []) {
    add(obligation?.assistanceType?.code, obligation?.assistanceType?.value ?? obligation?.assistanceType?.name)
  }
  return out
}

function matchesAssistanceType(row, wanted) {
  const raw = String(wanted ?? '').trim()
  if (!raw) return true
  const types = assistanceTypes(row)
  const codes = ASSISTANCE_TYPE_CODE_RX.test(raw)
    ? [raw.toUpperCase()]
    : ASSISTANCE_TYPE_CODES[normText(raw).replace(/ /g, '_')]
  if (codes) return types.some((t) => codes.includes(t.code))
  const needle = normText(raw)
  return types.some((t) => normText(t.name).includes(needle))
}

function eligibilityTypes(row, side) {
  const types = row?.eligibility?.[side]?.types
  return Array.isArray(types) ? types.map((t) => toTrimmedStringOrNull(t?.value ?? t?.name)).filter(Boolean) : []
}

function eligibilityInfo(row, side) {
  return toTrimmedStringOrNull(row?.eligibility?.[side]?.additionalInfo ?? row?.eligibility?.[side]?.description)
}

function matchesApplicantType(row, wanted) {
  const needle = normText(wanted).replace(/ /g, '')
  if (!needle) return true
  const hay = normText([
    ...eligibilityTypes(row, 'applicant'),
    ...eligibilityTypes(row, 'beneficiary'),
    eligibilityInfo(row, 'applicant'),
  ].join(' ')).replace(/ /g, '')
  return hay.includes(needle)
}

/** The most specific organization in the hierarchy (the agency or office). */
function agencyOf(row) {
  const levels = Array.isArray(row?.organizationHierarchy) ? [...row.organizationHierarchy] : []
  levels.sort((a, b) => (toNumberOrNull(b?.level) ?? 0) - (toNumberOrNull(a?.level) ?? 0))
  return toTrimmedStringOrNull(levels[0]?.name)
}

/**
 * Search federal assistance listings (CFDA programs).
 *
 * @param {Object=} query
 * @param {string=} query.keyword - free text, passed to SAM.gov's search
 * @param {string=} query.assistanceType - grant, loan, insurance, … or a code (F001)
 * @param {string=} query.applicantType - state, local, nonprofit, individual, etc.
 * @param {number=} query.page - page number (1-based)
 * @param {number=} query.limit - results per page (max 100)
 * @returns {Promise<{ total: number, opportunities: Array<import('./types.js').FundingOpportunity> }>}
 */
export async function fetchAssistanceListings(query = {}) {
  const { keyword = '', assistanceType, applicantType } = query
  const page = Math.max(1, Math.floor(Number(query.page) || 1))
  const limit = Math.max(1, Math.min(Math.floor(Number(query.limit) || 25), MAX_PAGE_SIZE))

  const { rows, total } = await searchListings({ q: String(keyword ?? '').trim(), page: page - 1, size: limit })
  const kept = rows
    .filter((row) => row?.isActive !== false)
    .filter((row) => matchesAssistanceType(row, assistanceType))
    .filter((row) => matchesApplicantType(row, applicantType))

  // Type and applicant filters apply to the rows on this page, so a filtered
  // request reports the rows it kept instead of the service's unfiltered count.
  const filtered = Boolean(String(assistanceType ?? '').trim() || String(applicantType ?? '').trim())
  return {
    total: filtered ? kept.length : (total ?? kept.length),
    opportunities: kept.map(normalizeListing),
  }
}

/**
 * Get a single assistance listing by CFDA number (active or not).
 *
 * @param {string} cfda - e.g. "10.500"
 * @returns {Promise<import('./types.js').FundingOpportunity|null>}
 */
export async function getAssistanceListing(cfda) {
  const wanted = String(cfda ?? '').trim()
  if (!wanted) return null
  const { rows } = await searchListings({ q: wanted, page: 0, size: 25, activeOnly: false })
  const row = rows.find((r) => String(r?.programNumber ?? '').trim() === wanted)
  return row ? normalizeListing(row) : null
}

function normalizeListing(row) {
  const cfda = toTrimmedStringOrNull(row?.programNumber)
  const title = toTrimmedStringOrNull(row?.title) || 'Federal Assistance Program'
  const agency = agencyOf(row)
  const objective = toTrimmedStringOrNull(row?.objective)
  const applicantNames = eligibilityTypes(row, 'applicant')
  const applicantDescription = eligibilityInfo(row, 'applicant')
  const beneficiaryNames = eligibilityTypes(row, 'beneficiary')
  const beneficiaryDescription = eligibilityInfo(row, 'beneficiary')
  const types = assistanceTypes(row)
  const typeLabels = [...new Set(types.map((t) => t.name).filter(Boolean))]
  const website = toTrimmedStringOrNull(row?.website)
  const falId = toTrimmedStringOrNull(row?._id)
  const falUrl = falId ? `https://sam.gov/fal/${encodeURIComponent(falId)}/view` : null
  const contact = firstOf(row?.contacts)

  // The search index carries no structured per-award range (only program-wide
  // obligations, which are not what one applicant can receive), so amounts stay
  // unset and the listing's own financial note is passed through as text.
  const amountDescription = toTrimmedStringOrNull(row?.financial?.additionalInfo)?.slice(0, 500) ?? null

  const codes = types.map((t) => t.code).filter(Boolean)
  const categories = ['federal', 'cfda']
  for (const label of typeLabels.map((l) => l.toLowerCase())) {
    if (label.includes('grant') || label.includes('cooperative agreement')) categories.push('grant')
    if (label.includes('loan')) categories.push('loan')
    if (label.includes('insurance')) categories.push('insurance')
  }
  const loanOnly = codes.length > 0 && codes.every((c) => c === 'F003' || c === 'F004')

  const bullets = []
  if (applicantNames.length > 0) bullets.push(`Eligible applicants: ${applicantNames.join(', ')}`)
  if (applicantDescription) bullets.push(`Applicant eligibility: ${applicantDescription.slice(0, 300)}`)
  if (beneficiaryNames.length > 0) bullets.push(`Beneficiaries: ${beneficiaryNames.join(', ')}`)
  else if (beneficiaryDescription) bullets.push(`Beneficiaries: ${beneficiaryDescription.slice(0, 300)}`)
  if (typeLabels.length > 0) bullets.push(`Assistance types: ${typeLabels.join(', ')}`)

  const contactInfo = contact
    ? {
        name: toTrimmedStringOrNull(contact.name ?? contact.fullName),
        email: toTrimmedStringOrNull(contact.email),
        phone: toTrimmedStringOrNull(contact.phone),
      }
    : null

  /** @type {import('./types.js').FundingOpportunity} */
  return {
    title: cfda ? `${cfda} — ${title}` : title,
    sponsor: agency,
    source: 'sam.assistance',
    source_id: cfda || falId || `sam-al-${Date.now()}`,
    source_url: falUrl || website,
    application_url: website,
    description: objective ? objective.slice(0, 2000) : null,
    amount_min: null,
    amount_max: null,
    amount_description: amountDescription,
    deadline: null,
    deadline_type: 'ongoing',
    is_national: true,
    state: 'nationwide',
    categories: [...new Set(categories)],
    keywords: ['federal', 'cfda', cfda, agency?.toLowerCase()].filter(Boolean),
    eligibility_bullets: bullets,
    contact_info: contactInfo,
    opportunity_type: loanOnly ? 'loan' : 'grant',
    type: 'PROGRAM',
    last_verified_at: null,
    record_origin: 'funding_api',
    requires_501c3: false,
    requires_match: false,
  }
}
