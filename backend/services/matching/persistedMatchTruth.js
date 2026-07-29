import { canonicalOpportunityKey } from '../../crawler-os/contract.js'

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
      ['DIRECTORY', 'PAST_AWARD_INTEL', 'REFERRAL'].includes(kind),
  )
}

function scoreEvidence(row, score) {
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

/**
 * Reapply the persisted profile↔opportunity score and decision after the
 * read-time trust/profile gate has run.
 *
 * The gate is intentionally allowed to recompute internally because it catches
 * current hard-ineligibility and malformed-source conditions. Its recomputed
 * score is NOT allowed to replace the persisted data-point-scale score, however.
 * Doing so produced owner-facing values as high as 97 for rows stored at 2–36,
 * inflated broad matches into ACCEPT, and made the explanation disagree with
 * the database. This helper restores one score truth before display filtering.
 */
export function restorePersistedMatchTruth(canonicalRows = [], persistedRows = []) {
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

    // A direct REJECT is never owner-facing. Directory resources remain a
    // REVIEW-only search aid and still have to clear the directory score floor.
    if (!directory && storedDecision === 'REJECT') continue

    const score = numericScore(persisted.match_score, canonical.match_score)
    const decision = directory
      ? 'REVIEW'
      : storedDecision === 'ACCEPT' || storedDecision === 'REVIEW'
        ? storedDecision
        : 'REVIEW'
    const explanation = scoreEvidence(persisted, score)

    restored.push({
      ...canonical,
      match_score: score,
      match_decision: decision,
      decision,
      match_explanation: explanation,
      match_decision_explanation: explanation,
      why: explanation,
      match_reasons: parseReasons(persisted.match_reasons),
      matcher_version: persisted.matcher_version ?? canonical.matcher_version ?? null,
      ineligibility_reasons: parseReasons(persisted.ineligibility_reasons),
      is_directory: directory,
    })
  }

  // Defense in depth for historical duplicates: use both the repository's
  // canonical cross-source identity and a conservative singular/plural-normalized
  // title+sponsor identity. Keep the highest persisted score for each program.
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
