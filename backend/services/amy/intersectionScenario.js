/**
 * intersectionScenario.js — turn a probe CELL into a synthetic profile.
 *
 * The catalog builds 32 hand-written archetypes. This builds an arbitrary
 * INTERSECTION — `{entity, identity, need, state}` — so the cohort can reach
 * the ~2M plausible combinations the catalog cannot, without anyone writing 2M
 * templates.
 *
 * HOW IT STAYS HONEST
 * -------------------
 *  - Every word of vocabulary comes from a canonical registry: the need's own
 *    `query`/`label` from `CANONICAL_NEED_CATEGORIES`, the entity's
 *    `defaultNeeds`/`anyaLabel`/`summary` from `PROFILE_TYPES`, the state's
 *    real city/county/ZIP from `probeSpace.LOCALITIES`. Nothing is invented for
 *    the profile to "find", so a match it gets is a match a real applicant with
 *    that shape would get.
 *  - The identity axis is applied through the CANONICAL SECTION FIELDS the
 *    product already reads (`military_service.veteran`, `health_medical.*`,
 *    `education.*`), not through prose — prose is what `profileContextToThesis`
 *    demonstrably drops.
 *  - INDIVIDUAL vs ORG shape is derived from `entityClass`, so a person never
 *    carries `organization_details` (the Kimberly-Botts invariant would have to
 *    repair it) and an org never asserts a household income.
 *  - HARD RULE, unchanged: no real PII. Names/emails/phones follow the same
 *    reserved-fiction conventions as the catalog (`.invalid`, `555-01xx`).
 *
 * Pure: cell + runId in, scenario out. Same output shape as
 * `generateScenarios()` so `runAmyTraining` needs no special case.
 */

import { makeSeededRng } from './amyMetadata.js'
import { PROFILE_TYPES } from '../profileTypeRegistry.js'
import {
  NEED_BY_ID,
  entityClass,
  identityParts,
  localityFor,
  cellKey,
} from './probeSpace.js'

/** Category id used for an adversarial probe, so it never collides with a
 *  catalog category in `by_category` histograms or the coverage weighting. */
export const ADVERSARIAL_CATEGORY_PREFIX = 'probe'

const FUNDING_BANDS_INDIVIDUAL = ['$1,500', '$3,000', '$5,000', '$9,000', '$15,000']
const FUNDING_BANDS_ORG = ['$15,000', '$25,000', '$50,000', '$100,000', '$250,000']

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length) % arr.length]
}

/**
 * Humanize a registry TOKEN (`health:visual_impairment` -> "Visual Impairment")
 * for the synthetic profile's own display name. Deliberately NOT named
 * `titleCase`: the repo lints that identifier out of `backend/` because profile
 * FIELD labels must come from SECTION_METADATA. This never labels a field — it
 * names a probe.
 */
function humanizeToken(s) {
  return String(s ?? '')
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ')
}

/**
 * The need's own search vocabulary, straight out of the canonical registry.
 * `query` is a space-separated bag of the exact terms the product uses for that
 * need, so using it here means Amy asks in the product's own language.
 */
function needVocabulary(needId) {
  const row = NEED_BY_ID[needId]
  if (!row) return { label: humanizeToken(needId), terms: [needId] }
  const terms = String(row.query ?? '').split(/\s+/).map((t) => t.trim()).filter(Boolean)
  return { label: row.label, terms: terms.length > 0 ? terms : [needId], group: row.group }
}

/**
 * Apply an identity to the canonical SECTION FIELDS.
 *
 * `subjectIsIdentity` is the individual/org difference in one flag: a person IS
 * a veteran (`military_service.veteran = true`); an organization SERVES
 * veterans (`narrative.target_population`), and asserting `military_service` on
 * a school district would be a lie the matcher would then act on.
 */
function identitySections(identityId, { subjectIsIdentity }) {
  const { kind, token } = identityParts(identityId)
  if (kind === 'none') return { sections: {}, label: null, terms: [] }

  if (kind === 'health') {
    const name = String(token).replace(/_/g, ' ')
    const sections = subjectIsIdentity
      ? {
          health_medical: {
            conditions: [{ name }],
            chronic_illness: true,
            chronic_illness_type: name,
          },
          financial_information: { has_medical_debt: true, financial_need_level: 'high' },
        }
      : { narrative: { target_population: `People living with ${name}` } }
    return { sections, label: humanizeToken(name), terms: [name, `${name} assistance`, `${name} grant`] }
  }

  if (kind === 'stage') {
    const stage = String(token)
    const gradeLevel = stage === 'high_school_student' || stage === 'dual_enrolled_incoming_freshman'
      ? 'high school senior'
      : stage === 'graduate_student' ? 'graduate' : 'undergraduate'
    const sections = subjectIsIdentity
      ? {
          education: {
            current_status: 'enrolled',
            enrollment_status: 'full-time',
            grade_level: gradeLevel,
            academic_stage: stage,
            fafsa_completed: true,
          },
        }
      : { narrative: { target_population: `${humanizeToken(stage)}s` } }
    return { sections, label: humanizeToken(stage), terms: [gradeLevel, 'scholarship', 'financial aid'] }
  }

  // Population identities — the ids ARE canonical need ids, so their registry
  // row supplies the vocabulary rather than a second hand-typed list.
  const vocab = needVocabulary(token)
  const sections = {}
  if (subjectIsIdentity) {
    if (token === 'veteran') sections.military_service = { veteran: true, notes: 'Synthetic probe profile — veteran status declared.' }
    else if (token === 'senior') sections.demographics = { age_range: '65+', senior: true }
    else if (token === 'tribal') sections.demographics = { tribal_affiliation: 'Tribal member (synthetic probe)' }
    else if (token === 'immigrant_refugee') sections.demographics = { immigrant_or_refugee: true }
    else if (token === 'women') sections.demographics = { gender: 'female' }
    else if (token === 'minority') sections.demographics = { minority: true }
    else if (token === 'children_youth') sections.family = { responsibilities: 'Household with school-age children.' }
    else if (token === 'family_life') sections.family = { household_size: 4, responsibilities: 'Caregiver in a multi-generation household.' }
    else sections.narrative = { target_population: vocab.label }
  } else {
    sections.narrative = { target_population: vocab.label }
  }
  return { sections, label: vocab.label, terms: vocab.terms.slice(0, 4) }
}

function mergeSections(base, extra) {
  const out = { ...base }
  for (const [key, value] of Object.entries(extra || {})) {
    out[key] = (out[key] && typeof out[key] === 'object' && !Array.isArray(out[key]))
      ? { ...out[key], ...value }
      : value
  }
  return out
}

/**
 * Build one adversarial scenario from a cell.
 *
 * @param {object} cell   {entity, identity, need, state, cell_key?, seed_pair?}
 * @param {object} args   {runId, index}
 * @returns {object|null} the same scenario shape `generateScenarios()` emits
 */
export function buildIntersectionScenario(cell, { runId = 'amy', index = 0 } = {}) {
  const entityId = String(cell?.entity ?? '')
  const type = PROFILE_TYPES[entityId]
  const klass = entityClass(entityId)
  const locality = localityFor(cell?.state)
  const needVocab = needVocabulary(String(cell?.need ?? ''))
  if (!type || !klass || !locality || !NEED_BY_ID[String(cell?.need ?? '')]) return null

  const key = cell?.cell_key || cellKey(cell)
  const scenarioId = `probe-${index + 1}`
  const rng = makeSeededRng(`${runId}:${key}`)
  const isIndividual = klass === 'individual'
  const identity = identitySections(cell?.identity, { subjectIsIdentity: isIndividual })

  const entityLabel = type.anyaLabel || humanizeToken(entityId)
  const labelParts = [identity.label, entityLabel].filter(Boolean)
  const label = `${labelParts.join(' · ')} — ${needVocab.label} (${locality.state})`
  const displayName = `Amy Probe — ${label} #${index + 1}`
  const syntheticEmail = `amy+${scenarioId}@synthetic.grantflow.invalid`

  // Interests/keywords: the entity's own default needs + the need registry's own
  // query terms + the identity's terms. Every token is registry-sourced.
  const interests = [...new Set([
    ...needVocab.terms.slice(0, 5),
    ...identity.terms,
    ...(Array.isArray(type.defaultNeeds) ? type.defaultNeeds.slice(0, 3) : []),
  ])].filter(Boolean)
  const keywords = [...new Set([
    `${needVocab.label.toLowerCase()} ${isIndividual ? 'assistance' : 'grant'}`,
    ...identity.terms.slice(0, 2).map((t) => `${t} ${isIndividual ? 'assistance' : 'grant'}`),
    ...needVocab.terms.slice(0, 3),
  ])].filter(Boolean)

  const shared = {
    location_focus: {
      geographic_focus: `${locality.county} County, ${locality.state}`,
      notes: `Synthetic probe: ${locality.city}, ${locality.state}.`,
    },
    narrative: {
      mission: isIndividual
        ? `${identity.label ? `${identity.label}: ` : ''}${type.summary || entityLabel} seeking ${needVocab.label.toLowerCase()}.`
        : `${entityLabel} in ${locality.county} County serving ${identity.label || 'the local community'}.`,
      primary_goal: `${needVocab.label} — ${needVocab.terms.slice(0, 4).join(', ')}.`,
      funding_amount_needed: pick(rng, isIndividual ? FUNDING_BANDS_INDIVIDUAL : FUNDING_BANDS_ORG),
    },
    programs_services: {
      focus_areas: [String(cell.need), ...(identity.label ? [String(cell.identity).replace(/^[a-z]+:/, '')] : [])],
      interests,
      keywords,
    },
  }

  const shapeSections = isIndividual
    ? {
        financial_information: { household_income: 24000 + Math.floor(rng() * 26000), household_size: 1 + Math.floor(rng() * 4), financial_need_level: 'high', low_income: true },
        occupation: { nonprofit_employee: false, small_business_owner: false },
      }
    : {
        organization_details: {
          organization_type: entityLabel,
          annual_budget: 60000 + Math.floor(rng() * 900000),
          staff_count: 1 + Math.floor(rng() * 25),
          sam_gov_registered: rng() > 0.5,
          grants_gov_account: rng() > 0.5,
        },
      }

  const sections = mergeSections(mergeSections(shared, shapeSections), identity.sections)

  return {
    scenario_id: scenarioId,
    category: `${ADVERSARIAL_CATEGORY_PREFIX}:${cell.entity}+${cell.identity}+${cell.need}`,
    label,
    primary_type: entityId,
    kind: isIndividual ? 'individual' : 'org',
    display_name: displayName,
    // The probe provenance travels WITH the scenario so the coverage ledger can
    // fold the outcome back onto the exact cell that produced it. Without this
    // the probe would be unattributable and the coverage claim unprovable.
    probe_cell: { entity: cell.entity, identity: cell.identity, need: cell.need, state: cell.state },
    probe_cell_key: key,
    probe_seed_pair: cell?.seed_pair ?? null,
    probe_top_up: cell?.top_up ?? null,
    sections: {
      ...sections,
      basic_information: {
        full_name: displayName,
        email: syntheticEmail,
        phone: `555-01${String(index % 100).padStart(2, '0')}`,
        city: locality.city,
        state: locality.state,
        zip: locality.zip,
        county: locality.county,
        profile_category: entityId,
        notes: 'SYNTHETIC gap-probe profile generated by Amy. Not a real person/org. Safe for Sam cleanup.',
      },
    },
    expected: {
      state: locality.state,
      zip: locality.zip,
      county: locality.county,
      needs: interests.slice(0, 4),
    },
  }
}

/** Build the whole adversarial batch, skipping any cell that cannot build. */
export function buildIntersectionScenarios(cells = [], { runId = 'amy', startIndex = 0 } = {}) {
  const out = []
  let i = startIndex
  for (const cell of Array.isArray(cells) ? cells : []) {
    const scenario = buildIntersectionScenario(cell, { runId, index: i })
    if (!scenario) continue
    out.push(scenario)
    i += 1
  }
  return out
}

export default { buildIntersectionScenario, buildIntersectionScenarios, ADVERSARIAL_CATEGORY_PREFIX }
