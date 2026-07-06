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

  // IMPORTANT: Do NOT pass `include_fields`. Empirically the NIH RePORTER v2
  // API returns rows as EMPTY objects ({}) when `include_fields` is set — the
  // field names in the public docs do not match what the server honours.
  // Omitting the clause returns the full projection (~44 keys per row) with
  // all of project_num, project_title, project_detail_url, agency_ic_admin,
  // organization.{org_name,org_state,...}, award_amount, etc. populated.
  // Verified against https://api.reporter.nih.gov/v2/projects/search on
  // 2026-04-17; the filtered-field response was 0% populated.
  const body = {
    criteria: {
      ...(text ? { advanced_text_search: { operator: 'and', search_field: 'all', search_text: text } } : {}),
    },
    offset,
    limit,
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
  return rows.map((row) => normalizeNihReporterRow(row)).filter((row) => row !== null)
}

/**
 * Comparable funded awards for proposal grounding (Deliverable: comparable-
 * awards panel + Hamilton drafting reference context).
 *
 * Returns CLEAN reference rows — real, historical NIH awards — labeled for
 * "reference only" use. These are OTHER applicants' awards: they may inform
 * structure/framing of a draft but must NEVER be asserted as applicant facts
 * (G0). Same live RePORTER API as fetchOpportunities; no key required.
 *
 * @param {Object=} query
 * @param {string=} query.text free-text search (profile/opportunity keywords)
 * @param {number=} query.limit max rows to return (default 5)
 * @returns {Promise<Array<{title:string, recipient:string|null, recipient_state:string|null,
 *   amount:number|null, agency:string|null, detail_url:string|null,
 *   project_start:string|null, project_end:string|null, source:'nih.reporter',
 *   reference_only:true}>>}
 */
export async function fetchComparableAwards(query = {}) {
  const { text = '', limit = 5 } = query
  const body = {
    criteria: {
      ...(text ? { advanced_text_search: { operator: 'and', search_field: 'all', search_text: text } } : {}),
    },
    offset: 0,
    // Over-fetch a little so rows dropped for missing title/id still leave
    // enough clean references.
    limit: Math.min(25, Math.max(10, limit * 2)),
  }

  /** @type {any} */
  const data = await requestJson({
    provider: 'nih.reporter',
    url: NIH_REPORTER_PROJECTS_SEARCH_URL,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    data: body,
    timeoutMs: 25_000,
    maxRetries: 2,
  })

  const rows = Array.isArray(data?.results) ? data.results : []
  const out = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const title = firstString(row?.project_title)
    const projectNum = firstString(row?.project_num, row?.appl_id, row?.core_project_num)
    if (!title || !projectNum) continue // no invented/placeholder rows (G0)

    const orgObj = row?.organization && typeof row.organization === 'object' ? row.organization : null
    const icObj = row?.agency_ic_admin && typeof row.agency_ic_admin === 'object' ? row.agency_ic_admin : null
    const applId = firstString(row?.appl_id)
    out.push({
      title,
      recipient: firstString(orgObj?.org_name),
      recipient_state: firstString(orgObj?.org_state),
      amount:
        typeof row?.award_amount === 'number' && Number.isFinite(row.award_amount)
          ? row.award_amount
          : null,
      agency: firstString(icObj?.name, icObj?.abbreviation, row?.agency_code) || 'National Institutes of Health',
      detail_url: firstString(
        row?.project_detail_url,
        applId ? `https://reporter.nih.gov/project-details/${encodeURIComponent(applId)}` : null,
      ),
      project_start: firstString(row?.project_start_date),
      project_end: firstString(row?.project_end_date),
      source: 'nih.reporter',
      reference_only: true,
    })
    if (out.length >= limit) break
  }
  return out
}

function firstString(...candidates) {
  for (const c of candidates) {
    const v = toTrimmedStringOrNull(c)
    if (v) return v
  }
  return null
}

function normalizeNihReporterRow(row) {
  if (!row || typeof row !== 'object') return null

  // project_num is the canonical short id; appl_id is the unique application id.
  const projectNum = firstString(row?.project_num, row?.appl_id, row?.core_project_num)
  const applId = firstString(row?.appl_id)
  const sourceId = projectNum || applId
  // Skip rows with no stable identifier — cannot be deduplicated or re-verified.
  if (!sourceId) return null

  const title = firstString(row?.project_title, row?.core_project_num && `NIH project ${row.core_project_num}`)
  // Skip rows that truly carry no title — the reviewer/validator would reject
  // them anyway, and a generic fallback like "NIH Funded Project" on every
  // record becomes a placeholder flood in the UI.
  if (!title) return null

  // agency_ic_admin is an OBJECT: { code, abbreviation, name, admin_org_id, admin_funding_url }
  const icObj = row?.agency_ic_admin && typeof row.agency_ic_admin === 'object' ? row.agency_ic_admin : null
  const ic = firstString(icObj?.name, icObj?.abbreviation, icObj?.code, row?.agency_code)

  // organization is an OBJECT with org_name / org_state / org_city.
  const orgObj = row?.organization && typeof row.organization === 'object' ? row.organization : null
  const org = firstString(orgObj?.org_name, orgObj?.city)
  const orgState = firstString(orgObj?.org_state) // 2-letter code

  const detailUrl = firstString(
    row?.project_detail_url,
    applId ? `https://reporter.nih.gov/project-details/${encodeURIComponent(applId)}` : null,
    projectNum ? `https://reporter.nih.gov/search?pn=${encodeURIComponent(projectNum)}` : null,
  )

  const start = firstString(row?.project_start_date)
  const end = firstString(row?.project_end_date)

  const awardAmount =
    typeof row?.award_amount === 'number' && Number.isFinite(row.award_amount)
      ? row.award_amount
      : null

  const categories = ['nih', 'research', 'award']
  if (ic) categories.push(`ic:${ic.toLowerCase()}`)

  const keywords = ['nih', 'reporter']
  if (ic) keywords.push(ic.toLowerCase())
  if (orgState) keywords.push(orgState.toLowerCase())

  /** @type {import('./types.js').FundingOpportunity} */
  return {
    title,
    sponsor: ic || 'National Institutes of Health',
    source: 'nih.reporter',
    source_id: sourceId,
    source_url: detailUrl,
    application_url: detailUrl, // NIH RePORTER detail page is the public entry point
    description: org
      ? `NIH-funded research award. Recipient: ${org}${orgState ? ` (${orgState})` : ''}.`
      : 'NIH-funded research award (historical).',
    amount_min: null,
    amount_max: awardAmount,
    amount_description: (awardAmount !== null && awardAmount !== undefined) ? 'Total award amount (reported)' : null,
    deadline: end || null,
    deadline_type: 'rolling', // Historical awards — never treat as a firm deadline.
    is_national: true,
    state: orgState || 'nationwide',
    categories,
    keywords,
    eligibility_bullets: [
      start ? `Start: ${start}` : null,
      end ? `End: ${end}` : null,
      org ? `Recipient: ${org}` : null,
    ].filter(Boolean),
    opportunity_type: 'award',
    type: 'PROGRAM',
    last_verified_at: new Date().toISOString(),
    evidence_url: detailUrl,
    record_origin: 'funding_api',
    requires_501c3: false,
    requires_match: false,
    is_active: 1,
  }
}

