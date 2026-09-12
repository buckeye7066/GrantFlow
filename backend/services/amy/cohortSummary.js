// The historical `issues` counter is target - clean, which includes members
// that were never evaluated. Never describe it as observed issue profiles.
export function cohortCounts(day = {}) {
  const count = (value) => Math.max(0, Math.trunc(Number(value) || 0))
  const evaluated = count(day.evaluated)
  const clean = count(day.clean)
  const target = count(day.target)
  return {
    evaluated, clean, target,
    evaluatedIssues: Math.max(0, evaluated - clean),
    unevaluated: Math.max(0, target - evaluated),
    inconsistent: clean > evaluated || evaluated > target,
  }
}

/**
 * The unevaluated members by CLASS (`discovery_blocked:<reason>`,
 * `oracle_unevaluable`, `crawler_error`, …) and the provider state the run
 * measured, when the day carries them (receipt_version >= 2). On 2026-09-12 a
 * dead LLM route read as "0/50 clean"; this line is what makes the same night
 * read as "50 not evaluated because: discovery_blocked:extraction_failed ×50".
 */
function unevaluatedDetail(day = {}) {
  const classes = day.outcome_classes && typeof day.outcome_classes === 'object'
    ? Object.entries(day.outcome_classes)
      .filter(([, n]) => Number(n) > 0)
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, 4)
      .map(([k, n]) => `${k} ×${Number(n)}`)
      .join(', ')
    : ''
  const ph = day.provider_health && typeof day.provider_health === 'object' ? day.provider_health : null
  const providers = ph && (ph.search || ph.llm) && !(ph.search === 'healthy' && ph.llm === 'healthy')
    ? ` [providers: search ${ph.search || 'unknown'}, llm ${ph.llm || 'unknown'}]`
    : ''
  return `${classes ? ` — not evaluated because: ${classes}` : ''}${providers}`
}

export function cohortSummary(day = {}) {
  const c = cohortCounts(day)
  return `${c.clean}/${c.evaluated} synthetic profiles clean (target ${c.target}; ` +
    `${c.evaluatedIssues} evaluated with issues; ${c.unevaluated} not evaluated) on ${day.day}` +
    unevaluatedDetail(day) +
    (c.inconsistent ? ' — inconsistent cohort receipt; reconcile membership before claiming completion' : '')
}
