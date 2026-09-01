// Client-side conservative pipeline dollar value helper.
// Mirrors backend/config/pipelineValue.js when a server-calculated
// pipeline_dollar_value is absent, and preserves recorded awarded amounts.
export const WIDE_AWARD_RANGE_RATIO = 10

export const CLIENT_NO_PER_AWARD_KINDS = Object.freeze([
  'directory',
  'referral',
  'school_portal',
  'past_award_intel',
  'benefit',
])

const NO_PER_AWARD_KIND_SET = new Set(CLIENT_NO_PER_AWARD_KINDS)

function positive(n) {
  const v = Number(n)
  return Number.isFinite(v) && v > 0 ? v : null
}

function fallbackCountsTowardPipelineDollars(grant) {
  if (String(grant?.eligibility_status ?? '').trim().toLowerCase() === 'ineligible') return false
  if (String(grant?.match_decision ?? '').trim().toLowerCase() === 'reject') return false
  const kind = String(
    grant?.opportunity_kind ?? grant?.funding_opportunity_kind ?? grant?.kind ?? '',
  ).trim().toLowerCase()
  return !kind || !NO_PER_AWARD_KIND_SET.has(kind)
}

export function computeClientPipelineDollar(grant) {
  if (!grant) return 0

  // Awarded rows display the recorded award, which is no longer pipeline potential.
  const status = String(grant.status || '').toLowerCase()
  const awarded = positive(grant.amount_awarded)
  if (status === 'awarded' && awarded) return awarded

  // The server field is authoritative whenever present, including an intentional 0.
  const server = Number(grant.pipeline_dollar_value)
  if (Number.isFinite(server)) return server > 0 ? server : 0

  // Stale/offline clients must still honor the same exclusion contract.
  if (!fallbackCountsTowardPipelineDollars(grant)) return 0

  // Zeroize explicit ineligible/reject and no-per-award kinds on fallback
  const elig = String(grant?.eligibility_status || '').trim().toLowerCase()
  if (elig === 'ineligible') return 0
  const decision = String(grant?.match_decision || '').trim().toUpperCase()
  if (decision === 'REJECT') return 0
  const kind = String(
    grant?.opportunity_kind ?? grant?.funding_opportunity_kind ?? grant?.kind ?? '',
  ).trim().toLowerCase()
  if (['directory', 'referral', 'school_portal', 'benefit', 'past_award_intel'].includes(kind)) return 0

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

export default {
  computeClientPipelineDollar,
  WIDE_AWARD_RANGE_RATIO,
  CLIENT_NO_PER_AWARD_KINDS,
}
