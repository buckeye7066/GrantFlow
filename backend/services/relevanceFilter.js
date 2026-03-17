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

  // Veteran-required grants — only block if profile explicitly has no veteran status
  const veteranRequiredPattern =
    /\b(veterans? only|must be a veteran|veteran status required|active duty only|service members only)\b/i
  if (veteranRequiredPattern.test(oppText)) {
    // Only block when we have explicit confirmation the profile is not a veteran
    const explicitNonVeteran =
      profileData.veteran_status === 'no' ||
      profileData.veteran_status === false ||
      profileData.veteran_status === 'false' ||
      profileData.veteran_status === 'non-veteran'
    if (explicitNonVeteran) {
      return { pass: false, reason: 'Demographic mismatch: veteran-only program for non-veteran profile' }
    }
  }

  // Refugee/resettlement specific — only block if profile has no immigrant indicator
  const refugeePattern =
    /\b(refugee resettlement|resettlement only|for refugees only|newly arrived immigrants? only)\b/i
  if (refugeePattern.test(oppText)) {
    const hasImmigrantIndicator = Boolean(
      profileData.immigrant_status &&
        profileData.immigrant_status !== 'no' &&
        profileData.immigrant_status !== 'false' &&
        profileData.immigrant_status !== false,
    )
    if (
      profileData.immigrant_status !== undefined &&
      profileData.immigrant_status !== null &&
      !hasImmigrantIndicator
    ) {
      return { pass: false, reason: 'Demographic mismatch: refugee-specific program, no immigrant indicator in profile' }
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
