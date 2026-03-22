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
    const hasImmigrantIndicator = Boolean(
      profileData.immigrant_status &&
        profileData.immigrant_status !== 'no' &&
        profileData.immigrant_status !== 'false' &&
        profileData.immigrant_status !== false,
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
  const universitySpecificPattern =
    /\b(university\s*—|college\s*—|institutional scholarship|college.{0,15}financial aid|university.{0,15}financial aid|college.{0,15}housing|university.{0,15}housing|off.campus resources)\b/i
  if (universitySpecificPattern.test(oppText) && !isStudentProfile) {
    return { pass: false, reason: 'Entity type mismatch: university/college-specific program for non-student profile' }
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

  // IDD-specific programs
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
    if (
      profileData.disability_status !== undefined &&
      profileData.disability_status !== null &&
      !hasIddIndicator
    ) {
      return { pass: false, reason: 'Disability mismatch: IDD-specific program, no IDD indicators in profile' }
    }
  }

  // Blind/visually-impaired specific
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
    if (
      profileData.disability_status !== undefined &&
      profileData.disability_status !== null &&
      !hasVisualImpairment
    ) {
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

  return { pass: true }
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
      null,
    tags: profile.tags || [],
  }
}
