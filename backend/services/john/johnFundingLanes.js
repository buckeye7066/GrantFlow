/**
 * John — funding lanes.
 *
 * Pure lookup, no I/O. Maps what we actually KNOW about an organization (its
 * type, mission, focus/program areas, and evidence text) to the categories of
 * funding GrantFlow would genuinely surface for an org like it. This is what
 * lets the email say something a fire chief or a food-pantry director will
 * recognize as written for THEM ("AFG, state fire commission awards…") instead
 * of the same generic "grants and foundation programs" sentence for everyone.
 *
 * Honesty contract (never weaken):
 *   - Each lane names CATEGORIES of funders/programs that exist for that
 *     sector. It never promises a match, an award, or eligibility.
 *   - The `observation` line is a general truth about the sector's funding
 *     reality, never a fabricated fact about the specific organization.
 *   - No statistics, no testimonials, no customer counts.
 *
 * Matching order matters: the organization_type is the strongest signal and is
 * checked for every lane first; evidence/mission text is the fallback. Lanes
 * earlier in the list win ties (e.g. "rescue squad" hits fire, not animal).
 */

const LANES = [
  {
    key: 'fire_ems',
    subjectLead: 'Fire and EMS grant options',
    typeRe: /\bfire\b|firefight|\bvfd\b|\bems\b|ambulance|rescue squad|first responder|public.?safety/i,
    textRe: /\bscba\b|turnout gear|fire (station|engine|truck|apparatus)|firefight|\bapparatus\b|extrication/i,
    categories:
      'federal firefighter assistance programs (like AFG), state fire commission awards, and equipment and safety funders',
    observation: 'Gear, apparatus, and training needs do not wait for a budget cycle to catch up.',
  },
  {
    key: 'faith',
    subjectLead: 'Ministry and outreach funding options',
    typeRe: /church|ministr|congregation|parish|\bfaith\b|worship|diocese|synagogue|mosque|chapel/i,
    textRe: /\bministry\b|congregation|worship|faith.based|\bsermon\b|\bparish\b/i,
    categories:
      'faith-based and congregational funders, community foundations, and grants for outreach and ministry programs',
    observation: 'Ministry needs have a way of growing faster than offerings do.',
  },
  {
    key: 'food_security',
    subjectLead: 'Food security funding options',
    typeRe: /food (pantry|bank)|\bpantry\b|hunger|soup kitchen|feeding|meal (program|ministry)/i,
    textRe: /food (in)?security|food (pantry|bank|distribution)|hunger|feeding program|nutrition program|meals? (for|to)\b/i,
    categories:
      'food security funders, hunger relief foundations, and community foundations that back feeding and nutrition programs',
    observation: 'Demand at the door rarely waits for a funding cycle.',
  },
  {
    key: 'veterans',
    subjectLead: 'Veteran services funding options',
    typeRe: /veteran|\bvfw\b|american legion/i,
    textRe: /\bveterans?\b|service members?|military famil/i,
    categories:
      'veteran-focused foundations, service organization grant programs, and state and federal veteran benefit programs',
    observation: 'The mission is steady; the funding rarely is.',
  },
  {
    key: 'scholarship',
    subjectLead: 'Scholarship and education funding options',
    typeRe: /\bstudent\b|scholarship/i,
    textRe: /scholarship|tuition|college (fund|cost|savings)|\bfafsa\b/i,
    categories: 'scholarships, endowment awards, and education benefit programs',
    observation: 'The cost of education moves faster than most family budgets.',
  },
  {
    key: 'education',
    subjectLead: 'Education funding options',
    typeRe: /school|academy|\bpto\b|\bpta\b|booster|classroom|educat/i,
    textRe: /classroom|teachers?\b|after.?school|literacy|\bstem\b|curriculum|tutoring/i,
    categories: 'education foundations, classroom and program grants, and state education funds',
    observation: 'Classroom needs rarely match the budget line meant to cover them.',
  },
  {
    key: 'youth',
    subjectLead: 'Youth program funding options',
    typeRe: /youth|mentoring|boys? (and|&) girls/i,
    textRe: /\byouth\b|mentor(ing|ship)|young people/i,
    categories:
      'youth development funders, mentoring and after-school program grants, and community foundations',
    observation: 'Youth work is long-term; most funding is not.',
  },
  {
    key: 'health',
    subjectLead: 'Community health funding options',
    typeRe: /clinic|health|medical|hospice|counseling|mental.?health|recovery/i,
    textRe: /patients?\b|\bclinic\b|health (care|services|screening)|treatment|counseling|recovery program/i,
    categories: 'health foundations, community health program grants, and access and prevention funders',
    observation: 'Care needs do not schedule themselves around grant cycles.',
  },
  {
    key: 'housing',
    subjectLead: 'Housing and shelter funding options',
    typeRe: /housing|homeless|habitat|transitional (housing|living)/i,
    textRe: /housing|homeless|shelter (beds|nights|capacity)|eviction|re.?hous/i,
    categories:
      'housing funders, homelessness and shelter program grants, and community development funds',
    observation: 'The need for a safe place to sleep never pauses for a budget year.',
  },
  {
    key: 'animal_welfare',
    subjectLead: 'Animal welfare funding options',
    typeRe: /animal|humane|\bspca\b|wildlife/i,
    textRe: /animals?\b|adoption program|spay|neuter|wildlife|kennel/i,
    categories: 'animal welfare foundations and shelter, rescue, and adoption program grants',
    observation: 'The animals keep coming whether or not the funding does.',
  },
  {
    key: 'arts_culture',
    subjectLead: 'Arts and culture funding options',
    typeRe: /\barts?\b|museum|theat(er|re)|\bmusic\b|cultural|library|orchestra|choir/i,
    textRe: /exhibit|performance|\bconcert\b|gallery|arts education|collection/i,
    categories:
      'state and local arts councils, cultural foundations, and program and operating grants for arts organizations',
    observation: 'Seasons get planned long before the funding to mount them is certain.',
  },
  {
    key: 'environment',
    subjectLead: 'Conservation funding options',
    typeRe: /environment|conservation|watershed|land trust|\bparks?\b|trails?\b/i,
    textRe: /conservation|habitat restoration|watershed|trail (network|system|maintenance)|river cleanup|reforestation/i,
    categories:
      'environmental and conservation funders, land and water program grants, and community foundations',
    observation: 'Stewardship is patient work; funding cycles are not.',
  },
  {
    key: 'small_business',
    subjectLead: 'Small business funding options',
    typeRe: /small business|business|entrepreneur|startup|\bfarm\b|cooperative/i,
    textRe: /small business|entrepreneur|storefront|main street|farm operation/i,
    categories:
      'small business grant programs, local and state economic development funds, and industry-specific programs',
    observation: 'Growing a business means funding it long before it pays for itself.',
  },
]

/** Everything the generic path says when no lane matches. */
export const DEFAULT_FUNDING_FRAME = Object.freeze({
  key: null,
  subjectLead: null,
  categories:
    'grants, foundation programs, and other funding that genuinely fits',
  observation: null,
})

function laneHaystack(parts) {
  return parts
    .flat()
    .map((p) => (p === null || p === undefined ? '' : String(p)))
    .filter(Boolean)
    .join(' • ')
}

/**
 * Match a lead (via its extracted signals) to a funding lane.
 *
 * @param {object} lead - the Yana lead packet (organization_type is read here)
 * @param {object} signals - output of extractOrgSignals(lead)
 * @returns {{key, subjectLead, categories, observation}|null} null when nothing matches
 */
export function matchFundingLane(lead, signals = {}) {
  const typeHay = laneHaystack([lead?.organization_type, lead?.suggested_persona])
  const textHay = laneHaystack([
    signals.mission,
    signals.focusAreas || [],
    signals.programAreas || [],
    signals.hookText,
    signals.websiteExcerpt,
    lead?.funding_need_summary,
    lead?.recommended_outreach_angle,
    lead?.organization_name,
  ])

  // Pass 1: the org's declared type is the strongest signal.
  if (typeHay) {
    for (const lane of LANES) {
      if (lane.typeRe.test(typeHay)) return lane
    }
  }
  // Pass 2: fall back to what the evidence text says they actually do.
  if (textHay) {
    for (const lane of LANES) {
      if (lane.textRe.test(textHay)) return lane
    }
  }
  return null
}

export const FUNDING_LANES = Object.freeze(LANES.map((l) => l.key))

export default { matchFundingLane, DEFAULT_FUNDING_FRAME, FUNDING_LANES }
