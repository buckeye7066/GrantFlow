/**
 * Federal Register API Integration
 *
 * Free, public, no API key required.
 * Docs:  https://www.federalregister.gov/developers/documentation/api/v1
 * Base:  https://www.federalregister.gov/api/v1/documents.json
 *
 * The Federal Register publishes agency NOTICE documents, a fraction of which
 * are real Notices of Funding Opportunity / Availability (NOFO/NOFA), Requests
 * for Applications, and cooperative-agreement announcements across EVERY federal
 * agency. These complement Grants.gov (some announcements appear here first or
 * only here).
 *
 * Mission rule #1 (real opportunities, not generic junk): raw NOTICE search is
 * ~90% non-funding noise (information collections, SEC filings, meetings). We
 * therefore apply a strict funding-signal gate before emitting ANY row — only
 * documents whose title/abstract clearly describe available funding survive.
 * The downstream upsertFundingOpportunity quality gate is a second safety net.
 */

import { requestJson } from './httpClient.js'
import { toTrimmedStringOrNull } from './types.js'

const FR_DOCUMENTS_URL = 'https://www.federalregister.gov/api/v1/documents.json'

// Strong positive signal that a notice is about *available funding to apply for*.
const FUNDING_SIGNAL =
  /(notice of funding (opportunity|availability)|funding opportunit|invites? applications?|request for applications?|availability of funds?|cooperative agreement|notice of intent to (issue|fund|award)|solicit(?:ing|ation) (?:of|for) applications|application (?:deadline|due date|period|window)|estimated total program funding|funding announcement|grant competition|\bnofo\b|\bnofa\b|\brfa\b)/i

// Notice types that routinely contain funding-ish words but are NOT applyable
// opportunities. Tested against the TITLE only (abstracts legitimately discuss
// applications). Keeps precision high.
const NON_FUNDING_TITLE =
  /(information collection|paperwork reduction|request for (?:comment|information)\b|comment request|self-regulatory|sunshine act|privacy act|advisory (?:committee|council|board)|public meeting|notice of meeting|agency information|membership|charter (?:renewal|establishment)|fee schedule|interest rate|exchange rate|antidumping|countervailing duty|combined federal campaign|environmental impact|record of decision)/i

/**
 * Decide whether a Federal Register document is a real, applyable funding notice.
 * Exported for unit testing.
 *
 * @param {string} title
 * @param {string} abstract
 * @returns {boolean}
 */
export function isFundingNotice(title, abstract) {
  const t = String(title || '')
  const hay = `${t} ${String(abstract || '')}`
  return FUNDING_SIGNAL.test(hay) && !NON_FUNDING_TITLE.test(t)
}

function buildUrl({ keyword, perPage, gteDate }) {
  const fields = [
    'title', 'abstract', 'html_url', 'pdf_url', 'publication_date',
    'document_number', 'agencies', 'type', 'action', 'dates',
  ]
  const parts = [
    `per_page=${perPage}`,
    // Relevance ordering is critical: ordering by "newest" buries the few
    // funding notices among hundreds of routine ones (yield ~0). Relevance
    // surfaces 100+ real NOFOs per query for a funding-oriented term.
    'order=relevance',
    'conditions[type][]=NOTICE',
    `conditions[term]=${encodeURIComponent(keyword || 'funding opportunity grant')}`,
    ...(gteDate ? [`conditions[publication_date][gte]=${gteDate}`] : []),
    ...fields.map((f) => `fields[]=${f}`),
  ]
  return `${FR_DOCUMENTS_URL}?${parts.join('&')}`
}

function isoDaysAgo(days) {
  const ms = Date.now() - Math.max(0, days) * 86_400_000
  return new Date(ms).toISOString().slice(0, 10) // YYYY-MM-DD
}

/**
 * Search the Federal Register for funding notices.
 *
 * @param {Object=} query
 * @param {string=} query.keyword   - free-text search term
 * @param {number=} query.perPage   - rows to scan per call (max 1000); we keep
 *                                     only the funding-signal subset
 * @param {number=} query.sinceDays - only consider notices published within this
 *                                     many days (freshness; default 180)
 * @returns {Promise<Array<import('./types.js').FundingOpportunity>>}
 */
export async function fetchOpportunities(query = {}) {
  const perPage = Math.min(Math.max(Number(query.perPage) || 250, 1), 1000)
  const sinceDays = Number.isFinite(query.sinceDays) ? query.sinceDays : 365
  const url = buildUrl({ keyword: query.keyword, perPage, gteDate: isoDaysAgo(sinceDays) })

  const data = await requestJson({
    provider: 'federal.register',
    url,
    method: 'GET',
    timeoutMs: 25_000,
    maxRetries: 3,
  })

  const rows = Array.isArray(data?.results) ? data.results : []
  const seen = new Set()
  const out = []
  for (const row of rows) {
    const opp = normalizeFederalRegisterDoc(row)
    if (!opp) continue
    if (seen.has(opp.source_id)) continue
    seen.add(opp.source_id)
    out.push(opp)
  }
  return out
}

function normalizeFederalRegisterDoc(row) {
  if (!row || typeof row !== 'object') return null

  const title = toTrimmedStringOrNull(row.title)
  const abstract = toTrimmedStringOrNull(row.abstract)
  if (!title) return null
  if (!isFundingNotice(title, abstract)) return null

  const docNum = toTrimmedStringOrNull(row.document_number)
  const htmlUrl = toTrimmedStringOrNull(row.html_url)
  // Must be actionable + de-dupeable, or downstream gates reject it anyway.
  if (!docNum || !htmlUrl) return null

  const agencyName =
    (Array.isArray(row.agencies) && row.agencies.length > 0
      ? toTrimmedStringOrNull(row.agencies[0]?.name || row.agencies[0]?.raw_name)
      : null) || 'Federal Agency'

  const pubDate = toTrimmedStringOrNull(row.publication_date)
  const datesNote = toTrimmedStringOrNull(row.dates)

  const bullets = [
    `Agency: ${agencyName}`,
    pubDate ? `Published: ${pubDate}` : null,
    datesNote ? `Key dates: ${datesNote.slice(0, 240)}` : null,
    `Federal Register doc: ${docNum}`,
  ].filter(Boolean)

  /** @type {import('./types.js').FundingOpportunity} */
  return {
    title,
    sponsor: agencyName,
    source: 'federal.register',
    source_id: docNum,
    source_url: htmlUrl,
    application_url: htmlUrl,
    description: abstract ? abstract.slice(0, 2000) : `Federal funding notice: ${title}`,
    amount_min: null,
    amount_max: null,
    amount_description: null,
    // FR "dates" is free text; we don't fabricate a structured deadline.
    deadline: null,
    deadline_type: null,
    is_national: true,
    state: 'nationwide',
    categories: ['federal', 'federal_register', 'grant', agencyName.toLowerCase()],
    keywords: ['federal register', 'nofo', 'funding opportunity', 'grant', agencyName.toLowerCase()],
    eligibility_bullets: bullets,
    opportunity_type: 'grant',
    type: 'OPPORTUNITY',
    last_verified_at: null,
    evidence_url: htmlUrl,
    record_origin: 'funding_api',
    requires_501c3: false,
    requires_match: false,
  }
}
