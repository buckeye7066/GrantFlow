function finiteScore(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue
    const number = Number(value)
    if (Number.isFinite(number)) return Math.max(0, Math.min(100, Math.round(number)))
  }
  return 0
}

function asStrings(value) {
  const values = Array.isArray(value) ? value : value ? [value] : []
  return values.map((entry) => String(entry ?? '').trim()).filter(Boolean)
}

function unique(values) {
  const seen = new Set()
  return values.filter((value) => {
    const key = value.toLowerCase()
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Convert one /specific-need result into the card/detail shape.
 *
 * Score truth comes ONLY from backend item-fit fields. There is deliberately no
 * base/default percentage: an unmeasured score renders as 0, never as a
 * convincing 50/75. Nullish coalescing preserves a measured zero.
 */
export function mapBackendItemFundingResult(result = {}) {
  const score = finiteScore(
    result.combined_score,
    result.item_fit_score,
    result.need_score,
    result.need_match?.score,
    result.match_score,
  )
  const decision = String(result.match_decision ?? result.decision ?? '').trim().toLowerCase()
  const loanOrMatch = Boolean(
    result.is_loan ||
    result.requires_match ||
    result.requires_cost_share ||
    /\b(?:loan|debt|matching funds?|cost[- ]?share)\b/i.test(
      `${result.opportunity_type ?? ''} ${result.funding_type ?? ''} ${result.type ?? ''}`,
    ),
  )
  const disqualified = decision === 'reject' || loanOrMatch
  const sourceLabel = result.result_source === 'web_search'
    ? 'Found via live web search'
    : result.result_source === 'item_catalog'
      ? 'Known item source'
      : 'Matched from the verified catalog'
  const eligibilityUnconfirmed = Boolean(
    result.eligibility_confirmed === false ||
    result.eligibility_unconfirmed === true ||
    result.match_explain?.eligibility_unconfirmed === true ||
    result.match_explain_json?.eligibility_unconfirmed === true,
  )

  const reasons = unique([
    ...asStrings(result.need_match?.matchedTerms),
    ...asStrings(result.matched_terms),
    ...asStrings(result.match_reasons),
    ...asStrings(result.match_explanation),
    sourceLabel,
    ...(eligibilityUnconfirmed ? ['Eligibility is not yet confirmed'] : []),
    ...(loanOrMatch ? ['Requires matching funds, cost share, or repayment'] : []),
    ...(decision === 'reject' ? ['The eligibility engine rejected this result for the selected profile'] : []),
  ])

  const isNational = result.is_national === true || result.is_national === 1 ||
    /^(?:national|nationwide)$/i.test(String(result.state ?? result.geography ?? ''))

  return {
    opportunity: {
      id: result.id,
      title: result.title ?? result.name ?? 'Funding source',
      description: result.description ?? result.summary ?? null,
      url: result.url ?? result.application_url ?? result.source_url ?? null,
      application_url: result.application_url ?? result.url ?? result.source_url ?? null,
      source_url: result.source_url ?? result.url ?? null,
      source: result.result_source === 'web_search'
        ? 'Live web search'
        : result.source ?? result.result_source ?? 'Profile-aware item search',
      categories: Array.isArray(result.categories) ? result.categories : [],
      match_reasons: reasons,
      amount_min: result.amount_min ?? null,
      amount_max: result.amount_max ?? null,
      deadline: result.deadline ?? null,
      deadline_type: result.deadline_type ?? null,
      state: isNational ? null : (result.state ?? null),
      is_national: isNational,
      opportunity_type: result.opportunity_type ?? result.type ?? 'program',
      funding_type: result.funding_type ?? null,
      sponsor: result.sponsor ?? result.funder ?? result.source ?? null,
      record_origin: result.record_origin ?? null,
      eligibility_bullets: Array.isArray(result.eligibility_bullets)
        ? result.eligibility_bullets
        : [],
      eligibility_confirmed: !eligibilityUnconfirmed,
    },
    match: {
      score,
      raw_score: result.match_score ?? null,
      item_score: result.need_score ?? result.need_match?.score ?? null,
      decision: decision || null,
      reasons,
      overlap: asStrings(result.need_match?.matchedTerms),
      disqualified,
      eligibility_unconfirmed: eligibilityUnconfirmed,
    },
  }
}

/** Apply the page's optional state/national display controls to backend rows. */
export function itemFundingResultPassesLocation(opportunity = {}, {
  state = 'all',
  includeNational = true,
} = {}) {
  const national = Boolean(opportunity.is_national)
  if (national) return Boolean(includeNational)
  if (!state || state === 'all') return true
  return String(opportunity.state ?? '').trim().toUpperCase() === String(state).trim().toUpperCase()
}

export default { mapBackendItemFundingResult, itemFundingResultPassesLocation }
