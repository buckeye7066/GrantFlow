/**
 * Boundary assertion for consumers of the one authoritative matcher.
 * This module does not score, filter, or reinterpret a pair; it only rejects
 * malformed/non-canonical results before they cross an API or persistence
 * boundary.
 */
import { MATCHER_VERSION } from './matchDecisionEngine.js'

export const CANONICAL_MATCH_AUTHORITY = 'matchEngine.computeMatchDecision'
export const CANONICAL_MATCH_CONTRACT_VERSION = 'canonical-match-result-v1'

export class CanonicalMatchAuthorityError extends Error {
  constructor(message, details = null) {
    super(message)
    this.name = 'CanonicalMatchAuthorityError'
    this.code = 'NON_CANONICAL_MATCH_RESULT'
    this.details = details
  }
}

export function assertCanonicalMatchDecision(result) {
  if (!result || typeof result !== 'object') {
    throw new CanonicalMatchAuthorityError('Canonical match result must be an object')
  }
  if (!Number.isFinite(Number(result.score))) {
    throw new CanonicalMatchAuthorityError('Canonical match result must contain a finite score')
  }
  const decision = String(result.decision ?? '').toUpperCase()
  if (!['ACCEPT', 'REVIEW', 'REJECT'].includes(decision)) {
    throw new CanonicalMatchAuthorityError('Canonical match result has an invalid decision', {
      decision: result.decision ?? null,
    })
  }
  if (result.matcherVersion !== MATCHER_VERSION) {
    throw new CanonicalMatchAuthorityError('Match result was not produced by the current canonical matcher', {
      expected: MATCHER_VERSION,
      received: result.matcherVersion ?? null,
    })
  }
  if (!result.scoreScaleId || !result.evaluatedAt) {
    throw new CanonicalMatchAuthorityError('Canonical match result is missing score-scale or evaluation provenance')
  }
  return result
}

export function canonicalMatchReceipt(result) {
  const canonical = assertCanonicalMatchDecision(result)
  return {
    authority: CANONICAL_MATCH_AUTHORITY,
    contract_version: CANONICAL_MATCH_CONTRACT_VERSION,
    matcher_version: canonical.matcherVersion,
    scoring_policy_version: canonical.scoringPolicyVersion ?? null,
    score_scale_id: canonical.scoreScaleId,
    evaluated_at: canonical.evaluatedAt,
  }
}

export default { assertCanonicalMatchDecision, canonicalMatchReceipt }
