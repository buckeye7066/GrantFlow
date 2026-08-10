import { searchItemNeeds } from './itemNeedSearch.js'
import {
  GREEN_HOME_NO_COST_POLICY_VERSION,
  GREEN_HOME_SEARCH_ITEMS,
  classifyNoCostGreenHomeResult,
  officialGreenHomePaths,
} from './greenHomeNoCostPolicy.js'

const OUTBOUND_SEARCH_FIELDS = Object.freeze([
  'profile.state',
  'profile.primary_type',
  'signals.location.state',
  'signals.entityType',
])
const CATALOG_VERIFICATION_MAX_IDS = 200

function normalizedUrl(value) {
  try {
    const url = new URL(String(value || ''))
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|gclid|fbclid)/i.test(key)) url.searchParams.delete(key)
    }
    return url.toString().replace(/\/$/, '').toLowerCase()
  } catch {
    return ''
  }
}

function keyFor(result = {}) {
  const urlKey = normalizedUrl(
    result.source_url || result.url || result.application_url || result.info_url,
  )
  if (urlKey) return `url:${urlKey}`
  const title = String(result.title || result.name || '').trim().toLowerCase()
  const sponsor = String(result.sponsor || result.source || '').trim().toLowerCase()
  return `text:${title}|${sponsor}`
}

function mergeMatchedItems(existing = [], incoming = []) {
  return [...new Set([...existing, ...incoming].map((item) => String(item || '').trim()).filter(Boolean))]
}

function addCandidate(map, result, classification, matchedItem) {
  const key = keyFor(result)
  const previous = map.get(key)
  const candidate = {
    ...result,
    eligibility_status: 'provider_confirmation_required',
    no_cost_classification: classification.status,
    no_cost_reason: classification.reason,
    no_cost_evidence: classification.no_cost_evidence || result.no_cost_evidence || null,
    no_cost_source_trust: classification.source_trust || null,
    no_cost_source_verified_at: classification.source_verified_at || null,
    no_cost_source_age_days: classification.source_age_days ?? null,
    no_cost_policy: GREEN_HOME_NO_COST_POLICY_VERSION,
    matched_green_home_items: mergeMatchedItems(result.matched_green_home_items, [matchedItem]),
  }

  if (!previous) {
    map.set(key, candidate)
    return
  }

  const previousScore = Number(previous.need_score ?? previous.item_relevance_score ?? -1)
  const candidateScore = Number(candidate.need_score ?? candidate.item_relevance_score ?? -1)
  map.set(key, {
    ...(candidateScore > previousScore ? candidate : previous),
    matched_green_home_items: mergeMatchedItems(
      previous.matched_green_home_items,
      candidate.matched_green_home_items,
    ),
  })
}

function cleanState(value) {
  const state = String(value || '').trim().toUpperCase()
  return /^[A-Z]{2}$/.test(state) ? state : null
}

function broadApplicantType(profileContext = {}) {
  const profile = profileContext.profile || profileContext || {}
  const signals = profileContext.signals || {}
  const raw = String(
    profile.primary_type ||
    profile.applicant_type ||
    signals.entityType ||
    '',
  ).trim().toLowerCase().replace(/[_-]+/g, ' ')

  if (/student/.test(raw)) return 'student'
  if (/nonprofit|501|church|ministry/.test(raw)) return 'nonprofit'
  if (/business|company|entrepreneur/.test(raw)) return 'small_business'
  if (/school|college|university|education institution/.test(raw)) return 'school'
  if (/municipal|government|county|city|tribe|tribal/.test(raw)) return 'government'
  if (/family|household|caregiver/.test(raw)) return 'family'
  if (/individual|person|homeowner|renter|tenant/.test(raw)) return 'individual'
  return 'individual'
}

function deriveHouseholdContext(profileContext = {}) {
  const profile = profileContext.profile || profileContext || {}
  const sections = profileContext.sections || {}
  const housing = sections.housing || sections.housing_status || sections.basic_information || {}
  const answers = housing.answers && typeof housing.answers === 'object' ? housing.answers : housing
  const rawStatus = String(
    answers.homeownership_status ||
    answers.housing_status ||
    answers.tenure ||
    profile.homeownership_status ||
    '',
  ).trim().toLowerCase()
  const explicitOwner = [
    answers.is_homeowner,
    answers.owns_home,
    answers.homeowner,
    profile.is_homeowner,
  ].some((value) => value === true || value === 'true' || value === 'yes')
  const explicitRenter = [
    answers.is_renter,
    profile.is_renter,
  ].some((value) => value === true || value === 'true' || value === 'yes')

  let occupancy = 'unknown'
  if (explicitOwner || /owner|own home|mortgage/.test(rawStatus)) occupancy = 'homeowner'
  else if (explicitRenter || /rent|tenant/.test(rawStatus)) occupancy = 'renter'

  const state = cleanState(
    profile.state ||
    profile.state_code ||
    sections.basic_information?.state ||
    sections.basic_information?.answers?.state ||
    profileContext?.signals?.location?.state,
  )

  return {
    occupancy,
    state,
    provider_must_confirm_eligibility: true,
  }
}

/**
 * External search receives only a broad applicant class and two-letter state.
 * It never receives names, contact details, exact address, income/assets,
 * disability or medical facts, veteran identifiers, document contents, or
 * credentials. Eligibility matching remains a provider-confirmed step.
 */
export function minimizeGreenHomeSearchContext(profileContext = {}) {
  const household = deriveHouseholdContext(profileContext)
  const type = broadApplicantType(profileContext)
  const state = household.state
  return {
    profile: {
      primary_type: type,
      ...(state ? { state } : {}),
    },
    signals: {
      entityType: type,
      location: state ? { state } : {},
    },
  }
}

function catalogResultIds(report = {}) {
  return [...new Set(
    (report.items || [])
      .flatMap((item) => item?.results || [])
      .filter((result) => result?.result_source === 'catalog' && result?.id)
      .map((result) => String(result.id)),
  )].slice(0, CATALOG_VERIFICATION_MAX_IDS)
}

function booleanColumn(value) {
  return value === true || value === 1 || value === '1'
}

/**
 * Item search intentionally returns a compact result shape. The green-home
 * policy needs the persisted verification and payment fields as well, so it
 * rehydrates those fields by immutable opportunity id before classification.
 */
export async function loadGreenHomeCatalogVerification(db, report = {}) {
  const ids = catalogResultIds(report)
  const byId = new Map()
  if (ids.length === 0 || !db || typeof db.prepare !== 'function') {
    return { byId, requested: ids.length, enriched: 0, error: null }
  }

  const placeholders = ids.map(() => '?').join(', ')
  try {
    const rows = await db.prepare(
      `SELECT id, source_url, application_url, final_url,
              last_verified_at, link_status, link_status_code,
              verification_method, verified_by, verified_url,
              verification_status, source_trust_tier, record_origin,
              reality_status, http_status,
              requires_match, match_percentage, is_loan,
              funding_type, opportunity_type,
              eligibility_text, eligibility_bullets,
              page_fact_schema_version, field_provenance
         FROM funding_opportunities
        WHERE id IN (${placeholders})`,
    ).all(...ids)

    for (const row of rows || []) {
      const id = String(row?.id || '')
      if (!id) continue
      const verifiedStatus =
        booleanColumn(row.verified_url) ||
        ['ok', 'redirect'].includes(String(row.link_status || '').toLowerCase()) ||
        String(row.verification_status || '').toLowerCase() === 'verified_live_url'
      byId.set(id, {
        source_url: row.source_url || null,
        application_url: row.application_url || null,
        final_url: row.final_url || null,
        source_verified_at: row.last_verified_at || null,
        last_verified_at: row.last_verified_at || null,
        link_status: row.link_status || null,
        link_status_code: row.link_status_code ?? null,
        verification_method: row.verification_method || null,
        verified_by: row.verified_by || null,
        source_verified: verifiedStatus,
        verification_status: row.verification_status || null,
        source_trust_tier: row.source_trust_tier || null,
        record_origin: row.record_origin || null,
        reality_status: row.reality_status || null,
        http_status: row.http_status ?? null,
        requires_match: booleanColumn(row.requires_match),
        match_percentage: row.match_percentage ?? null,
        is_loan: booleanColumn(row.is_loan),
        funding_type: row.funding_type || null,
        opportunity_type: row.opportunity_type || null,
        eligibility_text: row.eligibility_text || null,
        eligibility_bullets: row.eligibility_bullets || null,
        page_fact_schema_version: row.page_fact_schema_version ?? null,
        field_provenance: row.field_provenance || null,
      })
    }
    return { byId, requested: ids.length, enriched: byId.size, error: null }
  } catch (error) {
    return {
      byId,
      requested: ids.length,
      enriched: 0,
      error: error?.message || String(error),
    }
  }
}

function summarizeLanes(report = {}) {
  const items = Array.isArray(report.items) ? report.items : []
  return {
    searched_items: items.length,
    catalog_scanned: items.reduce((sum, item) => sum + Number(item?.lanes?.catalog?.scanned || 0), 0),
    catalog_matched_before_no_cost_policy: items.reduce((sum, item) => sum + Number(item?.lanes?.catalog?.matched || 0), 0),
    web_attempted: items.some((item) => item?.lanes?.web?.attempted === true),
    web_raw: items.reduce((sum, item) => sum + Number(item?.lanes?.web?.raw_results || 0), 0),
    web_matched_before_no_cost_policy: items.reduce((sum, item) => sum + Number(item?.lanes?.web?.matched || 0), 0),
    source_errors: items.flatMap((item) => {
      const errors = []
      if (item?.error) errors.push({ item: item.item, lane: 'item', error: item.error })
      if (item?.lanes?.catalog?.error) errors.push({ item: item.item, lane: 'catalog', error: item.lanes.catalog.error })
      if (item?.lanes?.web?.error) errors.push({ item: item.item, lane: 'web', error: item.lanes.web.error })
      return errors
    }),
  }
}

/**
 * Strict homeowner green-upgrade lane.
 *
 * This lane is intentionally narrower than ordinary item funding. It returns
 * only sources with explicit no-cost evidence and no loan, financing, lease,
 * tax-credit, rebate, reimbursement, match, contribution, or purchase signal.
 * Unknown cost models stay out of the primary results rather than being
 * optimistically presented as free.
 */
export async function searchGreenHomeNoCostPrograms(db, {
  profileId,
  profileContext = null,
  timeoutMs = 12000,
  now = new Date(),
  searchItemNeedsImpl = searchItemNeeds,
  officialGreenHomePathsImpl = officialGreenHomePaths,
} = {}) {
  if (!profileId) {
    const error = new Error('profileId is required')
    error.statusCode = 400
    throw error
  }
  if (typeof searchItemNeedsImpl !== 'function' || typeof officialGreenHomePathsImpl !== 'function') {
    const error = new TypeError('green-home search dependencies must be functions')
    error.statusCode = 500
    throw error
  }

  const household = deriveHouseholdContext(profileContext || {})
  const outboundSearchContext = minimizeGreenHomeSearchContext(profileContext || {})
  const report = await searchItemNeedsImpl(db, {
    profileId,
    items: GREEN_HOME_SEARCH_ITEMS,
    profileContext: outboundSearchContext,
    variant: 'funding',
    timeoutMs,
  })
  const verification = await loadGreenHomeCatalogVerification(db, report)

  const eligible = new Map()
  const review = new Map()
  const excludedCounts = new Map()

  for (const itemReport of report.items || []) {
    for (const result of itemReport.results || []) {
      const persisted = result?.id ? verification.byId.get(String(result.id)) : null
      const enriched = persisted
        ? {
            ...result,
            ...persisted,
            url: persisted.final_url || persisted.application_url || persisted.source_url || result.url,
          }
        : result
      const classification = classifyNoCostGreenHomeResult(enriched, { now })
      if (classification.status === 'eligible') {
        addCandidate(eligible, enriched, classification, itemReport.item)
      } else if (classification.status === 'review') {
        addCandidate(review, enriched, classification, itemReport.item)
      } else {
        excludedCounts.set(
          classification.reason,
          (excludedCounts.get(classification.reason) || 0) + 1,
        )
      }
    }
  }

  // Current official locator paths ensure a qualified household receives a
  // truthful starting point even when the generic web provider is unavailable.
  // They are directories/benefits, not claims that a particular upgrade has
  // already been approved.
  const officialPaths = officialGreenHomePathsImpl(now)
  for (const program of officialPaths) {
    const classification = program.no_cost_classification === 'eligible'
      ? {
          status: 'eligible',
          reason: program.no_cost_reason,
          no_cost_evidence: program.no_cost_evidence,
          source_trust: 'official_government',
          source_verified_at: program.reviewed_at || null,
          source_age_days: program.source_age_days ?? null,
        }
      : {
          status: 'review',
          reason: program.no_cost_reason,
          no_cost_evidence: program.no_cost_evidence,
          source_trust: 'official_government',
          source_verified_at: program.reviewed_at || null,
          source_age_days: program.source_age_days ?? null,
        }
    addCandidate(
      classification.status === 'eligible' ? eligible : review,
      program,
      classification,
      'official low-income home energy assistance',
    )
  }

  const programs = [...eligible.values()].sort((a, b) => {
    const aOfficial = a.no_cost_source_trust === 'official_government' ? 1 : 0
    const bOfficial = b.no_cost_source_trust === 'official_government' ? 1 : 0
    if (aOfficial !== bOfficial) return bOfficial - aOfficial
    return Number(b.need_score ?? b.item_relevance_score ?? 0) - Number(a.need_score ?? a.item_relevance_score ?? 0)
  })

  const reviewRows = [...review.values()]
  const laneSummary = summarizeLanes(report)
  laneSummary.catalog_verification_requested = verification.requested
  laneSummary.catalog_verification_enriched = verification.enriched
  if (verification.error) {
    laneSummary.source_errors.push({
      item: 'green_home_catalog_verification',
      lane: 'catalog_verification',
      error: verification.error,
    })
  }

  return {
    success: true,
    profile_id: String(profileId),
    policy_version: GREEN_HOME_NO_COST_POLICY_VERSION,
    strict_no_cost: true,
    household,
    search_privacy: {
      outbound_fields: [...OUTBOUND_SEARCH_FIELDS],
      sensitive_fields_transmitted: false,
      outbound_context: outboundSearchContext,
    },
    searched_items: [...GREEN_HOME_SEARCH_ITEMS],
    count: programs.length,
    programs,
    review_count: reviewRows.length,
    review_reasons: Object.entries(
      reviewRows.reduce((acc, row) => {
        const reason = row.no_cost_reason || 'review_required'
        acc[reason] = (acc[reason] || 0) + 1
        return acc
      }, {}),
    ).map(([reason, count]) => ({ reason, count })),
    excluded_count: [...excludedCounts.values()].reduce((sum, count) => sum + count, 0),
    excluded_reasons: [...excludedCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    search_coverage: laneSummary,
    source_freshness: officialPaths.map((path) => ({
      id: path.id,
      reviewed_at: path.reviewed_at,
      fresh: path.source_fresh,
      age_days: path.source_age_days,
    })),
    retired_program_guard: {
      solar_for_all: 'excluded_as_terminated_or_rescinded',
    },
    notice:
      'Only explicitly no-cost, non-loan paths are shown. Tax credits, rebates, reimbursement-only offers, leases, financing, required contributions, and sources with unknown or stale verification are withheld from the primary results.',
    searched_at: new Date().toISOString(),
  }
}

export default {
  searchGreenHomeNoCostPrograms,
}
