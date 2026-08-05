import { NEED_FIRST_SCORING_VERSION } from './needFirstScoringAdapter.js'

export const MATCH_CONFIDENCE_PROVENANCE_VERSION = 'crawler-os-confidence-v1'
export const MATCH_CONFIDENCE_PROVENANCE_FIELD = 'match_confidence_provenance'

function parseExplain(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value !== 'string' || value.trim() === '') return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function finiteNumberLike(value) {
  if (typeof value === 'number') return Number.isFinite(value)
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))
}

function normalizedMeasurement(value) {
  if (!finiteNumberLike(value)) return null
  const numeric = Number(value)
  return numeric >= 0 && numeric <= 100 ? numeric : null
}

function normalizedDecision(value) {
  const decision = String(value ?? '').trim().toLowerCase()
  return ['accept', 'review', 'reject'].includes(decision) ? decision : null
}

function scoringPolicyVersion(explain) {
  return String(
    explain?.scoring_policy_version ??
    explain?.scoreBreakdown?.scoring_policy_version ??
    explain?.score_breakdown?.scoring_policy_version ??
    '',
  ).trim()
}

export function hasMatchConfidenceProvenance(explainValue) {
  const explain = parseExplain(explainValue)
  return Object.prototype.hasOwnProperty.call(explain, MATCH_CONFIDENCE_PROVENANCE_FIELD)
}

export function stripMatchConfidenceProvenance(explainValue) {
  const explain = parseExplain(explainValue)
  const { [MATCH_CONFIDENCE_PROVENANCE_FIELD]: _provenance, ...withoutProvenance } = explain
  return withoutProvenance
}

/**
 * Bind a measured confidence to the exact persisted policy, score, and decision.
 * This marker is written only at the Crawler OS persistence boundary, after all
 * facade demotions have produced the final row. A policy label by itself is not
 * provenance: later integrity/audit passes can legitimately change score or
 * decision without re-measuring confidence.
 */
export function stampMatchConfidenceProvenance(explainValue, row = {}) {
  const explain = stripMatchConfidenceProvenance(explainValue)
  const score = normalizedMeasurement(row.match_score)
  const confidence = normalizedMeasurement(row.match_confidence)
  const decision = normalizedDecision(row.match_decision ?? row.decision)
  const policy = scoringPolicyVersion(explain)

  if (
    score === null ||
    confidence === null ||
    decision === null ||
    policy !== NEED_FIRST_SCORING_VERSION
  ) {
    return explain
  }

  return {
    ...explain,
    [MATCH_CONFIDENCE_PROVENANCE_FIELD]: {
      contract_version: MATCH_CONFIDENCE_PROVENANCE_VERSION,
      scoring_policy_version: policy,
      match_score: score,
      match_decision: decision,
      match_confidence: confidence,
    },
  }
}

/**
 * Return confidence only when its persistence-time provenance still matches the
 * row that will be displayed. Callers may provide the final read-time score and
 * decision; any policy/integrity adjustment then invalidates the old measure.
 */
export function trustedPersistedMatchConfidence(row = {}, overrides = {}) {
  const explain = parseExplain(
    overrides.matchExplainJson ?? overrides.match_explain_json ?? row.match_explain_json,
  )
  const provenance = explain[MATCH_CONFIDENCE_PROVENANCE_FIELD]
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) return null

  const rawScore = normalizedMeasurement(row.match_score)
  const finalScore = normalizedMeasurement(
    overrides.matchScore ?? overrides.match_score ?? row.match_score,
  )
  const confidence = normalizedMeasurement(row.match_confidence)
  const rawDecision = normalizedDecision(row.match_decision ?? row.decision)
  const finalDecision = normalizedDecision(
    overrides.matchDecision ?? overrides.match_decision ?? row.match_decision ?? row.decision,
  )
  const policy = scoringPolicyVersion(explain)

  if (
    rawScore === null ||
    finalScore === null ||
    confidence === null ||
    rawDecision === null ||
    finalDecision === null ||
    provenance.contract_version !== MATCH_CONFIDENCE_PROVENANCE_VERSION ||
    policy !== NEED_FIRST_SCORING_VERSION ||
    provenance.scoring_policy_version !== policy ||
    normalizedMeasurement(provenance.match_score) !== rawScore ||
    rawScore !== finalScore ||
    normalizedDecision(provenance.match_decision) !== rawDecision ||
    rawDecision !== finalDecision ||
    normalizedMeasurement(provenance.match_confidence) !== confidence
  ) {
    return null
  }

  return confidence
}

export default {
  MATCH_CONFIDENCE_PROVENANCE_FIELD,
  MATCH_CONFIDENCE_PROVENANCE_VERSION,
  hasMatchConfidenceProvenance,
  stampMatchConfidenceProvenance,
  stripMatchConfidenceProvenance,
  trustedPersistedMatchConfidence,
}
