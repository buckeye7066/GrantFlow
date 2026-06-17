/**
 * robertProfileDemandPlanner.js
 *
 * Turns a profile context (output of `loadProfileContext`) into a
 * structured "demand" object Robert can plan against. This is a PURE
 * function — no DB writes, no network — so unit tests can drive it
 * with hand-shaped fixtures.
 *
 * The shape mirrors what canonical signals already expose, but
 * Robert pulls only the fields it needs for query generation.
 */

const STATE_ABBREV_MAP = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR',
  california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS',
  kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM',
  'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND',
  ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA',
  'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV',
  wisconsin: 'WI', wyoming: 'WY',
}

export function buildProfileDemand(ctx, { signals = null } = {}) {
  if (!ctx) return null
  const profile = ctx.profile || {}
  const sections = ctx.sections || {}
  const sig = signals || ctx.signals || {}

  const applicantType = pickApplicantType(profile, sections, sig)
  const location = pickLocation(profile, sections, sig)
  const needs = uniq([
    ...(Array.isArray(profile.tags) ? profile.tags : []),
    ...(Array.isArray(sig?.needCategories) ? sig.needCategories : []),
    ...(Array.isArray(sections?.programs_services?.needs) ? sections.programs_services.needs : []),
  ]).filter(Boolean)

  const demographics = sections.demographics || sections.basic_information || {}
  const familyContext = sections.family || {}
  const housing = sections.housing || {}
  const employment = sections.employment || {}
  const education = sections.education || {}
  const ministry = sections.ministry || {}
  const orgDetails = sections.organization_details || {}
  const nonprofitCompliance = sections.nonprofit_compliance || {}
  const business = sections.small_business_details || {}
  const programs = sections.programs_services || {}

  return {
    profile_id: profile.id,
    display_name: profile.display_name || profile.organization_name || 'Profile',
    primary_type: applicantType,
    location,
    needs,
    demographics: {
      is_veteran: pickBool(demographics, ['is_veteran', 'veteran']),
      is_disabled: pickBool(demographics, ['has_disability', 'is_disabled']),
      is_caregiver: pickBool(familyContext, ['is_caregiver']) || Boolean(familyContext?.dependents_count),
      is_student: applicantType?.includes('student') === true,
      is_first_responder: ['volunteer_fire_department', 'fire_department', 'first_responder'].includes(applicantType),
      household_size: Number(familyContext?.household_size) || null,
      income_band: familyContext?.income_band || demographics?.income_band || null,
    },
    organization: {
      type: applicantType,
      ein: orgDetails?.ein || nonprofitCompliance?.ein || null,
      is_501c3: Boolean(nonprofitCompliance?.is_501c3),
      employees: Number(orgDetails?.employees) || null,
    },
    business: {
      industry: business?.industry || null,
      employees: Number(business?.employees) || null,
      revenue_band: business?.revenue_band || null,
    },
    ministry: {
      denomination: ministry?.denomination || null,
      congregation_size: Number(ministry?.congregation_size) || null,
      programs: Array.isArray(ministry?.programs) ? ministry.programs : [],
    },
    education: {
      level: education?.level || education?.school_level || null,
      institution: education?.institution || education?.school_name || null,
      major: education?.major || education?.field_of_study || null,
      gpa: Number(education?.gpa) || null,
      pell_eligible: Boolean(education?.pell_eligible),
      first_generation: Boolean(education?.first_generation),
    },
    employment: {
      employer: employment?.employer || null,
      title: employment?.job_title || null,
      employment_status: employment?.status || null,
    },
    housing: {
      situation: housing?.situation || housing?.status || null,
      county: housing?.county || null,
    },
    programs: {
      target_population: programs?.target_population || null,
      services: Array.isArray(programs?.services) ? programs.services : [],
    },
    requested_amount: Number(profile.requested_amount || sections?.financial?.requested_amount) || null,
    urgency: programs?.urgency || profile?.urgency || null,
  }
}

function pickApplicantType(profile, sections, signals) {
  return (
    signals?.entityType ||
    profile?.primary_type ||
    profile?.profile_type ||
    sections?.basic_information?.profile_type ||
    null
  )
}

function pickLocation(profile, sections, signals) {
  const stateRaw = profile?.state || sections?.location_focus?.state || sections?.basic_information?.state || signals?.state || null
  const state = stateRaw ? normalizeState(stateRaw) : null
  return {
    state,
    county: profile?.county || sections?.location_focus?.county || sections?.basic_information?.county || null,
    city: profile?.city || sections?.location_focus?.city || sections?.basic_information?.city || null,
    zip: profile?.zip || profile?.zip_code || sections?.basic_information?.zip || null,
    rural: pickBool(sections?.location_focus, ['is_rural', 'rural']) ||
           pickBool(sections?.basic_information, ['is_rural', 'rural']) || null,
  }
}

function normalizeState(value) {
  if (!value) return null
  const v = String(value).trim()
  if (v.length === 2) return v.toUpperCase()
  const lower = v.toLowerCase()
  return STATE_ABBREV_MAP[lower] || v
}

function pickBool(obj, keys) {
  if (!obj || typeof obj !== 'object') return false
  for (const k of keys) {
    if (k in obj && obj[k] !== null && obj[k] !== undefined && obj[k] !== '') {
      const v = obj[k]
      if (typeof v === 'boolean') return v
      if (typeof v === 'string') return /^(1|true|yes|y|on)$/i.test(v.trim())
      if (typeof v === 'number') return v > 0
    }
  }
  return false
}

function uniq(arr) {
  const seen = new Set()
  const out = []
  for (const x of arr) {
    const k = String(x).toLowerCase()
    if (!seen.has(k)) { seen.add(k); out.push(x) }
  }
  return out
}

export const __testing__ = { normalizeState, pickApplicantType, pickLocation }
