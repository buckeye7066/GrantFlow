import { createLogger } from '../../utils/logger.js'
import {
  applyNeedFirstScoring,
  NEED_FIRST_SCORING_VERSION,
} from './needFirstScoringAdapter.js'

const log = createLogger('needFirstReconciler')
const SURFACED_LANES = new Set(['crawler-os', 'crawler-os-xmatch', 'web-llm'])

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(String(value)) } catch { return fallback }
}

function parseReasons(value) {
  const parsed = parseJson(value, value)
  if (Array.isArray(parsed)) return parsed.map((entry) => String(entry || '').trim()).filter(Boolean)
  if (typeof parsed === 'string') {
    return parsed.split(/[;,|]+/).map((entry) => entry.trim()).filter(Boolean)
  }
  return []
}

function isCurrent(explain) {
  return String(
    explain?.scoring_policy_version ??
    explain?.scoreBreakdown?.scoring_policy_version ??
    explain?.score_breakdown?.scoring_policy_version ??
    '',
  ) === NEED_FIRST_SCORING_VERSION
}

function persistedCanonical(row, explain) {
  const matchedNeeds = Array.isArray(explain?.matchedNeeds)
    ? explain.matchedNeeds
    : Array.isArray(explain?.matched_needs)
      ? explain.matched_needs
      : parseReasons(row.match_reasons)
  return {
    score: Number(row.match_score) || 0,
    decision: String(row.match_decision || 'REVIEW').toUpperCase(),
    explanation: row.match_explanation ?? null,
    reasons: parseReasons(row.match_reasons),
    matchedNeeds,
    match_explain: explain ?? {},
    matcherVersion: explain?.matcher_version ?? null,
  }
}

function changed(row, adjusted) {
  const oldScore = Math.round(Number(row.match_score) || 0)
  const oldDecision = String(row.match_decision || 'REVIEW').toUpperCase()
  const newScore = Math.round(Number(adjusted.score) || 0)
  const newDecision = String(adjusted.decision || 'REVIEW').toUpperCase()
  return oldScore !== newScore || oldDecision !== newDecision
}

/**
 * Idempotently reconcile a profile's persisted surfaced matches to the current
 * need-first scoring policy. Discovery lane identity remains untouched.
 */
export async function reconcileNeedFirstProfileMatches(db, {
  profileId,
  profileContext,
  limit = 2000,
} = {}) {
  if (!db || typeof db.prepare !== 'function') {
    return { ok: false, reason: 'db_required', scanned: 0, updated: 0 }
  }
  if (!profileId || !profileContext) {
    return { ok: false, reason: 'profile_context_required', scanned: 0, updated: 0 }
  }

  const rows = await db.prepare(
    `SELECT m.profile_id, m.opportunity_id, m.match_score, m.match_decision,
            m.match_explanation, m.match_reasons, m.match_explain_json,
            m.matcher_version,
            o.id, o.title, o.sponsor, o.description, o.summary,
            o.eligibility, o.eligibility_text, o.eligibility_criteria,
            o.restrictions, o.opportunity_kind, o.opportunity_type, o.type,
            o.funding_type, o.categories, o.keywords, o.application_url,
            o.apply_url, o.source_url, o.record_origin
       FROM profile_opportunity_matches m
       JOIN funding_opportunities o ON o.id = m.opportunity_id
      WHERE m.profile_id = ?
      ORDER BY m.match_score DESC
      LIMIT ?`,
  ).all(String(profileId), Math.max(1, Math.min(5000, Number(limit) || 2000)))

  let scanned = 0
  let current = 0
  let updated = 0
  let rejected = 0
  let demoted = 0
  let scoreLowered = 0
  const failures = []

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!SURFACED_LANES.has(String(row.matcher_version || ''))) continue
    scanned += 1
    const explain = parseJson(row.match_explain_json, {}) || {}
    if (isCurrent(explain)) {
      current += 1
      continue
    }

    try {
      const adjusted = applyNeedFirstScoring({
        canonical: persistedCanonical(row, explain),
        profileContext,
        opportunity: row,
      })
      const newDecision = String(adjusted.decision || 'REVIEW').toUpperCase()
      const newScore = Math.round(Number(adjusted.score) || 0)
      const wasChanged = changed(row, adjusted)

      if (newDecision === 'REJECT') rejected += 1
      if (String(row.match_decision || '').toUpperCase() === 'ACCEPT' && newDecision !== 'ACCEPT') demoted += 1
      if (newScore < Math.round(Number(row.match_score) || 0)) scoreLowered += 1

      const result = await db.prepare(
        `UPDATE profile_opportunity_matches
            SET match_score = ?,
                match_decision = ?,
                match_explanation = ?,
                match_reasons = ?,
                match_explain_json = ?,
                updated_at = CURRENT_TIMESTAMP,
                evaluated_at = CURRENT_TIMESTAMP
          WHERE profile_id = ? AND opportunity_id = ?`,
      ).run(
        newScore,
        newDecision.toLowerCase(),
        adjusted.explanation ?? null,
        JSON.stringify(adjusted.reasons ?? []),
        JSON.stringify(adjusted.match_explain ?? {}),
        String(profileId),
        String(row.opportunity_id),
      )
      if (Number(result?.changes ?? result?.rowCount ?? 0) > 0 || wasChanged) updated += 1
    } catch (error) {
      failures.push({
        opportunity_id: row.opportunity_id,
        error: error?.message || String(error),
      })
    }
  }

  const summary = {
    ok: failures.length === 0,
    profile_id: String(profileId),
    scoring_policy_version: NEED_FIRST_SCORING_VERSION,
    scanned,
    already_current: current,
    updated,
    rejected,
    demoted,
    score_lowered: scoreLowered,
    failures,
  }
  if (updated > 0 || failures.length > 0) log.info('need_first_reconcile', summary)
  return summary
}

export default { reconcileNeedFirstProfileMatches }
