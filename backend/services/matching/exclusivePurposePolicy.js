function textFrom(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined || value === false) return ''
  if (value === true) return 'true'
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map((entry) => textFrom(entry, depth + 1)).filter(Boolean).join(' ')
  if (typeof value === 'object') {
    const source = value.answers && typeof value.answers === 'object' ? value.answers : value
    const parts = []
    for (const [key, entry] of Object.entries(source)) {
      if (entry === true) parts.push(key.replace(/_/g, ' '))
      else {
        const text = textFrom(entry, depth + 1)
        if (text) parts.push(text)
      }
    }
    return parts.join(' ')
  }
  return ''
}

function opportunityText(opportunity = {}) {
  return [
    opportunity.title,
    opportunity.name,
    opportunity.sponsor,
    opportunity.funder,
    opportunity.description,
    opportunity.summary,
    opportunity.eligibility,
    opportunity.eligibility_text,
    opportunity.eligibility_criteria,
    opportunity.restrictions,
    textFrom(opportunity.categories),
    textFrom(opportunity.keywords),
  ].filter(Boolean).join(' ')
}

function profileText(profileContext = {}, profileNorm = null) {
  const sections = profileContext?.sections ?? {}
  return [
    textFrom(sections.education),
    textFrom(sections.occupation),
    textFrom(sections.employment),
    textFrom(sections.programs_services),
    textFrom(profileNorm?.education),
    textFrom(profileNorm?.occupation),
    textFrom(profileNorm?.industry),
    textFrom(profileNorm?.effectiveFacets),
  ].filter(Boolean).join(' ')
}

const EXCLUSIVE_RULES = Object.freeze([
  {
    id: 'ems',
    label: 'EMS/EMT/paramedic',
    opportunity: /\b(?:naemt|ems|emergency medical services?|emt|aemt|paramedics?|first responder scholarship)\b/i,
    profile: /\b(?:ems|emergency medical services?|emt|aemt|paramedics?|first responder)\b/i,
  },
])

/**
 * Supplemental hard-exclusive rules whose acronyms or plural forms are easy to
 * miss in broad taxonomy regexes. These rules are deliberately narrow: they do
 * not create a match by themselves unless the opportunity explicitly targets
 * the domain and the profile explicitly carries the same domain.
 */
export function evaluateExclusivePurposePolicy({
  profileContext = {},
  profileNorm = null,
  opportunity = {},
} = {}) {
  const oppText = opportunityText(opportunity)
  const profText = profileText(profileContext, profileNorm)
  const hardMismatches = []
  const purposeReasons = []
  const matchedRules = []

  for (const rule of EXCLUSIVE_RULES) {
    if (!rule.opportunity.test(oppText)) continue
    matchedRules.push(rule.id)
    if (rule.profile.test(profText)) {
      purposeReasons.push(`Profession/major match: ${rule.label}`)
    } else {
      hardMismatches.push(
        `Opportunity is restricted to ${rule.label}; the profile has no matching education or occupation signal`,
      )
    }
  }

  return {
    purposeAnchor: purposeReasons.length > 0,
    hardMismatch: hardMismatches.length > 0,
    purposeReasons,
    hardMismatches,
    matchedRules,
  }
}

export default { evaluateExclusivePurposePolicy }
