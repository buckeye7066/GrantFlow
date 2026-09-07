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

/**
 * The per-pair MATCH EVIDENCE keys, in both persisted shapes: the canonical
 * engine writes `matchedSignals`/`matchedNeeds`, crawler-os writes
 * `matched_profile_facts`/`matched_location`/`matched_needs`. An explain
 * carrying NONE of them records no evidence about this profile at all.
 *
 * That used to be merely uninformative; since the pointer half of the four
 * gates (crawler-os/pointerTruthPolicy.js) it is LOAD-BEARING, because those
 * gates read exactly these keys. A row whose explain lost them reads as
 * unproven even when the engine can prove it on the spot — measured 2026-09-06
 * on "Bradley-Cleveland Community Services Agency", the applicant's OWN county
 * agency: the stored explain held only `{gate, source, needFirstPolicy,
 * scoring_policy_version, dataPointEvidence, scoreBreakdown}`, while re-running
 * the real engine on the same pair returns
 * `matchedSignals: ["geo:city","keywords","needs"]` with 17 matched data points.
 *
 * KEY ABSENCE, NOT EMPTINESS, is the test — a fresh write always carries the
 * keys (empty arrays included), so a refreshed row stops being a candidate and
 * the drain converges instead of re-scoring the same pair every boot.
 */
const MATCH_EVIDENCE_KEYS = Object.freeze([
  'matchedSignals', 'matchedNeeds',
  'matched_profile_facts', 'matched_location', 'matched_needs',
])

function carriesMatchEvidence(explain) {
  return MATCH_EVIDENCE_KEYS.some((key) => explain[key] !== undefined)
}

/**
 * True when persisted explain cannot prove the current scoring policy, or
 * carries no per-pair match evidence for the display gates to read.
 */
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
  if (!policy) return true
  return !carriesMatchEvidence(explain)
}

/** SQL predicate (no leading AND) — shared by residue drains so they cannot drift. */
export function staleMatchExplainSql(alias = 'm') {
  const col = `${alias}.match_explain_json`
  const carriesEvidence = MATCH_EVIDENCE_KEYS
    .map((key) => `${col} LIKE '%${key}%'`)
    .join(' OR ')
  return `(
    ${col} IS NULL
    OR ${col} NOT LIKE '%scoring_policy_version%'
    OR ${col} LIKE '%"scoring_policy_version": null%'
    OR ${col} LIKE '%"scoring_policy_version":null%'
    OR ${col} LIKE '%"scoring_policy_version": ""%'
    OR ${col} LIKE '%"scoring_policy_version":""%'
    OR NOT (${carriesEvidence})
  )`
}

export default {
  buildPersistedMatchExplain,
  isStaleMatchExplain,
  staleMatchExplainSql,
}
