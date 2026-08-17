/**
 * Dependency-free Grants.gov Search2 protocol contract.
 *
 * This module is the single authority for endpoint URLs, request shaping,
 * calendar/status normalization, detail links, and source identity. It has no
 * I/O and no imports so both the Crawler OS and the live API client can depend
 * on it without pulling either runtime into the other.
 */

export const GRANTS_GOV_SEARCH2_URL = 'https://api.grants.gov/v1/api/search2'
export const GRANTS_GOV_DETAIL_URL = 'https://www.grants.gov/search-results-detail/'
export const GRANTS_GOV_VIEW_URL = 'https://www.grants.gov/view-opportunity/'

const cleanIdentityPart = (value) => {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text || null
}

/** Build the one Search2 request shape used by every Grants.gov caller. */
export function buildGrantsGovSearchPayload(params = {}) {
  const {
    keyword = '',
    oppStatus = 'forecasted|posted',
    rows = 25,
    startRow = 0,
    fundingCategories = null,
    eligibilities = null,
  } = params
  const joinFilter = (value) => Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean).join('|')
    : String(value ?? '').trim()

  return {
    rows: Math.max(1, Number(rows) || 25),
    oppStatuses: String(oppStatus || 'forecasted|posted'),
    keyword: String(keyword || ''),
    startRecordNum: Math.max(0, Number(startRow) || 0),
    agencies: '',
    fundingCategories: joinFilter(fundingCategories),
    eligibilities: joinFilter(eligibilities),
    aln: '',
    oppNum: '',
  }
}

/** Grants.gov dates are commonly MM/DD/YYYY; store stable ISO calendar dates. */
export function normalizeGrantsGovDate(value) {
  if (value === null || value === undefined || value === '') return null
  const text = String(value).trim()
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text)
  if (!match) return text
  const [, month, day, year] = match
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
}

/** Preserve the official lifecycle fact in the canonical GrantFlow vocabulary. */
export function normalizeGrantsGovStatus(value) {
  const status = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (['posted', 'open', 'active'].includes(status)) return 'open'
  if (['forecasted', 'forecast', 'planned'].includes(status)) return 'forecasted'
  if (['closed', 'archived', 'cancelled', 'canceled'].includes(status)) return 'closed'
  return status || null
}

export function grantsGovDetailUrl(opportunityId, opportunityNumber = null) {
  const detailId = cleanIdentityPart(opportunityId)
  const publicNumber = cleanIdentityPart(opportunityNumber)
  const pathPart = detailId || publicNumber
  return pathPart ? `${GRANTS_GOV_DETAIL_URL}${encodeURIComponent(pathPart)}` : null
}

/**
 * Read the internal Search2 detail id from an authoritative Grants.gov URL.
 * Returns null for other hosts, other paths, malformed URLs, or empty ids.
 */
export function grantsGovDetailIdFromUrl(value) {
  if (!value) return null
  try {
    const url = new URL(String(value))
    const host = url.hostname.toLowerCase()
    if (host !== 'grants.gov' && host !== 'www.grants.gov') return null
    const match = /^\/(?:search-results-detail|view-opportunity)\/([^/]+)\/?$/i.exec(url.pathname)
    if (!match) return null
    return cleanIdentityPart(decodeURIComponent(match[1]))
  } catch {
    return null
  }
}

/**
 * Resolve one Grants.gov identity across raw Search2 rows and transformed rows.
 * The public opportunity number is the canonical source id. Search2's internal
 * detail id is retained only for the authoritative detail URL. If a legacy row
 * lacks a public number, the internal id remains a stable, honest fallback.
 */
export function resolveGrantsGovIdentity(raw = {}) {
  const detailId = cleanIdentityPart(raw.external_id ?? raw.id ?? raw.oppId)
  const opportunityNumber = cleanIdentityPart(
    raw.number ?? raw.oppNum ?? raw.oppNumber ?? raw.opportunityNumber,
  )
  return Object.freeze({
    detailId,
    opportunityNumber,
    sourceId: opportunityNumber || detailId,
    detailUrl: grantsGovDetailUrl(detailId, opportunityNumber),
  })
}
