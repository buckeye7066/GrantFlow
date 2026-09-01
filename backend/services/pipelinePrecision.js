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
 *   - A section merely EXISTING is not a declaration. Nearly every person-type
 *     profile carries empty `housing` / `education` / `health_medical` /
 *     `family_life` schema sections (measured 2026-08-23), so treating the
 *     section KEY as a need made every individual look the same and flooded
 *     their pipelines. Explicit need arrays, tags, and structured TYPE-derived
 *     needs (student→education, small_business→business) still count.
 *     `includeSectionKeys:true` remains for a census of the old loose reading.
 *   - SILENCE IS REPORTED, never hidden. `evaluateDeclaredNeedCoverage` still
 *     fails OPEN so a REMOVAL sweep can count unreadable rows without deleting
 *     them. ADMISSION (and the individual-root boot net) require a POSITIVE
 *     overlap — that is the gold standard for what GETS THROUGH. A profile
 *     that declares no needs, or a row that states no need vocabulary, cannot
 *     answer "yes, this meets a need" and does not enter an individual pipeline.
 */

import { normalizeNeedCategory } from './profileNormalizer.js'
import { CANONICAL_NEED_CATEGORIES } from '../constants/needCategories.js'
import { getParentChain, resolveProfileType } from './profileTypeRegistry.js'

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
  NO_POSITIVE_MATCH: 'no_positive_declared_match',
})

/**
 * Individual-root family (person / household / student / veteran). Same roots
 * `isIndividualLikeProfileType` uses — org roots win so a veteran-owned
 * business is not treated as a person. Used to apply the gold-standard
 * positive-need bar to individual pipelines without touching org ones.
 */
const INDIVIDUAL_ROOT_TYPES = Object.freeze(['individual', 'family', 'student', 'veteran'])
const ORG_ROOT_TYPES = Object.freeze([
  'business', 'nonprofit', 'public_agency', 'local_government', 'school',
  'school_district', 'church', 'library', 'government', 'organization',
])

export function isIndividualRootProfile(profileRow, applicantType = null) {
  const raw = applicantType
    || profileRow?.primary_type
    || profileRow?.applicant_type
    || profileRow?.type
    || profileRow?.profile_type
    || null
  const id = resolveProfileType(raw)
  if (!id) return false
  const chain = [id, ...getParentChain(id)]
  if (chain.some((t) => ORG_ROOT_TYPES.includes(t))) return false
  return chain.some((t) => INDIVIDUAL_ROOT_TYPES.includes(t))
}

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
export function declaredNeedsFrom(profileRow, sections, { includeSectionKeys = false } = {}) {
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
    // A section KEY that IS a canonical need used to count as a declaration.
    // Default is OFF: empty schema sections are not a need. Opt-in remains
    // for the census `--section-keys` reading of the old loose rule.
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
  for (const field of TYPE_NEED_ROW_FIELDS) {
    add(profileRow?.[field])
    // Walk the registry parent chain so `college_student` → `student` →
    // education. The leaf token itself is often not a need id (`college_student`
    // normalises to `student`, which is not in CANONICAL_NEED_IDS); the parent
    // `student` is what `normalizeNeedCategory` maps to `education`.
    const resolved = resolveProfileType(profileRow?.[field])
    if (resolved) {
      add(resolved)
      for (const parent of getParentChain(resolved)) add(parent)
    }
  }
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
/**
 * When a row states no structured need vocabulary, infer ONLY from phrases
 * the title/kind themselves use (scholarship → education). Never from
 * description prose. Lets unlabeled Pell/HOPE/NAEMT rows still answer the
 * need conjunct for a student without reopening fail-open silence.
 */
const TITLE_STATED_NEED_PATTERNS = Object.freeze([
  [/\b(?:scholarships?|fellowships?|pell\b|fafsa|tuition|work[\s-]?study|student aid|financial aid)\b/i, 'education'],
  [/\b(?:snap|food pantry|food bank|nutrition assistance)\b/i, 'food'],
  [/\b(?:liheap|rental assistance|rent assistance|section 8)\b/i, 'housing'],
  [/\b(?:small business grant|business grant)\b/i, 'business'],
  // Phrase-only: a title that NAMES the population/need. Bare "va" is
  // refused (Virginia / VA). "financial assistance" is refused (too
  // broad; financial aid already maps to education).
  [/\bveterans?\b/i, 'veteran'],
  [/\b(?:emergency (?:assistance|relief|aid|grant|fund)|disaster (?:relief|assistance)|crisis (?:assistance|relief))\b/i, 'emergency'],
])

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
  if (supported.size === 0) {
    // Kind is a structural class (scholarship/program), not a need. A crawler
    // that stamps `opportunity_kind='scholarship'` on a generic row must not
    // mint an education match. Only phrases the TITLE itself states count.
    const title = String(row?.title ?? '')
    for (const [rx, need] of TITLE_STATED_NEED_PATTERNS) {
      if (rx.test(title)) add(need)
    }
  }
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
  isIndividualRootProfile,
  opportunityNeedVocabulary,
  evaluateDeclaredNeedCoverage,
}
