/**
 * Parse Grants.gov email digest text into structured opportunity rows.
 *
 * Expected block shape (blank line between entries):
 *   DOS
 *   Department of State
 *   U.S. Mission to Belgium
 *   Opportunity Title
 *   Synopsis 1
 *   https://www.grants.gov/search-results-detail/362469
 */

const GRANTS_GOV_DETAIL_RE = /https:\/\/(?:www\.)?grants\.gov\/search-results-detail\/(\d+)/gi
const NOTICE_TYPE_RE = /^(Synopsis|Forecast)\s+(\d+)$/i
const AGENCY_ACRONYM_RE = /^[A-Z]{2,6}$/

function normalizeLines(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function parseBlockLines(lines, url, opportunityId) {
  if (!lines.length) return null

  let noticeType = null
  let noticeNumber = null
  const lastLine = lines[lines.length - 1]
  const noticeMatch = lastLine.match(NOTICE_TYPE_RE)
  if (noticeMatch) {
    noticeType = noticeMatch[1].toLowerCase()
    noticeNumber = Number(noticeMatch[2])
    lines.pop()
  }

  if (!lines.length) return null

  const title = lines.pop()
  if (!title) return null

  let agencyAcronym = null
  let department = null
  let subAgency = null

  if (lines.length && AGENCY_ACRONYM_RE.test(lines[0])) {
    agencyAcronym = lines.shift()
  }
  if (lines.length) {
    department = lines.shift()
  }
  if (lines.length) {
    subAgency = lines.join(' / ')
  }

  const funderParts = [department, subAgency].filter(Boolean)
  const funder = funderParts.length ? funderParts.join(' — ') : agencyAcronym || 'Federal'

  const noticeLabel =
    noticeType && Number.isFinite(noticeNumber) ? `${noticeType} ${noticeNumber}` : 'Grants.gov listing'

  return {
    opportunity_id: opportunityId,
    agency_acronym: agencyAcronym,
    department,
    sub_agency: subAgency,
    title,
    notice_type: noticeType,
    notice_number: noticeNumber,
    application_url: url,
    url,
    source_url: url,
    funder,
    sponsor: funder,
    source: 'grants.gov',
    record_origin: 'url_import',
    opportunity_number: opportunityId,
    program_description: `${noticeLabel}: ${title}`,
    opportunity_type: 'grant',
    categories: ['federal', 'grants.gov', 'government'],
  }
}

/**
 * @param {string} text - Raw pasted digest text
 * @returns {{ opportunities: object[], parse_errors: string[], total_urls: number }}
 */
export function parseGrantsGovDigest(text) {
  const raw = String(text || '').trim()
  if (!raw) {
    return { opportunities: [], parse_errors: ['No text provided'], total_urls: 0 }
  }

  const matches = [...raw.matchAll(GRANTS_GOV_DETAIL_RE)]
  if (!matches.length) {
    return {
      opportunities: [],
      parse_errors: ['No Grants.gov detail URLs found (expected search-results-detail/{id})'],
      total_urls: 0,
    }
  }

  const opportunities = []
  const parseErrors = []

  matches.forEach((match, index) => {
    const url = match[0]
    const opportunityId = match[1]
    const blockStart = index === 0 ? 0 : matches[index - 1].index + matches[index - 1][0].length
    const blockText = raw.slice(blockStart, match.index)
    const lines = normalizeLines(blockText)

    // Drop known digest header / boilerplate lines anywhere in the preamble.
    const filteredLines = lines.filter(
      (line) => !/^(the following grant opportunities|created, updated, or deleted on grants\.gov)/i.test(line),
    )

    const parsed = parseBlockLines(filteredLines, url, opportunityId)
    if (!parsed) {
      parseErrors.push(`Could not parse entry for opportunity ${opportunityId}`)
      return
    }
    opportunities.push(parsed)
  })

  return {
    opportunities,
    parse_errors: parseErrors,
    total_urls: matches.length,
  }
}

export default parseGrantsGovDigest
