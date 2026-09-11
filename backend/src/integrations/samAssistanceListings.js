/**
 * SAM.gov Federal Assistance Listings API Integration
 *
 * Provides the full CFDA (Catalog of Federal Domestic Assistance) database —
 * every federal program that provides grants, loans, or other assistance.
 *
 * Endpoint: https://api.sam.gov/assistance-listings/v1/search
 * Requires: SAM_GOV_PUBLIC_API_KEY (same key as SAM opportunities)
 * Docs: https://open.gsa.gov/api/assistance-listings-api/
 *
 * Contract facts (verified live 2026-09-11 — the old client got every one wrong,
 * so GET /api/foundations/federal/search answered 500 for every query):
 * - The API serves ONLY `application/hal+json`; `Accept: application/json` is
 *   refused with 406 Not Acceptable.
 * - Responses are `{ totalRecords, pageSize, pageNumber, totalPages,
 *   assistanceListingsData: [...] }`.
 * - There is NO free-text search parameter (`keyword`/`keywords` are ignored and
 *   return the whole catalog); filters are codes (assistanceTypes F001…,
 *   applicantTypes ET…).
 * - Public keys are capped per DAY (10/day without a SAM role, 1,000/day with
 *   one). One upstream call per search would exhaust the key, so this module
 *   downloads the ~3k active listings once (pageSize 1000) and serves every
 *   keyword/type/applicant search from that cached catalog.
 */

import { requestJson } from './httpClient.js'
import { toTrimmedStringOrNull, toNumberOrNull } from './types.js'

const SAM_AL_BASE = 'https://api.sam.gov/assistance-listings/v1'
const SAM_AL_HEADERS = Object.freeze({ Accept: 'application/hal+json' })
const CATALOG_PAGE_SIZE = 1000
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000
const CATALOG_MAX_REQUESTS = 12

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

let catalogCache = null // { fetchedAt: number, listings: object[] }
let catalogInflight = null

export function __resetAssistanceCatalogCacheForTests() {
  catalogCache = null
  catalogInflight = null
}

function normText(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function extractListings(data) {
  const rows = data?.assistanceListingsData ??
    data?._embedded?.assistanceListings ??
    data?.assistanceListings ??
    (Array.isArray(data) ? data : [])
  return Array.isArray(rows) ? rows : []
}

function listingKey(row) {
  return String(row?.assistanceListingId ?? row?.programNumber ?? row?.programId ?? '').trim()
}

async function downloadCatalog(apiKey) {
  const byKey = new Map()
  let totalRecords = null
  let totalPages = null
  for (let requests = 0; requests < CATALOG_MAX_REQUESTS; requests++) {
    const data = await requestJson({
      provider: 'sam.assistance',
      url: `${SAM_AL_BASE}/search`,
      method: 'GET',
      headers: SAM_AL_HEADERS,
      params: { api_key: apiKey, status: 'Active', pageSize: CATALOG_PAGE_SIZE, pageNumber: requests },
      timeoutMs: 45_000,
      maxRetries: 2,
    })
    const rows = extractListings(data)
    if (totalRecords === null) totalRecords = toNumberOrNull(data?.totalRecords ?? data?.page?.totalElements)
    if (totalPages === null) totalPages = toNumberOrNull(data?.totalPages ?? data?.page?.totalPages)
    if (rows.length === 0) break
    for (const row of rows) {
      const key = listingKey(row) || `row-${byKey.size}`
      if (!byKey.has(key)) byKey.set(key, row)
    }
    if (totalRecords !== null && byKey.size >= totalRecords) break
    if (rows.length < CATALOG_PAGE_SIZE) break
    // pageNumber is documented as 0-based while responses echo 1-based numbers;
    // one extra request covers either convention (duplicates are de-duplicated).
    if (totalPages !== null && requests + 1 >= totalPages + 1) break
  }
  const listings = [...byKey.values()]
  if (listings.length === 0) {
    // Loud, never a cached empty catalog: an empty answer would hide an outage for a day.
    throw new Error('[sam.assistance] catalog download returned no listings')
  }
  return listings
}

async function loadCatalog(apiKey) {
  if (catalogCache && Date.now() - catalogCache.fetchedAt < CATALOG_TTL_MS) return catalogCache.listings
  if (!catalogInflight) {
    catalogInflight = downloadCatalog(apiKey)
      .then((listings) => {
        catalogCache = { fetchedAt: Date.now(), listings }
        return listings
      })
      .finally(() => {
        catalogInflight = null
      })
  }
  try {
    return await catalogInflight
  } catch (error) {
    // Serve the last good catalog through an upstream outage or a spent daily quota.
    if (catalogCache?.listings?.length) return catalogCache.listings
    throw error
  }
}

function obligationTypes(row) {
  const obligations = row?.financialInformation?.obligations ?? row?.obligations
  if (!Array.isArray(obligations)) return []
  return obligations
    .map((o) => ({
      code: String(o?.assistanceType?.code ?? '').trim().toUpperCase(),
      name: toTrimmedStringOrNull(o?.assistanceType?.name ?? (typeof o?.assistanceType === 'string' ? o.assistanceType : null)),
    }))
    .filter((t) => t.code || t.name)
}

function matchesAssistanceType(row, wanted) {
  const raw = String(wanted ?? '').trim()
  if (!raw) return true
  const types = obligationTypes(row)
  const codes = ASSISTANCE_TYPE_CODE_RX.test(raw)
    ? [raw.toUpperCase()]
    : ASSISTANCE_TYPE_CODES[normText(raw).replace(/ /g, '_')]
  if (codes) return types.some((t) => codes.includes(t.code))
  const needle = normText(raw)
  return types.some((t) => normText(t.name).includes(needle))
}

function applicantTypeNames(row) {
  const types = row?.criteriaForApplying?.applicant?.types
  return Array.isArray(types) ? types.map((t) => toTrimmedStringOrNull(t?.name)).filter(Boolean) : []
}

function matchesApplicantType(row, wanted) {
  const needle = normText(wanted).replace(/ /g, '')
  if (!needle) return true
  const hay = normText([...applicantTypeNames(row), row?.criteriaForApplying?.applicant?.description].join(' ')).replace(/ /g, '')
  return hay.includes(needle)
}

function searchText(row) {
  return normText([
    row?.assistanceListingId,
    row?.title,
    row?.popularLongName,
    row?.popularShortName,
    row?.overview?.objective,
    row?.overview?.assistanceListingDescription,
    row?.federalOrganization?.department,
    row?.federalOrganization?.agency,
    row?.federalOrganization?.office,
  ].filter(Boolean).join(' '))
}

/**
 * Search federal assistance listings (CFDA programs).
 *
 * @param {Object=} query
 * @param {string=} query.keyword - free text; every word must appear in the listing
 * @param {string=} query.assistanceType - grant, loan, insurance, … or a code (F001)
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

  const { keyword = '', assistanceType, applicantType } = query
  const page = Math.max(1, Math.floor(Number(query.page) || 1))
  const limit = Math.max(1, Math.min(Math.floor(Number(query.limit) || 25), 100))

  const catalog = await loadCatalog(apiKey)
  const tokens = normText(keyword).split(' ').filter(Boolean)
  const matched = []
  for (const row of catalog) {
    if (!matchesAssistanceType(row, assistanceType)) continue
    if (!matchesApplicantType(row, applicantType)) continue
    if (tokens.length > 0) {
      const hay = ` ${searchText(row)} `
      if (!tokens.every((token) => hay.includes(token))) continue
      const title = normText(row?.title)
      matched.push({ row, titleHit: tokens.every((token) => title.includes(token)) })
    } else {
      matched.push({ row, titleHit: false })
    }
  }
  // Title matches first, catalog order otherwise (stable sort).
  matched.sort((a, b) => Number(b.titleHit) - Number(a.titleHit))

  const start = (page - 1) * limit
  return {
    total: matched.length,
    opportunities: matched.slice(start, start + limit).map(({ row }) => normalizeListing(row)),
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
  const wanted = String(cfda ?? '').trim()
  if (!apiKey || !wanted) return null

  const cached = catalogCache?.listings?.find((row) => listingKey(row) === wanted)
  if (cached) return normalizeListing(cached)

  const data = await requestJson({
    provider: 'sam.assistance',
    url: `${SAM_AL_BASE}/search`,
    method: 'GET',
    headers: SAM_AL_HEADERS,
    params: { api_key: apiKey, assistanceListingId: wanted, status: 'All' },
    timeoutMs: 15_000,
    maxRetries: 2,
  })
  const rows = extractListings(data)
  const row = rows.find((r) => listingKey(r) === wanted) ?? rows[0]
  return row ? normalizeListing(row) : null
}

function latestAwardRange(row) {
  const ranges = row?.financialInformation?.rangeAndAverageAssistance ?? row?.rangeAndAverageAssistance
  if (!Array.isArray(ranges) || ranges.length === 0) return null
  const sorted = [...ranges].sort((a, b) => (toNumberOrNull(b?.fiscalYear) ?? 0) - (toNumberOrNull(a?.fiscalYear) ?? 0))
  return sorted.find((r) => toNumberOrNull(r?.maximumAwardAmount) !== null || toNumberOrNull(r?.minimumAwardAmount) !== null) ?? null
}

function normalizeListing(row) {
  const cfda = toTrimmedStringOrNull(row?.assistanceListingId ?? row?.programNumber ?? row?.assistanceListingNumber)
  const title = toTrimmedStringOrNull(row?.title ?? row?.programTitle) || 'Federal Assistance Program'
  const agency = toTrimmedStringOrNull(
    row?.federalOrganization?.agency ?? row?.federalOrganization?.department ?? row?.organizationName ?? row?.agency,
  )
  const objective = toTrimmedStringOrNull(
    row?.overview?.objective ?? row?.overview?.assistanceListingDescription ?? row?.objective ?? row?.programObjective,
  )
  const applicantNames = applicantTypeNames(row)
  const applicantDescription = toTrimmedStringOrNull(row?.criteriaForApplying?.applicant?.description ?? row?.applicantEligibility)
  const beneficiaryTypes = row?.criteriaForApplying?.beneficiary?.types
  const beneficiaryNames = Array.isArray(beneficiaryTypes) ? beneficiaryTypes.map((t) => toTrimmedStringOrNull(t?.name)).filter(Boolean) : []
  const beneficiaryDescription = toTrimmedStringOrNull(row?.criteriaForApplying?.beneficiary?.description ?? row?.beneficiaryEligibility)
  const types = obligationTypes(row)
  const typeLabels = [...new Set(types.map((t) => t.name).filter(Boolean))]
  const url = toTrimmedStringOrNull(row?.programWebPage ?? row?.websiteUrl ?? row?.url)
  const hq = Array.isArray(row?.contacts?.headquarters) ? row.contacts.headquarters[0] : null

  const range = latestAwardRange(row)
  const amountMin = toNumberOrNull(range?.minimumAwardAmount)
  const amountMax = toNumberOrNull(range?.maximumAwardAmount)
  const fmt = (n) => `$${Number(n).toLocaleString()}`
  let amountDescription = null
  if (amountMin !== null && amountMax !== null) amountDescription = `Award range FY${range.fiscalYear}: ${fmt(amountMin)}–${fmt(amountMax)}`
  else if (amountMax !== null) amountDescription = `Awards up to ${fmt(amountMax)} (FY${range.fiscalYear})`

  const samUrl = cfda ? `https://sam.gov/fal/${encodeURIComponent(cfda)}/view` : null

  const codes = types.map((t) => t.code)
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

  const contactInfo = hq
    ? {
        name: toTrimmedStringOrNull(hq.fullName),
        email: toTrimmedStringOrNull(hq.email),
        phone: toTrimmedStringOrNull(hq.phone),
      }
    : null

  /** @type {import('./types.js').FundingOpportunity} */
  return {
    title: cfda ? `${cfda} — ${title}` : title,
    sponsor: agency,
    source: 'sam.assistance',
    source_id: cfda || `sam-al-${Date.now()}`,
    source_url: samUrl || url,
    application_url: url,
    description: objective ? objective.slice(0, 2000) : null,
    amount_min: amountMin,
    amount_max: amountMax,
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
