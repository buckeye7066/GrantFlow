import {
  collectProfileSchools,
  enforceNeedFirstDecision,
  evaluateNeedFirstMatchPolicy as evaluateCorrectedPolicy,
  isNeedFirstResource,
} from './needFirstMatchPolicyV2.js'

export { collectProfileSchools, enforceNeedFirstDecision, isNeedFirstResource }

function withProfessionAliases(args = {}) {
  const opportunity = args?.opportunity ?? {}
  const text = [
    opportunity.title,
    opportunity.name,
    opportunity.description,
    opportunity.summary,
    opportunity.eligibility,
    opportunity.eligibility_text,
    opportunity.eligibility_criteria,
    opportunity.restrictions,
  ].filter(Boolean).join(' ')
  const aliases = []
  if (/\bmedical students\b/i.test(text)) aliases.push('medical student')
  if (/\bdental students\b/i.test(text)) aliases.push('dental student')
  if (/\blaw students\b/i.test(text)) aliases.push('law student')
  if (aliases.length === 0) return args
  return {
    ...args,
    opportunity: {
      ...opportunity,
      keywords: [
        ...(Array.isArray(opportunity.keywords) ? opportunity.keywords : []),
        ...aliases,
      ],
    },
  }
}

export function evaluateNeedFirstMatchPolicy(args = {}) {
  const evaluated = evaluateCorrectedPolicy(withProfessionAliases(args))
  // `Number(null)` is zero. The scoring adapter accepts only numeric caps, so
  // represent "no cap" as undefined rather than null to prevent valid matches
  // and resources from being collapsed to SCORE_FLOOR.
  const result = evaluated?.scoreCap === null
    ? { ...evaluated, scoreCap: undefined }
    : evaluated

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
