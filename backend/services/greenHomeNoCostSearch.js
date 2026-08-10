import { searchItemNeeds } from './itemNeedSearch.js'
import {
  GREEN_HOME_NO_COST_POLICY_VERSION,
  GREEN_HOME_SEARCH_ITEMS,
  classifyNoCostGreenHomeResult,
  officialGreenHomePaths,
} from './greenHomeNoCostPolicy.js'

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
    no_cost_classification: classification.status,
    no_cost_reason: classification.reason,
    no_cost_evidence: classification.no_cost_evidence || result.no_cost_evidence || null,
    no_cost_source_trust: classification.source_trust || null,
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

  const state = String(
    profile.state ||
    profile.state_code ||
    sections.basic_information?.state ||
    sections.basic_information?.answers?.state ||
    profileContext?.signals?.location?.state ||
    '',
  ).trim().toUpperCase() || null

  return {
    occupancy,
    state,
    provider_must_confirm_eligibility: true,
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

  const report = await searchItemNeedsImpl(db, {
    profileId,
    items: GREEN_HOME_SEARCH_ITEMS,
    profileContext,
    variant: 'funding',
    timeoutMs,
  })

  const eligible = new Map()
  const review = new Map()
  const excludedCounts = new Map()

  for (const itemReport of report.items || []) {
    for (const result of itemReport.results || []) {
      const classification = classifyNoCostGreenHomeResult(result)
      if (classification.status === 'eligible') {
        addCandidate(eligible, result, classification, itemReport.item)
      } else if (classification.status === 'review') {
        addCandidate(review, result, classification, itemReport.item)
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
        }
      : {
          status: 'review',
          reason: program.no_cost_reason,
          no_cost_evidence: program.no_cost_evidence,
          source_trust: 'official_government',
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
  const household = deriveHouseholdContext(profileContext || {})
  const laneSummary = summarizeLanes(report)

  return {
    success: true,
    profile_id: String(profileId),
    policy_version: GREEN_HOME_NO_COST_POLICY_VERSION,
    strict_no_cost: true,
    household,
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
      'Only explicitly no-cost, non-loan paths are shown. Tax credits, rebates, reimbursement-only offers, leases, financing, required contributions, and sources with unknown cost terms are withheld from the primary results.',
    searched_at: new Date().toISOString(),
  }
}

export default {
  searchGreenHomeNoCostPrograms,
}
