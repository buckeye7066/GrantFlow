import { requestJson } from './httpClient.js'
import { toTrimmedStringOrNull } from './types.js'

const NIH_REPORTER_PROJECTS_SEARCH_URL = 'https://api.reporter.nih.gov/v2/projects/search'

/**
 * NIH RePORTER Projects Search (no API key required).
 *
 * Notes:
 * - This API returns *awards / funded projects*, not open solicitations.
 * - Treat these as PROGRAM/DIRECTORY-style items (historical awards), not new grant postings.
 *
 * @param {Object=} query
 * @param {string=} query.text - free text search
 * @param {number=} query.limit - max 500 per API docs
 * @param {number=} query.offset - max 14999 per API docs
 * @returns {Promise<Array<import('./types.js').FundingOpportunity>>}
 */
export async function fetchOpportunities(query = {}) {
  const { text = '', limit = 25, offset = 0 } = query

  const body = {
    criteria: {
      ...(text ? { text_search: text } : {}),
    },
    offset,
    limit,
    // Keep response small; callers can request more fields later.
    include_fields: [
      'project_num',
      'project_title',
      'agency_ic_admin',
      'org_name',
      'award_amount',
      'project_start_date',
      'project_end_date',
      'project_detail_url',
    ],
  }

  /** @type {any} */
  const data = await requestJson({
    provider: 'nih.reporter',
    url: NIH_REPORTER_PROJECTS_SEARCH_URL,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    data: body,
    timeoutMs: 25_000,
    maxRetries: 3,
  })

  const rows = Array.isArray(data?.results) ? data.results : []
  return rows.map((row) => normalizeNihReporterRow(row))
}

function normalizeNihReporterRow(row) {
  const projectNum = toTrimmedStringOrNull(row?.project_num) || 'unknown'
  const title = toTrimmedStringOrNull(row?.project_title) || 'NIH Funded Project'
  const ic = toTrimmedStringOrNull(row?.agency_ic_admin) || null
  const org = toTrimmedStringOrNull(row?.org_name) || null

  const detailUrl =
    toTrimmedStringOrNull(row?.project_detail_url) ||
    (projectNum !== 'unknown'
      ? `https://reporter.nih.gov/project-details/${encodeURIComponent(projectNum)}`
      : null)

  const start = toTrimmedStringOrNull(row?.project_start_date)
  const end = toTrimmedStringOrNull(row?.project_end_date)

  const awardAmount =
    typeof row?.award_amount === 'number' && Number.isFinite(row.award_amount)
      ? row.award_amount
      : null

  /** @type {import('./types.js').FundingOpportunity} */
  return {
    title,
    sponsor: ic,
    source: 'nih.reporter',
    source_id: projectNum,
    source_url: detailUrl,
    application_url: null,
    description: org ? `Recipient: ${org}` : null,
    amount_min: null,
    amount_max: awardAmount,
    amount_description: awardAmount != null ? 'Total award amount (reported)' : null,
    deadline: end || null,
    deadline_type: null,
    is_national: true,
    state: 'nationwide',
    categories: ['nih', 'research', 'award'],
    keywords: ['nih', 'reporter', ic?.toLowerCase()].filter(Boolean),
    eligibility_bullets: [
      start ? `Start: ${start}` : null,
      end ? `End: ${end}` : null,
    ].filter(Boolean),
    opportunity_type: 'award',
    type: 'PROGRAM',
    last_verified_at: null,
    record_origin: 'funding_api',
    requires_501c3: false,
    requires_match: false,
  }
}

