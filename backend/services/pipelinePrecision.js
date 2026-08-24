/**
 * pipelinePrecision.js — the DECLARED-NEED conjunct of pipeline admission.
 *
 * OWNER ORDER (2026-08-21, verbatim): "no funding source that does not meet
 * the needs of the profile, come from real relatable sources, that the profile
 * qualifies for, will make it to that profile's pipeline. All such funding
 * sources that are currently on a pipeline will be removed."
 *
 * Three conjuncts, ONE authority each:
 *   (1) MEETS A DECLARED NEED  → this module (`evaluateDeclaredNeedCoverage`)
 *   (2) REAL / RELATABLE       → config/fundingResultFilters + opportunityKindClasses
 *   (3) THE PROFILE QUALIFIES  → applicantTypeGate + stageOfLifeEligibility +
 *                                fundingResultFilters.passesEligibility/isRelevantGeo
 *                                (all already consulted by matchEngine.makeDecision)
 *
 * Conjunct (1) was the one with NO admission-time enforcer: the canonical
 * decision engine deliberately treats low need coverage as a SCORE, never as
 * hard ineligibility ("a low score alone is not hard ineligibility" —
 * matchEngine.js), so a row serving a need the profile never declared reached
 * the pipeline on applicant-type + geography alone. Robert's four-gate audit
 * (services/robert/robertPipelineAudit.js) had the predicate, but only as a
 * manual admin tool. This module is the ONE implementation both the admission
 * gate (opportunityMatcher.admitToPipeline, Gate 1.9) and the boot removal
 * sweep (enforceInvariants.enforcePipelinePrecision) and Robert consume — no
 * second encoding, no drift.
 *
 * THE RULE, stated plainly so it can be overruled:
 *   - The profile side is STRUCTURED declarations only (`DECLARED_NEED_FIELDS`
 *     on the profiles row and on every section, a section KEY that IS a
 *     canonical need, and the profile's tags). Never mined prose — free text
 *     carries its own DENIALS ("we do not need housing assistance"), the
 *     veteran-gate class this repo shipped twice.
 *   - The opportunity side is its own stated need vocabulary
 *     (`need_types_supported` / `categories` / `keywords` / `funding_category`
 *     / `opportunity_type`), canonicalised through the SAME
 *     `normalizeNeedCategory` the profile side uses.
 *   - "At least PART" of one declared need is the owner's bar: one overlapping
 *     canonical need passes.
 *   - SILENCE IS NEUTRAL ON BOTH SIDES and is REPORTED, never hidden. A profile
 *     that declares no needs is a profile we cannot read, not a profile with
 *     nothing to fund; a row that states no need vocabulary is silent, not
 *     contrary. Both outcomes carry a distinct `detail` so every sweep can
 *     count them per reason instead of folding them into "kept".
 */

import { normalizeNeedCategory } from './profileNormalizer.js'
import { CANONICAL_NEED_CATEGORIES } from '../constants/needCategories.js'

/**
 * The CANONICAL need vocabulary, read from the registry rather than hand-typed.
 * `normalizeNeedCategory` is a pass-through for values it does not recognise
 * (it returns `basic_information` for `basic_information`), so using it alone
 * would turn every profile SECTION NAME into a declared need.
 */
const CANONICAL_NEED_IDS = new Set(CANONICAL_NEED_CATEGORIES.map((n) => n.id))

/** Structured fields a profile may declare a NEED in. Never prose. */
export const DECLARED_NEED_FIELDS = Object.freeze([
  'needs', 'need_categories', 'primary_needs', 'support_needs', 'funding_needs',
  'item_needs', 'assistance_types',
])

/** Opportunity fields that state the needs a source serves. */
export const OPPORTUNITY_NEED_FIELDS = Object.freeze([
  'need_types_supported', 'categories', 'keywords',
])

export const NEED_COVERAGE_DETAIL = Object.freeze({
  PROFILE_DECLARES_NO_NEEDS: 'profile_declares_no_needs_gate_neutral',
  OPPORTUNITY_STATES_NO_NEEDS: 'opportunity_states_no_need_vocabulary',
  MATCHED: 'declared_need_matched',
  UNCOVERED: 'no_declared_need_covered',
})

export function canonicalNeed(value) {
  if (typeof value !== 'string') return null
  const normalized = normalizeNeedCategory(value)
  return normalized && CANONICAL_NEED_IDS.has(normalized) ? normalized : null
}

export function parseMaybeJson(value, fallback) {
  if (value === null || value === undefined) return fallback
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return fallback }
}

/**
 * The profile's DECLARED needs — structured fields only, canonicalised.
 *
 * @param {object|null} profileRow  the `profiles` row (or a profile-shaped object)
 * @param {object|null} sections    `{ section_key: parsedData }`
 * @returns {string[]} canonical need ids, de-duplicated, insertion-ordered
 */
export function declaredNeedsFrom(profileRow, sections, { includeSectionKeys = true } = {}) {
  const needs = new Set()
  const addNeed = (value) => {
    const canonical = canonicalNeed(value)
    if (canonical) needs.add(canonical)
  }
  for (const field of DECLARED_NEED_FIELDS) {
    const direct = parseMaybeJson(profileRow?.[field], null)
    if (Array.isArray(direct)) direct.forEach(addNeed)
    else if (typeof direct === 'string') addNeed(direct)
  }
  const sectionMap = sections && typeof sections === 'object' ? sections : {}
  for (const [key, section] of Object.entries(sectionMap)) {
    // A section KEY that IS a canonical need (`housing`, `education`,
    // `employment`, `health_medical`, `family_life`) counts as a declaration
    // (Robert's rule). MEASURED in prod 2026-08-23: nearly every profile
    // carries those five sections, so this arm makes "declared needs" read
    // the same for a biolab, the admin vault and a stress-cohort synthetic.
    // `includeSectionKeys:false` lets a census measure the strict reading.
    if (includeSectionKeys) addNeed(key)
    const parsed = parseMaybeJson(section, null)
    if (!parsed || typeof parsed !== 'object') continue
    for (const field of DECLARED_NEED_FIELDS) {
      const value = parsed[field]
      if (Array.isArray(value)) value.forEach(addNeed)
      else if (typeof value === 'string') addNeed(value)
    }
  }
  const tags = parseMaybeJson(profileRow?.tags, [])
  if (Array.isArray(tags)) tags.forEach(addNeed)
  // ORG/BUSINESS profiles declare their need through their structured TYPE +
  // mission/sector tags, not a needs array — derive those too (structured only).
  for (const derived of typeDerivedNeeds(profileRow, sections)) needs.add(derived)
  return [...needs]
}

// An ORG/BUSINESS profile does not fill a "needs" array the way an individual
// does — its funding need is expressed through its structured TYPE and its
// structured mission/sector TAGS (a small_business needs business funding; a
// farm needs agriculture funding; a nonprofit needs what its focus_areas name).
// So a small-business grant was being pruned from Olivia's pipeline for
// "no_positive_declared_match" even though she IS a business, because the gate
// only read need arrays she never fills. Derive the need from the STRUCTURED
// type + tag fields — NEVER from the mission NARRATIVE prose (the prose-denial
// class: "we don't need X" must never mint X). `canonicalNeed` returns null for
// a type that is not itself a need (individual/family/nonprofit), so no junk
// need is ever added; `small_business`→`business`, `farm`→`agriculture`,
// `student`→`education` all resolve, which is correct.
const TYPE_NEED_ROW_FIELDS = Object.freeze(['primary_type', 'type', 'profile_type'])
const ORG_TYPE_DESCRIPTOR_FIELDS = Object.freeze(['organization_type', 'business_type', 'industry', 'sector', 'entity_type'])
const ORG_TAG_ARRAY_FIELDS = Object.freeze([
  'focus_areas', 'service_areas', 'program_areas', 'programs', 'sectors',
  'industries', 'cause_areas', 'mission_areas',
])

/**
 * Needs DERIVED from a profile's STRUCTURED type + mission/sector tags — the way
 * an organization declares what it needs funding for. Structured fields only.
 * @returns {string[]} canonical need ids
 */
export function typeDerivedNeeds(profileRow, sections) {
  const out = new Set()
  const add = (value) => {
    const canonical = canonicalNeed(value)
    if (canonical) out.add(canonical)
  }
  for (const field of TYPE_NEED_ROW_FIELDS) add(profileRow?.[field])
  const sectionMap = sections && typeof sections === 'object' ? sections : {}
  for (const section of Object.values(sectionMap)) {
    const parsed = parseMaybeJson(section, null)
    if (!parsed || typeof parsed !== 'object') continue
    for (const field of ORG_TYPE_DESCRIPTOR_FIELDS) add(parsed[field])
    for (const field of ORG_TAG_ARRAY_FIELDS) {
      const arr = parsed[field]
      if (Array.isArray(arr)) arr.forEach(add)
    }
  }
  return [...out]
}

/**
 * The needs an opportunity row SAYS it serves — canonicalised.
 * @returns {string[]}
 */
export function opportunityNeedVocabulary(row) {
  const supported = new Set()
  const add = (value) => {
    const canonical = canonicalNeed(value)
    if (canonical) supported.add(canonical)
  }
  for (const field of OPPORTUNITY_NEED_FIELDS) {
    const parsed = parseMaybeJson(row?.[field], null)
    if (Array.isArray(parsed)) parsed.forEach(add)
    else if (typeof parsed === 'string') add(parsed)
  }
  add(row?.funding_category)
  add(row?.opportunity_type)
  return [...supported]
}

/**
 * Conjunct (1): does this opportunity meet at least PART of a need the
 * profile DECLARED?
 *
 * @param {object} row            an opportunity / pipeline row
 * @param {string[]} declaredNeeds canonical need ids from `declaredNeedsFrom`
 * @returns {{ pass: boolean, detail: string, matched: string[], profile_needs: string[], opportunity_needs: string[] }}
 */
export function evaluateDeclaredNeedCoverage(row, declaredNeeds) {
  const needs = Array.isArray(declaredNeeds) ? declaredNeeds.filter(Boolean) : []
  const opportunityNeeds = opportunityNeedVocabulary(row)
  if (needs.length === 0) {
    return {
      pass: true,
      detail: NEED_COVERAGE_DETAIL.PROFILE_DECLARES_NO_NEEDS,
      matched: [],
      profile_needs: [],
      opportunity_needs: opportunityNeeds,
    }
  }
  if (opportunityNeeds.length === 0) {
    return {
      pass: true,
      detail: NEED_COVERAGE_DETAIL.OPPORTUNITY_STATES_NO_NEEDS,
      matched: [],
      profile_needs: needs,
      opportunity_needs: [],
    }
  }
  const supported = new Set(opportunityNeeds)
  const matched = needs.filter((n) => supported.has(n))
  return {
    pass: matched.length > 0,
    detail: matched.length > 0 ? NEED_COVERAGE_DETAIL.MATCHED : NEED_COVERAGE_DETAIL.UNCOVERED,
    matched,
    profile_needs: needs,
    opportunity_needs: opportunityNeeds,
  }
}

export default {
  DECLARED_NEED_FIELDS,
  OPPORTUNITY_NEED_FIELDS,
  typeDerivedNeeds,
  NEED_COVERAGE_DETAIL,
  canonicalNeed,
  declaredNeedsFrom,
  opportunityNeedVocabulary,
  evaluateDeclaredNeedCoverage,
}
