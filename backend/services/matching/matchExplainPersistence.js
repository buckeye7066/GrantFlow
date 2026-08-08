/**
 * matchExplainPersistence.js — ONE shape for persisted match_explain_json.
 *
 * Recall nets (institution / field-of-study / in-state aid / county-crisis /
 * profile-discovery / funder-behavior) used to discard `decision.match_explain`
 * and write gate-only stubs. Funding Sources then reports those rows as
 * `scoring_policy_unknown` even when the engine scored them under the current
 * need_first policy (item 43 residue after catalog-rescore drain).
 *
 * Policy and score-scale MUST come from the engine decision (or its explain).
 * Never hardcode a policy version here — silence stays silence.
 */

import { SCORE_SCALE_ID } from '../../config/matchThresholds.js'

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/**
 * Merge canonical engine explain with linker gate provenance.
 * @param {object|null|undefined} decision  computeMatchDecision result
 * @param {object} [gateMeta]  linker-only fields (gate, institution, term, …)
 */
export function buildPersistedMatchExplain(decision, gateMeta = {}) {
  const explain = asObject(decision?.match_explain)
  const breakdown = asObject(explain.scoreBreakdown ?? explain.score_breakdown)
  const scoreScaleId =
    decision?.scoreScaleId ??
    explain.score_scale_id ??
    SCORE_SCALE_ID
  const scoringPolicyVersion =
    decision?.scoringPolicyVersion ??
    explain.scoring_policy_version ??
    breakdown.scoring_policy_version ??
    null
  const engineMatcherVersion =
    decision?.matcherVersion ?? explain.matcher_version ?? null

  const out = {
    ...explain,
    ...asObject(gateMeta),
    score_scale_id: scoreScaleId,
    matcher_version: engineMatcherVersion,
  }
  if (scoringPolicyVersion !== null && scoringPolicyVersion !== undefined && String(scoringPolicyVersion).trim() !== '') {
    out.scoring_policy_version = scoringPolicyVersion
  }
  return out
}

/** True when persisted explain cannot prove the current scoring policy. */
export function isStaleMatchExplain(raw) {
  if (raw === null || raw === undefined) return true
  let explain = raw
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (!text) return true
    try {
      explain = JSON.parse(text)
    } catch {
      return true
    }
  }
  if (!explain || typeof explain !== 'object' || Array.isArray(explain)) return true
  const policy = String(
    explain.scoring_policy_version ??
    explain.scoreBreakdown?.scoring_policy_version ??
    explain.score_breakdown?.scoring_policy_version ??
    '',
  ).trim()
  return !policy
}

/** SQL predicate (no leading AND) — shared by residue drains so they cannot drift. */
export function staleMatchExplainSql(alias = 'm') {
  const col = `${alias}.match_explain_json`
  return `(
    ${col} IS NULL
    OR ${col} NOT LIKE '%scoring_policy_version%'
    OR ${col} LIKE '%"scoring_policy_version": null%'
    OR ${col} LIKE '%"scoring_policy_version":null%'
    OR ${col} LIKE '%"scoring_policy_version": ""%'
    OR ${col} LIKE '%"scoring_policy_version":""%'
  )`
}

export default {
  buildPersistedMatchExplain,
  isStaleMatchExplain,
  staleMatchExplainSql,
}
