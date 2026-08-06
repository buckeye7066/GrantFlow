/**
 * Tiny formatters shared between Anya intake-results components. Kept in
 * a non-component file so React Fast Refresh doesn't complain about
 * mixed exports (`react-refresh/only-export-components`).
 */

export function formatMatchAmount(match) {
  const min = Number(match?.amount_min ?? match?.amount_low ?? 0)
  const max = Number(match?.amount_max ?? match?.amount_high ?? 0)
  if (min > 0 && max > 0 && min !== max) {
    return `$${Math.round(min).toLocaleString()} – $${Math.round(max).toLocaleString()}`
  }
  if (max > 0) return `Up to $${Math.round(max).toLocaleString()}`
  if (min > 0) return `From $${Math.round(min).toLocaleString()}`
  if (match?.amount_description) return match.amount_description
  return 'Amount varies'
}

export function formatMatchDeadline(match) {
  const value = match?.deadline || match?.application_deadline
  const deadlineType = String(match?.deadline_type || '').trim().toLowerCase()
  if (!value) {
    return match?.is_rolling === true || deadlineType === 'rolling' || deadlineType === 'ongoing'
      ? 'Rolling / ongoing'
      : null
  }
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

/**
 * Build the at-a-glance summary used by AnyaPotentialFundingSummary.
 *
 * IMPORTANT: We never sum unknown amounts as if they were guaranteed
 * money — only matches with a published amount_min / amount_max
 * contribute to the totals.
 */
export function buildPotentialFundingSummary(matches = []) {
  let accepted_matches = 0
  let review_matches = 0
  let rejected_matches = 0
  let unrated_matches = 0
  let potential_low_total = 0
  let potential_high_total = 0
  let amount_unknown_count = 0

  for (const m of matches) {
    const decision = String(m?.match_decision ?? m?.decision ?? '').trim().toUpperCase()
    if (decision === 'ACCEPT') accepted_matches += 1
    else if (decision === 'REVIEW') review_matches += 1
    else if (decision === 'REJECT') rejected_matches += 1
    else unrated_matches += 1

    const min = Number(m?.amount_min ?? m?.amount_low ?? 0)
    const max = Number(m?.amount_max ?? m?.amount_high ?? 0)
    if (min > 0) potential_low_total += min
    if (max > 0) potential_high_total += max
    if (!(min > 0) && !(max > 0)) amount_unknown_count += 1
  }

  return {
    total_matches: matches.length,
    accepted_matches,
    review_matches,
    rejected_matches,
    unrated_matches,
    potential_low_total: Math.round(potential_low_total),
    potential_high_total: Math.round(potential_high_total),
    amount_unknown_count,
  }
}
