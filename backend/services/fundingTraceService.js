/**
 * Funding Trace Service
 * ---------------------
 * Given a free-text entity (a company, public entity, or individual), trace
 * WHERE that entity gets its funding and return a consolidated list of distinct
 * funding sources that an admin can add to the GrantFlow catalog.
 *
 * Data backbone (factual, deterministic):
 *   - USASpending.gov  — federal awards (contracts + grants) the entity RECEIVED,
 *                        grouped by awarding agency = "who funds them".
 *   - ProPublica 990   — if the entity is a nonprofit, its 990 financials and the
 *                        grantmaker ecosystem around it.
 *
 * AI layer (optional, best-effort): produces explicitly unverified research
 * hypotheses for channels the public datasets miss. Hypotheses never enter the
 * verified source list and can never be added to the funding catalog.
 */

import { fetchWithRetry } from './sources/httpClient.js'
import { searchOrganizations } from '../src/integrations/propublica990.js'
import { invokeJsonWithFallback } from '../utils/aiProviders.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('fundingTrace')

const USASPENDING_API = 'https://api.usaspending.gov/api/v2'

// Federal award type codes. Grants/direct-payments + contracts both count as
// "funding received" for a recipient.
const GRANT_AWARD_TYPES = ['02', '03', '04', '05']
const CONTRACT_AWARD_TYPES = ['A', 'B', 'C', 'D']

// Addability floor: don't offer trivial or stale funders for one-click add.
// A funder is only worth adding to the catalog if it has moved real money
// recently. Tunable via env so ops can adjust without a code change.
export const ADDABILITY_DEFAULTS = Object.freeze({
  minAmount: Number(process.env.FUNDING_TRACE_MIN_AMOUNT) || 25_000,
  maxAgeYears: Number(process.env.FUNDING_TRACE_MAX_AGE_YEARS) || 5,
})

export const FUNDING_TRACE_ENTITY_TYPES = Object.freeze([
  'company',
  'nonprofit',
  'foundation',
  'grantmaker',
  'public_entity',
  'individual',
])

const LEGAL_SUFFIXES = new Set([
  'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'llc', 'llp',
  'lp', 'ltd', 'limited', 'pllc', 'pc', 'foundation',
])

function normalizedEntityName(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function coreEntityName(value) {
  const tokens = normalizedEntityName(value).split(' ').filter(Boolean)
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop()
  return tokens.join(' ')
}

/**
 * Resolve the free-text request to exactly one recipient name present in the
 * returned award evidence. Exact normalized name wins; equality after removal
 * of a trailing legal suffix is the only fuzzy rule. Tied subsidiaries or
 * other broad text hits fail closed as ambiguous.
 */
export function resolveRecipientIdentity(entity, awards = []) {
  const requested = normalizedEntityName(entity)
  const requestedCore = coreEntityName(entity)
  const groups = new Map()
  for (const row of Array.isArray(awards) ? awards : []) {
    const display = String(row?.['Recipient Name'] ?? '').trim()
    const normalized = normalizedEntityName(display)
    if (!normalized) continue
    const current = groups.get(normalized) ?? {
      recipient_name: display,
      normalized_name: normalized,
      core_name: coreEntityName(display),
      award_count: 0,
      total_amount: 0,
    }
    current.award_count += 1
    current.total_amount += parseAmount(row?.['Award Amount'])
    groups.set(normalized, current)
  }

  const candidates = [...groups.values()]
    .map((candidate) => ({
      ...candidate,
      score: candidate.normalized_name === requested
        ? 100
        : candidate.core_name && candidate.core_name === requestedCore
          ? 98
          : 0,
    }))
    .sort((a, b) => b.score - a.score || b.award_count - a.award_count || b.total_amount - a.total_amount)

  const qualified = candidates.filter((candidate) => candidate.score >= 98)
  const bestScore = qualified[0]?.score ?? 0
  const best = qualified.filter((candidate) => candidate.score === bestScore)
  const status = best.length === 1
    ? 'resolved'
    : best.length > 1
      ? 'ambiguous'
      : candidates.length > 0
        ? 'no_exact_identity_match'
        : 'no_recipient_identity'
  const selected = status === 'resolved' ? best[0] : null

  return {
    status,
    requested_name: String(entity ?? '').trim(),
    recipient_name: selected?.recipient_name ?? null,
    normalized_recipient_name: selected?.normalized_name ?? null,
    score: selected?.score ?? null,
    candidates: candidates.slice(0, 8).map((candidate) => ({
      recipient_name: candidate.recipient_name,
      score: candidate.score,
      award_count: candidate.award_count,
      total_amount: candidate.total_amount,
    })),
  }
}

export function resolveOrganizationIdentity(entity, organizations = []) {
  const requested = normalizedEntityName(entity)
  const requestedCore = coreEntityName(entity)
  const candidates = (Array.isArray(organizations) ? organizations : [])
    .filter((organization) => organization && String(organization.name ?? '').trim())
    .map((organization) => {
      const normalized = normalizedEntityName(organization.name)
      const core = coreEntityName(organization.name)
      return {
        organization,
        score: normalized === requested ? 100 : core && core === requestedCore ? 98 : 0,
      }
    })
    .sort((a, b) => b.score - a.score)
  const qualified = candidates.filter((candidate) => candidate.score >= 98)
  const bestScore = qualified[0]?.score ?? 0
  const best = qualified.filter((candidate) => candidate.score === bestScore)
  return {
    status: best.length === 1 ? 'resolved' : best.length > 1 ? 'ambiguous' : 'no_exact_identity_match',
    match: best.length === 1 ? best[0].organization : null,
    candidates: candidates.slice(0, 8).map(({ organization, score }) => ({
      name: organization.name,
      state: organization.state ?? null,
      score,
    })),
  }
}

export function isVerifiedTraceSource(source) {
  if (source?.origin !== 'usaspending' || source?.evidence_status !== 'verified_award_record') return false
  if (!source?.recipient_name || !source?.sample_url) return false
  try {
    const host = new URL(source.sample_url).hostname.toLowerCase()
    return host === 'usaspending.gov' || host.endsWith('.usaspending.gov')
  } catch {
    return false
  }
}

/**
 * Decide whether a traced source is worth offering for one-click add.
 *
 * Applies only to verified federal-award evidence: requires resolved recipient
 * identity, an official evidence URL, a total at or above `minAmount`, and a
 * known most-recent award within `maxAgeYears`. Unknowns fail closed.
 *
 * @returns {boolean}
 */
export function isSourceAddable(source, { minAmount, maxAgeYears, now = new Date() } = {}) {
  const min = Number.isFinite(minAmount) ? minAmount : ADDABILITY_DEFAULTS.minAmount
  const maxAge = Number.isFinite(maxAgeYears) ? maxAgeYears : ADDABILITY_DEFAULTS.maxAgeYears

  if (!isVerifiedTraceSource(source)) return false
  if (Number(source.total_amount) < min) return false
  if (!Number.isFinite(Number(source.latest_year))) return false
  const cutoff = now.getFullYear() - maxAge
  return Number(source.latest_year) >= cutoff
}

/**
 * Query USASpending for every award a named recipient received within a window.
 * Returns raw award rows (un-consolidated).
 */
async function fetchRecipientAwards(entity, { awardTypeCodes, sinceYears = 5, limit = 100 } = {}) {
  const end = new Date()
  const start = new Date()
  start.setFullYear(start.getFullYear() - sinceYears)

  const payload = {
    filters: {
      recipient_search_text: [entity],
      award_type_codes: awardTypeCodes,
      time_period: [{ start_date: start.toISOString().slice(0, 10), end_date: end.toISOString().slice(0, 10) }],
    },
    fields: [
      'Award ID',
      'Recipient Name',
      'Award Amount',
      'Awarding Agency',
      'Awarding Sub Agency',
      'Award Type',
      'Start Date',
      'Description',
    ],
    page: 1,
    limit,
    order: 'desc',
    sort: 'Award Amount',
  }

  try {
    const rows = []
    const seenAwards = new Set()
    for (let page = 1; page <= 10; page += 1) {
      const data = await fetchWithRetry(`${USASPENDING_API}/search/spending_by_award/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: { ...payload, page },
        timeout: 60000,
      })
      const batch = Array.isArray(data?.results) ? data.results : []
      for (const row of batch) {
        const awardId = String(row?.['Award ID'] ?? '').trim()
        const key = awardId || JSON.stringify(row)
        if (seenAwards.has(key)) continue
        seenAwards.add(key)
        rows.push(row)
      }
      if (data?.page_metadata?.hasNext !== true || batch.length === 0) break
    }
    return { rows, error: null }
  } catch (err) {
    log.warn(`[fundingTrace] USASpending query failed for "${entity}": ${err?.message}`)
    return { rows: [], error: err?.message ?? String(err) }
  }
}

function parseAmount(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function yearOf(dateStr) {
  if (!dateStr) return null
  const y = Number(String(dateStr).slice(0, 4))
  return Number.isFinite(y) ? y : null
}

/**
 * ────────────────────────────────────────────────────────────────────────────
 * consolidateFundingSources — THE core business decision (see request below).
 * ────────────────────────────────────────────────────────────────────────────
 * Collapse raw federal-award rows into distinct, rankable funding SOURCES.
 *
 * @param {Array<object>} awards  raw USASpending rows (mixed grants + contracts)
 * @returns {Array<object>} consolidated sources, each:
 *   { key, name, parent_agency, type, total_amount, award_count, latest_year,
 *     sample_award_id, sample_url }
 *
 * Groups by Awarding Sub Agency (the specific funding office, e.g. "Navy",
 * "National Cancer Institute") — falling back to the parent agency when a row
 * has no sub-agency. This is more actionable for outreach than rolling
 * everything up to the department level. See the note after this function for
 * the trade-offs an admin might want to tune.
 */
export function consolidateFundingSources(awards) {
  const bySubAgency = new Map()

  for (const row of awards) {
    const agency = (row['Awarding Agency'] || '').trim()
    const subAgency = (row['Awarding Sub Agency'] || '').trim()
    // The funder is the sub-agency when present; otherwise the department itself.
    const funder = subAgency || agency
    if (!funder) continue

    const amount = parseAmount(row['Award Amount'])
    const year = yearOf(row['Start Date'])
    const awardId = row['Award ID'] || null
    // Key on parent + funder so identically-named offices under different
    // departments don't collide.
    const groupKey = `${agency}::${funder}`

    const existing = bySubAgency.get(groupKey)
    if (existing) {
      existing.total_amount += amount
      existing.award_count += 1
      if (year && (!existing.latest_year || year > existing.latest_year)) existing.latest_year = year
      // Track the largest single award as the representative sample.
      if (amount > existing._max_amount) {
        existing._max_amount = amount
        existing.sample_award_id = awardId
      }
    } else {
      bySubAgency.set(groupKey, {
        key: `usaspending:${groupKey}`,
        name: funder,
        // Parent department for context; null when the funder IS the department.
        parent_agency: subAgency && agency !== subAgency ? agency : null,
        type: 'federal_agency',
        total_amount: amount,
        award_count: 1,
        latest_year: year,
        sample_award_id: awardId,
        _max_amount: amount,
      })
    }
  }

  return Array.from(bySubAgency.values())
    .map(({ _max_amount, ...src }) => ({
      ...src,
      sample_url: src.sample_award_id
        ? `https://www.usaspending.gov/award/${encodeURIComponent(src.sample_award_id)}`
        : null,
    }))
    // Rank by total dollars received — the biggest funders first.
    .sort((a, b) => b.total_amount - a.total_amount)
}

/**
 * Best-effort AI hypotheses for channels public award data will not show. They
 * are research prompts only: never verified, never addable, never merged into
 * the evidence-backed `sources` collection.
 */
async function aiFundingChannels(entity, entityType) {
  const prompt = `You are a funding-research analyst. The user wants to know WHERE the following ${entityType} gets its funding.

Entity: "${entity}"

Return STRICT JSON: an array (max 8) of likely funding SOURCES under the key "sources".
Each item: { "name": string, "type": one of ["federal_agency","foundation","venture_capital","corporate_csr","parent_company","state_agency","other"], "rationale": short string }.
Only include sources you are reasonably confident about. Do NOT invent specific dollar amounts.`

  try {
    const result = await invokeJsonWithFallback({
      system: 'You output only valid JSON. No prose.',
      prompt,
      maxTokens: 900,
      anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
    })
    if (!result?.ok) return []
    const arr = Array.isArray(result.json?.sources) ? result.json.sources : []
    return arr
      .filter((s) => s && typeof s.name === 'string' && s.name.trim())
      .map((s) => ({
        key: `ai:${s.name.trim().toLowerCase()}`,
        name: s.name.trim(),
        type: s.type || 'other',
        rationale: s.rationale || null,
        origin: 'ai_synthesis',
        evidence_status: 'unverified_hypothesis',
        classification: 'research_hypothesis_not_funding_source',
        addable: false,
        total_amount: null,
        award_count: null,
      }))
  } catch (err) {
    log.warn(`[fundingTrace] AI synthesis failed: ${err?.message}`)
    return []
  }
}

/**
 * Flag which traced sources already exist in the GrantFlow catalog so the admin
 * isn't offered duplicates. Matches on sponsor/title name (case-insensitive).
 */
async function markExistingInCatalog(db, sources) {
  if (!sources.length) return sources
  try {
    const rows = await db
      .prepare(`SELECT DISTINCT LOWER(sponsor) AS sponsor FROM funding_opportunities WHERE sponsor IS NOT NULL`)
      .all()
    const known = new Set(rows.map((r) => r.sponsor))
    return sources.map((s) => ({ ...s, already_in_catalog: known.has(s.name.toLowerCase()) }))
  } catch (err) {
    log.warn(`[fundingTrace] catalog dedupe check failed: ${err?.message}`)
    return sources.map((s) => ({ ...s, already_in_catalog: false }))
  }
}

/**
 * Main entry point. Trace an entity's funding into a consolidated, addable list.
 */
export async function traceFunding(db, { entity, entityType = 'company', useAi = false, addability = {} } = {}) {
  const clean = String(entity || '').trim()
  if (!clean) throw new Error('entity is required')

  // 1) Pull federal awards received (grants + contracts) in parallel.
  const [grantQuery, contractQuery] = await Promise.all([
    fetchRecipientAwards(clean, { awardTypeCodes: GRANT_AWARD_TYPES }),
    fetchRecipientAwards(clean, { awardTypeCodes: CONTRACT_AWARD_TYPES }),
  ])
  const grantRows = grantQuery.rows
  const contractRows = contractQuery.rows
  const allAwardRows = [...grantRows, ...contractRows]
  const recipientResolution = resolveRecipientIdentity(clean, allAwardRows)
  const matchedAwardRows = recipientResolution.status === 'resolved'
    ? allAwardRows.filter((row) => normalizedEntityName(row?.['Recipient Name']) === recipientResolution.normalized_recipient_name)
    : []
  const federalSources = consolidateFundingSources(matchedAwardRows).map((source) => {
    const evidenced = {
      ...source,
      origin: 'usaspending',
      evidence_status: 'verified_award_record',
      classification: 'evidence_backed_funder',
      recipient_name: recipientResolution.recipient_name,
      entity_resolution_score: recipientResolution.score,
    }
    return { ...evidenced, addable: isSourceAddable(evidenced, addability) }
  })

  // 2) ProPublica 990 — is the entity itself a nonprofit? (context + 990 link)
  let nonprofitMatch = null
  let nonprofitResolution = { status: 'unavailable', candidates: [] }
  let nonprofitError = null
  try {
    const pp = await searchOrganizations({ q: clean })
    nonprofitResolution = resolveOrganizationIdentity(clean, pp.organizations ?? [])
    nonprofitMatch = nonprofitResolution.match
  } catch (err) {
    nonprofitError = err?.message ?? String(err)
    log.warn(`[fundingTrace] ProPublica lookup failed: ${err?.message}`)
  }

  // 3) Optional AI hypotheses stay separate from evidence-backed sources.
  const researchHypotheses = useAi ? await aiFundingChannels(clean, entityType) : []
  const sources = await markExistingInCatalog(db, federalSources)

  return {
    entity: clean,
    entity_type: entityType,
    recipient_resolution: recipientResolution,
    nonprofit_match: nonprofitMatch,
    nonprofit_resolution: {
      status: nonprofitResolution.status,
      candidates: nonprofitResolution.candidates,
    },
    data_sources: {
      usaspending: {
        status: grantQuery.error && contractQuery.error
          ? 'unavailable'
          : grantQuery.error || contractQuery.error
            ? 'partial'
            : 'complete',
        grant_query_error: grantQuery.error,
        contract_query_error: contractQuery.error,
      },
      propublica: {
        status: nonprofitError ? 'unavailable' : 'complete',
        error: nonprofitError,
      },
    },
    addability: {
      min_amount: Number.isFinite(addability.minAmount) ? addability.minAmount : ADDABILITY_DEFAULTS.minAmount,
      max_age_years: Number.isFinite(addability.maxAgeYears) ? addability.maxAgeYears : ADDABILITY_DEFAULTS.maxAgeYears,
    },
    counts: {
      federal_grant_awards: grantRows.length,
      federal_contract_awards: contractRows.length,
      matched_recipient_awards: matchedAwardRows.length,
      total_sources: sources.length,
      addable_sources: sources.filter((s) => s.addable !== false).length,
      research_hypotheses: researchHypotheses.length,
    },
    sources,
    research_hypotheses: researchHypotheses,
  }
}

/**
 * Map a traced funding source into a GrantFlow funding_opportunities payload,
 * compatible with POST /api/opportunities (validateFundingTerms + normalize).
 */
export function traceSourceToOpportunity(source, entity) {
  if (!isVerifiedTraceSource(source) || source?.addable !== true || !isSourceAddable(source)) {
    const error = new Error('Only verified, addable USASpending award evidence can be added to the catalog')
    error.code = 'UNVERIFIED_TRACE_SOURCE'
    throw error
  }
  const fundingType =
    source.type === 'foundation' ? 'foundation' : source.type === 'federal_agency' ? 'government' : 'other'

  const descBits = [
    `Identified as a funding source for "${entity}".`,
    source.award_count ? `${source.award_count} federal award(s) traced` : null,
    source.total_amount ? `Total traced: $${Number(source.total_amount).toLocaleString()}` : null,
    source.latest_year ? `Most recent: ${source.latest_year}` : null,
    source.parent_agency ? `Part of: ${source.parent_agency}` : null,
    source.rationale ? `Note: ${source.rationale}` : null,
  ].filter(Boolean)

  return {
    title: `${source.name} — Funding Source`,
    sponsor: source.name,
    source: 'funding_trace.usaspending',
    source_id: source.key,
    source_url: source.sample_url || null,
    description: descBits.join(' '),
    amount_min: null,
    // A multi-year cumulative USASpending total is not a per-award ceiling
    // (the Coca-Cola "$42M appropriation is not a per-award ceiling" class).
    // The real figure stays as text in amount_description, never a fabricated
    // numeric ceiling other surfaces would read as "up to $X per award".
    amount_max: null,
    amount_description: source.total_amount ? `Traced total: $${Number(source.total_amount).toLocaleString()}` : null,
    deadline: null,
    deadline_type: 'rolling',
    is_national: true,
    state: 'nationwide',
    categories: ['funding-source', source.type].filter(Boolean),
    keywords: [source.type, 'funding-trace'].filter(Boolean),
    eligibility_bullets: [],
    opportunity_type: 'grant',
    type: 'DIRECTORY',
    // A traced funder is a POINTER — it names an agency that has funded someone,
    // never an award anyone can apply to. `type:'DIRECTORY'` alone is invisible
    // to every pointer predicate in the product: `isPointerKind`
    // (config/opportunityKindClasses.js), the awardable census
    // (coverageAudit/profileResultCoverageAudit.js) and the amount-answer census
    // all read `opportunity_kind`, and a NULL kind is UNCLASSIFIED — never
    // "awardable". Declaring the canonical lowercase kind here is what makes
    // these rows count honestly as directories instead of inflating the
    // apply-to headline.
    opportunity_kind: 'directory',
    record_origin: 'funding_trace',
    funding_source_type: fundingType,
    requires_501c3: false,
    requires_match: false,
  }
}
