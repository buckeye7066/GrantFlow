/**
 * farmIdentity.js — the ONE registry of agricultural-producer identity.
 *
 * WHY THIS EXISTS
 * ---------------
 * The owner's Anita profile is a PERSON who also runs a Kentucky farm: an
 * individual with a legitimate farm-business identity. Two structural defects
 * made that shape unreachable, and both were provable against the shipped code:
 *
 * 1. `applicantTypeGate.bucket()` knew only individual / org / business. The
 *    word "farm" appeared NOWHERE in the gate, so an opportunity carrying the
 *    explicit `applicant_types: ['farm']` — exactly what the crawler-os
 *    `usda_conservation` (NRCS EQIP/CSP) lane emits — took the
 *    `explicitMatchesBucket` "we have explicit types but none match" branch and
 *    returned a HARD `mismatch` for EVERY profile in the system (individual,
 *    org AND business alike). That decision is not a penalty: Discover drops it,
 *    `POST /grants/from-opportunity` answers HTTP 400 `ineligible_for_profile`,
 *    and `pipelineEligibilitySweep` DISMISSES the row if it ever landed. The
 *    entire agriculture universe was closed to the entire user base.
 *
 * 2. The gate is handed ONE applicant-type string, so a dual identity could not
 *    even be expressed. Anita reads as `individual`; her farm never votes.
 *
 * THE RULE
 * --------
 * Farm identity is DECLARED and STRUCTURED, never inferred from prose. A
 * mission statement that mentions a "farmers market", a narrative about growing
 * up on a farm, or an address in a rural county is NOT a farm applicant — that
 * free-text inference is the documented 13-bucket-explosion / false-positive
 * class (see crawler-os/profileIntelligence.js). We read only:
 *   - a declared applicant/profile type in the farm vocabulary,
 *   - the `occupation.farmer` schema checkbox (profileSchema.js) and its
 *     recognised aliases,
 *   - a NAICS code in sector 11 (Agriculture, Forestry, Fishing and Hunting) on
 *     `small_business_details` — an unambiguous structured self-declaration.
 *
 * `FARM_OCCUPATION_FLAG_KEYS` is ALSO consumed by crawler-os
 * (`profileIntelligence.hasStructuredFarmerFlag`) so the discovery lane and the
 * eligibility gate cannot drift apart about what declares a farmer. A static
 * tripwire test asserts both sides read this registry.
 */

/**
 * Canonical applicant-type tokens that mean "agricultural producer".
 * Used on BOTH sides of the gate: a profile declaring one of these is a farm
 * applicant, and an opportunity listing one of these admits farm applicants.
 * Compared after `String(x).trim().toLowerCase().replace(/\s+/g,'_')`.
 */
export const FARM_APPLICANT_TOKENS = Object.freeze([
  'farm',
  'farms',
  'farmer',
  'farmers',
  'farming',
  'farm_operation',
  'family_farm',
  'ranch',
  'ranches',
  'rancher',
  'ranchers',
  'agriculture',
  'agricultural',
  'agricultural_producer',
  'agriculture_producer',
  'agricultural_producers',
  'producer',
  'producers',
  'grower',
  'growers',
  'agribusiness',
  'agricultural_business',
  'livestock_producer',
  'forest_landowner',
])

const FARM_TOKEN_SET = new Set(FARM_APPLICANT_TOKENS)

/**
 * Occupation-section boolean flags that DECLARE an agricultural producer.
 * `farmer` is the real `profileSchema.occupation` checkbox; the rest are
 * aliases an importer/AI-enrichment pass has been seen to write.
 */
export const FARM_OCCUPATION_FLAG_KEYS = Object.freeze([
  'farmer',
  'rancher',
  'agricultural_producer',
  'farm_owner',
  'farm_operator',
])

/** NAICS sector 11 = Agriculture, Forestry, Fishing and Hunting. */
const NAICS_AGRICULTURE_SECTOR = '11'

/** Normalize any applicant-type-ish value to the comparison form. */
export function normalizeApplicantToken(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim().toLowerCase().replace(/[\s-]+/g, '_')
}

/** @returns {boolean} true when the token names an agricultural producer. */
export function isFarmApplicantToken(value) {
  return FARM_TOKEN_SET.has(normalizeApplicantToken(value))
}

function coerceObject(data) {
  if (!data) return null
  if (typeof data === 'object' && !Array.isArray(data)) return data
  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  return null
}

/** True when `small_business_details.naics_code` sits in NAICS sector 11. */
export function isAgricultureNaics(naicsCode) {
  const digits = String(naicsCode ?? '').replace(/\D/g, '')
  // A bare "11" is the sector itself; a longer code must START with it. Require
  // at least 2 digits so a stray "1" can never claim agriculture.
  return digits.length >= 2 && digits.startsWith(NAICS_AGRICULTURE_SECTOR)
}

/**
 * Does this profile STRUCTURALLY declare an agricultural-producer identity?
 *
 * @param {object} args
 * @param {object} [args.profile]  - the profiles row (applicant_type/primary_type…)
 * @param {Record<string, any>} [args.sections] - section_key → data (object or JSON string)
 * @returns {boolean}
 */
export function hasFarmIdentity({ profile = null, sections = null } = {}) {
  // 1. A declared type in the farm vocabulary (profiles row or basic_information).
  const basic = coerceObject(sections?.basic_information) ?? {}
  const declared = [
    profile?.applicant_type,
    profile?.primary_type,
    profile?.primary_profile_type,
    profile?.profile_type,
    basic.profile_type,
    basic.profile_category,
    basic.applicant_type,
    coerceObject(sections?.organization_details)?.organization_type,
  ]
  for (const value of declared) {
    if (isFarmApplicantToken(value)) return true
  }

  // 2. The occupation schema checkbox (structured, deliberate).
  const occupation = coerceObject(sections?.occupation) ?? coerceObject(profile?.occupation) ?? {}
  for (const key of FARM_OCCUPATION_FLAG_KEYS) {
    if (occupation[key] === true) return true
  }

  // 3. A NAICS sector-11 code on the business section.
  const smallBiz = coerceObject(sections?.small_business_details) ?? {}
  if (isAgricultureNaics(smallBiz.naics_code)) return true

  return false
}

export default {
  FARM_APPLICANT_TOKENS,
  FARM_OCCUPATION_FLAG_KEYS,
  normalizeApplicantToken,
  isFarmApplicantToken,
  isAgricultureNaics,
  hasFarmIdentity,
}
