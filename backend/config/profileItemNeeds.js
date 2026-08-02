/**
 * profileItemNeeds.js — THE ITEM LIST A PROFILE ACTUALLY DECLARES.
 *
 * THE OWNER'S RULE (2026-08-02): "Ensure GrantFlow builds an item list for each
 * profile of items the profile might need, and have the item search crawler
 * tooled to be able to find those items if the profile owner or admin requires
 * a crawl for that item or list of items. Also, make sure there is a free-text
 * field that the profile owner or admin can type in an item they feel they
 * need, and GrantFlow be able to find it in accordance to our rules and goals."
 *
 * WHAT THIS IS NOT. It is not a checklist. `services/itemCatalogService.js`
 * scores a NINE-ROW fixture (laptop / desktop / hotspot / wheelchair van /
 * wheelchair / hearing aids / vision glasses / school supplies / work clothing)
 * against coarse need buckets and then asks an LLM to invent the rest. Two
 * profiles with nothing in common get the same nine candidates, and a nonprofit
 * ministry that declares "Building supplies" is offered hearing aids. A list
 * that does not come from what the profile SAID is a guess wearing a UI.
 *
 * A DERIVED NEED IS A CLAIM WITH AN ADDRESS. Every entry returned here carries
 * the REGISTRY FIELD ID it was read from (`evidence`), exactly as
 * `config/profileDerivedFacts.js` does for topical facts. If a field says
 * nothing, the need is ABSENT — never defaulted into existence.
 *
 * PROSE IS NOT MINED. `narrative.primary_goal` on Focus Forward Ministry
 * literally reads "Deliver building supplies …" — and it is `format:'prose',
 * scored:false` in `PROFILE_SCHEMA`, i.e. DRAFTING ONLY. This module reads
 * structured fields only, so the same fact reaches it through
 * `programs_services.focus_areas: ["… Building supplies"]`, which is a tag the
 * profile owner chose. Mining prose here would re-open the exact hole
 * `getUnscoredProseFieldNames()` exists to close.
 *
 * PRECISION OVER VOLUME. Free text is a coincidence magnet: `health_medical.
 * disability_type` on a real prod profile holds `["CIPN","mobility","arthritis",
 * "unsteady gait"]`, and only ONE of those four names a purchasable thing. An
 * unmapped entry is reported as an honest `unmapped` gap with the vocabulary
 * line that would fix it — the convergent-gap shape from CLAUDE.md — never
 * emitted as an item and never silently dropped.
 *
 * APPLICABILITY IS READ FROM THE SCHEMA, NEVER HAND-TYPED. Focus Forward
 * Ministry (a `nonprofit`) carries an imported `health_medical.disability_type:
 * ["physical"]` AND an imported `housing.broadband_speed: "low"` — both of
 * sections the schema declares `applies_to: ALL_PERSON_TYPES`. Deriving a
 * mobility aid or a household internet plan for a ministry off an import
 * artifact is the Kimberly-Botts class one level down. Each rule therefore
 * names its SECTION and is gated by that section's own
 * `PROFILE_SCHEMA[section].applies_to` — a hand-typed person/org flag on the
 * rule would be a second copy of a rule that already has one owner, and the
 * first draft of this file got it wrong in exactly that way (it admitted
 * Focus Forward's household broadband).
 *
 * REGISTRY + TOTALITY (CLAUDE.md). `ITEM_NEED_RULES` is the enumerable
 * inventory; `backend/tests/profileItemNeeds.test.js` asserts every rule is
 * consulted by `deriveProfileItemNeeds` and that every vocabulary entry is
 * reachable, so a new rule cannot silently fall out of derivation or search.
 *
 * THIS MODULE NEVER DECIDES A MATCH. It says what to LOOK for.
 * `services/matchEngine.js` stays the sole decision authority.
 */

import { isProfileTypeInList, ALL_PERSON_TYPES, ALL_ORG_TYPES } from '../../shared/profileSectionApplicability.js'
import { PROFILE_SCHEMA } from './profileSchema.js'

/**
 * Every profile type the applicability registry actually recognizes. A value
 * outside this set is not "an org" or "a person" — it is a value nothing can
 * classify, and it must therefore cost the profile NOTHING.
 */
const RECOGNIZED_PROFILE_TYPES = new Set([...ALL_PERSON_TYPES, ...ALL_ORG_TYPES])

/** Coerce a section value to a plain object (may be an object or a JSON string). */
function obj(v) {
  if (!v) return {}
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return p && typeof p === 'object' ? p : {} } catch { return {} }
  }
  return typeof v === 'object' ? v : {}
}

function list(v) {
  if (Array.isArray(v)) return v
  if (typeof v === 'string' && v.trim()) return v.split(',')
  return []
}

/** Lowercase, punctuation → space, collapsed whitespace. */
export function normalizeItemTerm(v) {
  return String(v ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Token-boundary containment, both directions, min length 4 — the same rule
 * `coverageEvidenceService.conditionCoveredBySource` settled on after the
 * "one shared word" floor shipped three times. `renal` must not hit inside
 * `adrenal`; `building supplies` must hit inside "essential building supplies".
 */
function statesTerm(vocabTerm, declared) {
  const v = normalizeItemTerm(vocabTerm)
  const d = normalizeItemTerm(declared)
  if (v.length < 4 || !d) return false
  return ` ${d} `.includes(` ${v} `)
}

/** Bounded so a verbose profile cannot explode the search fan-out. */
export const MAX_ITEM_NEEDS = 12

// ───────────────────────────────────────────────────────────────────────────
// CURATED VOCABULARIES. Every entry maps a value a profile can DECLARE to a
// concrete purchasable thing plus the phrase an item search should look for.
// A declared value with no entry here is an `unmapped` gap, never a guess.
// ───────────────────────────────────────────────────────────────────────────

/** `health_medical.support_needs[]` → item. */
export const SUPPORT_NEED_ITEMS = Object.freeze({
  transportation: { item: 'Transportation to medical appointments', needText: 'medical transportation assistance', category: 'transportation' },
  'copay assistance': { item: 'Prescription and treatment copay assistance', needText: 'copay assistance program', category: 'medical' },
  lodging: { item: 'Lodging during out-of-town treatment', needText: 'patient lodging assistance during treatment', category: 'housing' },
  'caregiver support': { item: 'Caregiver respite support', needText: 'caregiver respite grant', category: 'family' },
  equipment: { item: 'Adaptive or medical equipment', needText: 'adaptive equipment assistance', category: 'medical_equipment' },
  'mental health support': { item: 'Mental health counseling support', needText: 'mental health counseling assistance', category: 'mental_health' },
  'home modification': { item: 'Home accessibility modification', needText: 'home accessibility modification grant', category: 'housing' },
  food: { item: 'Food and nutrition assistance', needText: 'food assistance program', category: 'food' },
  childcare: { item: 'Childcare assistance', needText: 'childcare assistance program', category: 'childcare' },
  utilities: { item: 'Utility bill assistance', needText: 'utility bill assistance', category: 'utilities' },
})

/** `health_medical.disability_type[]` → item. Canonical tokens only. */
export const DISABILITY_TYPE_ITEMS = Object.freeze({
  mobility: { item: 'Mobility aid (walker, wheelchair, or scooter)', needText: 'mobility equipment assistance', category: 'mobility' },
  physical: { item: 'Adaptive equipment for a physical disability', needText: 'adaptive equipment grant disability', category: 'mobility' },
  hearing: { item: 'Hearing aids', needText: 'hearing aid assistance program', category: 'medical_equipment' },
  vision: { item: 'Low-vision aids', needText: 'low vision aid assistance', category: 'medical_equipment' },
  visual: { item: 'Low-vision aids', needText: 'low vision aid assistance', category: 'medical_equipment' },
})

/**
 * Canonical health BOOLEANS → item. Finite by construction, so unlike free text
 * this table can be total (`profileItemNeeds.test.js` asserts it).
 */
export const HEALTH_FLAG_ITEMS = Object.freeze({
  wheelchair_user: { item: 'Wheelchair or wheelchair-accessible vehicle', needText: 'wheelchair assistance program', category: 'mobility' },
  visual_impairment: { item: 'Assistive technology for visual impairment', needText: 'visual impairment assistive technology grant', category: 'adaptive_equipment' },
  hearing_impairment: { item: 'Hearing aids or assistive listening device', needText: 'hearing aid assistance program', category: 'medical_equipment' },
})

/**
 * LICENSED / CREDENTIALED ROLES → the recurring purchases that role carries.
 * A licensed professional's real item needs are credential costs: continuing
 * education, board-required coursework, renewal and exam fees. This is the rule
 * that makes "Dr. John White needs a PROBE ethics class for nursing licensure"
 * a COHERENT ask rather than an unexplained one — his profile declares
 * `occupation.healthcare_worker_type = "RN"`.
 */
export const CREDENTIAL_ROLE_ITEMS = Object.freeze({
  healthcare_worker_type: { item: 'Professional license renewal and continuing education', needText: 'nursing continuing education and license renewal assistance', category: 'licensure' },
  educator: { item: 'Teaching credential renewal and professional development', needText: 'teacher certification renewal assistance', category: 'licensure' },
  ems_worker: { item: 'EMS recertification and continuing education', needText: 'EMS recertification assistance', category: 'licensure' },
  firefighter: { item: 'Firefighter certification and safety training', needText: 'firefighter certification training funding', category: 'licensure' },
})

/**
 * TAG VOCABULARY for `programs_services.*` and `basic_information.keywords`.
 * ONLY entries that name a purchasable thing. A focus area like "Poverty
 * alleviation" or "Discipleship" is a MISSION, not an item, and admitting it
 * would put every mission word into the item search — the flood signature.
 * Every term is multi-word or ≥6 chars for the same reason
 * `profileDerivedFacts.isTopicalTerm` refuses single generic words.
 */
export const ITEM_TAG_VOCABULARY = Object.freeze({
  'building supplies': { item: 'Building supplies and construction materials', needText: 'building materials donation program', category: 'equipment' },
  'building materials': { item: 'Building supplies and construction materials', needText: 'building materials donation program', category: 'equipment' },
  'medical equipment': { item: 'Medical equipment', needText: 'donated medical equipment program', category: 'medical_equipment' },
  'medical supplies': { item: 'Medical supplies', needText: 'donated medical supplies program', category: 'medical_equipment' },
  'school supplies': { item: 'School supplies', needText: 'school supplies donation program', category: 'education' },
  'classroom technology': { item: 'Classroom technology', needText: 'classroom technology grant', category: 'technology' },
  'computer equipment': { item: 'Computer equipment', needText: 'donated computers nonprofit', category: 'technology' },
  'office equipment': { item: 'Office equipment and furniture', needText: 'office furniture donation nonprofit', category: 'furniture' },
  'commercial kitchen': { item: 'Commercial kitchen equipment', needText: 'commercial kitchen equipment grant', category: 'equipment' },
  'passenger van': { item: 'Passenger van', needText: 'passenger van donation nonprofit', category: 'vehicle' },
  'food truck': { item: 'Food truck', needText: 'food truck startup funding', category: 'food_truck' },
  'assistive technology': { item: 'Assistive technology', needText: 'assistive technology funding', category: 'adaptive_equipment' },
  'protective equipment': { item: 'Personal protective equipment', needText: 'personal protective equipment donation', category: 'equipment' },
  'musical instruments': { item: 'Musical instruments', needText: 'musical instrument donation program', category: 'equipment' },
  'playground equipment': { item: 'Playground equipment', needText: 'playground equipment grant', category: 'equipment' },
  'lab equipment': { item: 'Laboratory equipment', needText: 'laboratory equipment grant', category: 'equipment' },
  'laboratory equipment': { item: 'Laboratory equipment', needText: 'laboratory equipment grant', category: 'equipment' },
})

/** Broadband values that declare a connectivity NEED. */
const LOW_BROADBAND = Object.freeze(new Set(['low', 'none', 'no broadband', 'unserved', 'dial up', 'dialup']))

const CONNECTIVITY_ITEM = Object.freeze({
  item: 'Home internet service or hotspot',
  needText: 'low-cost home internet or hotspot program',
  category: 'internet',
})

// ───────────────────────────────────────────────────────────────────────────
// THE REGISTRY. Every rule names ONE declared field, in descending evidence
// strength — the bound truncates the WEAKEST evidence, never what the owner
// typed. `personOnly` gates the health lane off organization profiles.
// ───────────────────────────────────────────────────────────────────────────

/**
 * A rule emits `{ item, needText, category }` entries plus `unmapped` strings.
 * `section` is the PROFILE_SCHEMA section the rule reads; its `applies_to` is
 * the applicability gate (totality-tested).
 */
export const ITEM_NEED_RULES = Object.freeze([
  Object.freeze({
    id: 'financial_information.item_needs',
    section: 'financial_information',
    source: 'declared',
    vocabulary: null,
    read: (s) => list(obj(s.financial_information).item_needs),
    // The owner/admin typed it. It is the item, verbatim, and it is never
    // adjudicated against a vocabulary — refusing a person's own words is how
    // "I need a PROBE ethics class" becomes "no results".
    emit: (values) => ({
      needs: values
        .map((v) => String(v ?? '').trim())
        .filter(Boolean)
        .map((v) => ({ item: v, needText: v, category: 'declared' })),
      unmapped: [],
    }),
  }),
  Object.freeze({
    id: 'medical_history.dme_needed',
    section: 'medical_history',
    source: 'derived',
    vocabulary: null,
    read: (s) => list(obj(s.medical_history).dme_needed),
    // A DME list is already an item list by schema definition ("Durable medical
    // equipment needed (e.g., shower chair) when explicitly stated").
    emit: (values) => ({
      needs: values
        .map((v) => String(v ?? '').trim())
        .filter(Boolean)
        .map((v) => ({ item: v, needText: `${v} assistance program`, category: 'medical_equipment' })),
      unmapped: [],
    }),
  }),
  Object.freeze({
    id: 'health_medical.support_needs',
    section: 'health_medical',
    source: 'derived',
    vocabulary: 'SUPPORT_NEED_ITEMS',
    read: (s) => list(obj(s.health_medical).support_needs),
    emit: (values) => mapThroughVocabulary(values, SUPPORT_NEED_ITEMS),
  }),
  Object.freeze({
    id: 'health_medical.disability_type',
    section: 'health_medical',
    source: 'derived',
    vocabulary: 'DISABILITY_TYPE_ITEMS',
    read: (s) => list(obj(s.health_medical).disability_type),
    emit: (values) => mapThroughVocabulary(values, DISABILITY_TYPE_ITEMS),
  }),
  Object.freeze({
    id: 'health_medical.flags',
    section: 'health_medical',
    source: 'derived',
    vocabulary: 'HEALTH_FLAG_ITEMS',
    read: (s) => Object.keys(HEALTH_FLAG_ITEMS).filter((k) => obj(s.health_medical)[k] === true),
    emit: (values) => ({
      needs: values.map((k) => ({ ...HEALTH_FLAG_ITEMS[k] })).filter(Boolean),
      unmapped: [],
    }),
  }),
  Object.freeze({
    id: 'occupation.credentialed_role',
    section: 'occupation',
    source: 'derived',
    vocabulary: 'CREDENTIAL_ROLE_ITEMS',
    read: (s) => {
      const occ = obj(s.occupation)
      const hit = []
      // `healthcare_worker_type` is a STRING ("RN", "CNA") — a non-empty value
      // is the declaration. The rest are canonical booleans.
      if (String(occ.healthcare_worker_type ?? '').trim()) hit.push('healthcare_worker_type')
      for (const key of ['educator', 'ems_worker', 'firefighter']) {
        if (occ[key] === true) hit.push(key)
      }
      return hit
    },
    emit: (values) => ({
      needs: values.map((k) => ({ ...CREDENTIAL_ROLE_ITEMS[k] })).filter(Boolean),
      unmapped: [],
    }),
  }),
  Object.freeze({
    id: 'housing.broadband_speed',
    section: 'housing',
    source: 'derived',
    vocabulary: null,
    read: (s) => {
      const speed = normalizeItemTerm(obj(s.housing).broadband_speed)
      return LOW_BROADBAND.has(speed) ? [speed] : []
    },
    emit: (values) => ({ needs: values.map(() => ({ ...CONNECTIVITY_ITEM })), unmapped: [] }),
  }),
  Object.freeze({
    id: 'programs_services.focus_areas',
    section: 'programs_services',
    source: 'derived',
    vocabulary: 'ITEM_TAG_VOCABULARY',
    read: (s) => list(obj(s.programs_services).focus_areas),
    // A focus area that names no purchasable thing is NOT an unmapped gap —
    // "Discipleship" is a mission, and asking the owner to add it to an item
    // vocabulary would be an unfillable ask (the `lodging`-in-the-disease-lane
    // class). Vocabulary misses are silent here by design.
    emit: (values) => mapThroughVocabulary(values, ITEM_TAG_VOCABULARY, { reportUnmapped: false }),
  }),
  Object.freeze({
    id: 'programs_services.keywords',
    section: 'programs_services',
    source: 'derived',
    vocabulary: 'ITEM_TAG_VOCABULARY',
    read: (s) => list(obj(s.programs_services).keywords),
    emit: (values) => mapThroughVocabulary(values, ITEM_TAG_VOCABULARY, { reportUnmapped: false }),
  }),
  Object.freeze({
    id: 'basic_information.keywords',
    section: 'basic_information',
    source: 'derived',
    vocabulary: 'ITEM_TAG_VOCABULARY',
    read: (s) => list(obj(s.basic_information).keywords),
    emit: (values) => mapThroughVocabulary(values, ITEM_TAG_VOCABULARY, { reportUnmapped: false }),
  }),
])

/**
 * Map declared values through a curated vocabulary. A value that resolves to
 * nothing is returned as `unmapped` (when the rule asks for it) carrying the
 * one-line fix, so the gap CONVERGES instead of recurring nightly.
 */
function mapThroughVocabulary(values, vocabulary, { reportUnmapped = true } = {}) {
  const needs = []
  const unmapped = []
  for (const raw of values) {
    const declared = String(raw ?? '').trim()
    if (!declared) continue
    let hit = null
    for (const [term, entry] of Object.entries(vocabulary)) {
      if (statesTerm(term, declared)) { hit = entry; break }
    }
    if (hit) needs.push({ ...hit })
    else if (reportUnmapped) unmapped.push(declared)
  }
  return { needs, unmapped }
}

/**
 * Does this rule's SECTION apply to this profile type?
 *
 * The gate is the section's own `PROFILE_SCHEMA[...].applies_to`, which is the
 * registry the whole product already uses to decide what a profile may hold. A
 * section with no `applies_to` applies to every type (`isProfileTypeInList`
 * returns true for an empty allowlist), and an UNKNOWN profile type is treated
 * as NEUTRAL — it loses nothing — matching the "MISSING = NEUTRAL everywhere"
 * rule the match-scope gates settled on.
 */
export function ruleAppliesToProfile(rule, primaryType) {
  const appliesTo = PROFILE_SCHEMA?.[rule?.section]?.applies_to
  if (!Array.isArray(appliesTo) || appliesTo.length === 0) return true
  const t = String(primaryType ?? '').trim()
  if (!t) return true
  // AN UNRECOGNIZED TYPE IS NEUTRAL, exactly like a missing one. Measured in
  // prod 2026-08-02: `resolveEffectiveProfileType` resolves Focus Forward
  // Ministry to the FREE TEXT its `organization_details.organization_type`
  // holds — "Faith-based nonprofit ministry" — which `canonicalizeProfileTypeId`
  // cannot map, so `isProfileTypeInList` returned false against ALL_ORG_TYPES
  // and the ministry's own `programs_services` section was reported NOT
  // APPLICABLE to it. That is the wrong failure direction: "the registry does
  // not know this type" must never be read as "this type is excluded", or a
  // profile loses its declared items because an importer wrote prose into a
  // type field. MISSING = NEUTRAL, and so is UNRECOGNIZED.
  if (!RECOGNIZED_PROFILE_TYPES.has(canonicalTypeToken(t))) return true
  return isProfileTypeInList(t, appliesTo)
}

/** Lowercase / underscore the way `canonicalizeProfileTypeId` does, for set lookup. */
function canonicalTypeToken(raw) {
  return String(raw).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_')
}

/**
 * deriveProfileItemNeeds — the canonical item list for ONE profile.
 *
 * @param {object} profile the profiles row (`primary_type` gates person-only rules)
 * @param {object} sections the profile's sections map
 * @returns {{needs: Array, unmapped: Array, consultedFields: string[], silentFields: string[], truncated: number}}
 */
export function deriveProfileItemNeeds(profile = {}, sections = {}) {
  const s = sections ?? {}
  const byKey = new Map()
  const unmapped = []
  const consultedFields = []
  const silentFields = []
  const notApplicableFields = []

  for (const rule of ITEM_NEED_RULES) {
    if (!ruleAppliesToProfile(rule, profile?.primary_type)) {
      notApplicableFields.push(rule.id)
      continue
    }
    consultedFields.push(rule.id)
    let raw = []
    try { raw = rule.read(s) ?? [] } catch { raw = [] }
    if (!Array.isArray(raw) || raw.length === 0) { silentFields.push(rule.id); continue }
    let emitted = { needs: [], unmapped: [] }
    try { emitted = rule.emit(raw) ?? emitted } catch { emitted = { needs: [], unmapped: [] } }
    for (const entry of emitted.unmapped ?? []) {
      unmapped.push(Object.freeze({
        value: entry,
        evidence: rule.id,
        fix: `add ${JSON.stringify(normalizeItemTerm(entry))} to ${rule.vocabulary ?? 'the rule\'s vocabulary'} in backend/config/profileItemNeeds.js`,
      }))
    }
    for (const need of emitted.needs ?? []) {
      const key = normalizeItemTerm(need.item)
      if (!key || byKey.has(key)) continue
      byKey.set(key, Object.freeze({
        item: need.item,
        need_text: need.needText,
        category: need.category ?? null,
        evidence: rule.id,
        source: rule.source,
      }))
    }
    if ((emitted.needs ?? []).length === 0) silentFields.push(rule.id)
  }

  const all = [...byKey.values()]
  return Object.freeze({
    needs: Object.freeze(all.slice(0, MAX_ITEM_NEEDS)),
    truncated: Math.max(0, all.length - MAX_ITEM_NEEDS),
    unmapped: Object.freeze(unmapped),
    consultedFields: Object.freeze(consultedFields),
    silentFields: Object.freeze([...new Set(silentFields)]),
    notApplicableFields: Object.freeze(notApplicableFields),
  })
}

export default {
  ITEM_NEED_RULES,
  SUPPORT_NEED_ITEMS,
  DISABILITY_TYPE_ITEMS,
  HEALTH_FLAG_ITEMS,
  CREDENTIAL_ROLE_ITEMS,
  ITEM_TAG_VOCABULARY,
  MAX_ITEM_NEEDS,
  ruleAppliesToProfile,
  normalizeItemTerm,
  deriveProfileItemNeeds,
}
