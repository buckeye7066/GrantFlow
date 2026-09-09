// Preserve measured recall gaps while distinguishing search evidence from a
// diagnosis of their cause. Missing historical telemetry is never healthy.
export function searchEvidence(lane) {
  const text = (value, fallback = 'unknown') => typeof value === 'string' && value.trim() ? value.trim().slice(0, 160) : fallback
  const provenance = (Array.isArray(lane?.search_provenance) ? lane.search_provenance : []).map(p => ({
    query_index: Number.isInteger(p?.query_index) ? p.query_index : null, provider: text(p?.provider), provenance: text(p?.provenance),
    status: text(p?.status), provider_mode: text(p?.provider_mode, null),
    result_count: Number.isInteger(p?.result_count) ? Math.max(0, p.result_count) : null,
    provenance_reason: text(p?.provenance_reason, null),
  }))
  const degraded = Number(lane?.search_degraded_queries) > 0 || Number(lane?.search_unavailable_queries) > 0
    || provenance.some(p => /degrad|error|unavailable|not_attempted/.test(p.status))
  const healthy = provenance.length > 0 && !(Number(lane?.search_unknown_provenance_count) > 0)
    && provenance.every(p => p.status === 'ok' && p.provider !== 'unknown' && p.provenance !== 'unknown')
  return { status: degraded ? 'degraded' : healthy ? 'healthy' : 'unknown', provenance: provenance.slice(0, 100), provenance_truncated: provenance.length > 100 }
}

export function recallAttribution(evaluations = []) {
  const evidence = evaluations.map(e => e?.search_evidence || { status: 'unknown', provenance: [] })
  const healthy = evidence.length > 0 && evidence.every(e => e.status === 'healthy')
  return {
    status: healthy ? 'search_verified' : 'inconclusive',
    reason: healthy ? 'Search responses were healthy; the recall gap remains.'
      : evidence.some(e => e.status === 'degraded')
        ? 'Search returned degraded or unavailable responses. The coverage gap remains; its cause requires a healthy rerun.'
        : 'Provider evidence is missing or incomplete. The coverage gap remains; a query-builder defect has not been established.',
    search_evidence: evidence,
  }
}

export function healthyRecallCoverage(entry, evaluations = []) {
  const type = entry.finding_type || String(entry.id).split(':')[0]
  const subjects = entry.evidence?.subjects || []
  if (!subjects.length || entry.evidence?.subject_history_incomplete) return false
  return subjects.every(subject => evaluations.some(e => e.category === entry.category
    && e.search_evidence?.status === 'healthy'
    && (e.recall_coverage?.[type] || []).includes(subject)))
}
