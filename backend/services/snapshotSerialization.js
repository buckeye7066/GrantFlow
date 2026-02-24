/**
 * Snapshot serialization helpers
 * Ensures profile context signals (which use Set) survive JSON.stringify/parse.
 * Set does not serialize; we convert to arrays when storing and back to Sets when loading.
 */

const SIGNAL_SET_KEYS = [
  'keywordSet',
  'phrases',
  'intentPhrases',
  'demographics',
  'genders',
  'assistance',
  'military',
  'interests',
  'applicantTypes',
  'health',
  'family',
  'occupation',
]

/**
 * Convert Set fields in signals to arrays for JSON serialization.
 * Call before stableStringify/JSON.stringify when storing profile_context_snapshot.
 */
export function prepareContextForSnapshot(context) {
  if (!context?.signals) return context
  const signals = { ...context.signals }
  for (const key of SIGNAL_SET_KEYS) {
    if (signals[key] instanceof Set) {
      signals[key] = Array.from(signals[key])
    }
  }
  return { ...context, signals }
}

/**
 * Restore array fields in signals back to Set after JSON.parse.
 * Call after parsing profile_context_snapshot so crawlers receive real Sets.
 * Old snapshots (pre-fix) had Sets serialize as {}; treat plain objects as empty Set.
 */
export function restoreContextFromSnapshot(parsed) {
  if (!parsed?.signals) return parsed
  const signals = { ...parsed.signals }
  for (const key of SIGNAL_SET_KEYS) {
    const val = signals[key]
    if (Array.isArray(val)) {
      signals[key] = new Set(val)
    } else if (val && typeof val === 'object' && !(val instanceof Set)) {
      // Old snapshots: Set serialized as {}; restore as empty Set
      signals[key] = new Set()
    }
  }
  return { ...parsed, signals }
}
