// crawler-os/coverageOverrides.js
//
// Amy-managed, ADDITIVE-ONLY coverage overrides for the source registry. Amy's
// training loop detects categories that systematically return zero results and
// broadens an existing, relevant source's coverage so those profiles get
// candidates next run. Overrides can only ADD need_categories / applicant_types
// to an existing source — they never remove or retarget, so a bad override can
// only broaden recall (then be reverted), never silently break an existing lane.
//
// Lives INSIDE crawler-os (the OS is self-contained; no imports escape the
// package). The Amy editor in backend/services/amy reaches IN to read/write it.
//
// Shape:
//   { [source_id]: { add_need_categories?: string[], add_applicant_types?: string[] } }
//
// Persistence: the literal below is rewritten by crawlerCoverageEditor (with a
// backup) so overrides survive restarts; an in-memory mirror makes edits take
// effect live in the running process (the registry reads getCoverageOverrides()).

// AMY_COVERAGE_OVERRIDES_BEGIN
export const COVERAGE_OVERRIDES = {}
// AMY_COVERAGE_OVERRIDES_END

let _live = { ...COVERAGE_OVERRIDES }

/** Live overrides used by the registry (mutable so edits apply in-process). */
export function getCoverageOverrides() {
  return _live
}

/** Replace the live overrides (called by the editor after a file write). */
export function setCoverageOverrides(next) {
  _live = next && typeof next === 'object' ? next : {}
  return _live
}

/** Apply additive coverage overrides to a single source row (pure). */
export function mergeSourceCoverage(source) {
  if (!source) return source
  const ov = _live[source.source_id]
  if (!ov) return source
  const needs = new Set(Array.isArray(source.need_categories) ? source.need_categories : [])
  for (const n of Array.isArray(ov.add_need_categories) ? ov.add_need_categories : []) needs.add(n)
  const types = new Set(Array.isArray(source.applicant_types) ? source.applicant_types : [])
  for (const t of Array.isArray(ov.add_applicant_types) ? ov.add_applicant_types : []) types.add(t)
  return { ...source, need_categories: [...needs], applicant_types: [...types], _amy_coverage_extended: true }
}

export default { COVERAGE_OVERRIDES, getCoverageOverrides, setCoverageOverrides, mergeSourceCoverage }
