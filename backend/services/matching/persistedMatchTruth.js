import { canonicalOpportunityKey } from '../../crawler-os/contract.js'
import {
  applyNeedFirstScoring,
  NEED_FIRST_SCORING_VERSION,
} from './needFirstScoringAdapter.js'

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(String(value))
  } catch {
    return fallback
  }
}

function parseReasons(value) {
  const parsed = parseJson(value, value)
  if (Array.isArray(parsed)) return parsed.map((item) => String(item || '').trim()).filter(Boolean)
  if (typeof parsed === 'string') {
    return parsed
      .split(/[;,|]+/)
      .map((item) => item.trim())
      .filter(Boolean)
  }
  return []
}

function numericScore(value, fallback = 0) {
  const score = Number(value)
  if (Number.isFinite(score)) return Math.round(Math.max(0, Math.min(100, score)))
  const backup = Number(fallback)
  return Number.isFinite(backup) ? Math.round(Math.max(0, Math.min(100, backup))) : 0
}

function rowKey(row) {
  return String(row?.id ?? row?.opportunity_id ?? '').trim()
}

function isDirectory(row) {
  const kind = String(
    row?.opportunity_kind ??
      row?.opportunity_type ??
      row?.type ??
      '',
  ).toUpperCase()
  return Boolean(
    row?.is_directory === true ||
      row?.is_directory_resource === true ||
      row?.is_resource === true ||
      ['DIRECTORY', 'PAST_AWARD_INTEL', 'SCHOOL_PORTAL', 'REFERRAL'].includes(kind),
  )
}

function scoreEvidence(row, score, adjusted = null) {
  if (adjusted?.explanation) return adjusted.explanation
  const explanation = parseJson(row?.match_explain_json, {}) || {}
  const breakdown = explanation.scoreBreakdown ?? explanation.score_breakdown ?? {}
  const evidence = explanation.dataPointEvidence ?? explanation.data_point_evidence ?? {}
  const total = Number(
    evidence.total ??
      breakdown.data_point_total ??
      breakdown.denominator,
  )
  const credit = Number(
    evidence.total_credit ??
      breakdown.data_point_total_credit ??
      evidence.credit ??
      breakdown.data_point_credit ??
      breakdown.numerator,
  )

  if (Number.isFinite(total) && total > 0 && Number.isFinite(credit)) {
    const roundedCredit = Math.round(credit * 10) / 10
    return `Matched ${roundedCredit} of ${total} substantive profile data points; eligibility and geography gates produced a match score of ${score}.`
  }

  const reasons = parseReasons(row?.match_reasons)
  if (reasons.length > 0) {
    return `Profile match score ${score}. Evidence: ${reasons.slice(0, 4).join(', ')}.`
  }

  const legacy = String(row?.match_explanation ?? '').trim()
  if (legacy) {
    const withoutRetiredScore = legacy
      .replace(/\bscore\s+\d+(?:\.\d+)?\s*\/\s*100\s*;?\s*/i, '')
      .replace(/\bcovers about\s+\d+(?:\.\d+)?%[^.]*\.?\s*/i, '')
      .trim()
    if (withoutRetiredScore) return `Profile match score ${score}. ${withoutRetiredScore}`
  }

  const lane = String(row?.matcher_version ?? '').trim()
  return lane
    ? `Profile match score ${score} from the ${lane} discovery lane; detailed data-point evidence is unavailable for this legacy match.`
    : `Profile match score ${score}; detailed data-point evidence is unavailable for this legacy match.`
}

function looseIdentityText(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\bscholarships\b/g, 'scholarship')
    .replace(/\bgrants\b/g, 'grant')
    .replace(/\bawards\b/g, 'award')
    .replace(/\bfellowships\b/g, 'fellowship')
    .replace(/\bprogrammes\b/g, 'program')
    .replace(/\bprograms\b/g, 'program')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ')
}

function duplicateKeys(row) {
  const canonical = canonicalOpportunityKey({
    ...row,
    apply_url: row.apply_url ?? row.application_url ?? row.url ?? null,
    info_url: row.source_url ?? null,
  })
  const title = looseIdentityText(row.title)
  const sponsor = looseIdentityText(row.sponsor)
  const loose = title ? `loose:${sponsor}::${title}` : ''
  return [...new Set([canonical, loose].filter((key) => key && key !== 'id:'))]
}

function adjustPersistedRow(persisted, canonical, profileContext, directory) {
  const storedDecision = directory
    ? 'REVIEW'
    : String(persisted.match_decision ?? 'REVIEW').trim().toUpperCase()
  const storedScore = numericScore(persisted.match_score, canonical.match_score)
  const rawExplain = parseJson(persisted.match_explain_json, {}) || {}
  const storedReasons = parseReasons(persisted.match_reasons)
  const matchedNeeds = Array.isArray(rawExplain.matchedNeeds)
    ? rawExplain.matchedNeeds
    : Array.isArray(rawExplain.matched_needs)
      ? rawExplain.matched_needs
      : storedReasons

  if (!profileContext) {
    return {
      score: storedScore,
      decision: storedDecision,
      explanation: null,
      reasons: storedReasons,
      match_explain: rawExplain,
      scoringPolicyVersion: rawExplain.scoring_policy_version ?? null,
    }
  }

  return applyNeedFirstScoring({
    canonical: {
      score: storedScore,
      decision: storedDecision,
      explanation: persisted.match_explanation ?? null,
      reasons: storedReasons,
      matchedNeeds,
      match_explain: rawExplain,
      matcherVersion: rawExplain.matcher_version ?? null,
    },
    profileContext,
    opportunity: persisted,
  })
}

/**
 * Restore one persisted score truth after read-time trust/profile gates, then
 * enforce the current need-first policy against that exact stored evidence.
 * The owner-facing score therefore equals the persisted score unless the current
 * policy intentionally lowers/rejects it; the reconciliation service persists
 * that same adjustment so the two converge permanently.
 */
export function restorePersistedMatchTruth(canonicalRows = [], persistedRows = [], opts = {}) {
  const profileContext = opts?.profileContext ?? null
  const persistedById = new Map()
  for (const row of Array.isArray(persistedRows) ? persistedRows : []) {
    const key = rowKey(row)
    if (key) persistedById.set(key, row)
  }

  const restored = []
  for (const canonical of Array.isArray(canonicalRows) ? canonicalRows : []) {
    const persisted = persistedById.get(rowKey(canonical))
    if (!persisted) {
      restored.push(canonical)
      continue
    }

    const directory = isDirectory(canonical) || isDirectory(persisted)
    const storedDecision = String(persisted.match_decision ?? '').trim().toUpperCase()
    if (!directory && storedDecision === 'REJECT') continue

    const adjusted = adjustPersistedRow(persisted, canonical, profileContext, directory)
    const decision = directory ? 'REVIEW' : String(adjusted.decision ?? 'REVIEW').toUpperCase()
    if (!directory && decision === 'REJECT') continue

    const score = numericScore(adjusted.score, persisted.match_score)
    const explanation = scoreEvidence(persisted, score, adjusted)

    restored.push({
      ...canonical,
      match_score: score,
      match_decision: decision,
      decision,
      match_explanation: explanation,
      match_decision_explanation: explanation,
      why: explanation,
      match_reasons: Array.isArray(adjusted.reasons) ? adjusted.reasons : parseReasons(persisted.match_reasons),
      match_explain_json: adjusted.match_explain ?? parseJson(persisted.match_explain_json, {}),
      matcher_version: persisted.matcher_version ?? canonical.matcher_version ?? null,
      scoring_policy_version: adjusted.scoringPolicyVersion ?? NEED_FIRST_SCORING_VERSION,
      ineligibility_reasons: parseReasons(persisted.ineligibility_reasons),
      is_directory: directory,
      is_resource: directory,
    })
  }

  restored.sort((a, b) => Number(b.match_score || 0) - Number(a.match_score || 0))
  const seen = new Set()
  return restored.filter((row) => {
    const keys = duplicateKeys(row)
    if (keys.some((key) => seen.has(key))) return false
    keys.forEach((key) => seen.add(key))
    return true
  })
}

export default { restorePersistedMatchTruth }
