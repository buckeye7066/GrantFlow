import { NO_PER_AWARD_FIGURE_KINDS } from './opportunityKindClasses.js'

/**
 * CHOKE POINT: pipeline dollar-value semantics.
 *
 * Every surface that shows "Pipeline $X" / "Pipeline Potential" must derive
 * both the active status set and every row's dollar contribution here. A
 * directory, referral, benefit, school portal, or past-award research record is
 * valuable information, but it is not a fixed per-applicant award and must not
 * add dollars to a person's pipeline.
 */

/**
 * Pipeline stages whose dollar values count toward "in-pipeline" totals.
 * Terminal stages (awarded/declined/closed/deadline_passed/archived) are
 * excluded because awarded money is funds secured, not pipeline potential.
 */
export const PIPELINE_ACTIVE_STATUSES = Object.freeze([
  'discovery', 'discovered', 'interested', 'auto_applied', 'drafting',
  'application_prep', 'app_prep', 'revision', 'portal', 'submitted',
  'pending_review', 'under_review', 'follow_up', 'report',
])

/**
 * A floor-to-ceiling spread above this ratio is treated as a program envelope,
 * not a realistic single-award estimate. For example, $1M-$42M describes the
 * whole program, not what one applicant should count as pipeline potential.
 */
export const WIDE_AWARD_RANGE_RATIO = 10

const NO_PER_AWARD_KIND_LIST = Object.freeze(
  [...NO_PER_AWARD_FIGURE_KINDS].map((kind) => String(kind).trim().toLowerCase()).sort(),
)
const NO_PER_AWARD_KIND_SQL = NO_PER_AWARD_KIND_LIST.map((kind) => `'${kind.replaceAll("'", "''")}'`).join(', ')

function positiveMoney(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null
}

function normalizedOpportunityKind(grant) {
  return String(
    grant?.opportunity_kind ??
    grant?.funding_opportunity_kind ??
    grant?.kind ??
    '',
  ).trim().toLowerCase()
}

export function isWideAwardRange(amountMin, amountMax) {
  const floor = positiveMoney(amountMin)
  const ceiling = positiveMoney(amountMax)
  return Boolean(floor && ceiling && ceiling > floor * WIDE_AWARD_RANGE_RATIO)
}

/**
 * Canonical write-time default for amount_requested.
 *
 * A real explicit ask remains authoritative. When no ask exists, an ordinary
 * range defaults to its ceiling, while a wide program envelope defaults to its
 * floor. Both automatic and manual opportunity promotion paths must call this
 * helper instead of reimplementing `amount_max ?? amount_min`.
 */
export function defaultPipelineRequestedAmount(source = {}) {
  const requested = positiveMoney(source?.amount_requested ?? source?.requestedAmount)
  if (requested) return requested

  const floor = positiveMoney(source?.amount_min ?? source?.amountMin)
  const ceiling = positiveMoney(source?.amount_max ?? source?.amountMax)
  if (floor && ceiling && ceiling > floor * WIDE_AWARD_RANGE_RATIO) return floor
  return ceiling ?? floor ?? null
}

/**
 * Whether a row may contribute a dollar amount to pipeline potential.
 *
 * Progressed rows can be retained for history after a later eligibility
 * failure. Keeping the row is correct; continuing to count it as potential
 * money is not. Likewise, source kinds that intentionally publish no fixed
 * per-award figure remain visible but contribute zero dollars.
 */
export function grantCountsTowardPipelineDollars(grant) {
  if (String(grant?.eligibility_status ?? '').trim().toLowerCase() === 'ineligible') return false
  if (String(grant?.match_decision ?? '').trim().toUpperCase() === 'REJECT') return false
  const kind = normalizedOpportunityKind(grant)
  return !kind || !NO_PER_AWARD_FIGURE_KINDS.has(kind)
}

function sqlPrefix(alias) {
  return alias ? `${alias}.` : ''
}

function catalogKindSql(prefix, explicitKindSql = null) {
  if (explicitKindSql) return explicitKindSql
  return `(SELECT LOWER(COALESCE(pv_fo.opportunity_kind, ''))
             FROM funding_opportunities pv_fo
            WHERE pv_fo.id = ${prefix}funding_opportunity_id
            LIMIT 1)`
}

function rowDollarEligibleSql(prefix, explicitKindSql = null) {
  const kindSql = catalogKindSql(prefix, explicitKindSql)
  return `(
    LOWER(COALESCE(CAST(${prefix}eligibility_status AS TEXT), '')) <> 'ineligible'
    AND UPPER(COALESCE(CAST(${prefix}match_decision AS TEXT), '')) <> 'REJECT'
    AND COALESCE(${kindSql}, '') NOT IN (${NO_PER_AWARD_KIND_SQL})
  )`
}

function conservativeValueSql(prefix) {
  return `(
    CASE
      WHEN NULLIF(${prefix}amount_min, 0) IS NOT NULL
       AND NULLIF(${prefix}amount_max, 0) IS NOT NULL
       AND ${prefix}amount_max > ${prefix}amount_min * ${WIDE_AWARD_RANGE_RATIO}
      THEN CASE
        WHEN NULLIF(${prefix}amount_requested, 0) IS NOT NULL
         AND ABS(${prefix}amount_requested - ${prefix}amount_max) > 0.01
        THEN ${prefix}amount_requested
        ELSE ${prefix}amount_min
      END
      ELSE COALESCE(
        NULLIF(${prefix}amount_requested, 0),
        NULLIF(${prefix}amount_max, 0),
        NULLIF(${prefix}amount_min, 0),
        0
      )
    END
  )`
}

/**
 * SQL expression for one grant row's honest pipeline dollar contribution.
 *
 * The scalar catalog lookup makes the no-per-award classification available to
 * every existing aggregate without maintaining another hand-written join. It
 * works in SQLite and Postgres. Callers that already joined the catalog may
 * pass `{ opportunityKindSql: 'fo.opportunity_kind' }`.
 */
export function pipelineValueSql(alias = 'g', { opportunityKindSql = null } = {}) {
  const prefix = sqlPrefix(alias)
  return `CASE WHEN ${rowDollarEligibleSql(prefix, opportunityKindSql)}
               THEN ${conservativeValueSql(prefix)}
               ELSE 0 END`
}

/**
 * SQL expression including a linked catalog amount for answer-coverage audits.
 * Grant-side values retain precedence, but all eligibility, source-kind, and
 * wide-range safeguards remain identical to the user-facing dollar contract.
 */
export function pipelineValueWithCatalogSql(alias = 'g', foAlias = 'fo') {
  const prefix = sqlPrefix(alias)
  const catalogPrefix = sqlPrefix(foAlias)
  const grantValue = conservativeValueSql(prefix)
  const catalogValue = `(
    CASE
      WHEN NULLIF(${catalogPrefix}amount_min, 0) IS NOT NULL
       AND NULLIF(${catalogPrefix}amount_max, 0) IS NOT NULL
       AND ${catalogPrefix}amount_max > ${catalogPrefix}amount_min * ${WIDE_AWARD_RANGE_RATIO}
      THEN ${catalogPrefix}amount_min
      ELSE COALESCE(NULLIF(${catalogPrefix}amount_max, 0), NULLIF(${catalogPrefix}amount_min, 0), 0)
    END
  )`
  return `CASE WHEN ${rowDollarEligibleSql(prefix, `${catalogPrefix}opportunity_kind`)}
               THEN COALESCE(NULLIF(${grantValue}, 0), NULLIF(${catalogValue}, 0), 0)
               ELSE 0 END`
}

/** JS twin of pipelineValueSql for rows already in memory. */
export function grantPipelineValue(grant) {
  if (!grantCountsTowardPipelineDollars(grant)) return 0

  const requested = positiveMoney(grant?.amount_requested)
  const floor = positiveMoney(grant?.amount_min)
  const ceiling = positiveMoney(grant?.amount_max)

  if (floor && ceiling && ceiling > floor * WIDE_AWARD_RANGE_RATIO) {
    // Both known writer paths historically copied the ceiling into
    // amount_requested. Until provenance exists on legacy rows, an exact copy of
    // a wide-range ceiling is conservatively treated as the auto-default. A
    // distinct explicit ask remains authoritative.
    if (requested && Math.abs(requested - ceiling) > 0.01) return requested
    return floor
  }

  return requested ?? ceiling ?? floor ?? 0
}

/**
 * Count visible active sources whose eligible dollar value is not stated.
 *
 * No-per-award resources still count here because the UI intentionally reports
 * them as useful sources without a fixed amount. Explicitly ineligible or
 * rejected rows do not count as either dollars or an unvalued opportunity.
 */
export function unvaluedCountSql(alias = 'g', { opportunityKindSql = null } = {}) {
  const prefix = sqlPrefix(alias)
  const notRejected = `(
    LOWER(COALESCE(CAST(${prefix}eligibility_status AS TEXT), '')) <> 'ineligible'
    AND UPPER(COALESCE(CAST(${prefix}match_decision AS TEXT), '')) <> 'REJECT'
  )`
  return `SUM(CASE WHEN ${notRejected} AND ${pipelineValueSql(alias, { opportunityKindSql })} = 0 THEN 1 ELSE 0 END)`
}

/** JS twin of unvaluedCountSql for rows already in memory. */
export function isUnvaluedGrant(grant) {
  const rejected =
    String(grant?.eligibility_status ?? '').trim().toLowerCase() === 'ineligible' ||
    String(grant?.match_decision ?? '').trim().toUpperCase() === 'REJECT'
  return !rejected && grantPipelineValue(grant) === 0
}

export default {
  PIPELINE_ACTIVE_STATUSES,
  WIDE_AWARD_RANGE_RATIO,
  defaultPipelineRequestedAmount,
  grantCountsTowardPipelineDollars,
  pipelineValueSql,
  pipelineValueWithCatalogSql,
  grantPipelineValue,
  unvaluedCountSql,
  isUnvaluedGrant,
}
