/**
 * robertSearchPlanner.js
 *
 * Generates structured search plans from a profile demand object
 * (output of robertProfileDemandPlanner). Each plan has:
 *   { profile_id, applicant_type, location_scope, need_category,
 *     search_query, source_types, trusted_domains, exclude_terms,
 *     expected_evidence, priority, reason }
 *
 * The planner is PURE — it produces query plans only; it never
 * touches the network.
 */

import { makeSearchPlan } from './robertTypes.js'

const COMMON_EXCLUDES = [
  'loan', 'loans', 'matching funds', 'cost share',
  'sample resume', 'how to apply', 'site:youtube.com',
]

const NEED_QUERY_TEMPLATES = {
  housing: ['{type} housing assistance grant {geo}', '{type} home repair grant {geo}', '{type} rental assistance grant {geo}'],
  capital_improvement: ['{type} capital improvement grant {geo}', '{type} building repair grant {geo}', '{type} facility renovation grant {geo}'],
  equipment: ['{type} equipment grant {geo}', '{type} new equipment funding {geo}'],
  education: ['{type} scholarship {geo}', '{type} tuition grant {geo}', '{type} living expenses scholarship {geo}'],
  health: ['{type} medical assistance grant {geo}', '{type} health emergency fund {geo}'],
  food: ['{type} food assistance grant {geo}', '{type} food pantry equipment grant {geo}'],
  utility: ['{type} utility assistance program {geo}', '{type} energy bill help {geo}'],
  transportation: ['{type} transportation assistance grant {geo}'],
  emergency: ['{type} emergency assistance grant {geo}', '{type} disaster recovery grant {geo}'],
  research: ['{type} research grant {geo}'],
  business: ['{type} small business grant {geo}', '{type} startup grant {geo}'],
  community: ['{type} community grant {geo}', '{type} community foundation grant {geo}'],
  ministry: ['{type} faith-based grant {geo}', '{type} ministry outreach grant {geo}'],
  general: ['{type} grant {geo}', '{type} foundation grant {geo}'],
}

const APPLICANT_TYPE_QUERY_HINTS = {
  volunteer_fire_department: ['volunteer fire department equipment grant', 'turnout gear grant', 'fire department capital improvement grant'],
  fire_department: ['fire department equipment grant', 'AFG SAFER grant', 'firefighter training grant'],
  first_responder: ['first responder grant', 'EMS equipment grant'],
  church: ['church repair grant foundation', 'church capital improvement grant', 'church program grant'],
  ministry: ['ministry outreach grant foundation', 'faith-based community grant'],
  nonprofit: ['nonprofit operating grant foundation', 'community nonprofit grant'],
  small_business: ['small business equipment grant', 'rural small business grant', 'minority business grant'],
  business: ['business growth grant foundation'],
  school: ['school facility grant', 'school program grant foundation'],
  university: ['university research grant'],
  student: ['scholarship application student'],
  college_student: ['college scholarship application'],
  graduate_student: ['graduate fellowship', 'graduate research grant'],
  high_school_student: ['high school scholarship'],
  individual: ['individual assistance grant', 'family emergency grant'],
  family: ['family assistance program grant'],
  caregiver: ['caregiver respite grant', 'family caregiver assistance grant'],
  veteran: ['veteran assistance grant', 'veteran housing grant'],
  disability: ['disability home modification grant', 'disability assistance grant'],
}

const SOURCE_TYPES_BY_NEED = {
  housing: ['benefits_directory', 'utility_assistance', 'private_foundation', 'community_foundation'],
  capital_improvement: ['private_foundation', 'community_foundation', 'rural_development'],
  equipment: ['fire_department_grants', 'rural_development', 'state_grant_portal', 'private_foundation'],
  education: ['education_directory', 'university_scholarship_portal', 'private_foundation'],
  health: ['benefits_directory', 'hospital_charity_care', 'private_foundation'],
  food: ['benefits_directory', 'community_foundation'],
  utility: ['utility_assistance', 'benefits_directory'],
  transportation: ['benefits_directory'],
  emergency: ['benefits_directory', 'private_foundation'],
  research: ['federal_portal', 'private_foundation'],
  business: ['federal_portal', 'state_grant_portal', 'rural_development'],
  community: ['community_foundation', 'private_foundation'],
  ministry: ['faith_based_foundation', 'community_foundation'],
  general: ['federal_portal', 'state_grant_portal', 'community_foundation', 'private_foundation'],
}

const LOCATION_SCOPES = ['city', 'county', 'state', 'national']

/**
 * Build a list of search plans for a single profile demand.
 *
 * @param {object} demand    output of buildProfileDemand
 * @param {object} [opts]
 * @param {number} [opts.maxPlans=8]
 * @param {string[]} [opts.locationScopes]
 */
export function buildSearchPlans(demand, opts = {}) {
  if (!demand) return []
  const maxPlans = Math.max(1, Math.min(50, Number(opts.maxPlans) || 8))
  const scopes = Array.isArray(opts.locationScopes) && opts.locationScopes.length > 0
    ? opts.locationScopes.filter((s) => LOCATION_SCOPES.includes(s))
    : LOCATION_SCOPES

  const applicantType = demand.primary_type || 'individual'
  const typeWord = humanizeType(applicantType)
  const needs = (demand.needs && demand.needs.length > 0) ? demand.needs : ['general']

  const out = []

  // ── Targeted, identity-specific plans (HIGHEST priority) ────────────────────
  // The generic templates above search by applicant-type + need + geo only, so a
  // hyper-local, role/employer/school-specific award (e.g. "Bradley County EMS
  // scholarship for paramedics at Cleveland State Community College") is NEVER
  // searched. These plans inject the profile's employer, school, occupation, and
  // major — the signals that actually surface niche local funding — so discovery
  // looks for the real thing instead of "<type> grant <geo>" boilerplate.
  out.push(...buildTargetedPlans(demand, applicantType))
  for (const need of needs) {
    const templates = NEED_QUERY_TEMPLATES[need] || NEED_QUERY_TEMPLATES.general
    for (const scope of scopes) {
      const geo = formatGeo(demand.location, scope)
      const priorityForScope = priorityFromScope(scope, demand)
      for (const template of templates) {
        const search_query = template
          .replace('{type}', typeWord)
          .replace('{geo}', geo)
          .replace(/\s+/g, ' ')
          .trim()
        out.push(makeSearchPlan({
          profile_id: demand.profile_id,
          applicant_type: applicantType,
          location_scope: scope,
          need_category: need,
          search_query,
          source_types: SOURCE_TYPES_BY_NEED[need] || SOURCE_TYPES_BY_NEED.general,
          trusted_domains: defaultTrustedDomains(applicantType, need),
          exclude_terms: COMMON_EXCLUDES,
          expected_evidence: ['real .gov/.org/.edu URL', 'sponsor name', 'application instructions or link', 'eligibility text'],
          priority: priorityForScope,
          reason: `${typeWord} · ${need} · ${scope}`,
        }))
      }
    }
  }

  // Add applicant-type-specific hints (always national, low geo specificity).
  const typeHints = APPLICANT_TYPE_QUERY_HINTS[applicantType] || []
  for (const hint of typeHints) {
    out.push(makeSearchPlan({
      profile_id: demand.profile_id,
      applicant_type: applicantType,
      location_scope: 'national',
      need_category: 'general',
      search_query: `${hint} ${formatGeo(demand.location, 'national')}`.trim(),
      source_types: ['federal_portal', 'community_foundation', 'private_foundation'],
      trusted_domains: defaultTrustedDomains(applicantType, 'general'),
      exclude_terms: COMMON_EXCLUDES,
      expected_evidence: ['real funder URL', 'sponsor', 'application path'],
      priority: 40,
      reason: `applicant-type hint · ${applicantType}`,
    }))
  }

  // Sort by priority desc + clip to limit.
  return out.sort((a, b) => b.priority - a.priority).slice(0, maxPlans)
}

/**
 * Build identity-specific search plans from the profile's employer, school,
 * occupation, and major. These are the signals that surface real local/niche
 * funding (employer scholarships, school foundations, occupation-specific
 * awards) which the generic type+need+geo templates can never find.
 */
function buildTargetedPlans(demand, applicantType) {
  const plans = []
  const loc = demand.location || {}
  const stateGeo = loc.state || ''
  const cityGeo = [loc.city, loc.state].filter(Boolean).join(', ')
  const employer = cleanTerm(demand.employment?.employer)
  const title = cleanTerm(demand.employment?.title)
  const institution = cleanTerm(demand.education?.institution)
  const major = cleanTerm(demand.education?.major)

  const add = (query, reason, priority) => {
    const q = String(query || '').replace(/\s+/g, ' ').trim()
    if (!q) return
    plans.push(makeSearchPlan({
      profile_id: demand.profile_id,
      applicant_type: applicantType,
      location_scope: 'targeted',
      need_category: 'general',
      search_query: q,
      source_types: ['employer_program', 'university_scholarship_portal', 'community_foundation', 'private_foundation', 'federal_portal'],
      trusted_domains: [],
      exclude_terms: COMMON_EXCLUDES,
      expected_evidence: ['real funder/portal URL', 'sponsor name', 'eligibility text', 'application path'],
      priority,
      reason,
    }))
  }

  // Employer-sponsored aid (e.g. "Bradley County EMS scholarship").
  if (employer) {
    add(`${employer} scholarship`, `employer aid · ${employer}`, 92)
    add(`${employer} grant OR assistance fund`, `employer aid · ${employer}`, 88)
    if (title) add(`${employer} ${title} scholarship`, `employer+role · ${employer}`, 90)
  }
  // School-specific aid (e.g. "Cleveland State Community College paramedic scholarship").
  if (institution) {
    add(`${institution} scholarship ${stateGeo}`, `school aid · ${institution}`, 86)
    if (title) add(`${title} scholarship ${institution}`, `school+role · ${institution}`, 91)
    if (major) add(`${major} scholarship ${institution}`, `school+major · ${institution}`, 84)
  }
  // Occupation/role aid scoped to the user's geography (e.g. "paramedic scholarship Cleveland, TN").
  if (title) {
    add(`${title} scholarship ${cityGeo || stateGeo}`, `occupation · ${title}`, 82)
    add(`${title} training grant ${stateGeo}`, `occupation · ${title}`, 78)
  }
  // Major + geography (e.g. "Forensic Science scholarship Tennessee").
  if (major && !institution) {
    add(`${major} scholarship ${stateGeo}`, `major · ${major}`, 76)
  }
  return plans
}

function cleanTerm(value) {
  const v = String(value || '').trim()
  // Drop placeholder/unknown values so we don't search "null scholarship".
  if (!v || /^(n\/?a|none|unknown|null|undefined)$/i.test(v)) return ''
  return v
}

function priorityFromScope(scope, demand) {
  // City/county searches matter most for an individual/local org;
  // national for broad programs. Matches GrantFlow's "expand outward"
  // matching rule (city → county → state → national).
  switch (scope) {
    case 'city': return 70
    case 'county': return 65
    case 'state': return 55
    case 'national': return 40
    default: return 30
  }
}

function formatGeo(loc, scope) {
  if (!loc) return ''
  switch (scope) {
    case 'city':
      return [loc.city, loc.state].filter(Boolean).join(', ')
    case 'county':
      return [loc.county, loc.state].filter(Boolean).join(', ')
    case 'state':
      return loc.state || ''
    case 'national':
    default:
      return ''
  }
}

function humanizeType(applicantType) {
  if (!applicantType) return ''
  return String(applicantType).replace(/_/g, ' ').toLowerCase()
}

function defaultTrustedDomains(applicantType, need) {
  const base = ['grants.gov', 'benefits.gov', 'studentaid.gov']
  if (applicantType?.includes('fire')) base.push('fema.gov', 'usfa.fema.gov')
  if (need === 'education') base.push('studentaid.gov')
  if (applicantType?.includes('rural') || need === 'rural_development') base.push('rd.usda.gov')
  return base
}

export const __testing__ = { COMMON_EXCLUDES, NEED_QUERY_TEMPLATES, APPLICANT_TYPE_QUERY_HINTS, formatGeo, humanizeType, buildTargetedPlans, cleanTerm }
