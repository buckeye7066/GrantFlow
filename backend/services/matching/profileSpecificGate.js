import { applyRelevanceFilter, extractProfileData } from '../relevanceFilter.js'
import { NO_FIT_RELEVANCE_RULE_IDS } from '../relevanceFilterRules.js'
import { REVIEW_SCORE } from '../../config/matchThresholds.js'
import { isGenericOnly } from '../../config/genericTitleVocabulary.js'

/**
 * The NO-FIT rule family: rules that reject on CONTENT SHAPE ("directory /
 * generic homepage / no concrete keyword profile match"), NOT on eligibility or
 * demographic mismatch. When a row carries an AUTHORITATIVE stored decision from
 * the matchEngine (the sole decision authority) AND that stored score is at or
 * above the surfacing floor AND the decision is ACCEPT/REVIEW, the affirmative
 * score is dispositive — these keyword-shape rules must NOT re-adjudicate it
 * away at display time. This is the direct fix for the class where the
 * data-point scorer scored a row (e.g. Benefits.gov = 52) but the older keyword
 * gate dropped it for "no keyword profile fit."
 *
 * This is TYPE-AGNOSTIC by construction: the suppression keys only on
 * "authoritative stored above-floor decision", never on profile type or
 * opportunity kind — so it protects an org's foundation grant, a student's
 * scholarship, a veteran's benefit, a business's SBA match, and an individual's
 * directory identically.
 *
 * It deliberately does NOT include eligibility/demographic mismatch rules
 * (foster-youth-only, seniors-only, veterans-only, applicant-type, geography,
 * student-aid-vs-nonstudent): those are real hard-ineligibility and STILL drop
 * however high the stored score (Chafee-for-a-non-foster-adult must stay
 * dropped). Those live in the relevance filter (applyRelevanceFilter), which
 * runs FIRST below and rejects them before the CATEGORY loop is reached.
 *
 * OWNER DIRECTIVE 2026-08-03 (recall over suppression — GrantFlow must beat a
 * free Google search): the gate's OWN CATEGORY_RULES population net (the 14
 * "opportunity text mentions <population> but the profile shows no <population>
 * signal" keyword rules below) is ALSO trusted away for an authoritative
 * above-floor row. Those are hard boolean filters on a population keyword, not
 * explicit exclusivity — exactly what the canonical rule forbids ("population/
 * eligibility mismatches must reduce score, not discard results; hard boolean
 * filters are forbidden unless the funding source is explicitly exclusive").
 * The matchEngine already scored the row against the FULL profile (fields these
 * keyword heuristics never see), and explicit exclusivity is still enforced by
 * the relevance filter's hard: true rules above. Reversible: set
 * PROFILE_GATE_TRUST_ENGINE=0 to restore the old population-net hard drops.
 */
/**
 * When ON (default), an authoritative above-floor engine decision is trusted
 * over the gate's own CATEGORY_RULES population keyword net (recall over
 * suppression — owner directive 2026-08-03). Set PROFILE_GATE_TRUST_ENGINE=0 to
 * restore the old behavior where a population keyword rule could re-adjudicate
 * an engine-endorsed match away at display time.
 */
const TRUST_ENGINE_OVER_CATEGORY_HEURISTICS = process.env.PROFILE_GATE_TRUST_ENGINE !== '0'

export const SUPPRESSIBLE_NO_FIT_RULE_IDS = new Set([
  // relevanceFilter (applyRelevanceFilter) content-shape rejections
  ...NO_FIT_RELEVANCE_RULE_IDS, // referral_directory, generic_directory_page
  // profileSpecificGate-local content-shape rejections (below)
  'directory_no_profile_fit',
  'web_lead_no_profile_fit',
  'generic_only_no_profile_fit',
])

/**
 * SOFT geographic-mismatch rules that must NOT discard an engine-endorsed row
 * at display (canonical rule: "geographic matching must expand outward: city →
 * county → state → national"). The matchEngine already applied its geo logic
 * before scoring a row ACCEPT/REVIEW above the floor, so a plain state/city
 * mismatch is a score signal, not a disqualifier — a TN profile can still want a
 * multi-state or wrongly-title-tagged program the engine judged a real fit.
 * EXCLUSIVITY is untouched: geographic_residents_only_exclusive and
 * geographic_rural_exclusive are hard: true and still reject in any mode. Only
 * suppressed for an authoritative above-floor decision, and only when
 * PROFILE_GATE_TRUST_ENGINE is on.
 */
export const SUPPRESSIBLE_GEO_MISMATCH_RULE_IDS = new Set([
  'geographic_state_mismatch',
  'geographic_title_state_mismatch',
  'geographic_wrong_city',
])

/**
 * Does this row carry an authoritative stored match decision at/above the
 * surfacing floor? Only such rows earn no-fit suppression — a raw web lead or an
 * unscored candidate keeps the strict keyword gate (it is the only filter those
 * unvetted rows have).
 */
export function hasAuthoritativeStoredDecision(opportunity, opts = {}) {
  if (opts.useStoredDecision !== true) return false
  const score = Number(opportunity?.match_score)
  if (!Number.isFinite(score) || score < REVIEW_SCORE) return false
  const decision = String(opportunity?.match_decision ?? 'REVIEW').toUpperCase()
  return decision === 'ACCEPT' || decision === 'REVIEW'
}

const NEGATIVE_TEXT_VALUES = new Set([
  '',
  '0',
  'false',
  'no',
  'none',
  'n/a',
  'na',
  'not applicable',
  'not-applicable',
  'not specified',
  'unspecified',
  'unknown',
  'prefer not to say',
])

function asBoolNullable(value) {
  if (value === true) return true
  if (value === false) return false
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    if (['yes', 'true', 'y', 't', 'on'].includes(text)) return true
    if (NEGATIVE_TEXT_VALUES.has(text) || ['n', 'f', 'off'].includes(text)) return false
  }
  return null
}

function valueText(value) {
  if (value === null || value === undefined || value === false) return []
  if (value === true) return ['true']
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).trim()
    if (!text || NEGATIVE_TEXT_VALUES.has(text.toLowerCase())) return []
    return [text]
  }
  if (Array.isArray(value)) return value.flatMap((entry) => valueText(entry))
  if (typeof value === 'object') return Object.values(value).flatMap((entry) => valueText(entry))
  return [String(value)]
}

function parseList(value) {
  if (!value) return []
  if (Array.isArray(value)) return value.flatMap((v) => valueText(v)).filter(Boolean)
  if (value instanceof Set) return [...value].flatMap((v) => valueText(v)).filter(Boolean)
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return []
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed)
        if (Array.isArray(parsed)) return parsed.map((v) => String(v ?? '')).filter(Boolean)
      } catch {
        // Fall through to the scalar string below.
      }
    }
    return [trimmed]
  }
  if (typeof value === 'object') {
    return valueText(value)
  }
  return [String(value)]
}

function fieldText(value) {
  return parseList(value).join(' ')
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
    opportunity.opportunity_type,
    opportunity.opportunity_kind,
    opportunity.funding_type,
    fieldText(opportunity.categories),
    fieldText(opportunity.keywords),
    fieldText(opportunity.tags),
    fieldText(opportunity.eligibility_bullets),
    fieldText(opportunity.matched_needs),
    fieldText(opportunity.match_reasons),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

function profileText(profileData = {}) {
  return [
    profileData.primary_type,
    profileData.organization_type,
    profileData.industry,
    profileData.description,
    profileData.situation,
    profileData.employment_notes,
    profileData.employment_status,
    profileData.ethnicity,
    fieldText(profileData.needs),
    fieldText(profileData.tags),
    fieldText(profileData.keywords),
    fieldText(profileData.interests),
    fieldText(profileData.affiliations),
    fieldText(profileData.geographic_qualifiers),
    fieldText(profileData.population_served),
    fieldText(profileData.mission_focus),
    fieldText(profileData.challenges),
    fieldText(profileData.special_circumstances),
    fieldText(profileData.education),
    fieldText(profileData.employment),
    fieldText(profileData.business),
    fieldText(profileData.organization_details),
    fieldText(profileData.government_assistance),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

function isDirectoryRecord(opportunity = {}) {
  const kind = String(
    opportunity.opportunity_kind ||
      opportunity.opportunity_type ||
      opportunity.record_type ||
      opportunity.type ||
      '',
  ).toUpperCase()
  const source = String(opportunity.source || opportunity.record_origin || '').toLowerCase()
  const text = opportunityText(opportunity)
  return Boolean(
    opportunity.is_directory_resource ||
      opportunity.is_directory ||
      kind === 'DIRECTORY' ||
      kind === 'PAST_AWARD_INTEL' ||
      source.startsWith('directory') ||
      source.includes('local_directory') ||
      /\b(boots to business|veterans business outreach centers?|veteran-owned business resources|military onesource|transition assistance program)\b/.test(text),
  )
}

function isWebLead(opportunity = {}) {
  const source = String(opportunity.source || opportunity.record_origin || '').toLowerCase()
  return source.includes('web_search') || source.includes('web-llm') || source.includes('web_llm')
}

function hasToken(text, regex) {
  return regex.test(String(text || ''))
}

function hasMeaningfulObjectValue(value) {
  if (!value || typeof value !== 'object') return false
  for (const entry of Object.values(value)) {
    if (entry === null || entry === undefined || entry === false) continue
    const bool = asBoolNullable(entry)
    if (bool === false) continue
    if (typeof entry === 'string' && NEGATIVE_TEXT_VALUES.has(entry.trim().toLowerCase())) continue
    if (Array.isArray(entry) && entry.length === 0) continue
    if (typeof entry === 'object' && !hasMeaningfulObjectValue(entry)) continue
    return true
  }
  return false
}

function buildEvidence(profileData = {}) {
  const type = String(profileData.primary_type || '').toLowerCase()
  const text = profileText(profileData)
  const needs = parseList(profileData.needs).map((v) => v.toLowerCase())
  const affiliations = parseList(profileData.affiliations).map((v) => v.toLowerCase())
  const needHas = (regex) => needs.some((n) => regex.test(n))

  const student =
    type.includes('student') ||
    needHas(/\b(education|scholarship|fafsa|pell|tuition|student)\b/) ||
    hasToken(text, /\b(student|college|university|high school|undergraduate|graduate|fafsa|scholarship|tuition)\b/)

  const business =
    /\b(business|small_business|startup|entrepreneur|farm|farmer|ranch|food truck|law firm|legal practice|self[-\s]?employ)\b/.test(type) ||
    needHas(/\b(business|startup|entrepreneur|agriculture|farm|capital|operations)\b/) ||
    hasToken(text, /\b(start a business|startup|entrepreneur|food truck|small business|farm|farmer|ranch|law firm|legal practice|working capital|equipment for business)\b/) ||
    hasMeaningfulObjectValue(profileData.business)

  const veteran =
    asBoolNullable(profileData.veteran_status) === true ||
    type.includes('veteran') ||
    affiliations.includes('veteran') ||
    needHas(/\b(veteran|military)\b/) ||
    hasToken(text, /\b(veteran|prior service|former service member|service-disabled)\b/)

  const activeDuty =
    type.includes('active_duty') ||
    needHas(/\b(active_duty|military_transition|military_spouse|guard_reserve)\b/) ||
    hasToken(text, /\b(active duty|currently serving|servicemember|service member|national guard|reservist|military spouse|transitioning service member)\b/)

  const health =
    needHas(/\b(health|medical|disability|cancer|dementia|mental_health|prescription|substance)\b/) ||
    Boolean(profileData.disability_status) ||
    hasToken(text, /\b(cancer|medical|healthcare|health care|illness|disabled|disability|prescription|dementia|alzheimer|patient|treatment|therapy|wheelchair|blind|deaf)\b/)

  const disability =
    needHas(/\b(disability|disabled|ssi|ssdi|special_needs|adaptive|assistive)\b/) ||
    Boolean(profileData.disability_status) ||
    hasToken(text, /\b(disabled|disability|ssi|ssdi|special needs|wheelchair|blind|deaf|developmental disability|intellectual disability)\b/)

  const employment =
    needHas(/\b(employment|workforce|job|career|work_study|training)\b/) ||
    hasToken(text, /\b(job|employment|workforce|career|work study|work-study|apprenticeship|training|uniform|work clothing)\b/)

  const professional =
    needHas(/\b(professional_development|continuing_education|license|licensure|certification|employment|workforce)\b/) ||
    hasToken(text, /\b(nurse|nursing|emt|paramedic|teacher|educator|attorney|lawyer|license|licensure|continuing education|certification|credential|professional development)\b/)

  const organization =
    /\b(organization|nonprofit|church|school|ministry|government|tribal|institution|university|college|agency|vfd|volunteer_fire)\b/.test(type) ||
    Boolean(profileData.organization_type) ||
    hasMeaningfulObjectValue(profileData.organization_details) ||
    affiliations.some((a) => /\b(nonprofit|church|school|tribal|faith_based|first_responder)\b/.test(a))

  return {
    text,
    needs,
    type,
    student,
    education: student || needHas(/\b(education|scholarship|tuition|student|school)\b/),
    business,
    farm: business && hasToken(text, /\b(farm|farmer|ranch|agriculture|livestock|crop)\b/),
    veteran,
    activeDuty,
    military: veteran || activeDuty,
    health,
    disability,
    employment,
    professional,
    organization,
    nonprofit: organization && hasToken(text, /\b(nonprofit|non-profit|501c3|501\(c\)\(3\)|church|ministry|charity)\b/),
    research: organization && hasToken(text, /\b(research institution|university|college|hospital|medical center|principal investigator)\b/),
    tribal: type.includes('tribal') || affiliations.includes('tribal') || Boolean(profileData.is_tribal),
    firstResponder: affiliations.includes('first_responder') || hasToken(text, /\b(firefighter|fire department|emt|paramedic|law enforcement|police|sheriff|border patrol|first responder)\b/),
    hasChildren: Boolean(profileData.has_children) || Number(profileData.number_of_children || 0) > 0 || Number(profileData.household_members_under_18 || 0) > 0,
    senior: Number(profileData.age || 0) >= 55 || String(profileData.age_group || '').toLowerCase().includes('senior'),
    emergency: needHas(/\b(emergency|disaster|crisis)\b/) || hasToken(text, /\b(disaster|emergency|fire|flood|tornado|hurricane|crisis)\b/),
  }
}

const CATEGORY_RULES = [
  {
    id: 'boots_to_business_without_military_entrepreneur_signal',
    re: /\bboots to business\b/,
    supported: (e) => e.military && e.business,
    reason: 'Boots to Business requires a military/veteran/spouse/transitioning-service signal plus business/startup intent.',
  },
  {
    id: 'veteran_military_without_profile_signal',
    re: /\b(veterans?|veteran-owned|va benefits?|va healthcare|veteran entrepreneurship|boots to business|active duty|service members?|servicemembers?|military spouse|military family|mycaa)\b/,
    supported: (e) => e.military,
    reason: 'Military/veteran-specific source, but this profile has no military or veteran signal.',
  },
  {
    id: 'business_without_profile_signal',
    re: /\b(sba\b|small business|startup|entrepreneur|microenterprise|business development|business grant|sbir\b|sttr\b|8\(a\)|women-owned small business|working capital|food truck|self-employment assistance)\b/,
    supported: (e) => e.business,
    reason: 'Business/startup source, but this profile has no business, farm, startup, or self-employment signal.',
  },
  {
    id: 'farm_without_profile_signal',
    re: /\b(farmers?|ranchers?|agriculture|agricultural|livestock|crop|usda rural business|value-added producer|vapg)\b/,
    supported: (e) => e.farm || e.business,
    reason: 'Farm/agriculture source, but this profile has no farm or agriculture signal.',
  },
  {
    id: 'medical_without_profile_signal',
    re: /\b(medicaid|medicare|medical bills?|health ?care|healthcare|patient assistance|prescription assistance|cancer|oncology|clinical trial|hospital|dental|vision|mental health|substance recovery)\b/,
    supported: (e) => e.health || e.disability,
    reason: 'Health/medical source, but this profile has no health, disability, or patient-assistance signal.',
  },
  {
    id: 'disability_without_profile_signal',
    re: /\b(disability|disabled|ssi\b|ssdi\b|ticket to work|vocational rehabilitation|blindness|for the blind|developmental disability|intellectual disability|assistive technology)\b/,
    supported: (e) => e.disability,
    reason: 'Disability-specific source, but this profile has no disability signal.',
  },
  {
    id: 'workforce_without_profile_signal',
    re: /\b(workforce|wioa\b|job training|employment training|career training|apprenticeship|american job center|workforce development)\b/,
    supported: (e, text) => e.employment || e.professional || /\b(work[-\s]?study|campus job)\b/.test(text),
    reason: 'Workforce/employment source, but this profile has no employment, work-study, or professional-training signal.',
  },
  {
    id: 'professional_license_without_profile_signal',
    re: /\b(nursing|nurse|license reinstatement|licensure|continuing education|ceu\b|cme\b|certification|credential|paramedic|emt|teacher training|professional development)\b/,
    supported: (e) => e.professional,
    reason: 'Professional/licensure source, but this profile has no matching profession, license, or training signal.',
  },
  {
    id: 'organization_only_without_profile_signal',
    re: /\b(501\s*\(?c\)?\s*\(?3\)?|nonprofit only|nonprofits only|organizations only|must be a nonprofit|uei required|duns number|sam\.gov registration|institutional grant|principal investigator|institutions of higher education|federal agenc(?:y|ies) only|state agenc(?:y|ies) only)\b/,
    supported: (e) => e.organization || e.research,
    reason: 'Organization/institution-only source, but this profile is not an organization or research institution profile.',
  },
  {
    id: 'tribal_without_profile_signal',
    re: /\b(tribal|tribe|indian tribes?|native american|alaska native|bureau of indian affairs)\b/,
    supported: (e) => e.tribal,
    reason: 'Tribal/Native-specific source, but this profile has no tribal or Native signal.',
  },
  {
    id: 'student_aid_without_profile_signal',
    re: /\b(fafsa|pell grant|fseog|student aid|scholarship|tuition assistance|college financial aid|university financial aid|work[-\s]?study)\b/,
    supported: (e, text) => e.student || e.education ||
      (e.professional && /\b(emt|paramedic|nursing|nurse|continuing education|professional|licensure|certification)\b/.test(text)),
    reason: 'Student-aid source, but this profile has no student or education signal.',
  },
  {
    id: 'children_without_profile_signal',
    re: /\b(head start|early head start|child care|childcare|children only|kids|youth program|wic\b)\b/,
    supported: (e) => e.hasChildren || e.student,
    reason: 'Child/youth-specific source, but this profile has no child, youth, or student signal.',
  },
  {
    id: 'senior_without_profile_signal',
    re: /\b(senior citizens?|older adults?|area agency on aging|aging services|age 55\+|age 60\+|age 65\+)\b/,
    supported: (e) => e.senior,
    reason: 'Senior/aging source, but this profile has no senior or aging signal.',
  },
  {
    id: 'disaster_without_profile_signal',
    re: /\b(fema individual assistance|disaster assistance|disaster relief|individuals and households program|ihp\b|hazard mitigation)\b/,
    supported: (e) => e.emergency,
    reason: 'Disaster/emergency source, but this profile has no disaster or emergency signal.',
  },
]

// The generic vocabulary lives in ONE registry (backend/config/
// genericTitleVocabulary.js) that the canonical engine's ACCEPT cap and Amy's
// false-positive detector also read. This gate used to carry its own list which
// had drifted from Amy's (4 of ~12 terms shared), so the two disagreed about
// what "generic" even meant. Keep the local carve-out semantics — `matched`
// rules and stored authority still rescue a row below.

export function evaluateProfileSpecificGate(profileContext, opportunity, opts = {}) {
  if (!opportunity || typeof opportunity !== 'object') {
    return { pass: false, ruleId: 'invalid_opportunity', reason: 'Invalid opportunity record.' }
  }

  const mode = opts.mode || 'display'
  const profileData = extractProfileData(profileContext)
  const evidence = buildEvidence(profileData)
  const text = opportunityText(opportunity)
  const directory = isDirectoryRecord(opportunity)
  const webLead = isWebLead(opportunity)

  // A row the matchEngine already scored above the surfacing floor is immune to
  // the NO-FIT (content-shape) rule family — the affirmative score is the
  // authority. Eligibility/demographic mismatches are NOT suppressed and still
  // drop below.
  const storedAuthoritative = hasAuthoritativeStoredDecision(opportunity, opts)

  // Skip only the no-fit content-shape rules when authoritative; a real
  // eligibility/demographic rule LATER in the list still fires and rejects.
  // When PROFILE_GATE_TRUST_ENGINE is on (default), also relax the SOFT
  // geographic-mismatch rules for an engine-endorsed row (geography expands
  // outward; hard residents-only/rural-only exclusivity is untouched).
  // The canonical engine score-penalizes non-exclusive women-prioritized
  // language. The display enrichment gate must not turn that one soft rule into
  // a second hard eligibility trial. Other legacy soft rules retain their
  // existing strict behavior here unless an authoritative stored decision earns
  // the documented no-fit/geography suppression below.
  const skipRuleIds = new Set(['demographic_women_prioritized'])
  if (storedAuthoritative) {
    for (const id of SUPPRESSIBLE_NO_FIT_RULE_IDS) skipRuleIds.add(id)
    if (TRUST_ENGINE_OVER_CATEGORY_HEURISTICS) {
      for (const id of SUPPRESSIBLE_GEO_MISMATCH_RULE_IDS) skipRuleIds.add(id)
    }
  }

  const relevance = applyRelevanceFilter(opportunity, profileData, {
    mode: 'strict',
    allowDirectories: false,
    skipRuleIds,
  })
  if (!relevance.pass) {
    return {
      pass: false,
      ruleId: relevance.ruleId || 'relevance_filter',
      reason: relevance.reason || 'Rejected by profile relevance rules.',
    }
  }

  const matched = []
  let trustedOverCategory = false
  for (const rule of CATEGORY_RULES) {
    if (!rule.re.test(text)) continue
    if (rule.supported(evidence, text, opportunity)) {
      matched.push(rule.id)
      continue
    }
    // Unsupported population category. The gate's own keyword net used to
    // hard-drop here. When the matchEngine carries an authoritative above-floor
    // decision for THIS profile, that affirmative score is dispositive (owner
    // directive: population mismatches reduce score, not discard; hard boolean
    // filters are forbidden unless the source is explicitly exclusive — and
    // explicit exclusivity was already enforced by the relevance filter above).
    // So we do NOT re-adjudicate the row away on a keyword here.
    if (storedAuthoritative && TRUST_ENGINE_OVER_CATEGORY_HEURISTICS) {
      trustedOverCategory = true
      continue
    }
    return { pass: false, ruleId: rule.id, reason: rule.reason }
  }

  // isGenericOnly = generic vocabulary hit AND no concrete anchor (the same
  // predicate the engine's ACCEPT cap uses). This gate adds its own extra
  // condition: a row that matched a CATEGORY_RULE has proven profile fit.
  const genericOnly = isGenericOnly(text) && matched.length === 0

  // NO-FIT suppression: a stored above-floor row keeps surfacing even when its
  // short text hit no keyword rule — the scorer already found the fit.
  if (genericOnly && !storedAuthoritative) {
    return {
      pass: false,
      ruleId: 'generic_only_no_profile_fit',
      reason: 'Generic funding/search directory with no concrete profile-specific need match.',
    }
  }

  if ((directory || webLead) && matched.length === 0 && !storedAuthoritative) {
    const allowUnmatchedDirectoryFallback =
      mode === 'fallback' && opts.allowUnmatchedDirectoryFallback === true
    if (!allowUnmatchedDirectoryFallback) {
      return {
        pass: false,
        ruleId: directory ? 'directory_no_profile_fit' : 'web_lead_no_profile_fit',
        reason: directory
          ? 'Directory/referral row has no concrete profile-specific category match.'
          : 'Web-discovered lead has no concrete profile-specific category match.',
      }
    }
  }

  if (mode === 'pipeline' && directory) {
    return {
      pass: false,
      ruleId: 'directory_not_pipeline_grant',
      reason: 'Directory/referral rows may be shown as search aids, but not saved as direct pipeline grants.',
    }
  }

  return { pass: true, matchedRules: matched, directory, webLead, trustedOverCategory }
}

export default {
  evaluateProfileSpecificGate,
}
