import { ACCEPT_SCORE, SCORE_FLOOR } from '../../config/matchThresholds.js'

/**
 * An unconfirmed match must remain below the engine's ACCEPT threshold, but it
 * stays visible for human review. This is a cap, never a rejection or a score
 * floor. Lower measured scores remain lower.
 */
export const ELIGIBILITY_UNCONFIRMED_SCORE_CAP = Math.max(
  SCORE_FLOOR,
  ACCEPT_SCORE - 1,
)

/**
 * `evaluateEligibility()` also reports missing actionability/geography facts.
 * Those are important, but they are not applicant eligibility and therefore do
 * not trigger this cap. Their own gates and labels remain authoritative.
 */
export const NON_ELIGIBILITY_MISSING_FIELDS = Object.freeze(new Set([
  'application_url',
  'profile_location',
  'local_award_out_of_state',
]))

function asArray(value) {
  if (Array.isArray(value)) return value
  if (value === null || value === undefined || value === '') return []
  if (typeof value !== 'string') return [value]
  const trimmed = value.trim()
  if (!trimmed) return []
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) return parsed
    } catch {
      // Fall through to delimiter parsing.
    }
  }
  return trimmed.split(/[,;|]/).map((entry) => entry.trim()).filter(Boolean)
}

function normalizeField(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function unique(values) {
  const out = []
  const seen = new Set()
  for (const value of values) {
    const normalized = normalizeField(value)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}

/**
 * Read the canonical engine's missing-field evidence and distinguish real
 * applicant-eligibility uncertainty from missing URL/geography metadata.
 */
export function eligibilityConfirmationOf(canonical = {}) {
  const explain = canonical?.match_explain ?? {}
  const policy = explain?.eligibility_confirmation ?? explain?.eligibilityConfirmation ?? {}
  const allMissingFields = unique([
    ...asArray(canonical?.missingEligibilityFields),
    ...asArray(explain?.missingEligibilityFields),
    ...asArray(explain?.missing_eligibility_fields),
    ...asArray(policy?.missing_fields),
  ])
  const missingFields = allMissingFields.filter(
    (field) => !NON_ELIGIBILITY_MISSING_FIELDS.has(field),
  )
  const unconfirmed = missingFields.length > 0

  return {
    confirmed: !unconfirmed,
    unconfirmed,
    missingFields,
    allMissingFields,
    scoreCap: unconfirmed ? ELIGIBILITY_UNCONFIRMED_SCORE_CAP : null,
  }
}

function numericScore(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : SCORE_FLOOR
}

function humanize(field) {
  return String(field ?? '').replace(/_/g, ' ')
}

/**
 * Apply the policy after substantive fit scoring. A canonical REJECT remains a
 * REJECT; a resource stays governed by the resource/pointer policy. Direct
 * ACCEPT/REVIEW rows with unresolved applicant eligibility are capped and held
 * at REVIEW with explicit machine-readable and owner-readable evidence.
 */
export function applyEligibilityConfirmationPolicy({
  canonical = {},
  score,
  decision,
  explanation = null,
  reasons = [],
  resource = false,
} = {}) {
  const confirmation = eligibilityConfirmationOf(canonical)
  const normalizedDecision = String(decision ?? canonical?.decision ?? 'REVIEW').toUpperCase()
  const initialScore = numericScore(score ?? canonical?.score)

  if (!confirmation.unconfirmed || resource) {
    return {
      score: initialScore,
      decision: normalizedDecision,
      explanation,
      reasons: Array.isArray(reasons) ? reasons : [],
      confirmation,
      applied: false,
    }
  }

  const cappedScore = Math.min(initialScore, confirmation.scoreCap)
  const nextDecision = normalizedDecision === 'REJECT' ? 'REJECT' : 'REVIEW'
  const missingText = confirmation.missingFields.map(humanize).join(', ')
  const label = `Eligibility unconfirmed: ${missingText}. Score capped at ${confirmation.scoreCap} pending confirmation.`
  const nextReasons = [...new Set([
    ...(Array.isArray(reasons) ? reasons : []),
    label,
  ].filter(Boolean))]
  const baseExplanation = String(explanation ?? canonical?.explanation ?? '').trim()
  const nextExplanation = nextDecision === 'REJECT'
    ? baseExplanation
    : [baseExplanation, `Eligibility is unconfirmed (${missingText}); review the program criteria before pursuing.`]
        .filter(Boolean)
        .join(' ')

  return {
    score: cappedScore,
    decision: nextDecision,
    explanation: nextExplanation,
    reasons: nextReasons,
    confirmation,
    applied: true,
  }
}

export default {
  ELIGIBILITY_UNCONFIRMED_SCORE_CAP,
  NON_ELIGIBILITY_MISSING_FIELDS,
  eligibilityConfirmationOf,
  applyEligibilityConfirmationPolicy,
}
