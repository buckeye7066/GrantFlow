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

export function cohortSummary(day = {}) {
  const c = cohortCounts(day)
  return `${c.clean}/${c.evaluated} synthetic profiles clean (target ${c.target}; ` +
    `${c.evaluatedIssues} evaluated with issues; ${c.unevaluated} not evaluated) on ${day.day}` +
    (c.inconsistent ? ' — inconsistent cohort receipt; reconcile membership before claiming completion' : '')
}
