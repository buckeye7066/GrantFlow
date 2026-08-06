/**
 * profileGapInterview.js — the backend for Anya's opening interview + the login
 * gap gate + the gap-explanation email.
 *
 * The problem this closes: an empty/under-filled profile (e.g. Demo Basic Needs Persona, who
 * had only a name and phone) cannot be matched to real funding no matter how good
 * the crawlers are — there is nothing to match on. So on login, when a profile has
 * gaps, Anya must ASK for the missing pieces and the owner must get an email
 * explaining them.
 *
 * This module is PURE and unit-tested. It produces:
 *   - a prioritized list of QUESTIONS for Anya to ask (dichotomous yes/no where the
 *     answer establishes a data-derived FACET the matcher reads — disability, age,
 *     student, caregiver, veteran — plus short value questions for matching-critical
 *     gaps like location and needs), each mapping its answer to a profile section +
 *     field so the front end can persist it directly, and
 *   - a warm, Annie-voiced gap-explanation email body.
 *
 * The dichotomous facet questions write the exact fields profileNormalizer reads to
 * derive effectiveFacets, so "the information determines the type" end to end: the
 * user never picks a type, they answer about their life and the type follows.
 */

import { computeProfileCoverage } from './profileCoverage.js'
import { shouldAskProfileQuestion } from './profileKnownFacts.js'

/**
 * Dichotomous (yes/no) facet questions. Each answer populates the field that
 * profileNormalizer reads to derive an effective facet, so type + eligibility
 * follow from the answers. `writes` describes how the front end persists a YES.
 */
export const FACET_QUESTIONS = Object.freeze([
  {
    id: 'is_organization',
    type: 'yes_no',
    prompt: 'Are you applying on behalf of an organization (a nonprofit, church, business, school, or agency), rather than for yourself or your family?',
    facet: 'organization',
    writes: { section: 'basic_information', field: 'applicant_kind', yes: 'organization', no: 'individual' },
  },
  {
    id: 'has_disability',
    type: 'yes_no',
    prompt: 'Do you (or someone in your household you are applying for) have a disability or a long-term health condition?',
    facet: 'disabled',
    writes: { section: 'demographics', field: 'disability_status', yes: 'Has disability', no: 'No disability' },
  },
  {
    id: 'is_senior',
    type: 'yes_no',
    prompt: 'Are you 60 years old or older?',
    facet: 'senior',
    // A "no" must persist too ('Under 60'), or the question is re-asked on
    // every login — the duplicate-qualifier-question class.
    writes: { section: 'demographics', field: 'age_group', yes: 'Senior 60+', no: 'Under 60' },
  },
  {
    id: 'is_student',
    type: 'yes_no',
    prompt: 'Are you (or the person you are applying for) currently a student, or planning to enroll soon?',
    facet: 'student',
    writes: { section: 'education', field: 'is_student', yes: true, no: false },
  },
  {
    id: 'is_veteran',
    type: 'yes_no',
    prompt: 'Have you (or the person you are applying for) served in the military?',
    facet: 'veteran',
    // String values: buildProfileSignals reads demographics.veteran_status as
    // a STRING ('not a veteran' is recognised as an explicit no), so a boolean
    // true here silently fed nothing into matching.
    writes: { section: 'demographics', field: 'veteran_status', yes: 'Veteran', no: 'Not a veteran' },
  },
  {
    id: 'is_caregiver',
    type: 'yes_no',
    prompt: 'Are you caring for a child, an aging parent, or another dependent?',
    facet: 'caregiver',
    writes: { section: 'family_life', field: 'caregiver', yes: true, no: false },
  },
])

/**
 * Value questions for the matching-critical gaps the coverage util flags. Keyed by
 * the coverage field key; only asked when that field is missing.
 */
export const GAP_QUESTIONS = Object.freeze({
  // Location answers persist to the CANONICAL home (basic_information — what
  // readiness, field prompts, and buildProfileSignals read first), not the
  // location_focus alias that some readers never saw (an answered ZIP was
  // re-asked by the other surfaces — the duplicate-qualifier-question class).
  state: { id: 'state', type: 'text', prompt: 'Which state do you live in (or primarily serve)?', writes: { section: 'basic_information', field: 'state' } },
  city: { id: 'city', type: 'text', prompt: 'What city or town?', writes: { section: 'basic_information', field: 'city' } },
  zip: { id: 'zip', type: 'text', prompt: 'What is your ZIP code? (this unlocks local funding)', writes: { section: 'basic_information', field: 'zip' } },
  needCategories: { id: 'needs', type: 'text', prompt: 'What do you most need help with right now? (for example: housing, utilities, medical bills, food, education, disability support, emergency assistance)', writes: { section: 'funding_needs', field: 'need_categories' } },
  // Canonical home is narrative.funding_amount_needed (PROFILE_SCHEMA), which
  // signals/keyword extraction actually read; financial_information was an
  // alias only profileFieldPrompts knew about.
  fundingAmountNeeded: { id: 'funding_amount', type: 'number', prompt: 'Roughly how much funding are you looking for?', writes: { section: 'narrative', field: 'funding_amount_needed' } },
  organizationType: { id: 'org_type', type: 'text', prompt: 'What kind of organization is it? (nonprofit, church, school, business, agency…)', writes: { section: 'organization_details', field: 'organization_type' } },
  populationServed: { id: 'population', type: 'text', prompt: 'Who do you serve?', writes: { section: 'organization_details', field: 'population_served' } },
  missionFocus: { id: 'mission', type: 'text', prompt: 'In a sentence, what is your mission or main focus?', writes: { section: 'organization_details', field: 'mission_focus' } },
  programDescriptions: { id: 'programs', type: 'text', prompt: 'Briefly, what programs or services do you run?', writes: { section: 'programs_services', field: 'program_descriptions' } },
})

/** True once a FACET question has already been answered (either way) in the data. */
function facetAnswered(q, normalized, sections) {
  const sec = sections?.[q.writes.section]
  const data = sec?.answers ?? sec ?? null
  const has = (obj, field) => obj && typeof obj === 'object' &&
    obj[field] !== undefined && obj[field] !== null && String(obj[field]).length > 0
  switch (q.id) {
    case 'has_disability': return Boolean(normalized?.hasDisabilityNeed) || has(data, 'disability_status')
    case 'is_senior': return (normalized?.effectiveFacets || []).includes('senior') || has(data, 'age_group')
    case 'is_student': return Boolean(normalized?.isStudent) || has(data, 'is_student')
    case 'is_veteran': return Boolean(normalized?.isVeteran) || has(data, 'veteran_status')
    case 'is_caregiver': return Boolean(normalized?.isCaregiver) || has(data, 'caregiver') || has(data, 'is_caregiver')
    case 'is_organization': return has(data, 'applicant_kind') ||
      (normalized?.effectiveFacets || []).some((f) => ['nonprofit', 'business'].includes(f))
    default: return false
  }
}

/**
 * buildProfileGapPlan — PURE. Given a normalized profile + raw sections, decide
 * whether the profile is complete enough, and if not, produce the ordered
 * questions Anya should ask and a gap-explanation email.
 *
 * @param {object} normalized  output of normalizeProfile
 * @param {object} [sections]  raw sections map
 * @param {object} [opts]
 * @param {number} [opts.minCoverage=0.5]  below this, the profile is "incomplete"
 * @param {number} [opts.maxQuestions=8]
 * @param {string} [opts.displayName]
 * @param {object} [opts.profile]  raw profile row — lets the known-facts gate
 *   resolve the org/person side from the declared type
 */
export function buildProfileGapPlan(normalized, sections = {}, opts = {}) {
  const minCoverage = Number.isFinite(opts.minCoverage) ? opts.minCoverage : 0.5
  const maxQuestions = Number.isFinite(opts.maxQuestions) ? opts.maxQuestions : 8
  const displayName = opts.displayName || normalized?.display_name || 'there'

  const coverage = computeProfileCoverage(normalized, sections)

  // Known-facts choke point (profileKnownFacts.js): never ask a question the
  // profile already answers under ANY alias spelling, and never ask a
  // person-demographic question of an organization (or an org question of an
  // individual). facetAnswered stays as the facet-specific first line;
  // shouldAskProfileQuestion is the net across all alias locations + the
  // org/person applicability matrix.
  const factCtx = { profile: opts.profile ?? null, sections, normalized }

  // Unanswered dichotomous facet questions first — they establish the type from
  // data (no manual type pick), and they are quick yes/no.
  const facetQs = FACET_QUESTIONS.filter(
    (q) => !facetAnswered(q, normalized, sections) && shouldAskProfileQuestion(q.id, factCtx),
  )

  // Then the matching-critical value gaps, worst (highest weight) first.
  const missing = (coverage.fieldSignals || [])
    .filter((f) => !f.present && GAP_QUESTIONS[f.key] && shouldAskProfileQuestion(f.key, factCtx))
    .sort((a, b) => (b.weight || 0) - (a.weight || 0))
  const gapQs = missing.map((f) => ({ ...GAP_QUESTIONS[f.key], label: f.label, weight: f.weight }))

  const questions = [...facetQs, ...gapQs].slice(0, maxQuestions)

  const complete = coverage.coverage >= minCoverage && facetQs.length === 0
  const missingLabels = [
    ...facetQs.map((q) => q.prompt.replace(/\?.*$/, '').replace(/^(Are|Do|Have)\b/, 'whether you').toLowerCase()),
    ...missing.map((f) => String(f.label || f.key).toLowerCase()),
  ]

  return {
    complete,
    coverage: coverage.coverage,
    completeness: coverage.completeness,
    needs_questions: questions.length > 0,
    questions,
    missing_fields: missing.map((f) => ({ key: f.key, label: f.label, section: f.section, weight: f.weight })),
    email: complete ? null : buildGapEmail({ displayName, questions, missingLabels }),
  }
}

/**
 * buildGapEmail — a warm, Annie-voiced note explaining what is missing and why it
 * matters, and inviting the owner to finish with Anya. Consistent with the John →
 * Annie outreach identity. Plain text; the caller adds the CTA link.
 */
export function buildGapEmail({ displayName = 'there', questions = [], missingLabels = [] } = {}) {
  const topLabels = missingLabels.slice(0, 5)
  const bullets = topLabels.map((l) => `  - ${l}`).join('\n')
  const subject = 'A few quick questions to unlock funding matches for you'
  const body = [
    `Hello ${displayName},`,
    '',
    'I am Annie, from GrantFlow. I would love to start finding funding that fits you, but your profile is missing a few details that the search really depends on. Right now there is not quite enough for me to match you well, so I would rather ask than guess.',
    '',
    'When you next sign in, I will walk you through a short set of questions (mostly yes or no). The biggest things I still need to know:',
    '',
    bullets || '  - a little more about your situation and needs',
    '',
    'It takes just a couple of minutes, and the more you tell me, the more real, eligible funding I can surface for you, instead of generic results. Nothing here is shared outside your account.',
    '',
    'Warmly,',
    'Annie',
    'GrantFlow (founded by Dr. John White at Axiom BioLabs)',
    'Annie@axiombiolabs.org',
  ].join('\n')
  return { subject, body, question_count: questions.length }
}

export default { buildProfileGapPlan, buildGapEmail, FACET_QUESTIONS, GAP_QUESTIONS }
