/**
 * CHOKE POINT: pipeline dollar-value semantics.
 *
 * Every surface that shows "Pipeline $X" / "Pipeline Potential" (dashboard
 * stats, ProfileCard, profile detail, /:id/pipeline-potential breakdown) MUST
 * derive a grant's dollar value and the set of "active pipeline" statuses from
 * THIS module. Do not re-inline a status list or a SUM(amount_requested)
 * expression at a call site — that is exactly the drift class this closes.
 *
 * THE BUG THIS CLOSES (2026-07-05)
 * --------------------------------
 * Pipeline totals were computed as SUM(amount_requested) in four separately
 * maintained copies (routes/stats.js, routes/profiles.js ×2, scripts). But the
 * canonical auto-add saver (opportunityMatcher.saveToProfilePipeline) only set
 * amount_requested when the OPPORTUNITY carried one — and catalog opportunities
 * carry amount_min/amount_max, essentially never amount_requested (that is a
 * pipeline-side concept the manual /from-opportunity path defaults from
 * amount_max ?? amount_min). Result fleet-wide: 15 of 489 active pipeline
 * grants had amount_requested, so a student with 118 active sources showed
 * "$6,500 in pipeline" while the same rows carried ~$1.8M of award ceilings in
 * amount_max/amount_min the display never read.
 *
 * THE RULE
 * --------
 * A grant's displayed pipeline value = amount_requested when the user (or the
 * promote-time default) set one, else the award ceiling (amount_max), else the
 * award floor (amount_min), else 0. This is the SAME fallback the frontend
 * breakdown (PipelinePotentialBreakdown.estimatedValue) and the Pipeline page
 * already use — the backend totals had to reconcile with it.
 *
 * Defense in depth (each layer independently correct):
 *   1. READ  — the SQL/JS helpers here coalesce at display time.
 *   2. WRITE — saveToProfilePipeline defaults amount_requested from max/min.
 *   3. NET   — enforceGrantAmountBackfill (startup/enforceInvariants.js)
 *              re-derives missing amounts against the live DB on every boot.
 */

/**
 * Pipeline stages whose dollar values count toward "in-pipeline" totals.
 * Terminal stages (awarded/declined/closed/deadline_passed/archived) are
 * excluded — awarded money is "funds secured", not pipeline potential.
 */
export const PIPELINE_ACTIVE_STATUSES = Object.freeze([
  'discovery', 'discovered', 'interested', 'auto_applied', 'drafting',
  'application_prep', 'app_prep', 'revision', 'portal', 'submitted',
  'pending_review', 'under_review', 'follow_up', 'report',
])

/**
 * When a grant carries BOTH an award floor and ceiling and the ceiling is more
 * than this many times the floor, the range is a program ENVELOPE ("$1M–$42M"),
 * not a realistic single-award figure — defaulting amount_requested to the
 * ceiling would overstate the pipeline by construction (the HUD Section 4
 * class: one such row fabricated ~$84M across two org pipelines). Defaulting
 * uses the FLOOR for wide ranges; the ceiling stays visible in amount_max.
 */
export const WIDE_AWARD_RANGE_RATIO = 10

/**
 * SQL expression for one grant row's pipeline dollar value.
 * Compile-time literal (no user input), safe to inline in SQL; works on both
 * SQLite and Postgres (NULLIF/COALESCE are common dialect).
 *
 * @param {string} [alias='g'] table alias; pass '' for un-aliased queries.
 */
export function pipelineValueSql(alias = 'g') {
  const p = alias ? `${alias}.` : ''
  return `COALESCE(NULLIF(${p}amount_requested, 0), NULLIF(${p}amount_max, 0), NULLIF(${p}amount_min, 0), 0)`
}

/**
 * SQL expression for a grant row's pipeline dollar value INCLUDING the value
 * its linked catalog row already carries (the ANSWER-census variant).
 *
 * WHY THIS EXISTS (2026-08-15, the "grants.gov ×38 need an API adapter" false
 * alarm): the amountCoverage census documents that "the predicates read an
 * answer off EITHER the grant itself OR its linked catalog row" — but its
 * value predicate was `pipelineValueSql('g')`, which reads ONLY the grant's own
 * columns. A nightly-crawl grant linked to a catalog row whose figure the
 * grants.gov API adapter had ALREADY fetched (measured in prod: 52 rows incl.
 * a $2,500 scholarship and a $629,042 award, catalog `amount_status`
 * 'known'/'range', `amount_enrich_last_reason` 'grants_gov_api') therefore
 * counted as `unanswered_unreadable` — the one bucket that reds the owner's
 * report and NAMES ADAPTER WORK — for work the adapter had already done. The
 * inheritance sweep (`enforceGrantAmountBackfill` step 1) copies the figure
 * onto the grant a boot later; until then the row HAS an answer and the census
 * must say so.
 *
 * Grant-side values keep precedence (a user-entered ask outranks a catalog
 * ceiling). This is a CENSUS/answer predicate — "Pipeline $" dollar SURFACES
 * keep reading `pipelineValueSql`, because a dollar card must never display a
 * value the grant row itself does not yet carry.
 */
export function pipelineValueWithCatalogSql(alias = 'g', foAlias = 'fo') {
  const p = alias ? `${alias}.` : ''
  const f = foAlias ? `${foAlias}.` : ''
  return (
    `COALESCE(NULLIF(${p}amount_requested, 0), NULLIF(${p}amount_max, 0), NULLIF(${p}amount_min, 0), ` +
    `NULLIF(${f}amount_max, 0), NULLIF(${f}amount_min, 0), 0)`
  )
}

/** JS twin of pipelineValueSql for rows already in memory. */
export function grantPipelineValue(grant) {
  for (const key of ['amount_requested', 'amount_max', 'amount_min']) {
    const v = Number(grant?.[key])
    if (Number.isFinite(v) && v > 0) return v
  }
  return 0
}

/**
 * SQL expression counting active-pipeline rows with NO derivable dollar value.
 * "$0" and "no amount stated" are DIFFERENT facts: benefit programs (SSI,
 * SNAP, LIHEAP) and directories have real value to the profile but no
 * per-award figure, so a card that silently sums them as $0 reads as
 * "qualifies for nothing". Surfaces MUST show this count alongside the total
 * (e.g. "$32,250 + 51 sources without stated amounts").
 *
 * @param {string} [alias='g'] table alias; pass '' for un-aliased queries.
 */
export function unvaluedCountSql(alias = 'g') {
  return `SUM(CASE WHEN ${pipelineValueSql(alias)} = 0 THEN 1 ELSE 0 END)`
}

/** JS twin of unvaluedCountSql for rows already in memory. */
export function isUnvaluedGrant(grant) {
  return grantPipelineValue(grant) === 0
}

export default { PIPELINE_ACTIVE_STATUSES, pipelineValueSql, grantPipelineValue, unvaluedCountSql, isUnvaluedGrant }
