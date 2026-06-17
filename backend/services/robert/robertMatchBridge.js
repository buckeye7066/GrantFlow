/**
 * robertMatchBridge.js
 *
 * Bridges into the canonical match engine ONLY. Robert never invents
 * its own scoring; it uses `computeMatchDecision` and respects the
 * existing accept/review/reject thresholds.
 *
 * To keep tests deterministic, `computeMatchDecision` is injected
 * (default = lazy-imported real implementation).
 */

let _cachedComputeMatchDecision = null
async function getDefaultComputeMatchDecision() {
  if (_cachedComputeMatchDecision) return _cachedComputeMatchDecision
  const mod = await import('../matchEngine.js')
  _cachedComputeMatchDecision = mod.computeMatchDecision
  return _cachedComputeMatchDecision
}

/**
 * Score a profile/opportunity pair using the canonical engine.
 *
 * @param {object} args
 * @param {object} args.profileContext  output of loadProfileContext
 * @param {object} args.opportunity     normalized opportunity (or DB row)
 * @param {Function} [args.computeMatchDecision]
 * @returns {Promise<{ score, decision, reasons, eligible, missingProfileFields }>}
 */
export async function scoreOpportunityForProfile({ profileContext, opportunity, computeMatchDecision = null } = {}) {
  if (!profileContext?.profile) {
    return {
      score: 0,
      decision: 'NEEDS_PROFILE_DATA',
      reasons: ['Profile context missing'],
      eligible: 'maybe',
      missingProfileFields: [],
      explanation: 'Profile context not loaded.',
    }
  }
  if (!opportunity) {
    return {
      score: 0,
      decision: 'REJECT',
      reasons: ['Opportunity missing'],
      eligible: false,
      missingProfileFields: [],
      explanation: 'Opportunity not provided.',
    }
  }
  const fn = typeof computeMatchDecision === 'function'
    ? computeMatchDecision
    : await getDefaultComputeMatchDecision()
  const result = fn(profileContext.profile, opportunity, {
    profileSections: profileContext.sections,
    signals: profileContext.signals,
  })
  return {
    score: Number(result?.score) || 0,
    decision: result?.decision || 'REVIEW',
    reasons: Array.isArray(result?.reasons) ? result.reasons : [],
    eligible: result?.eligible,
    missingProfileFields: Array.isArray(result?.missingEligibilityFields) ? result.missingEligibilityFields : [],
    explanation: result?.explanation || '',
    matchExplain: result?.match_explain || null,
    matcherVersion: result?.matcherVersion || null,
  }
}

/**
 * Score a single opportunity against many profiles. Profiles are
 * loaded one at a time using the injected loader so we don't hold
 * everything in memory at once.
 */
export async function scoreOpportunityAcrossProfiles({
  db,
  opportunity,
  profileIds = [],
  loadProfileContext,
  computeMatchDecision = null,
}) {
  if (!db || !opportunity) return []
  if (typeof loadProfileContext !== 'function') {
    throw new Error('scoreOpportunityAcrossProfiles: loadProfileContext required')
  }
  const out = []
  for (const profileId of profileIds) {
    let ctx
    try { ctx = await loadProfileContext(db, profileId) } catch { ctx = null }
    if (!ctx?.profile) continue
    const decision = await scoreOpportunityForProfile({
      profileContext: ctx,
      opportunity,
      computeMatchDecision,
    })
    out.push({ profile_id: profileId, ...decision })
  }
  return out
}
