/**
 * relevanceFilterRules.js
 *
 * Data-driven rule definitions for the relevance filter.
 * Each rule has:
 *   - id:           Unique string identifier
 *   - category:     Logical grouping (entity_type, demographic, geographic, etc.)
 *   - description:  Human-readable description of what the rule filters
 *   - oppPattern:   RegExp tested against oppText, or null to skip text matching
 *   - profileCheck: function(profileData, oppText, opportunity) → boolean
 *                   Returns true when the filter should REJECT the opportunity.
 *   - reason:       String or function(profileData, opportunity) → string
 *
 * Adding a new rule: append a rule object here — no other file changes required.
 */

// ── Shared helpers (local copies to avoid circular deps with relevanceFilter.js) ─

const _STATE_ABBREVIATIONS = {
  alabama: 'al', alaska: 'ak', arizona: 'az', arkansas: 'ar', california: 'ca',
  colorado: 'co', connecticut: 'ct', delaware: 'de', florida: 'fl', georgia: 'ga',
  hawaii: 'hi', idaho: 'id', illinois: 'il', indiana: 'in', iowa: 'ia', kansas: 'ks',
  kentucky: 'ky', louisiana: 'la', maine: 'me', maryland: 'md', massachusetts: 'ma',
  michigan: 'mi', minnesota: 'mn', mississippi: 'ms', missouri: 'mo', montana: 'mt',
  nebraska: 'ne', nevada: 'nv', 'new hampshire': 'nh', 'new jersey': 'nj',
  'new mexico': 'nm', 'new york': 'ny', 'north carolina': 'nc', 'north dakota': 'nd',
  ohio: 'oh', oklahoma: 'ok', oregon: 'or', pennsylvania: 'pa', 'rhode island': 'ri',
  'south carolina': 'sc', 'south dakota': 'sd', tennessee: 'tn', texas: 'tx',
  utah: 'ut', vermont: 'vt', virginia: 'va', washington: 'wa', 'west virginia': 'wv',
  wisconsin: 'wi', wyoming: 'wy',
}

const _STATE_NAME_TO_ABBR_ENTRIES = [
  ['west virginia', 'WV'], ['north carolina', 'NC'], ['north dakota', 'ND'],
  ['south carolina', 'SC'], ['south dakota', 'SD'], ['new hampshire', 'NH'],
  ['rhode island', 'RI'], ['new mexico', 'NM'], ['new jersey', 'NJ'],
  ['new york', 'NY'], ['connecticut', 'CT'], ['massachusetts', 'MA'],
  ['mississippi', 'MS'], ['pennsylvania', 'PA'], ['minnesota', 'MN'],
  ['tennessee', 'TN'], ['california', 'CA'], ['louisiana', 'LA'],
  ['wisconsin', 'WI'], ['kentucky', 'KY'], ['oklahoma', 'OK'],
  ['nebraska', 'NE'], ['arkansas', 'AR'], ['colorado', 'CO'],
  ['maryland', 'MD'], ['michigan', 'MI'], ['missouri', 'MO'],
  ['delaware', 'DE'], ['illinois', 'IL'],
  ['virginia', 'VA'], ['montana', 'MT'], ['wyoming', 'WY'],
  ['georgia', 'GA'], ['arizona', 'AZ'], ['indiana', 'IN'],
  ['florida', 'FL'], ['alabama', 'AL'], ['vermont', 'VT'],
  ['kansas', 'KS'], ['nevada', 'NV'], ['oregon', 'OR'],
  ['alaska', 'AK'], ['hawaii', 'HI'], ['idaho', 'ID'],
  ['maine', 'ME'], ['texas', 'TX'], ['utah', 'UT'],
  ['iowa', 'IA'], ['ohio', 'OH'],
].sort((a, b) => b[0].length - a[0].length)

function _normalizeState(s) {
  return _STATE_ABBREVIATIONS[s] || s
}

function _isNationalOpportunity(opportunity) {
  const oppState = (opportunity.state || '').toLowerCase().trim()
  return !oppState || oppState === 'nationwide' || oppState === 'national' || Boolean(opportunity.is_national)
}

function _extractStateNameFromTitle(title) {
  const lower = (title || '').toLowerCase()
  for (const [name, abbr] of _STATE_NAME_TO_ABBR_ENTRIES) {
    if (lower.includes(name)) return abbr
  }
  return null
}

// ── Profile predicate helpers ─────────────────────────────────────────────────

function _isVeteranProfile(pd) {
  return pd.veteran_status === true || pd.veteran_status === 'yes' || pd.veteran_status === 'true'
}

function _isBusinessProfile(pd) {
  const t = (pd.primary_type || '').toLowerCase()
  // 'nonprofit' is NOT a business type — removing it prevents nonprofits from being
  // incorrectly included in business-only program checks.
  return t === 'small_business' || t === 'organization'
}

function _isNonprofitProfile(pd) {
  const t = (pd.primary_type || '').toLowerCase()
  // Churches, schools, and volunteer fire departments are nonprofits and should
  // qualify for nonprofit-targeted programs.
  return (
    t === 'organization' ||
    t === 'nonprofit' ||
    t === 'church' ||
    t === 'school' ||
    t === 'volunteer_fire' ||
    t === 'volunteer_fire_department' ||
    t === 'vfd'
  )
}

function _isStudentProfile(pd) {
  const t = (pd.primary_type || '').toLowerCase()
  return t === 'student' || t === 'high_school_student' || t === 'college_student'
}

function _hasImmigrantIndicator(pd) {
  const NON_IMMIGRANT_STATUSES = new Set([
    'us_citizen', 'citizen', 'us citizen', 'permanent_resident',
    'permanent resident', 'green_card', 'green card', 'naturalized',
    'naturalized_citizen', 'born_in_us', 'native_born', 'n/a', 'none',
  ])
  const statusLower = String(pd.immigrant_status || '').toLowerCase().trim()
  return Boolean(
    pd.immigrant_status &&
    pd.immigrant_status !== 'no' &&
    pd.immigrant_status !== 'false' &&
    pd.immigrant_status !== false &&
    !NON_IMMIGRANT_STATUSES.has(statusLower),
  )
}

function _hasHivIndicator(pd) {
  return (
    (Array.isArray(pd.tags) && pd.tags.some((t) => /hiv|aids\b/i.test(String(t)))) ||
    (pd.disability_status && /hiv|aids/i.test(JSON.stringify(pd.disability_status)))
  )
}

function _hasDisasterIndicator(pd) {
  return (
    (Array.isArray(pd.tags) &&
      pd.tags.some((t) =>
        /disaster|fema|emergency|flood|fire|tornado|hurricane|storm/i.test(String(t)),
      )) ||
    (pd.primary_type || '').toLowerCase() === 'disaster_survivor'
  )
}

function _hasFosterIndicator(pd) {
  return Boolean(
    (Array.isArray(pd.tags) && pd.tags.some((t) => /foster/i.test(String(t)))) ||
    pd.foster_youth === true,
  )
}

function _hasFirstResponderIndicator(pd) {
  return Boolean(
    (Array.isArray(pd.tags) &&
      pd.tags.some((t) =>
        /first.?respond|firefight|emt|paramedic|law.?enforce/i.test(String(t)),
      )) ||
    pd.first_responder === true,
  )
}

function _hasNursingBackground(pd) {
  const employmentText = JSON.stringify(pd.employment || '').toLowerCase()
  const educationText = JSON.stringify(pd.education || '').toLowerCase()
  return (
    employmentText.includes('nurs') ||
    educationText.includes('nurs') ||
    (Array.isArray(pd.tags) && pd.tags.some((t) => String(t).toLowerCase().includes('nurs')))
  )
}

function _hasIddIndicator(pd) {
  const disabilityText = JSON.stringify(pd.disability_status || '').toLowerCase()
  return (
    disabilityText.includes('intellectual') ||
    disabilityText.includes('developmental') ||
    disabilityText.includes('idd') ||
    disabilityText.includes('ecf') ||
    disabilityText.includes('didd') ||
    (Array.isArray(pd.tags) &&
      pd.tags.some(
        (t) =>
          String(t).toLowerCase().includes('intellectual') ||
          String(t).toLowerCase().includes('developmental') ||
          String(t).toLowerCase().includes('idd'),
      ))
  )
}

function _hasVisualImpairmentSpecific(pd) {
  const disabilityText = JSON.stringify(pd.disability_status || '').toLowerCase()
  return (
    disabilityText.includes('blind') ||
    disabilityText.includes('visual') ||
    (Array.isArray(pd.tags) &&
      pd.tags.some(
        (t) =>
          String(t).toLowerCase().includes('blind') || String(t).toLowerCase().includes('visual'),
      ))
  )
}

function _hasVisualImpairmentBroad(pd) {
  const dText = JSON.stringify(pd.disability_status || '').toLowerCase()
  return (
    dText.includes('blind') ||
    dText.includes('visual') ||
    dText.includes('vision') ||
    (Array.isArray(pd.tags) && pd.tags.some((t) => /blind|visual|vision/i.test(String(t))))
  )
}

function _hasNativeIndicator(pd) {
  return (
    (pd.ethnicity && /native|indigenous|tribal|indian|alaska.?native/i.test(String(pd.ethnicity))) ||
    (Array.isArray(pd.tags) &&
      pd.tags.some((t) => /native|indigenous|tribal/i.test(String(t))))
  )
}

function _getAlreadyEnrolledPrograms(pd) {
  const gov = pd.government_assistance || {}
  const enrolled = []
  if (gov.medicaid_enrolled || gov.medicaid || (pd.insurance_provider || '').toLowerCase() === 'medicaid') enrolled.push('medicaid')
  if (gov.snap_recipient || gov.snap) enrolled.push('snap')
  if (gov.ssi_recipient || gov.ssi) enrolled.push('ssi')
  if (gov.ssdi_recipient || gov.ssdi) enrolled.push('ssdi')
  if (gov.tanf_recipient || gov.tanf) enrolled.push('tanf')
  if (gov.medicare_recipient || gov.medicare) enrolled.push('medicare')
  return enrolled
}

function _isUnableToWork(pd) {
  return (
    pd.unable_to_work === true ||
    pd.unable_to_work === 'yes' ||
    /not able to work|unable to work|cannot work/i.test(String(pd.employment_notes || '')) ||
    /disabled|unable/i.test(String(pd.employment_status || ''))
  )
}

function _hasChildren(pd) {
  return (
    pd.has_children === true ||
    Number(pd.number_of_children) > 0 ||
    pd.household_members_under_18 > 0
  )
}

function _isSenior(pd) {
  return (
    (pd.age_group || '').toLowerCase().includes('senior') || Number(pd.age) >= 55
  )
}

function _hasConcreteDeadline(opportunity) {
  if (!opportunity) return false

  const raw = [
    opportunity.deadline,
    opportunity.deadline_text,
    opportunity.close_date,
    opportunity.closing_date,
    opportunity.application_deadline,
  ].filter(Boolean).join(' ').trim()

  return Boolean(raw)
}

// ── Rule definitions ──────────────────────────────────────────────────────────

export const RELEVANCE_RULES = [
  // ── 1a. Entity Type: individual-only programs for org profiles ────────────
  {
    id: 'entity_org_individual_only',
    category: 'entity_type',
    description: 'Individual-benefit programs that organizations cannot apply for',
    hard: true, // legally exclusive: organizations literally cannot apply for SNAP/SSI/etc.
    oppPattern: /\b(snap|food stamps|tanf|wic|ssdi|ssi\b|medicaid enrollment|personal food bank|section 8|housing voucher|individual disability benefits?|individual benefit)\b/i,
    profileCheck: (pd) => (pd.primary_type || '').toLowerCase() === 'organization',
    reason: 'Entity type mismatch: individual-only program for organization profile',
  },

  // ── 1b. Entity Type: org-only programs for individual profiles ────────────
  {
    id: 'entity_individual_org_only',
    category: 'entity_type',
    description: 'Organization-only programs that individuals cannot apply for',
    hard: true, // legally exclusive: individuals cannot provide 501c3 / EIN
    oppPattern: /\b(501\(c\)\(3\)|501c3|ein required|duns number|uei required|organizational capacity|nonprofit only|must be a nonprofit|must have an ein)\b/i,
    profileCheck: (pd) => (pd.primary_type || '').toLowerCase() === 'individual',
    reason: 'Entity type mismatch: organization-only program for individual profile',
  },

  // ── 2a. Demographic: women-only programs for non-female profiles ──────────
  {
    id: 'demographic_women_only',
    category: 'demographic',
    description: 'Women-only grant programs',
    hard: true, // explicit exclusivity
    oppPattern: /\b(women only|for women|amber grant for women|female entrepreneurs only|women.{0,10}only)\b/i,
    profileCheck: (pd) => {
      const g = (pd.gender || '').toLowerCase()
      return Boolean(g && g !== 'female')
    },
    reason: 'Demographic mismatch: women-only program, profile is not female',
  },

  // ── 2b. Demographic: veteran-focused programs for non-veteran profiles ────
  {
    id: 'demographic_veteran_focused',
    category: 'demographic',
    description: 'Veteran-targeted programs for profiles with no veteran indicator',
    oppPattern: /\b(ssvf|supportive services for veteran|veterans? only|must be a veteran|veteran status required|active duty only|service members only|boots to business|veteran entrepreneurship|va (housing|benefits|disability|healthcare|medical)|veterans? (assistance|support|services|program|families))\b/i,
    profileCheck: (pd) => !_isVeteranProfile(pd),
    reason: 'Demographic mismatch: veteran-focused program, profile has no veteran indicator',
  },

  // ── 2b-hard. Demographic: EXPLICITLY veteran-EXCLUSIVE programs (hard) ─────
  // The broad demographic_veteran_focused rule above is soft (penalize) because
  // many "veteran services" programs also serve families / the public. THIS rule
  // is the tight, unambiguous-exclusivity subset ("veterans only", "must be a
  // veteran", "active-duty only", "exclusively for veterans") and is HARD: such
  // a program literally cannot be applied to by a non-veteran, so it must never
  // be surfaced (even via a relaxed fallback) for a profile with no veteran
  // indicator. Conservative patterns only — no broad "veteran assistance" match.
  {
    id: 'demographic_veteran_exclusive',
    category: 'demographic',
    description: 'Explicitly veteran-exclusive programs for non-veteran profiles',
    hard: true,
    oppPattern: /\b(veterans?\s*only|must be (a|an)\s+veteran|veteran status required|active[-\s]duty( service members?)?\s*only|service members?\s*only|exclusively for veterans?)\b/i,
    profileCheck: (pd) => !_isVeteranProfile(pd),
    reason: 'Demographic exclusivity: veterans-only program, profile has no veteran indicator',
  },

  // ── 6c-hard. Geographic: explicitly RESIDENTS-ONLY of a different state ────
  // Plain state mismatch stays SOFT (cross-state grants are often open). But
  // language that EXPLICITLY restricts to residents of a specific state ("X
  // residents only", "must be a resident of X", "open only to residents of X")
  // is exclusive — a non-resident cannot apply — so when that state differs from
  // the profile's, HARD-reject. Catches e.g. "Texas residents only" for a TN
  // profile without dropping genuinely open cross-state opportunities.
  {
    id: 'geographic_residents_only_exclusive',
    category: 'geographic',
    description: 'Explicitly residents-only programs for a different state',
    hard: true,
    oppPattern: /\b(residents?\s+only|open only to residents|restricted to residents|must (be|reside)[^.]{0,25}resident|for residents of)\b/i,
    profileCheck: (pd, _oppText, opportunity) => {
      if (!opportunity || _isNationalOpportunity(opportunity)) return false
      const profileState = _normalizeState((pd.state || '').toLowerCase().trim())
      if (!profileState) return false
      const oppState = _normalizeState((opportunity.state || '').toLowerCase().trim())
      const titleAbbr = _extractStateNameFromTitle(opportunity.title || '')
      const target = oppState || (titleAbbr ? String(titleAbbr).toLowerCase() : '')
      if (!target) return false
      return profileState !== target
    },
    reason: 'Geographic exclusivity: residents-only program for a different state than the profile',
  },

  // ── 2c. Demographic: refugee/resettlement programs for non-immigrants ──────
  {
    id: 'demographic_refugee_only',
    category: 'demographic',
    description: 'Refugee/resettlement programs for profiles with no immigrant indicator',
    oppPattern: /\b(refugee resettlement|resettlement only|for refugees only|newly arrived immigrants? only|office of refugee|refugee assistance|irc.{0,5}resettlement)\b/i,
    profileCheck: (pd) => !_hasImmigrantIndicator(pd),
    reason: 'Demographic mismatch: refugee-specific program, no immigrant indicator in profile',
  },

  // ── 2b-biz. Entity Type: Business/SBA programs for non-business profiles ──
  {
    id: 'entity_business_sba',
    category: 'entity_type',
    description: 'Business/SBA programs for non-business profiles',
    oppPattern: /\b(sba\b|small business (administration|development|innovation|grants?|resources?|funding)|sbir\b|sttr\b|entrepreneur(ship)?( training| center| program)?|minority business development|business development grant|usda (rural )?business|community advantage program|8\(a\) business|women.owned small business|wosb\b|liftfund|nase growth grant|kiva u\.?s\.?|crowdfunded business|value.added producer grant|vapg\b|native cdfi|indigenous business|national urban league.{0,20}entrepreneur|self.employment assistance)\b/i,
    profileCheck: (pd) => !_isBusinessProfile(pd),
    reason: 'Entity type mismatch: business/SBA program for non-business profile',
  },

  // ── 2c-nonprofit. Entity Type: Nonprofit-specific programs for individuals ─
  {
    id: 'entity_nonprofit_only',
    category: 'entity_type',
    description: 'Nonprofit-specific programs for non-nonprofit profiles',
    oppPattern: /\b(for nonprofits|philanthropy for nonprofits|grants? for nonprofits|nonprofit.only|nonprofits? (van|vehicle|equipment)|foundation directory online)\b/i,
    profileCheck: (pd) => !_isNonprofitProfile(pd),
    reason: 'Entity type mismatch: nonprofit-specific program for non-nonprofit profile',
  },

  // ── 2d. Entity Type: University/college-specific programs for non-students ─
  {
    id: 'entity_university_specific',
    category: 'entity_type',
    description: 'Institutional university/college programs for non-student profiles',
    oppPattern: /\b(university\s*[—–-]\s*|college\s*[—–-]\s*|institutional scholarship|college.{0,20}financial aid|university.{0,20}financial aid|college.{0,20}housing|university.{0,20}housing|off.campus resources?|community college.{0,30}(aid|grant|scholarship|resource))\b/i,
    profileCheck: (pd) => !_isStudentProfile(pd),
    reason: 'Entity type mismatch: university/college-specific program for non-student profile',
  },

  // ── 2d-ii. Entity Type: Generic student academic aid for non-students ──────
  {
    id: 'entity_student_academic_aid',
    category: 'entity_type',
    description: 'Student-only academic aid programs for non-student profiles',
    oppPattern: /\b(federal pell grant|pell grant|teach grant\b|fseog\b|federal supplemental educational opportunity|buick achievers|questbridge\b|quest bridge|jack kent cooke|gates scholarship|cobell scholarship|cal grant\b|texas public educational grant|tpeg\b|state tuition (assistance|grant)|tuition assistance program|state financial aid program|academic competitive grant|smart grant|iraq and afghanistan service grant|dependent student grant|college access grant|college opportunity grant|need.based (college|academic) (grant|scholarship))\b/i,
    profileCheck: (pd) => !_isStudentProfile(pd),
    reason: 'Entity type mismatch: student-only academic aid program for non-student profile',
  },

  // ── 2d-iii. Demographic: HIV/AIDS-specific programs ───────────────────────
  {
    id: 'demographic_hiv_aids',
    category: 'demographic',
    description: 'HIV/AIDS-specific programs for profiles with no HIV/AIDS indicator',
    oppPattern: /\b(ryan white|hiv\/aids program|aids drug assistance|adap\b|people living with hiv|plwh\b|hiv.{0,20}(care|treatment|support|assistance)|aids.{0,20}(care|treatment|support|assistance))\b/i,
    profileCheck: (pd) => !_hasHivIndicator(pd),
    reason: 'Demographic mismatch: HIV/AIDS-specific program, no HIV/AIDS indicator in profile',
  },

  // ── 2e-i. Demographic: FEMA/disaster programs ────────────────────────────
  {
    id: 'demographic_fema_disaster',
    category: 'demographic',
    description: 'FEMA/disaster programs for profiles with no disaster indicator',
    oppPattern: /\b(fema individual assistance|fema disaster (relief|assistance|grant)|disaster (relief|assistance) grant|individual.*assistance.*disaster|ihp\b|individuals and households program)\b/i,
    profileCheck: (pd) => !_hasDisasterIndicator(pd),
    reason: 'Demographic mismatch: FEMA/disaster program, no disaster need indicator in profile',
  },

  // ── 2e. Demographic: Foster care youth programs ───────────────────────────
  {
    id: 'demographic_foster_youth',
    category: 'demographic',
    description: 'Foster care youth programs for profiles with no foster care indicator',
    oppPattern: /\b(foster.?club|youth aging out|foster care youth|foster youth|chafee|aging out of foster)\b/i,
    profileCheck: (pd) => !_hasFosterIndicator(pd),
    reason: 'Demographic mismatch: foster care youth program, no foster care indicator in profile',
  },

  // ── 2f. Demographic: First responder programs ─────────────────────────────
  {
    id: 'demographic_first_responder',
    category: 'demographic',
    description: 'First responder programs for profiles with no first responder indicator',
    oppPattern: /\b(first responder(s)?( children)?( foundation)?|firefighter grant|law enforcement grant|emt grant)\b/i,
    profileCheck: (pd) => !_hasFirstResponderIndicator(pd),
    reason: 'Demographic mismatch: first responder program, no first responder indicator in profile',
  },

  // ── 3. Professional: nursing license/re-entry programs ───────────────────
  {
    id: 'professional_nursing_license',
    category: 'professional',
    description: 'Nursing license reinstatement programs for profiles with no nursing background',
    oppPattern: /\b(nursing license (reinstatement|recovery|renewal)|nurse re.?entry|rn license recovery|lpn license recovery|nurse reinstatement)\b/i,
    profileCheck: (pd) => !_hasNursingBackground(pd),
    reason: 'Professional mismatch: nursing license program, no nursing background in profile',
  },

  // ── 4a. Age: children-only programs ──────────────────────────────────────
  {
    id: 'age_children_only',
    category: 'age_restriction',
    description: 'Children-only programs for adult profiles',
    oppPattern: /\b(children only|youth under 18|minor children|katie beckett|coverkids|cover kids|children.{0,15}program)\b/i,
    profileCheck: (pd) => Number(pd.age || 0) > 18,
    reason: (pd) => `Age mismatch: children-only program, profile age is ${Number(pd.age || 0)}`,
  },

  // ── 4b. Age: senior-only programs ────────────────────────────────────────
  {
    id: 'age_senior_only',
    category: 'age_restriction',
    description: 'Senior-only programs for young-adult profiles (when age is known)',
    oppPattern: /\b(seniors? only|seniors? program|age 55\+|age 60\+|age 65\+|aaad|area agency on aging|aging services)\b/i,
    profileCheck: (pd) => {
      const age = Number(pd.age || 0)
      return age > 0 && age < 55
    },
    reason: (pd) => `Age mismatch: senior-only program, profile age is ${Number(pd.age || 0)}`,
  },

  // ── 5a. Disability: IDD-specific programs ────────────────────────────────
  {
    id: 'disability_idd_specific',
    category: 'disability',
    description: 'IDD-specific programs for profiles with no IDD indicator',
    oppPattern: /\b(ecf choices|didd\b|intellectual disability|developmental disability|idd waiver|intellectual.{0,20}developmental)\b/i,
    profileCheck: (pd) => !_hasIddIndicator(pd),
    reason: 'Disability mismatch: IDD-specific program, no IDD indicators in profile',
  },

  // ── 5b. Disability: blindness-specific programs ───────────────────────────
  {
    id: 'disability_blind_specific',
    category: 'disability',
    description: 'Blindness-specific programs for profiles with no visual impairment',
    oppPattern: /\b(blind only|visually impaired only|for the blind|blindness program)\b/i,
    profileCheck: (pd) => !_hasVisualImpairmentSpecific(pd),
    reason: 'Disability mismatch: blindness-specific program, no visual impairment in profile',
  },

  // ── 6. Geographic: state mismatch ────────────────────────────────────────
  {
    id: 'geographic_state_mismatch',
    category: 'geographic',
    description: 'State-specific opportunities for profiles in a different state',
    oppPattern: null, // Trigger is purely data-based; no text pattern needed
    profileCheck: (pd, _oppText, opportunity) => {
      if (!opportunity) return false
      const profileState = (pd.state || '').toLowerCase().trim()
      const oppState = (opportunity.state || '').toLowerCase().trim()
      if (_isNationalOpportunity(opportunity) || !profileState || !oppState) return false
      return _normalizeState(profileState) !== _normalizeState(oppState)
    },
    reason: (pd, opportunity) => {
      const oppState = (opportunity?.state || '').toLowerCase().trim()
      const profileState = (pd.state || '').toLowerCase().trim()
      return `Geographic mismatch: opportunity is for ${oppState}, profile is in ${profileState}`
    },
  },

  // ── 6b. Geographic: state name embedded in opportunity title ─────────────
  {
    id: 'geographic_title_state_mismatch',
    category: 'geographic',
    description: 'Opportunity title names a different state than the profile',
    oppPattern: null, // Trigger depends on extractStateNameFromTitle, not a simple text scan
    profileCheck: (pd, _oppText, opportunity) => {
      if (!opportunity || opportunity.is_national) return false
      const profileState = (pd.state || '').toLowerCase().trim()
      if (!profileState) return false
      const titleStateAbbr = _extractStateNameFromTitle(opportunity.title || '')
      if (!titleStateAbbr) return false
      const profileStateAbbr = _normalizeState(profileState.toLowerCase())
      return profileStateAbbr !== titleStateAbbr.toLowerCase()
    },
    reason: (pd, opportunity) => {
      const titleStateAbbr = _extractStateNameFromTitle(opportunity?.title || '') || ''
      const profileState = (pd.state || '').toUpperCase()
      return `Geographic mismatch: opportunity title names ${titleStateAbbr}, profile is in ${profileState}`
    },
  },

  // ── 7a. Already enrolled: Medicaid ───────────────────────────────────────
  {
    id: 'already_enrolled_medicaid',
    category: 'already_enrolled',
    description: 'Medicaid enrollment programs for profiles already on Medicaid',
    oppPattern: /\b(medicaid:? contact|enroll in medicaid|medicaid application|tenncare enrollment)\b/i,
    profileCheck: (pd) => _getAlreadyEnrolledPrograms(pd).includes('medicaid'),
    reason: 'Already enrolled: profile already on Medicaid',
  },

  // ── 7b. Already enrolled: SNAP ───────────────────────────────────────────
  {
    id: 'already_enrolled_snap',
    category: 'already_enrolled',
    description: 'SNAP enrollment programs for profiles already receiving SNAP',
    oppPattern: /\b(snap \(supplemental|supplemental nutrition assistance program\))\b/i,
    profileCheck: (pd) => _getAlreadyEnrolledPrograms(pd).includes('snap'),
    reason: 'Already enrolled: profile already receives SNAP',
  },

  // ── 7c. Already enrolled: SSI ────────────────────────────────────────────
  {
    id: 'already_enrolled_ssi',
    category: 'already_enrolled',
    description: 'SSI enrollment programs for profiles already receiving SSI',
    oppPattern: /\b(ssi \(supplemental security|supplemental security income\))\b/i,
    profileCheck: (pd) => _getAlreadyEnrolledPrograms(pd).includes('ssi'),
    reason: 'Already enrolled: profile already receives SSI',
  },

  // ── 7d. Already enrolled: SSDI ───────────────────────────────────────────
  {
    id: 'already_enrolled_ssdi',
    category: 'already_enrolled',
    description: 'SSDI enrollment programs for profiles already receiving SSDI',
    oppPattern: /\b(ssdi \(social security disability|social security disability insurance\))\b/i,
    profileCheck: (pd) => _getAlreadyEnrolledPrograms(pd).includes('ssdi'),
    reason: 'Already enrolled: profile already receives SSDI',
  },

  // ── 7e. Already enrolled: TANF ───────────────────────────────────────────
  {
    id: 'already_enrolled_tanf',
    category: 'already_enrolled',
    description: 'TANF enrollment programs for profiles already receiving TANF',
    oppPattern: /\b(tanf \(temporary assistance|temporary assistance for needy families\))\b/i,
    profileCheck: (pd) => _getAlreadyEnrolledPrograms(pd).includes('tanf'),
    reason: 'Already enrolled: profile already receives TANF',
  },

  // ── 8. Employment: workforce training for unable-to-work profiles ─────────
  {
    id: 'employment_unable_to_work',
    category: 'employment',
    description: 'Workforce training programs for profiles that cannot work',
    oppPattern: /\b(workforce (training|innovation|development)|wioa\b|vocational rehabilitation|job training|employment training|career training|license reinstatement|job center|american job center|hpog|health profession opportunity)\b/i,
    profileCheck: (pd) => _isUnableToWork(pd),
    reason: 'Employment mismatch: workforce training program but profile indicates unable to work',
  },

  // ── 9. Household: children programs for childless senior households ────────
  {
    id: 'household_children_senior',
    category: 'household',
    description: 'Children-required programs for childless senior households',
    oppPattern: /\b(head start|early head start|child care assistance|ccdf|ccdbg|wic \(women|women,? infants,? and children|cover ?kids|first responder children)\b/i,
    profileCheck: (pd) => !_hasChildren(pd) && _isSenior(pd),
    reason: 'Household mismatch: children-required program for childless senior household',
  },

  // ── 10. Disability: broad blindness/vision programs ───────────────────────
  {
    id: 'disability_broad_blind',
    category: 'disability',
    description: 'Blindness/vision programs for profiles with no visual impairment indicator',
    oppPattern: /\b(national federation of the blind|american foundation for the blind|for the blind|blindness (program|assistance|support)|blind.{0,10}(assistance|program|resource|support))\b/i,
    profileCheck: (pd) => !_hasVisualImpairmentBroad(pd),
    reason: 'Disability mismatch: blindness program, no visual impairment in profile',
  },

  // ── 11. Professional: broad nursing/healthcare professional programs ────────
  {
    id: 'professional_broad_nursing',
    category: 'professional',
    description: 'Nursing/healthcare professional programs for profiles with no nursing background',
    oppPattern: /\b(ncsbn|national council of state boards|american nurses association|nurse (re.?entry|recovery|remediation)|nursing (workforce|scholarship|recovery|reinstatement)|probe.{0,5}(ethics|professional)|professional boundaries.{0,5}ethics|ana foundation.{0,10}nurs)\b/i,
    profileCheck: (pd) => !_hasNursingBackground(pd),
    reason: 'Professional mismatch: nursing program, no nursing background in profile',
  },

  // ── 12. Demographic: Native/Indigenous programs for non-Native profiles ────
  {
    id: 'demographic_native_indigenous',
    category: 'demographic',
    description: 'Native/Indigenous programs for profiles with no Native indicator',
    oppPattern: /\b(native cdfi|indigenous business|native american (business|grant|program)|tribal (grant|program|business)|bureau of indian affairs)\b/i,
    profileCheck: (pd) => !_hasNativeIndicator(pd),
    reason: 'Demographic mismatch: Native/Indigenous program, no Native indicator in profile',
  },

  // ── 13. Referral directories (not direct funding sources) ─────────────────
  {
    id: 'referral_directory',
    category: 'content_type',
    description: 'Resource directories that are not direct funding sources',
    oppPattern: /\b(benefits\.gov|211\.org|tennessee 211|connect to help|resource directory|benefit (finder|screener))\b/i,
    profileCheck: (_pd, _oppText, opportunity) => !opportunity?.application_url,
    reason: 'Not a funding source: resource is an info directory, not direct funding',
  },

  // ── 14. Entity Type: AmeriCorps institutional grants for individuals ────────
  {
    id: 'entity_americorps_institutional',
    category: 'entity_type',
    description: 'AmeriCorps institutional grants for individual/non-org profiles',
    oppPattern: /\b(americorps (state|national).{0,20}(grant|competition)|americorps.{0,10}(competitive|grant).{0,10}(organization|nonprofit))\b/i,
    profileCheck: (pd) => !_isNonprofitProfile(pd) && !_isBusinessProfile(pd),
    reason: 'Entity mismatch: AmeriCorps institutional grant for individual profile',
  },

  // ── 15. Geographic: wrong city for geo-located resources ──────────────────
  {
    id: 'geographic_wrong_city',
    category: 'geographic',
    description: 'Geo-located resources in a different city than the profile',
    oppPattern: null, // Trigger is a regex match with capture groups on opportunity.title
    profileCheck: (pd, _oppText, opportunity) => {
      if (!opportunity) return false
      const profileCity = (pd.city || '').toLowerCase().trim()
      if (!profileCity) return false
      const nearMatch = (opportunity.title || '').match(/near\s+([A-Za-z\s]+),\s*([A-Z]{2})/i)
      if (!nearMatch) return false
      const oppCity = nearMatch[1].trim().toLowerCase()
      const oppSt = nearMatch[2].trim().toLowerCase()
      const profSt = (pd.state || '').toLowerCase()
      return (
        oppSt === profSt &&
        oppCity !== profileCity &&
        oppCity.substring(0, 4) !== profileCity.substring(0, 4)
      )
    },
    reason: (_pd, opportunity) => {
      const nearMatch = (opportunity?.title || '').match(/near\s+([A-Za-z\s]+),\s*([A-Z]{2})/i)
      return `Geographic mismatch: resource near ${nearMatch?.[1]?.trim() || ''} but profile in ${_pd.city || ''}`
    },
  },

  // ── 16. Content type: Procurement / contract solicitations ────────────────
  // Only reject for individual/family profiles. Organizations, nonprofits, and
  // businesses legitimately respond to RFPs and solicitations.
  {
    id: 'content_procurement_contract',
    category: 'content_type',
    description: 'Procurement and contract solicitations are not grant opportunities for individuals',
    oppPattern: /\b(contract opportunity|statement of work|bidder|vendor)\b/i,
    profileCheck: (pd) => {
      const t = (pd.primary_type || '').toLowerCase()
      return ['individual', 'individual_need', 'family', 'student', 'college_student', 'high_school_student', 'medical_assistance', 'caregiver'].includes(t)
    },
    reason: 'Content type mismatch: procurement/contract solicitation, not a grant opportunity for individuals',
  },

  // ── 17. Content type: Fundraising / crowdfunding asks ─────────────────────
  // These are "give money" pages, not "receive funding" opportunities.
  // Reject for all profile types since they are not award applications.
  {
    id: 'content_fundraising_crowdfunding',
    category: 'content_type',
    description: 'Crowdfunding and fundraising asks are not award opportunities',
    hard: true, // content type exclusivity
    oppPattern: /\b(donate to|gofundme|kickstarter|indiegogo)\b/i,
    profileCheck: () => true,
    reason: 'Content type mismatch: fundraising/crowdfunding ask, not an award opportunity',
  },

  // ── 18. Content type: PI / institution-restricted academic calls ───────────
  // Only reject for individual/family profiles. Organizations, nonprofits, schools,
  // and researchers legitimately apply for institutional academic calls.
  {
    id: 'content_pi_institution_restricted',
    category: 'content_type',
    description: 'PI/institution-only academic calls not open to individual profiles',
    oppPattern: /\b(principal investigator|faculty member|doctoral dissertation research)\b/i,
    profileCheck: (pd) => {
      const t = (pd.primary_type || '').toLowerCase()
      return !_isNonprofitProfile(pd) && !_isBusinessProfile(pd) && !_isStudentProfile(pd) &&
        t !== 'researcher' && t !== 'school'
    },
    reason: 'Content type mismatch: PI/institution-only academic call, not open to individual profiles',
  },

  // — 19. No actionable URL — reject opportunities with no application_url AND no source_url
  // These are unfundable placeholders: users cannot apply or even visit the source.
  {
        id: 'no_actionable_url',
        category: 'data_quality',
        description: 'Opportunity has no application URL and no source URL — not actionable',
        hard: true, // data quality — always reject
        oppPattern: null,
        profileCheck: (pd, oppText, opp) => {
                const url = opp?.application_url || opp?.source_url || opp?.url || ''
                return !url || typeof url !== 'string' || !url.startsWith('http')
        },
        reason: 'Data quality: no actionable URL — cannot apply or visit this opportunity',
  },

    // — 20. Generic directory page — reject opportunities that are just org homepages
    // without specific funding program information.
  {
        id: 'generic_directory_page',
        category: 'content_type',
        description: 'Generic organizational directory or homepage, not a specific funding program',
        oppPattern: /\b(resource directory|service directory|agency listing|department homepage|find your local)\b/i,
        profileCheck: (pd, oppText, opp) => {
                const title = (opp?.title || '').toLowerCase()
                const desc = (opp?.description || '').toLowerCase()
                // Reject if title looks like a generic directory AND description is vague
                const directoryTitles = [
                          'local housing finance agencies',
                          'department of labor',
                          'community action agencies',
                          'state vocational rehabilitation',
                          'workforce development boards',
                        ]
                const isDirectoryTitle = directoryTitles.some(d => title.includes(d))
                const hasNoSpecificProgram = desc.length < 80 || /\b(directory|listing|find your|locate)\b/i.test(desc)
                return isDirectoryTitle && hasNoSpecificProgram
        },
        reason: 'Content type mismatch: generic directory/agency listing, not a specific funding program',
  },

    // — 21. Disability-specific programs for non-disability profiles ——————
    // Programs like "Ticket to Work", "ODEP", disability employment grants
    // should only match profiles that indicate a disability need.
  {
        id: 'disability_program_mismatch',
        category: 'demographic',
        description: 'Disability-specific employment/funding program shown to profile without disability indicators',
        oppPattern: /\b(disability employment|ticket to work|ODEP|vocational rehabilitation|disability grants|SSI|SSDI)\b/i,
        profileCheck: (pd) => {
                const needs = (pd.needs || []).map(n => (n || '').toLowerCase())
                const text = [
                          pd.primary_type, pd.description, pd.situation,
                          ...(pd.challenges || []), ...(pd.special_circumstances || []),
                        ].filter(Boolean).join(' ').toLowerCase()
                const hasDisabilityNeed = needs.some(n => /disab|special.?need|impair|handicap|ssi|ssdi/.test(n))
                const hasDisabilityText = /disab|special.?need|impair|handicap|ssi|ssdi|wheelchair|blind|deaf/.test(text)
                return !hasDisabilityNeed && !hasDisabilityText
        },
        reason: 'Demographic mismatch: disability-specific program for profile without disability indicators',
  },

    // — 22. Foster/adoption programs for non-foster profiles ——————
  {
        id: 'foster_program_mismatch',
        category: 'demographic',
        description: 'Foster/adoption-specific program shown to non-foster profile',
        oppPattern: /\b(foster youth|foster care|foster parent|aging out of foster|former foster)\b/i,
        profileCheck: (pd) => {
                const needs = (pd.needs || []).map(n => (n || '').toLowerCase())
                const text = [
                          pd.primary_type, pd.description, pd.situation,
                          ...(pd.challenges || []), ...(pd.special_circumstances || []),
                        ].filter(Boolean).join(' ').toLowerCase()
                const hasFosterNeed = needs.some(n => /foster|adopt|aging.?out/.test(n))
                const hasFosterText = /foster|adopt|aging.?out|child.?welfare|dcs|dcfs/.test(text)
                return !hasFosterNeed && !hasFosterText
        },
        reason: 'Demographic mismatch: foster/adoption program for non-foster profile',
  },

    // — 23. Homeless-specific programs for non-homeless profiles ——————
  {
        id: 'homeless_program_mismatch',
        category: 'demographic',
        description: 'Homeless-specific program shown to profile without housing instability',
        oppPattern: /\b(homeless assistance|homeless shelter|HUD continuum of care|emergency shelter grant|homeless veterans)\b/i,
        profileCheck: (pd) => {
                const needs = (pd.needs || []).map(n => (n || '').toLowerCase())
                const text = [
                          pd.primary_type, pd.description, pd.situation,
                          ...(pd.challenges || []), ...(pd.special_circumstances || []),
                        ].filter(Boolean).join(' ').toLowerCase()
                const hasHousingNeed = needs.some(n => /hous|home|shelter|homeless|evict|rent/.test(n))
                const hasHousingText = /homeless|housing.?instab|evict|shelter|unsheltered|couch.?surf/.test(text)
                return !hasHousingNeed && !hasHousingText
        },
        reason: 'Demographic mismatch: homeless-specific program for profile without housing instability',
  },

  // Rule 19 REMOVED: Rolling / open-until-filled programs are legitimate funding
  // sources (Goal 8: avoid zero results; Goal 5: evolve with new needs).
  // Many real assistance programs, benefits, and directory resources operate
  // on a rolling basis and do not have concrete deadlines.
]
