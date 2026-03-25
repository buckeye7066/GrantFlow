/**
 * relevanceFilter.js
 *
 * Post-scoring hard disqualification filter.
 * Removes opportunities that cannot possibly be relevant to a profile,
 * regardless of keyword overlap or computed score.
 *
 * Rules are intentionally conservative: when profile data is missing or
 * ambiguous the filter PASSES (returns { pass: true }) so we never
 * accidentally suppress a genuine match.
 */

// State full-name → abbreviation map (module-level constant, not recreated per call)
const STATE_ABBREVIATIONS = {
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

// State name → 2-letter abbreviation (uppercase) sorted by name length descending so
// multi-word state names ("west virginia") match before single-word names ("virginia").
const STATE_NAME_TO_ABBR_ENTRIES = [
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

/**
 * Detect a US state name embedded in an opportunity title.
 * "Ohio Family and Children First" → "OH"
 * "New York Tuition Assistance Program" → "NY"
 *
 * Returns the 2-letter uppercase state abbreviation or null.
 */
export function extractStateNameFromTitle(title) {
  const lower = (title || '').toLowerCase()
  for (const [name, abbr] of STATE_NAME_TO_ABBR_ENTRIES) {
    if (lower.includes(name)) return abbr
  }
  return null
}

/** Normalize a state string to its 2-letter abbreviation when possible. */
function normalizeState(s) {
  return STATE_ABBREVIATIONS[s] || s
}

/** Return true if the opportunity is available nationally. */
function isNationalOpportunity(opportunity) {
  const oppState = (opportunity.state || '').toLowerCase().trim()
  return !oppState || oppState === 'nationwide' || oppState === 'national' || Boolean(opportunity.is_national)
}

/**
 * Apply hard disqualification rules to a single opportunity.
 *
 * @param {object} opportunity  - Opportunity row (title, description, keywords, state, sponsor, …)
 * @param {object} profileData  - Extracted profile fields (see extractProfileData helper below)
 * @returns {{ pass: boolean, reason?: string }}
 */
export function applyRelevanceFilter(opportunity, profileData) {
  if (!opportunity || !profileData) return { pass: true }

  const oppText = [
    opportunity.title || '',
    opportunity.description || '',
    opportunity.sponsor || '',
    ...(Array.isArray(opportunity.keywords) ? opportunity.keywords : []),
    ...(Array.isArray(opportunity.categories) ? opportunity.categories : []),
    ...(Array.isArray(opportunity.eligibility_bullets) ? opportunity.eligibility_bullets : []),
  ]
    .join(' ')
    .toLowerCase()

  // ── 1. Entity Type Mismatch ───────────────────────────────────────────────

  const profileType = (profileData.primary_type || '').toLowerCase()

  if (profileType === 'organization') {
    // Individual-benefit programs that orgs cannot apply for
    const individualOnlyPattern =
      /\b(snap|food stamps|tanf|wic|ssdi|ssi\b|medicaid enrollment|personal food bank|section 8|housing voucher|individual disability benefits?|individual benefit)\b/i
    if (individualOnlyPattern.test(oppText)) {
      return { pass: false, reason: 'Entity type mismatch: individual-only program for organization profile' }
    }
  }

  if (profileType === 'individual') {
    // Org-only requirements that individuals cannot meet
    const orgOnlyPattern =
      /\b(501\(c\)\(3\)|501c3|ein required|duns number|uei required|organizational capacity|nonprofit only|must be a nonprofit|must have an ein)\b/i
    if (orgOnlyPattern.test(oppText)) {
      return { pass: false, reason: 'Entity type mismatch: organization-only program for individual profile' }
    }
  }

  // ── 2. Demographic Mismatch ───────────────────────────────────────────────

  const profileGender = (profileData.gender || '').toLowerCase()

  // Women-only grants
  const womenOnlyPattern =
    /\b(women only|for women|amber grant for women|female entrepreneurs only|women.{0,10}only)\b/i
  if (womenOnlyPattern.test(oppText) && profileGender && profileGender !== 'female') {
    return { pass: false, reason: 'Demographic mismatch: women-only program, profile is not female' }
  }

  // Veteran-focused grants — block when profile has no veteran indicator.
  // Broadened beyond "veterans only" to catch programs like SSVF that are inherently
  // veteran-targeted even without an explicit "only" qualifier.
  const isVeteranProfile =
    profileData.veteran_status === true ||
    profileData.veteran_status === 'yes' ||
    profileData.veteran_status === 'true'
  const veteranFocusedPattern =
    /\b(ssvf|supportive services for veteran|veterans? only|must be a veteran|veteran status required|active duty only|service members only|boots to business|veteran entrepreneurship|va (housing|benefits|disability|healthcare|medical)|veterans? (assistance|support|services|program|families))\b/i
  if (veteranFocusedPattern.test(oppText) && !isVeteranProfile) {
    return { pass: false, reason: 'Demographic mismatch: veteran-focused program, profile has no veteran indicator' }
  }

  // Refugee/resettlement specific — block if profile has no immigrant indicator.
  // Broadened to also catch "Office of Refugee Resettlement" and "IRC — Resettlement".
  const refugeePattern =
    /\b(refugee resettlement|resettlement only|for refugees only|newly arrived immigrants? only|office of refugee|refugee assistance|irc.{0,5}resettlement)\b/i
  if (refugeePattern.test(oppText)) {
        const NON_IMMIGRANT_STATUSES = new Set([
                  'us_citizen', 'citizen', 'us citizen', 'permanent_resident',
                  'permanent resident', 'green_card', 'green card', 'naturalized',
                  'naturalized_citizen', 'born_in_us', 'native_born', 'n/a', 'none',
                ])
          const statusLower = String(profileData.immigrant_status || '').toLowerCase().trim()
          const hasImmigrantIndicator = Boolean(
                    profileData.immigrant_status &&
                    profileData.immigrant_status !== 'no' &&
                    profileData.immigrant_status !== 'false' &&
                    profileData.immigrant_status !== false &&
                    !NON_IMMIGRANT_STATUSES.has(statusLower)
                  )
    if (!hasImmigrantIndicator) {
      return { pass: false, reason: 'Demographic mismatch: refugee-specific program, no immigrant indicator in profile' }
    }
  }

  // ── 2b. Business/SBA grants for non-business profiles ─────────────────────
  // SBA, entrepreneur, and small-business-specific programs should not appear
  // for individual/family/student profiles who are not business owners.
  const isBusinessProfile =
    profileType === 'small_business' ||
    profileType === 'organization' ||
    profileType === 'nonprofit'
  const businessOnlyPattern =
    /\b(sba\b|small business (administration|development|innovation|grants?|resources?|funding)|sbir\b|sttr\b|entrepreneur(ship)?( training| center| program)?|minority business development|business development grant|usda (rural )?business|community advantage program|8\(a\) business|women.owned small business|wosb\b|liftfund|nase growth grant|kiva u\.?s\.?|crowdfunded business|value.added producer grant|vapg\b|native cdfi|indigenous business|national urban league.{0,20}entrepreneur|self.employment assistance)\b/i
  if (businessOnlyPattern.test(oppText) && !isBusinessProfile) {
    return { pass: false, reason: 'Entity type mismatch: business/SBA program for non-business profile' }
  }

  // ── 2c. Nonprofit-specific grants for individuals ─────────────────────────
  // Programs explicitly "for nonprofits" should not appear for individual/family/student profiles.
  const isNonprofitProfile =
    profileType === 'organization' ||
    profileType === 'nonprofit'
  const nonprofitOnlyPattern =
    /\b(for nonprofits|philanthropy for nonprofits|grants? for nonprofits|nonprofit.only|nonprofits? (van|vehicle|equipment)|foundation directory online)\b/i
  if (nonprofitOnlyPattern.test(oppText) && !isNonprofitProfile) {
    return { pass: false, reason: 'Entity type mismatch: nonprofit-specific program for non-nonprofit profile' }
  }

  // ── 2d. University/college-specific programs for non-students ──────────────
  // Institutional scholarships, financial aid, and housing from specific universities
  // should not appear for profiles that are not students.
  const isStudentProfile =
    profileType === 'student' ||
    profileType === 'high_school_student' ||
    profileType === 'college_student'
  // Broadened: catches em-dash, regular dash, plain " - ", "Financial Aid", "Housing",
  // "Off-Campus Resources", and generic "community college" financial aid programs.
  const universitySpecificPattern =
    /\b(university\s*[—–-]\s*|college\s*[—–-]\s*|institutional scholarship|college.{0,20}financial aid|university.{0,20}financial aid|college.{0,20}housing|university.{0,20}housing|off.campus resources?|community college.{0,30}(aid|grant|scholarship|resource))\b/i
  if (universitySpecificPattern.test(oppText) && !isStudentProfile) {
    return { pass: false, reason: 'Entity type mismatch: university/college-specific program for non-student profile' }
  }

  // ── 2d-ii. Generic student scholarship / academic aid for non-student profiles ─
  // These programs are exclusively for enrolled or prospective students.
  // Block them unless the profile type indicates a student.
  const genericStudentAidPattern =
    /\b(federal pell grant|pell grant|teach grant\b|fseog\b|federal supplemental educational opportunity|buick achievers|questbridge\b|quest bridge|jack kent cooke|gates scholarship|cobell scholarship|cal grant\b|texas public educational grant|tpeg\b|state tuition (assistance|grant)|tuition assistance program|state financial aid program|academic competitive grant|smart grant|iraq and afghanistan service grant|dependent student grant|college access grant|college opportunity grant|need.based (college|academic) (grant|scholarship))\b/i
  if (genericStudentAidPattern.test(oppText) && !isStudentProfile) {
    return { pass: false, reason: 'Entity type mismatch: student-only academic aid program for non-student profile' }
  }

  // ── 2d-iii. HIV/AIDS-specific programs for profiles with no HIV indicator ──
  // Ryan White and AIDS drug assistance programs are exclusively for people living
  // with HIV/AIDS. Block for profiles with no HIV/AIDS indicator.
  const hivAidsPattern =
    /\b(ryan white|hiv\/aids program|aids drug assistance|adap\b|people living with hiv|plwh\b|hiv.{0,20}(care|treatment|support|assistance)|aids.{0,20}(care|treatment|support|assistance))\b/i
  if (hivAidsPattern.test(oppText)) {
    const hasHivIndicator =
      (Array.isArray(profileData.tags) &&
        profileData.tags.some((t) => /hiv|aids\b/i.test(String(t)))) ||
      (profileData.disability_status && /hiv|aids/i.test(JSON.stringify(profileData.disability_status)))
    if (!hasHivIndicator) {
      return { pass: false, reason: 'Demographic mismatch: HIV/AIDS-specific program, no HIV/AIDS indicator in profile' }
    }
  }

  // ── 2e-i. FEMA/disaster programs for non-disaster profiles ─────────────────
  // FEMA Individual Assistance and generic disaster relief should not appear for
  // profiles that have no disaster-related need indicator.
  const femaDisasterPattern =
    /\b(fema individual assistance|fema disaster (relief|assistance|grant)|disaster (relief|assistance) grant|individual.*assistance.*disaster|ihp\b|individuals and households program)\b/i
  if (femaDisasterPattern.test(oppText)) {
    const hasDisasterIndicator =
      (Array.isArray(profileData.tags) &&
        profileData.tags.some((t) => /disaster|fema|emergency|flood|fire|tornado|hurricane|storm/i.test(String(t)))) ||
      (profileData.primary_type || '').toLowerCase() === 'disaster_survivor'
    if (!hasDisasterIndicator) {
      return { pass: false, reason: 'Demographic mismatch: FEMA/disaster program, no disaster need indicator in profile' }
    }
  }

  // ── 2e. Foster care youth programs ────────────────────────────────────────
  const fosterYouthPattern =
    /\b(foster.?club|youth aging out|foster care youth|foster youth|chafee|aging out of foster)\b/i
  if (fosterYouthPattern.test(oppText)) {
    const hasFosterIndicator = Boolean(
      (Array.isArray(profileData.tags) && profileData.tags.some(t => /foster/i.test(String(t)))) ||
      profileData.foster_youth === true,
    )
    if (!hasFosterIndicator) {
      return { pass: false, reason: 'Demographic mismatch: foster care youth program, no foster care indicator in profile' }
    }
  }

  // ── 2f. First responder programs ──────────────────────────────────────────
  const firstResponderPattern =
    /\b(first responder(s)?( children)?( foundation)?|firefighter grant|law enforcement grant|emt grant)\b/i
  if (firstResponderPattern.test(oppText)) {
    const hasFirstResponderIndicator = Boolean(
      (Array.isArray(profileData.tags) && profileData.tags.some(t => /first.?respond|firefight|emt|paramedic|law.?enforce/i.test(String(t)))) ||
      profileData.first_responder === true,
    )
    if (!hasFirstResponderIndicator) {
      return { pass: false, reason: 'Demographic mismatch: first responder program, no first responder indicator in profile' }
    }
  }

  // ── 3. Professional License Mismatch ─────────────────────────────────────

  const nursingProgramPattern =
    /\b(nursing license (reinstatement|recovery|renewal)|nurse re.?entry|rn license recovery|lpn license recovery|nurse reinstatement)\b/i
  if (nursingProgramPattern.test(oppText)) {
    const employmentText = JSON.stringify(profileData.employment || '').toLowerCase()
    const educationText = JSON.stringify(profileData.education || '').toLowerCase()
    const hasNursingBackground =
      employmentText.includes('nurs') ||
      educationText.includes('nurs') ||
      (Array.isArray(profileData.tags) && profileData.tags.some((t) => String(t).toLowerCase().includes('nurs')))
    if (!hasNursingBackground) {
      return { pass: false, reason: 'Professional mismatch: nursing license program, no nursing background in profile' }
    }
  }

  // ── 4. Age-Restricted Programs ────────────────────────────────────────────

  const profileAge = Number(profileData.age || 0)

  // Children/minor-only programs
  const childrenOnlyPattern =
    /\b(children only|youth under 18|minor children|katie beckett|coverkids|cover kids|children.{0,15}program)\b/i
  if (childrenOnlyPattern.test(oppText) && profileAge > 18) {
    return { pass: false, reason: `Age mismatch: children-only program, profile age is ${profileAge}` }
  }

  // Senior-only programs (only block if age is known and clearly below threshold)
  const seniorOnlyPattern =
    /\b(seniors? only|seniors? program|age 55\+|age 60\+|age 65\+|aaad|area agency on aging|aging services)\b/i
  if (seniorOnlyPattern.test(oppText) && profileAge > 0 && profileAge < 55) {
    return { pass: false, reason: `Age mismatch: senior-only program, profile age is ${profileAge}` }
  }

  // ── 5. Disability Program Specificity ─────────────────────────────────────

  // IDD-specific programs — require a positive IDD indicator; block everyone else
  // (ECF Choices, DIDD waivers, etc. are exclusively for people with IDD diagnoses)
  const iddPattern =
    /\b(ecf choices|didd\b|intellectual disability|developmental disability|idd waiver|intellectual.{0,20}developmental)\b/i
  if (iddPattern.test(oppText)) {
    const disabilityText = JSON.stringify(profileData.disability_status || '').toLowerCase()
    const hasIddIndicator =
      disabilityText.includes('intellectual') ||
      disabilityText.includes('developmental') ||
      disabilityText.includes('idd') ||
      disabilityText.includes('ecf') ||
      disabilityText.includes('didd') ||
      (Array.isArray(profileData.tags) &&
        profileData.tags.some(
          (t) =>
            String(t).toLowerCase().includes('intellectual') ||
            String(t).toLowerCase().includes('developmental') ||
            String(t).toLowerCase().includes('idd'),
        ))
    if (!hasIddIndicator) {
      return { pass: false, reason: 'Disability mismatch: IDD-specific program, no IDD indicators in profile' }
    }
  }

  // Blind/visually-impaired specific — require a positive visual-impairment indicator
  const blindPattern = /\b(blind only|visually impaired only|for the blind|blindness program)\b/i
  if (blindPattern.test(oppText)) {
    const disabilityText = JSON.stringify(profileData.disability_status || '').toLowerCase()
    const hasVisualImpairment =
      disabilityText.includes('blind') ||
      disabilityText.includes('visual') ||
      (Array.isArray(profileData.tags) &&
        profileData.tags.some(
          (t) => String(t).toLowerCase().includes('blind') || String(t).toLowerCase().includes('visual'),
        ))
    if (!hasVisualImpairment) {
      return { pass: false, reason: 'Disability mismatch: blindness-specific program, no visual impairment in profile' }
    }
  }

  // ── 6. Geographic Hard Mismatch ───────────────────────────────────────────

  const profileState = (profileData.state || '').toLowerCase().trim()
  const oppState = (opportunity.state || '').toLowerCase().trim()

  if (!isNationalOpportunity(opportunity) && profileState && oppState && profileState !== oppState) {
    if (normalizeState(profileState) !== normalizeState(oppState)) {
      return { pass: false, reason: `Geographic mismatch: opportunity is for ${oppState}, profile is in ${profileState}` }
    }
  }

  // ── 6b. State name embedded in opportunity title ───────────────────────────
  // If the opportunity title contains an explicit US state name that differs
  // from the profile's state, it is almost certainly a state-specific program
  // that the profile cannot access (e.g. "Cleveland State University — Financial Aid"
  // for a TN profile, or "Ohio Family and Children First" for a CA profile).
  // We skip this check only when the opportunity explicitly has is_national=true.
  // We intentionally do NOT skip when state is null/empty — a missing state column
  // is not the same as "national".
  if (profileState && !opportunity.is_national) {
    const titleStateAbbr = extractStateNameFromTitle(opportunity.title || '')
    if (titleStateAbbr) {
      const profileStateAbbr = normalizeState(profileState.toLowerCase())
      const titleStateAbbrLower = titleStateAbbr.toLowerCase()
      if (profileStateAbbr !== titleStateAbbrLower) {
        return {
          pass: false,
          reason: `Geographic mismatch: opportunity title names ${titleStateAbbr}, profile is in ${profileState.toUpperCase()}`,
        }
      }
    }
  }


  // ── 7. Already-Enrolled Programs ──────────────────────────────────────────
  const govAssistance = profileData.government_assistance || {}
  const alreadyEnrolled = []
  if (govAssistance.medicaid_enrolled || govAssistance.medicaid || (profileData.insurance_provider || '').toLowerCase() === 'medicaid') alreadyEnrolled.push('medicaid')
  if (govAssistance.snap_recipient || govAssistance.snap) alreadyEnrolled.push('snap')
  if (govAssistance.ssi_recipient || govAssistance.ssi) alreadyEnrolled.push('ssi')
  if (govAssistance.ssdi_recipient || govAssistance.ssdi) alreadyEnrolled.push('ssdi')
  if (govAssistance.tanf_recipient || govAssistance.tanf) alreadyEnrolled.push('tanf')
  if (govAssistance.medicare_recipient || govAssistance.medicare) alreadyEnrolled.push('medicare')

  const alreadyEnrolledPattern = /\b(medicaid:? contact|enroll in medicaid|medicaid application|tenncare enrollment)\b/i
  if (alreadyEnrolledPattern.test(oppText) && alreadyEnrolled.includes('medicaid')) {
    return { pass: false, reason: 'Already enrolled: profile already on Medicaid' }
  }
  const snapEnrollPat = /\b(snap \(supplemental|supplemental nutrition assistance program\))\b/i
  if (snapEnrollPat.test(oppText) && alreadyEnrolled.includes('snap')) {
    return { pass: false, reason: 'Already enrolled: profile already receives SNAP' }
  }
  const ssiEnrollPat = /\b(ssi \(supplemental security|supplemental security income\))\b/i
  if (ssiEnrollPat.test(oppText) && alreadyEnrolled.includes('ssi')) {
    return { pass: false, reason: 'Already enrolled: profile already receives SSI' }
  }
  const ssdiEnrollPat = /\b(ssdi \(social security disability|social security disability insurance\))\b/i
  if (ssdiEnrollPat.test(oppText) && alreadyEnrolled.includes('ssdi')) {
    return { pass: false, reason: 'Already enrolled: profile already receives SSDI' }
  }
  const tanfEnrollPat = /\b(tanf \(temporary assistance|temporary assistance for needy families\))\b/i
  if (tanfEnrollPat.test(oppText) && alreadyEnrolled.includes('tanf')) {
    return { pass: false, reason: 'Already enrolled: profile already receives TANF' }
  }

  // ── 8. Workforce Training for Unable-to-Work Profiles ─────────────────────
  const isUnableToWork = profileData.unable_to_work === true || profileData.unable_to_work === 'yes' || /not able to work|unable to work|cannot work/i.test(String(profileData.employment_notes || '')) || /disabled|unable/i.test(String(profileData.employment_status || ''))
  const workforcePattern = /\b(workforce (training|innovation|development)|wioa\b|vocational rehabilitation|job training|employment training|career training|license reinstatement|job center|american job center|hpog|health profession opportunity)\b/i
  if (workforcePattern.test(oppText) && isUnableToWork) {
    return { pass: false, reason: 'Employment mismatch: workforce training program but profile indicates unable to work' }
  }

  // ── 9. Children Programs for Childless Senior Households ──────────────────
  const hasChildren = profileData.has_children === true || Number(profileData.number_of_children) > 0 || profileData.household_members_under_18 > 0
  const childProgramPattern = /\b(head start|early head start|child care assistance|ccdf|ccdbg|wic \(women|women,? infants,? and children|cover ?kids|first responder children)\b/i
  const isSenior = (profileData.age_group || '').toLowerCase().includes('senior') || Number(profileData.age) >= 55
  if (childProgramPattern.test(oppText) && !hasChildren && isSenior) {
    return { pass: false, reason: 'Household mismatch: children-required program for childless senior household' }
  }

  // ── 10. Broad Blind/Vision Programs ───────────────────────────────────────
  const broadBlindPat = /\b(national federation of the blind|american foundation for the blind|for the blind|blindness (program|assistance|support)|blind.{0,10}(assistance|program|resource|support))\b/i
  if (broadBlindPat.test(oppText)) {
    const dText = JSON.stringify(profileData.disability_status || '').toLowerCase()
    if (!dText.includes('blind') && !dText.includes('visual') && !dText.includes('vision') && !(Array.isArray(profileData.tags) && profileData.tags.some(t => /blind|visual|vision/i.test(String(t))))) {
      return { pass: false, reason: 'Disability mismatch: blindness program, no visual impairment in profile' }
    }
  }

  // ── 11. Broad Nursing/Healthcare Professional Programs ────────────────────
  const broadNursingPat = /\b(ncsbn|national council of state boards|american nurses association|nurse (re.?entry|recovery|remediation)|nursing (workforce|scholarship|recovery|reinstatement)|probe.{0,5}(ethics|professional)|professional boundaries.{0,5}ethics|ana foundation.{0,10}nurs)\b/i
  if (broadNursingPat.test(oppText)) {
    const empText = JSON.stringify(profileData.employment || '').toLowerCase()
    const eduText = JSON.stringify(profileData.education || '').toLowerCase()
    if (!empText.includes('nurs') && !eduText.includes('nurs') && !(Array.isArray(profileData.tags) && profileData.tags.some(t => String(t).toLowerCase().includes('nurs')))) {
      return { pass: false, reason: 'Professional mismatch: nursing program, no nursing background in profile' }
    }
  }

  // ── 12. Native/Indigenous Programs for Non-Native Profiles ────────────────
  const nativePat = /\b(native cdfi|indigenous business|native american (business|grant|program)|tribal (grant|program|business)|bureau of indian affairs)\b/i
  if (nativePat.test(oppText)) {
    const hasNative = (profileData.ethnicity && /native|indigenous|tribal|indian|alaska.?native/i.test(String(profileData.ethnicity))) || (Array.isArray(profileData.tags) && profileData.tags.some(t => /native|indigenous|tribal/i.test(String(t))))
    if (!hasNative) {
      return { pass: false, reason: 'Demographic mismatch: Native/Indigenous program, no Native indicator in profile' }
    }
  }

  // ── 13. Referral Directories (Not Funding Sources) ────────────────────────
  const directoryPat = /\b(benefits\.gov|211\.org|tennessee 211|connect to help|resource directory|benefit (finder|screener))\b/i
  if (directoryPat.test(oppText) && !opportunity.application_url) {
    return { pass: false, reason: 'Not a funding source: resource is an info directory, not direct funding' }
  }

  // ── 14. AmeriCorps Institutional Grants for Individuals ───────────────────
  const ameriCorpsInstPat = /\b(americorps (state|national).{0,20}(grant|competition)|americorps.{0,10}(competitive|grant).{0,10}(organization|nonprofit))\b/i
  if (ameriCorpsInstPat.test(oppText) && !isNonprofitProfile && !isBusinessProfile) {
    return { pass: false, reason: 'Entity mismatch: AmeriCorps institutional grant for individual profile' }
  }

  // ── 15. Wrong City for Geo-Located Resources ──────────────────────────────
  const profileCity = (profileData.city || '').toLowerCase().trim()
  if (profileCity) {
    const nearMatch = (opportunity.title || '').match(/near\s+([A-Za-z\s]+),\s*([A-Z]{2})/i)
    if (nearMatch) {
      const oppCity = nearMatch[1].trim().toLowerCase()
      const oppSt = nearMatch[2].trim().toLowerCase()
      const profSt = (profileData.state || '').toLowerCase()
      if (oppSt === profSt && oppCity !== profileCity && oppCity.substring(0, 4) !== profileCity.substring(0, 4)) {
        return { pass: false, reason: 'Geographic mismatch: resource near ' + nearMatch[1].trim() + ' but profile in ' + profileData.city }
      }
    }
  }

  return { pass: true }
}

/**
 * Extract a 2-letter state abbreviation from an address value that may be a
 * plain string ("123 Main St, Nashville, TN 37201") or an object ({ state: 'TN' }).
 */
function extractStateFromAddress(addr) {
  if (!addr) return null
  if (typeof addr === 'object') return addr.state || null
  if (typeof addr === 'string') {
    const m = addr.match(/\b([A-Z]{2})\s*,?\s*\d{5}/)
    return m ? m[1] : null
  }
  return null
}

/**
 * Extract a flat profileData object from a profileContext (as used by
 * comprehensiveCrawler, opportunityMatcher, realCrawlers).
 *
 * All fields default to safe values so the filter is no-op when data is missing.
 */
export function extractProfileData(profileContext) {
  if (!profileContext) return {}
  const profile = profileContext.profile || {}
  const sections = profileContext.sections || {}

  const basic = sections.basic_information || {}
  const demographics = sections.demographics || {}
  const military = sections.military_service || {}
  const health = sections.health_medical || {}
  const employment = sections.employment || {}
  const education = sections.education || {}
  const comprehensive = sections.comprehensive_application || {}

  const family = sections.family_life || {}

  return {
    primary_type:
      profile.primary_type ||
      comprehensive.applicant_type ||
      null,
    age:
      basic.age ||
      demographics.age ||
      null,
    gender:
      basic.gender ||
      demographics.gender ||
      null,
    veteran_status:
      demographics.veteran_status ||
      military.veteran ||
      null,
    disability_status:
      demographics.disability_status ||
      health.disability_type ||
      null,
    immigrant_status:
      demographics.immigrant_status ||
      null,
    foster_youth:
      family.foster_youth ||
      null,
    first_responder:
      null,
    employment,
    education,
    state:
      profile.state ||
      basic.state ||
      sections.location_focus?.state ||
      extractStateFromAddress(basic.address) ||
      extractStateFromAddress((sections.comprehensive_application || {}).address) ||
      null,
    tags: profile.tags || [],
    government_assistance: sections.government_assistance || {},
    insurance_provider: (sections.medical_insurance || {}).insurance_provider || null,
    unable_to_work: (employment.notes || '').toLowerCase().includes('not able to work') || 
      (employment.notes || '').toLowerCase().includes('unable to work') ||
      (employment.current_status || '').toLowerCase().includes('disabled'),
    employment_notes: employment.notes || null,
    employment_status: employment.current_status || null,
    has_children: Number((sections.household_details || {}).household_size || 0) > 2 || 
      (family.has_children === true) || Number(family.number_of_children || 0) > 0,
    number_of_children: family.number_of_children || 0,
    household_members_under_18: family.members_under_18 || 0,
    age_group: demographics.age_group || null,
    ethnicity: demographics.ethnicity || null,
    city: basic.city || (typeof basic.address === 'object' ? basic.address.city : null) || null,

  }
}
