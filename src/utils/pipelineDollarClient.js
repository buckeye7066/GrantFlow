// Client-side conservative pipeline dollar value helper
// Mirrors backend/config/pipelineValue.js behavior for fallbacks when
// server-calculated pipeline_dollar_value is absent, and preserves awarded.
export const WIDE_AWARD_RANGE_RATIO = 10

function positive(n) {
  const v = Number(n)
  return Number.isFinite(v) && v > 0 ? v : null
}

export function computeClientPipelineDollar(grant) {
  if (!grant) return 0
  // Preserve awarded totals for awarded rows
  const status = String(grant.status || '').toLowerCase()
  const awarded = positive(grant.amount_awarded)
  if (status === 'awarded' && awarded) return awarded

  // Prefer server field when present and meaningful (including zero)
  const server = Number(grant?.pipeline_dollar_value)
  if (Number.isFinite(server)) return server

  const requested = positive(grant.amount_requested)
  const min = positive(grant.amount_min)
  const max = positive(grant.amount_max)
  const isWide = Boolean(min && max && max > min * WIDE_AWARD_RANGE_RATIO)

  if (requested !== null && requested !== undefined) {
    if (isWide && Math.abs(requested - max) <= 0.01) return min ?? requested
    return requested
  }
  if (isWide) return min ?? 0
  return max ?? min ?? 0
}

export default { computeClientPipelineDollar, WIDE_AWARD_RANGE_RATIO }
