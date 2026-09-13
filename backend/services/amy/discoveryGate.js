/**
 * discoveryGate.js — the ONE place that decides whether a synthetic profile's
 * discovery run can be EVALUATED at all, and what its outcome class is.
 *
 * WHY THIS EXISTS (prod 2026-09-12, run amy-2026-09-12T11-31-58-550Z-dfd2cbce)
 * ---------------------------------------------------------------------------
 * 50 planned members, 50 "evaluated", 0 clean, finding_types
 * {hyperlocal_recall_miss: 50}. Every LLM provider was dead that night: the
 * open-web lane fetched ~40 pages per profile and EXTRACTED ZERO candidates on
 * every one (`system_kv web_lane_health` recent[]: queries 28, pages 48,
 * fetched 39-50, extracted 0, stored 0, for every profile), while search
 * itself answered healthily from cache. The hyperlocal detector then fired on
 * the REGISTRY-only recommendations, the flywheel counted every member as an
 * ISSUE, and the approval queue attributed all 50 to
 * backend/crawler-os/webQueries.js. A provider outage was reported as a
 * query-breadth code defect, and the cohort receipt said "0/50 clean" about a
 * question no stage of the pipeline had actually asked.
 *
 * THE CONTRACT
 * ------------
 * A member is CLEAN only when: every planned stage RAN, provider state was
 * healthy or explicitly classified, the result reached the evidence floor (or
 * an evidence-backed no-qualified outcome was established), no query cap or
 * silent pipeline loss caused the absence, and no ineligible/unproven source
 * was admitted. When the web lane was skipped / absent / errored, when
 * extraction produced nothing on every fetched page, or when search providers
 * were unavailable, the member is UNEVALUABLE with class
 * `discovery_blocked:<reason>` — counted in unevaluated, NEVER clean, NEVER an
 * issue attributed to the query builder, NEVER silently omitted. A profile
 * with zero evaluation stages is never clean.
 *
 * Consumers: amyReport.evaluateDiscovery (computes + gates the recall
 * detectors), flywheelCohort (receipt outcomes), probeCoverageLedger
 * (coverage credit — must agree with the receipt), the approval ledger's
 * hold-open rule, and the offline cohort-baseline script. Pure: no imports,
 * no I/O, no clock.
 */

/** Reasons a discovery run is BLOCKED from evaluation. The first four are the
 *  derivable lane-counter reasons; the rest name evidence states honestly. */
export const DISCOVERY_BLOCK_REASON = Object.freeze({
  NO_CRAWL: 'no_crawl',
  PROVIDER_UNAVAILABLE: 'provider_unavailable',
  EXTRACTION_FAILED: 'extraction_failed',
  BUDGET_TRUNCATED: 'budget_truncated',
  PROVIDER_DEGRADED: 'provider_degraded',
  PROVIDER_UNKNOWN: 'provider_unknown',
  STAGES_UNKNOWN: 'stages_unknown',
})

const BLOCK_REASONS = new Set(Object.values(DISCOVERY_BLOCK_REASON))

/** `discovery_blocked:<reason>` — the exception class the receipt reports. */
export function blockedClass(reason) {
  return `discovery_blocked:${reason}`
}

/** Finding classes whose evidence depends on the open-web lane having run healthily. */
export const RECALL_FINDING_TYPES = Object.freeze(['institution_recall_miss', 'hyperlocal_recall_miss'])

const UNAVAILABLE_STATUSES = new Set(['error', 'unavailable', 'not_attempted'])

function count(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Classify the search side of the lane from its provenance + counters.
 * Mirrors searchAttribution.searchEvidence for the healthy/degraded/unknown
 * split and adds the UNAVAILABLE case (every query error/unavailable/not
 * attempted) that the requirement names as a distinct block reason.
 */
function classifySearch(lane) {
  const provenance = Array.isArray(lane?.search_provenance) ? lane.search_provenance : []
  const queries = Array.isArray(lane?.queries) ? lane.queries.length : count(lane?.queries)
  const unavailableCounter = count(lane?.search_unavailable_queries)
  const degradedCounter = count(lane?.search_degraded_queries)
  const unknownCounter = count(lane?.search_unknown_provenance_count)
  const statuses = provenance.map((p) => String(p?.status ?? '').toLowerCase())
  const allUnavailable = statuses.length > 0 && statuses.every((s) => UNAVAILABLE_STATUSES.has(s))
  if (allUnavailable || (unavailableCounter !== null && unavailableCounter > 0 && queries !== null && queries > 0 && unavailableCounter >= queries)) {
    return 'unavailable'
  }
  const degraded = (degradedCounter !== null && degradedCounter > 0)
    || (unavailableCounter !== null && unavailableCounter > 0)
    || statuses.some((s) => /degrad|error|unavailable|not_attempted/.test(s))
  if (degraded) return 'degraded'
  const healthy = provenance.length > 0
    && !(unknownCounter !== null && unknownCounter > 0)
    && provenance.every((p) => String(p?.status ?? '') === 'ok'
      && p?.provider && String(p.provider).trim() && String(p.provider).trim() !== 'unknown'
      && p?.provenance && String(p.provenance).trim() && String(p.provenance).trim() !== 'unknown')
  return healthy ? 'healthy' : 'unknown'
}

/**
 * Classify ONE web-lane telemetry object (`run.web_lane`) into an evaluability
 * verdict. This is the only function that reads lane counters.
 *
 * @param {object|null|undefined} lane   run.web_lane as returned by runProfileDiscoveryLive
 * @param {object} [opts]
 * @param {object|string|null} [opts.primaryAttribution]  lane B's primary attribution
 *   ({reason, detail} or a bare reason string); when present and in the block
 *   vocabulary it names the reason instead of the derived one.
 * @returns {{
 *   present:boolean, executed:boolean, skipped:boolean, skip_reason:string|null, errored:boolean, error:string|null,
 *   counters:object, search:string, extraction:string, llm:string,
 *   evaluable:boolean, recall_measurable:boolean, reason:string|null, class:string|null, detail:string|null,
 *   provider_health:{search:string, llm:string, detail:string}
 * }}
 */
export function classifyWebLane(lane, { primaryAttribution = null } = {}) {
  const present = Boolean(lane && typeof lane === 'object')
  const counters = {
    queries: Array.isArray(lane?.queries) ? lane.queries.length : count(lane?.queries),
    pages: count(lane?.pages),
    seeded: count(lane?.seeded),
    fetched: count(lane?.fetched),
    extracted: count(lane?.extracted),
    stored: count(lane?.stored),
    deduped: count(lane?.deduped),
    rejected: count(lane?.rejected),
    search_unavailable_queries: count(lane?.search_unavailable_queries),
    search_degraded_queries: count(lane?.search_degraded_queries),
    search_unknown_provenance_count: count(lane?.search_unknown_provenance_count),
  }
  const attribution = primaryAttribution ?? lane?.primary_attribution ?? null
  const attributedReason = typeof attribution === 'string'
    ? attribution
    : (attribution && typeof attribution === 'object' ? attribution.reason ?? null : null)
  const attributedDetail = attribution && typeof attribution === 'object' ? (attribution.detail ?? null) : null

  const base = {
    present,
    executed: false,
    skipped: false,
    skip_reason: null,
    errored: false,
    error: null,
    counters,
    search: 'not_run',
    extraction: 'not_run',
    llm: 'not_run',
    evaluable: false,
    recall_measurable: false,
    reason: null,
    class: null,
    detail: null,
    provider_health: { search: 'not_run', llm: 'not_run', detail: '' },
  }
  const finish = (out) => {
    // Lane B's attribution names the reason when it is in the vocabulary; the
    // derived reason stays in `detail` so nothing is lost.
    if (!out.evaluable && attributedReason && BLOCK_REASONS.has(String(attributedReason))) {
      const derived = out.reason
      out.reason = String(attributedReason)
      out.detail = attributedDetail ?? (derived && derived !== out.reason ? `derived:${derived}` : out.detail)
    }
    out.class = out.reason ? blockedClass(out.reason) : null
    out.provider_health = {
      search: out.search,
      llm: out.llm,
      detail: [
        counters.queries !== null ? `queries=${counters.queries}` : null,
        counters.pages !== null ? `pages=${counters.pages}` : null,
        counters.fetched !== null ? `fetched=${counters.fetched}` : null,
        counters.extracted !== null ? `extracted=${counters.extracted}` : null,
        counters.stored !== null ? `stored=${counters.stored}` : null,
        out.reason ? `blocked=${out.reason}` : null,
        out.detail ? `detail=${out.detail}` : null,
      ].filter(Boolean).join(' '),
    }
    return out
  }

  if (!present) {
    return finish({ ...base, reason: DISCOVERY_BLOCK_REASON.NO_CRAWL, detail: 'web_lane_absent' })
  }
  if (lane.skipped) {
    const skipReason = lane.reason ? String(lane.reason) : null
    const reason = skipReason === 'time_budget_exhausted' ? DISCOVERY_BLOCK_REASON.BUDGET_TRUNCATED : DISCOVERY_BLOCK_REASON.NO_CRAWL
    return finish({ ...base, skipped: true, skip_reason: skipReason, reason, detail: skipReason ? `skipped:${skipReason}` : 'skipped' })
  }
  const hasCounters = counters.queries !== null || counters.pages !== null || counters.fetched !== null || counters.extracted !== null
    || (Array.isArray(lane.search_provenance) && lane.search_provenance.length > 0)
  if (lane.ok === false && !hasCounters) {
    const error = lane.error ? String(lane.error) : (lane.reason ? String(lane.reason) : 'web_lane_error')
    return finish({ ...base, errored: true, error, reason: DISCOVERY_BLOCK_REASON.NO_CRAWL, detail: `web_lane_error:${error}`.slice(0, 200) })
  }

  const search = classifySearch(lane)
  const out = { ...base, executed: true, search, errored: lane.ok === false, error: lane.error ? String(lane.error) : null }

  // Extraction verdict from the lane's own counters. `undefined` counters are
  // legacy telemetry and read as UNKNOWN — never as "failed" (silence is not a
  // denial) and never as "produced".
  if (counters.extracted === null) {
    out.extraction = 'unknown'
    out.llm = 'unknown'
  } else if (counters.extracted > 0) {
    out.extraction = 'produced'
    out.llm = 'healthy'
  } else if (counters.fetched !== null && counters.fetched > 0) {
    out.extraction = 'failed'
    out.llm = 'unavailable'
  } else if (counters.pages !== null && counters.pages > 0) {
    // Pages were found but none could be fetched — nothing reached extraction.
    out.extraction = 'none_fetched'
    out.llm = 'not_run'
  } else {
    // Search returned no pages at all: extraction had nothing to do. The lane
    // ran; whether search found anything is a recall question, not a block.
    out.extraction = 'no_pages'
    out.llm = 'not_run'
  }

  if (search === 'unavailable') {
    return finish({ ...out, reason: DISCOVERY_BLOCK_REASON.PROVIDER_UNAVAILABLE, detail: 'every_search_query_unavailable' })
  }
  if (out.extraction === 'failed') {
    return finish({ ...out, reason: DISCOVERY_BLOCK_REASON.EXTRACTION_FAILED, detail: `zero_extractions_on_${counters.fetched}_fetched_pages` })
  }
  if (out.extraction === 'none_fetched') {
    return finish({ ...out, reason: DISCOVERY_BLOCK_REASON.EXTRACTION_FAILED, detail: `zero_pages_fetched_of_${counters.pages}` })
  }

  // The lane executed and extraction is not provably broken. Recall findings
  // are MEASURABLE only against healthy search; degraded/unknown search keeps
  // the run evaluable for the other detectors (an ineligible ACCEPT is an
  // ineligible ACCEPT whatever the SERP did) but cannot make a member clean.
  out.evaluable = true
  out.recall_measurable = search === 'healthy'
  if (search === 'degraded') {
    out.reason = DISCOVERY_BLOCK_REASON.PROVIDER_DEGRADED
    out.detail = 'search_degraded_recall_unmeasurable'
  } else if (search === 'unknown') {
    out.reason = DISCOVERY_BLOCK_REASON.PROVIDER_UNKNOWN
    out.detail = 'search_provenance_unknown_recall_unmeasurable'
  }
  return finish(out)
}

/**
 * The gate for one EVALUATION row. New rows carry `discovery_gate` from
 * evaluateDiscovery; legacy rows (persisted before this module, or hand-built
 * fixtures) are derived from whatever evidence they carry — and a row with NO
 * stage evidence at all is `discovery_blocked:stages_unknown`, never clean.
 */
export function discoveryGateFor(evaluation) {
  const gate = evaluation?.discovery_gate
  if (gate && typeof gate === 'object' && typeof gate.evaluable === 'boolean') {
    return {
      evaluable: gate.evaluable,
      recall_measurable: gate.recall_measurable === true,
      reason: gate.reason ?? null,
      class: gate.class ?? (gate.reason ? blockedClass(gate.reason) : null),
      detail: gate.detail ?? null,
      legacy: false,
    }
  }
  const status = evaluation?.search_evidence?.status
  if (status === 'healthy') {
    return { evaluable: true, recall_measurable: true, reason: null, class: null, detail: 'legacy_row_healthy_search', legacy: true }
  }
  if (status === 'degraded') {
    return { evaluable: true, recall_measurable: false, reason: DISCOVERY_BLOCK_REASON.PROVIDER_DEGRADED, class: blockedClass(DISCOVERY_BLOCK_REASON.PROVIDER_DEGRADED), detail: 'legacy_row_degraded_search', legacy: true }
  }
  return { evaluable: false, recall_measurable: false, reason: DISCOVERY_BLOCK_REASON.STAGES_UNKNOWN, class: blockedClass(DISCOVERY_BLOCK_REASON.STAGES_UNKNOWN), detail: 'legacy_row_no_stage_evidence', legacy: true }
}

/** The goals/rules bar: status ok, zero findings, every ACCEPT oracle-checked, every stage ran healthily. */
export function isCleanEvaluation(evaluation) {
  if (!evaluation) return false
  if (evaluation.status !== 'ok') return false
  if (Array.isArray(evaluation.findings) && evaluation.findings.length > 0) return false
  const gate = discoveryGateFor(evaluation)
  if (!gate.evaluable || !gate.recall_measurable) return false
  // ACCEPT is the match engine's decision, not independent qualification
  // proof. A clean member must have every accepted opportunity exercised by
  // the bounded synthetic-fixture oracle. Unknown/missing evidence is not clean.
  const oracle = evaluation.opportunity_oracle
  const accepted = Number(evaluation.accepted)
  if (!Number.isInteger(accepted) || accepted <= 0) return false
  if (!oracle || oracle.status !== 'checked' || oracle.complete !== true) return false
  if (Number(oracle.accepted_claims) !== accepted) return false
  if (Number(oracle.checked_accepts) !== accepted) return false
  if (Number(oracle.unknown_accepts) !== 0 || Number(oracle.known_conflicts) !== 0) return false
  return true
}

/**
 * The canonical outcome of one evaluation, shared by the cohort receipt and
 * the probe-coverage ledger so coverage credit can never exceed receipt credit.
 *
 * @returns {{ outcome:'errored'|'skipped'|'unevaluable'|'clean'|'issue', class:string|null }}
 */
export function evaluationOutcome(evaluation) {
  const status = String(evaluation?.status || '').toLowerCase()
  if (status === 'error') return { outcome: 'errored', class: 'crawler_error' }
  if (status === 'skipped') return { outcome: 'skipped', class: 'discovery_skipped' }
  if (!['ok', 'weak', 'zero'].includes(status)) return { outcome: 'unevaluable', class: 'status_unknown' }

  const gate = discoveryGateFor(evaluation)
  if (!gate.evaluable) return { outcome: 'unevaluable', class: gate.class || blockedClass(DISCOVERY_BLOCK_REASON.STAGES_UNKNOWN) }

  const findings = Array.isArray(evaluation?.findings) ? evaluation.findings : []
  if (!gate.recall_measurable) {
    // Degraded/unknown search: a non-recall finding (ineligible ACCEPT, false
    // positive, source failure…) was measured regardless of the SERP and is a
    // real issue; a member with only recall findings, or none, cannot be told
    // apart from a search artefact and is unevaluable under the search class.
    const nonRecall = findings.filter((f) => !RECALL_FINDING_TYPES.includes(String(f?.type)))
    if (nonRecall.length === 0) return { outcome: 'unevaluable', class: gate.class || blockedClass(DISCOVERY_BLOCK_REASON.PROVIDER_UNKNOWN) }
    return { outcome: 'issue', class: 'issue' }
  }
  if (status === 'ok') {
    const oracleStatus = evaluation?.opportunity_oracle?.status
    if (!['checked', 'conflict'].includes(oracleStatus)) return { outcome: 'unevaluable', class: 'oracle_unevaluable' }
  }
  return isCleanEvaluation(evaluation) ? { outcome: 'clean', class: 'clean' } : { outcome: 'issue', class: 'issue' }
}

export default {
  DISCOVERY_BLOCK_REASON,
  RECALL_FINDING_TYPES,
  blockedClass,
  classifyWebLane,
  discoveryGateFor,
  isCleanEvaluation,
  evaluationOutcome,
}
