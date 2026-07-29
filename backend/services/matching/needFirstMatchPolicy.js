import {
  REVIEW_SCORE,
  SCORE_FLOOR,
} from '../../config/matchThresholds.js'
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

function opportunityText(opportunity = {}, { includeSponsor = true } = {}) {
  return [
    opportunity.title,
    opportunity.name,
    includeSponsor ? opportunity.sponsor : null,
    includeSponsor ? opportunity.funder : null,
    opportunity.description,
    opportunity.summary,
    opportunity.eligibility,
    opportunity.eligibility_text,
    opportunity.eligibility_criteria,
    opportunity.restrictions,
    ...(Array.isArray(opportunity.categories) ? opportunity.categories : []),
    ...(Array.isArray(opportunity.keywords) ? opportunity.keywords : []),
  ].filter(Boolean).join(' ')
}

function normalized(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function acronym(value) {
  return normalized(value)
    .split(' ')
    .filter((word) => word && !['the', 'of', 'at', 'and', 'for'].includes(word))
    .map((word) => word[0])
    .join('')
}

function explicitlyBusinessApplicant(text, title) {
  return /\b(?:eligible applicants?|applicants? must be|open only to|restricted to)\s+(?:are\s+)?(?:qualifying\s+)?(?:small\s+)?business(?:es| owners?)\b/i.test(text) ||
    /\b(?:grants?|funding|awards?|loans?)\s+(?:program\s+)?(?:exclusively\s+|only\s+)?for\s+(?:eligible\s+)?(?:small\s+)?business(?:es| owners?)\b/i.test(text) ||
    /\b(?:small\s+)?business(?:es)?\s+(?:grant|funding|award|loan)\b/i.test(title)
}

function explicitlyOrganizationApplicant(text, title) {
  const org = '(?:nonprofits?|non-profit organizations?|churches|ministries|school districts?|municipalities|local governments?|research institutions?)'
  return new RegExp(`\\b(?:eligible applicants?|applicants? must be|open only to|restricted to)\\s+(?:are\\s+)?${org}\\b`, 'i').test(text) ||
    new RegExp(`\\b(?:grants?|funding|awards?)\\s+(?:program\\s+)?(?:exclusively\\s+|only\\s+)?for\\s+${org}\\b`, 'i').test(text) ||
    new RegExp(`\\b${org}\\s+(?:grant|funding|award)\\b`, 'i').test(title)
}

function institutionNamedOutsideSponsor(opportunity, requiredInstitution) {
  const body = normalized(opportunityText(opportunity, { includeSponsor: false }))
  const institution = normalized(requiredInstitution)
  if (!body || !institution) return false
  if (body.includes(institution)) return true
  const short = acronym(institution)
  return short.length >= 2 && new RegExp(`(?:^|\\s)${short}(?:\\s|$)`, 'i').test(body)
}

function recomputePolicy(result, {
  hardMismatches,
  reviewOnly,
  addedReasons = [],
} = {}) {
  const originalHard = Array.isArray(result.hardMismatches) ? result.hardMismatches : []
  const retainedHard = Array.isArray(hardMismatches) ? hardMismatches : originalHard
  const removedHard = new Set(originalHard.filter((reason) => !retainedHard.includes(reason)))
  const reasons = [
    ...(Array.isArray(result.reasons) ? result.reasons : []).filter((reason) => !removedHard.has(reason)),
    ...addedReasons,
  ]
  const hardMismatch = retainedHard.length > 0
  let decision = null
  let scoreCap
  if (hardMismatch) {
    decision = 'REJECT'
    scoreCap = SCORE_FLOOR
  } else if (!result.purposeAnchor) {
    decision = 'REJECT'
    scoreCap = Math.max(SCORE_FLOOR, REVIEW_SCORE - 1)
  } else if (reviewOnly) {
    decision = 'REVIEW'
    scoreCap = REVIEW_SCORE
  }

  return {
    ...result,
    hardMismatches: [...new Set(retainedHard)],
    hardMismatch,
    reviewOnly: Boolean(reviewOnly),
    decision,
    scoreCap,
    reasons: [...new Set(reasons.filter(Boolean))],
  }
}

export function evaluateNeedFirstMatchPolicy(args = {}) {
  const aliasedArgs = withProfessionAliases(args)
  const opportunity = aliasedArgs?.opportunity ?? {}
  const evaluated = evaluateCorrectedPolicy(aliasedArgs)
  if (evaluated?.resource) {
    return evaluated?.scoreCap === null ? { ...evaluated, scoreCap: undefined } : evaluated
  }

  const text = opportunityText(opportunity)
  const title = String(opportunity.title ?? opportunity.name ?? '')
  let hardMismatches = [...(evaluated.hardMismatches ?? [])]
  let reviewOnly = Boolean(evaluated.reviewOnly)
  const addedReasons = []

  const businessMismatch = hardMismatches.find((reason) =>
    String(reason).startsWith('Business-only funding requires'),
  )
  if (businessMismatch && !explicitlyBusinessApplicant(text, title)) {
    hardMismatches = hardMismatches.filter((reason) => reason !== businessMismatch)
    addedReasons.push('Business wording describes the population or employer context; applicant exclusivity is unconfirmed')
  }

  const organizationMismatch = hardMismatches.find((reason) =>
    String(reason).startsWith('Organization-only funding requires'),
  )
  if (organizationMismatch && !explicitlyOrganizationApplicant(text, title)) {
    hardMismatches = hardMismatches.filter((reason) => reason !== organizationMismatch)
    addedReasons.push('Organization wording does not explicitly restrict who may apply')
  }

  const institutionMismatch = hardMismatches.find((reason) =>
    String(reason).startsWith('Institution-specific funding is for'),
  )
  if (
    institutionMismatch &&
    evaluated?.diagnostics?.institution_source === 'sponsor' &&
    !institutionNamedOutsideSponsor(opportunity, evaluated?.diagnostics?.required_institution)
  ) {
    hardMismatches = hardMismatches.filter((reason) => reason !== institutionMismatch)
    reviewOnly = true
    addedReasons.push(
      `The sponsor is ${evaluated.diagnostics.required_institution}, but the opportunity text does not prove enrollment there is required`,
    )
  }

  const professionMismatch = hardMismatches.find((reason) =>
    String(reason).startsWith('Opportunity is restricted to'),
  )
  const domains = evaluated?.diagnostics?.profession_domains ?? []
  const nursingFacilityContext = /\b(nursing home|nursing facility|skilled nursing facility|home nursing care)\b/i.test(text)
  const explicitNurseApplicant = /\b(nursing students?|registered nurses?|licensed practical nurses?|nurses? may apply|applicants? must be nurses?|rn\b|lpn\b|nclex)\b/i.test(text)
  if (
    professionMismatch &&
    domains.length === 1 &&
    domains[0] === 'nursing' &&
    nursingFacilityContext &&
    !explicitNurseApplicant
  ) {
    hardMismatches = hardMismatches.filter((reason) => reason !== professionMismatch)
    addedReasons.push('Nursing terminology describes a care setting, not a nurse-only applicant restriction')
  }

  let result = recomputePolicy(evaluated, { hardMismatches, reviewOnly, addedReasons })
  const childMismatch = result?.hardMismatches?.some((reason) =>
    String(reason).includes('Child/dependent program'),
  )
  if (childMismatch) {
    const compatibilityReason =
      'Child or caregiver context is insufficient: this child/dependent program requires a child, dependent, or pregnancy signal'
    result = {
      ...result,
      reasons: [...new Set([...(result.reasons ?? []), compatibilityReason])],
    }
  }
  return result
}

export default {
  collectProfileSchools,
  enforceNeedFirstDecision,
  evaluateNeedFirstMatchPolicy,
  isNeedFirstResource,
}
