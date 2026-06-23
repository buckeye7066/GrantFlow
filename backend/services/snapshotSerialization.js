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

// Per-document cap for raw extracted_text stored in a crawler-job snapshot.
// The snapshot is a job-context CACHE, not a fidelity copy: the matcher reads the
// precomputed `signals` (keywords/phrases), so multi-MB raw document text is dead
// weight in every crawler_jobs row. Uncapped, a profile with large documents
// produced 1.6MB-avg / 24MB-max snapshots, growing crawler_jobs to 8.3GB and
// triggering prod disk-full failures (2026-06). We keep enough lead text to
// preserve keyword signal and record the original length for transparency.
const SNAPSHOT_DOC_TEXT_CAP = 4000

function trimSnapshotDocuments(documents) {
  if (!Array.isArray(documents)) return documents
  return documents.map((doc) => {
    if (!doc || typeof doc !== 'object') return doc
    const text = doc.extracted_text
    if (typeof text !== 'string' || text.length <= SNAPSHOT_DOC_TEXT_CAP) return doc
    return {
      ...doc,
      extracted_text: text.slice(0, SNAPSHOT_DOC_TEXT_CAP),
      extracted_text_truncated: true,
      extracted_text_full_length: text.length,
    }
  })
}

/**
 * Convert Set fields in signals to arrays for JSON serialization, and cap heavy
 * document text so the snapshot stays small.
 * Call before stableStringify/JSON.stringify when storing profile_context_snapshot.
 */
export function prepareContextForSnapshot(context) {
  if (!context || typeof context !== 'object') return context
  const out = { ...context }
  if (context.signals) {
    const signals = { ...context.signals }
    for (const key of SIGNAL_SET_KEYS) {
      if (signals[key] instanceof Set) {
        signals[key] = Array.from(signals[key])
      }
    }
    out.signals = signals
  }
  if (Array.isArray(context.documents)) {
    out.documents = trimSnapshotDocuments(context.documents)
  }
  return out
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
