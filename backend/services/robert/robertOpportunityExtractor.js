/**
 * robertOpportunityExtractor.js
 *
 * Extracts opportunity candidates from a fetched payload (HTML, JSON,
 * structured API response). The extractor is INTENTIONALLY simple at
 * this stage — it accepts an array of structured records returned by
 * the caller's source-specific adapter (Grants.gov API, Benefits.gov,
 * a foundation crawler, etc.) and turns them into Robert candidate
 * shapes.
 *
 * No live HTML parsing here. If a caller wants to extract from raw
 * HTML, they should plug in a parser (e.g. cheerio) and pass the
 * structured output back to `extractCandidates`. This keeps the
 * unit tests deterministic.
 */

import { extractDomain, makeOpportunityCandidate } from './robertTypes.js'
import { isPlaceholderUrl, isSearchEngineUrl } from './robertSafety.js'

/**
 * Convert a list of raw structured records into Robert candidate shapes.
 *
 * @param {object} args
 * @param {object[]} args.records          source-adapter-shaped records
 * @param {string}   [args.sourceCandidateId]
 * @param {string}   [args.runId]
 * @param {string}   [args.extractionMethod] e.g. 'grants_gov_api', 'foundation_html', 'manual'
 * @returns {{ candidates, dropped, reasons }}
 */
export function extractCandidates({ records = [], sourceCandidateId = null, runId = null, extractionMethod = 'unknown' } = {}) {
  const candidates = []
  const reasons = []
  let dropped = 0
  if (!Array.isArray(records)) return { candidates, dropped, reasons }
  for (const raw of records) {
    if (!raw || typeof raw !== 'object') { dropped += 1; reasons.push('not_object'); continue }

    const application_url = pickFirst(raw, [
      'application_url', 'apply_url', 'apply_link', 'opportunity_url', 'url', 'link',
    ])
    const source_url = pickFirst(raw, [
      'source_url', 'detail_url', 'page_url', application_url ? null : 'url', application_url ? null : 'link',
    ].filter(Boolean))

    // Both the source URL and application URL must be real and not search-engine results.
    const checkUrl = source_url || application_url
    if (!checkUrl) { dropped += 1; reasons.push('no_url'); continue }
    if (isPlaceholderUrl(checkUrl)) { dropped += 1; reasons.push('placeholder_url'); continue }
    if (isSearchEngineUrl(application_url) || isSearchEngineUrl(source_url)) {
      dropped += 1; reasons.push('search_engine_url'); continue
    }

    const candidate = makeOpportunityCandidate({
      run_id: runId,
      source_candidate_id: sourceCandidateId,
      title: pickFirst(raw, ['title', 'name', 'opportunity_title', 'program_name']),
      sponsor: pickFirst(raw, ['sponsor', 'agency', 'funder', 'agency_name', 'sponsoring_organization']),
      description: pickFirst(raw, ['description', 'summary', 'details', 'overview']),
      application_url,
      source_url,
      deadline: pickFirst(raw, ['deadline', 'close_date', 'application_deadline', 'closing_date']),
      deadline_type: pickFirst(raw, ['deadline_type', 'deadline_kind']) || classifyDeadlineType(raw),
      amount_min: numberOrNull(pickFirst(raw, ['amount_min', 'award_floor', 'min_amount'])),
      amount_max: numberOrNull(pickFirst(raw, ['amount_max', 'award_ceiling', 'max_amount'])),
      amount_description: pickFirst(raw, ['amount_description', 'award_description', 'funding_description']),
      geography: raw.geography || raw.geo || {
        state: raw.state || null,
        is_national: Boolean(raw.is_national),
        county: raw.county || null,
      },
      eligibility: toArray(raw.eligibility || raw.eligibility_bullets || raw.who_can_apply),
      categories: toArray(raw.categories || raw.category || raw.tags),
      keywords: toArray(raw.keywords || raw.tags),
      applicant_types: toArray(raw.applicant_types || raw.eligible_applicants),
      need_categories: toArray(raw.need_categories || raw.need_category),
      raw_payload: raw,
      extraction_method: extractionMethod,
      confidence: confidenceFromRecord(raw),
    })
    candidates.push(candidate)
  }
  return { candidates, dropped, reasons }
}

function pickFirst(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k]
    if (v !== null && v !== undefined && v !== '') return typeof v === 'string' ? v.trim() : v
  }
  return null
}

function toArray(value) {
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v.trim() : v)).filter(Boolean)
  if (typeof value === 'string') return value.split(/[,;]/).map((s) => s.trim()).filter(Boolean)
  return []
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function classifyDeadlineType(raw) {
  const desc = `${raw.deadline || ''} ${raw.deadline_description || ''} ${raw.description || ''}`.toLowerCase()
  if (/rolling|continuous|open\s+enrollment|year[-\s]?round/.test(desc)) return 'rolling'
  if (raw.deadline) return 'fixed'
  return 'unknown'
}

function confidenceFromRecord(raw) {
  let score = 0
  if (raw.title) score += 0.2
  if (raw.sponsor || raw.agency) score += 0.2
  if (raw.application_url || raw.apply_url) score += 0.2
  if (raw.description && String(raw.description).length > 80) score += 0.15
  if (raw.eligibility || raw.eligibility_bullets) score += 0.1
  if (raw.deadline || raw.close_date) score += 0.1
  if (raw.amount_max || raw.award_ceiling) score += 0.05
  return Math.min(1, score)
}

export const __testing__ = { pickFirst, toArray, classifyDeadlineType, confidenceFromRecord }
