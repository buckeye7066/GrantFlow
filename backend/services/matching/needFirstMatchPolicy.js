import {
  collectProfileSchools,
  enforceNeedFirstDecision,
  evaluateNeedFirstMatchPolicy as evaluateCorrectedPolicy,
  isNeedFirstResource,
} from './needFirstMatchPolicyV2.js'

export { collectProfileSchools, enforceNeedFirstDecision, isNeedFirstResource }

export function evaluateNeedFirstMatchPolicy(args = {}) {
  const result = evaluateCorrectedPolicy(args)
  const childMismatch = result?.hardMismatches?.some((reason) =>
    String(reason).includes('Child/dependent program'),
  )
  if (!childMismatch) return result

  const compatibilityReason =
    'Child or caregiver context is insufficient: this child/dependent program requires a child, dependent, or pregnancy signal'
  return {
    ...result,
    reasons: [...new Set([...(result.reasons ?? []), compatibilityReason])],
  }
}

export default {
  collectProfileSchools,
  enforceNeedFirstDecision,
  evaluateNeedFirstMatchPolicy,
  isNeedFirstResource,
}
