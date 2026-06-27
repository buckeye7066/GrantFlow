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
 * AI layer (optional, best-effort): classifies the entity and surfaces likely
 * funding channels the public datasets miss (e.g. VC backers, parent companies,
 * corporate CSR programs). Never required — the service degrades to public data.
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

/**
 * Decide whether a traced source is worth offering for one-click add.
 *
 * Applies to data-backed (federal) sources: requires a total at or above
 * `minAmount` AND a most-recent award within `maxAgeYears`. Sources with no
 * dollar data (e.g. AI-identified channels) are not subject to the dollar
 * floor — they keep whatever `addable` flag they arrived with.
 *
 * @returns {boolean}
 */
export function isSourceAddable(source, { minAmount, maxAgeYears, now = new Date() } = {}) {
  const min = Number.isFinite(minAmount) ? minAmount : ADDABILITY_DEFAULTS.minAmount
  const maxAge = Number.isFinite(maxAgeYears) ? maxAgeYears : ADDABILITY_DEFAULTS.maxAgeYears

  // No dollar signal (AI sources): defer to the source's own flag.
  if (source.total_amount === null || source.total_amount === undefined) return source.addable !== false

  if (Number(source.total_amount) < min) return false

  // Recency floor — only enforced when we know the latest year.
  if (source.latest_year !== null && source.latest_year !== undefined) {
    const cutoff = now.getFullYear() - maxAge
    if (source.latest_year < cutoff) return false
  }
  return true
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
    const data = await fetchWithRetry(`${USASPENDING_API}/search/spending_by_award/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      data: payload,
      timeout: 60000,
    })
    return Array.isArray(data?.results) ? data.results : []
  } catch (err) {
    log.warn(`[fundingTrace] USASpending query failed for "${entity}": ${err?.message}`)
    return []
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
 * Best-effort AI synthesis: classify the entity and name likely funding channels
 * that public award data won't show (VC, parent company, corporate foundations).
 * Returns [] on any failure or when no AI provider is configured.
 */
async function aiFundingChannels(entity, entityType) {
  const prompt = `You are a funding-research analyst. The user wants to know WHERE the following ${entityType} gets its funding.

Entity: "${entity}"

Return STRICT JSON: an array (max 8) of likely funding SOURCES under the key "sources".
Each item: { "name": string, "type": one of ["federal_agency","foundation","venture_capital","corporate_csr","parent_company","state_agency","other"], "rationale": short string, "addable": boolean (true only if it is a real, nameable grantmaking/funding ORGANIZATION an admin could add to a grant catalog) }.
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
        addable: s.addable !== false,
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
export async function traceFunding(db, { entity, entityType = 'company', useAi = true, addability = {} } = {}) {
  const clean = String(entity || '').trim()
  if (!clean) throw new Error('entity is required')

  // 1) Pull federal awards received (grants + contracts) in parallel.
  const [grantRows, contractRows] = await Promise.all([
    fetchRecipientAwards(clean, { awardTypeCodes: GRANT_AWARD_TYPES }),
    fetchRecipientAwards(clean, { awardTypeCodes: CONTRACT_AWARD_TYPES }),
  ])
  const federalSources = consolidateFundingSources([...grantRows, ...contractRows]).map((s) => ({
    ...s,
    origin: 'usaspending',
    addable: isSourceAddable(s, addability),
  }))

  // 2) ProPublica 990 — is the entity itself a nonprofit? (context + 990 link)
  let nonprofitMatch = null
  try {
    const pp = await searchOrganizations({ q: clean })
    nonprofitMatch = pp.organizations?.[0] ?? null
  } catch (err) {
    log.warn(`[fundingTrace] ProPublica lookup failed: ${err?.message}`)
  }

  // 3) Optional AI synthesis for channels the public data misses.
  const aiSources = useAi ? await aiFundingChannels(clean, entityType) : []

  // 4) Merge + dedupe by name (federal/public data wins over AI guesses).
  const merged = []
  const seen = new Set()
  for (const s of [...federalSources, ...aiSources]) {
    const k = s.name.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    merged.push(s)
  }

  const sources = await markExistingInCatalog(db, merged)

  return {
    entity: clean,
    entity_type: entityType,
    nonprofit_match: nonprofitMatch,
    addability: {
      min_amount: Number.isFinite(addability.minAmount) ? addability.minAmount : ADDABILITY_DEFAULTS.minAmount,
      max_age_years: Number.isFinite(addability.maxAgeYears) ? addability.maxAgeYears : ADDABILITY_DEFAULTS.maxAgeYears,
    },
    counts: {
      federal_grant_awards: grantRows.length,
      federal_contract_awards: contractRows.length,
      total_sources: sources.length,
      addable_sources: sources.filter((s) => s.addable !== false).length,
    },
    sources,
  }
}

/**
 * Map a traced funding source into a GrantFlow funding_opportunities payload,
 * compatible with POST /api/opportunities (validateFundingTerms + normalize).
 */
export function traceSourceToOpportunity(source, entity) {
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
    source: source.origin === 'ai_synthesis' ? 'funding_trace.ai' : 'funding_trace.usaspending',
    source_id: source.key,
    source_url: source.sample_url || null,
    description: descBits.join(' '),
    amount_min: null,
    amount_max: source.total_amount || null,
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
    record_origin: 'funding_trace',
    funding_source_type: fundingType,
    requires_501c3: false,
    requires_match: false,
  }
}
