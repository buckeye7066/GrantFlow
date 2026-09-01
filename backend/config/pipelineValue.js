import { NO_PER_AWARD_FIGURE_KINDS } from './opportunityKindClasses.js'

/**
 * CHOKE POINT: pipeline dollar-value semantics.
 *
 * Every surface that shows "Pipeline $X" or "Pipeline Potential" must derive
 * both the active status set and each row's dollar contribution here. Keep the
 * raw amount-presence helpers separate: crawler/enrichment checks need to know
 * whether a source contains an amount even when that row is ineligible or is a
 * directory that intentionally contributes no fixed per-applicant dollars.
 */

/** Active stages included in pipeline-potential totals. */
export const PIPELINE_ACTIVE_STATUSES = Object.freeze([
  'discovery', 'discovered', 'interested', 'auto_applied', 'drafting',
  'application_prep', 'app_prep', 'revision', 'portal', 'submitted',
  'pending_review', 'under_review', 'follow_up', 'report',
])

/** A larger spread is treated as a program envelope, not one applicant's award. */
export const WIDE_AWARD_RANGE_RATIO = 10

const NO_PER_AWARD_KIND_SQL = NO_PER_AWARD_FIGURE_KINDS
  .map((kind) => `'${String(kind).replaceAll("'", "''")}'`)
  .join(', ')

function positiveMoney(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null
}

function sqlPrefix(alias) {
  return alias ? `${alias}.` : ''
}

function explicitRejectionSql(prefix) {
  return `(
    LOWER(COALESCE(CAST(${prefix}eligibility_status AS TEXT), '')) = 'ineligible'
    OR LOWER(COALESCE(CAST(${prefix}match_decision AS TEXT), '')) = 'reject'
  )`
}

function noPerAwardSql(prefix, foAlias = null) {
  if (foAlias) {
    return `LOWER(COALESCE(CAST(${foAlias}.opportunity_kind AS TEXT), '')) IN (${NO_PER_AWARD_KIND_SQL})`
  }
  return `EXISTS (
    SELECT 1
      FROM funding_opportunities pipeline_value_fo
     WHERE pipeline_value_fo.id = ${prefix}funding_opportunity_id
       AND LOWER(COALESCE(CAST(pipeline_value_fo.opportunity_kind AS TEXT), ''))
           IN (${NO_PER_AWARD_KIND_SQL})
  )`
}

function conservativeDollarSql(prefix) {
  const rawValue = pipelineValueSql(prefix ? prefix.slice(0, -1) : '')
  return `(
    CASE
      WHEN ${prefix}amount_min > 0
       AND ${prefix}amount_max > 0
       AND ${prefix}amount_max > ${prefix}amount_min * ${WIDE_AWARD_RANGE_RATIO}
      THEN CASE
        WHEN NULLIF(${prefix}amount_requested, 0) IS NOT NULL
         AND ABS(${prefix}amount_requested - ${prefix}amount_max) > 0.01
        THEN ${prefix}amount_requested
        ELSE ${prefix}amount_min
      END
      ELSE ${rawValue}
    END
  )`
}

/**
 * Raw amount-presence/value fallback.
 *
 * This intentionally does NOT apply eligibility or opportunity-kind filters.
 * Amount coverage, enrichment, and dead-link repair use it to answer whether a
 * row already carries a figure. Dollar surfaces must use pipelineDollarSql().
 */
export function pipelineValueSql(alias = 'g') {
  const prefix = sqlPrefix(alias)
  return `COALESCE(
    NULLIF(${prefix}amount_requested, 0),
    NULLIF(${prefix}amount_max, 0),
    NULLIF(${prefix}amount_min, 0),
    0
  )`
}

/**
 * Honest dollar contribution for one grant row.
 *
 * Callers select active statuses. This expression additionally contributes $0
 * for explicitly ineligible/rejected rows and for source kinds that publish no
 * fixed per-applicant award. Unknown or unlinked legacy kinds remain eligible.
 * A >10x floor/ceiling range uses the floor unless a distinct requested amount
 * proves that a separate ask was entered.
 */
export function pipelineDollarSql(gAlias = 'g', foAlias = null) {
  const prefix = sqlPrefix(gAlias)
  return `CASE
    WHEN ${explicitRejectionSql(prefix)} THEN 0
    WHEN ${noPerAwardSql(prefix, foAlias)} THEN 0
    ELSE ${conservativeDollarSql(prefix)}
  END`
}

/**
 * Raw amount coverage including a linked catalog figure.
 *
 * This is an answer-presence predicate, not a user-facing dollar contribution.
 */
export function pipelineValueWithCatalogSql(alias = 'g', foAlias = 'fo') {
  const prefix = sqlPrefix(alias)
  const foPrefix = sqlPrefix(foAlias)
  return `COALESCE(
    NULLIF(${prefix}amount_requested, 0),
    NULLIF(${prefix}amount_max, 0),
    NULLIF(${prefix}amount_min, 0),
    NULLIF(${foPrefix}amount_max, 0),
    NULLIF(${foPrefix}amount_min, 0),
    0
  )`
}

/** JS twin of pipelineValueSql: raw amount presence/value only. */
export function grantPipelineValue(grant) {
  return positiveMoney(grant?.amount_requested)
    ?? positiveMoney(grant?.amount_max)
    ?? positiveMoney(grant?.amount_min)
    ?? 0
}

export function grantCountsTowardPipelineDollars(grant) {
  if (!grant) return false
  if (String(grant.eligibility_status ?? '').trim().toLowerCase() === 'ineligible') return false
  if (String(grant.match_decision ?? '').trim().toLowerCase() === 'reject') return false
  const kind = String(
    grant.opportunity_kind ?? grant.funding_opportunity_kind ?? grant.kind ?? '',
  ).trim().toLowerCase()
  return !kind || !NO_PER_AWARD_FIGURE_KINDS.includes(kind)
}

/** JS twin of pipelineDollarSql. */
export function grantPipelineDollarValue(grant) {
  if (!grantCountsTowardPipelineDollars(grant)) return 0

  const requested = positiveMoney(grant?.amount_requested)
  const floor = positiveMoney(grant?.amount_min)
  const ceiling = positiveMoney(grant?.amount_max)

  if (floor && ceiling && ceiling > floor * WIDE_AWARD_RANGE_RATIO) {
    // Historic automatic/manual promotion copied the ceiling into requested.
    // With no provenance column on legacy rows, a missing request or an exact
    // copy of that wide ceiling is conservatively treated as the old default.
    if (requested && Math.abs(requested - ceiling) > 0.01) return requested
    return floor
  }

  return requested ?? ceiling ?? floor ?? 0
}

/**
 * Count useful active sources that have no fixed dollar contribution.
 *
 * Direct rows without an amount and no-per-award resources are included.
 * Explicitly ineligible/rejected history rows are excluded from both the dollar
 * total and this useful-unvalued count.
 */
export function unvaluedCountSql(alias = 'g', foAlias = null) {
  const prefix = sqlPrefix(alias)
  return `SUM(CASE
    WHEN ${explicitRejectionSql(prefix)} THEN 0
    WHEN ${pipelineDollarSql(alias, foAlias)} = 0 THEN 1
    ELSE 0
  END)`
}

export function isUnvaluedGrant(grant) {
  if (!grantCountsTowardPipelineDollars(grant)) {
    const kind = String(
      grant?.opportunity_kind ?? grant?.funding_opportunity_kind ?? grant?.kind ?? '',
    ).trim().toLowerCase()
    // No-per-award resources are useful unvalued sources; rejected rows are not.
    const rejected =
      String(grant?.eligibility_status ?? '').trim().toLowerCase() === 'ineligible'
      || String(grant?.match_decision ?? '').trim().toLowerCase() === 'reject'
    return !rejected && NO_PER_AWARD_FIGURE_KINDS.includes(kind)
  }
  return grantPipelineDollarValue(grant) === 0
}

/**
 * Canonical insert-time default for amount_requested.
 *
 * A supplied positive requested amount is preserved. Without one, ordinary
 * ranges use their ceiling and >10x program envelopes use their floor.
 */
export function defaultPipelineRequestedAmount(input = {}) {
  const requested = positiveMoney(input.amount_requested ?? input.requestedAmount ?? input.requested)
  const floor = positiveMoney(input.amount_min ?? input.amountMin ?? input.min)
  const ceiling = positiveMoney(input.amount_max ?? input.amountMax ?? input.max)
  const isWide = Boolean(floor && ceiling && ceiling > floor * WIDE_AWARD_RANGE_RATIO)
  if (requested !== null && requested !== undefined) {
    // If this looks like a historic auto-ceiling copy on a wide range, use the floor.
    if (isWide && Math.abs(requested - ceiling) <= 0.01) return floor ?? requested
    return requested
  }
  if (isWide) return floor
  return ceiling ?? floor ?? null
}

export default {
  PIPELINE_ACTIVE_STATUSES,
  WIDE_AWARD_RANGE_RATIO,
  pipelineValueSql,
  pipelineDollarSql,
  pipelineValueWithCatalogSql,
  grantPipelineValue,
  grantCountsTowardPipelineDollars,
  grantPipelineDollarValue,
  unvaluedCountSql,
  isUnvaluedGrant,
  defaultPipelineRequestedAmount,
}
