/**
 * profileFieldMirrors.js — one question, one field, many readers.
 *
 * Owner order 2026-09-08: "there are several fields in the different profile
 * sections that ask for the same information. Please make sure nothing is
 * doubled up." The profile form asked the same thing in two or three places
 * (Demographics > Veteran status AND Military service > Veteran; Financial >
 * Unemployed AND Financial > Employment status AND Employment > Current
 * status; Government assistance > Medicaid recipient self AND Medicaid
 * enrolled; …). Each duplicate has 5–45 readers in matching, Anya, Hamilton
 * and the crawlers, so deleting the legacy keys would silently starve them.
 *
 * The contract instead:
 *   - SECTION_METADATA marks the duplicate (legacy) field `deprecated: true`,
 *     which hides it from every intake/edit surface (ProfileSectionEditor keeps
 *     the stored value as a hidden input so a save never drops it).
 *   - This module derives the legacy value FROM the canonical answer, so every
 *     reader of the legacy key keeps seeing the truth the user actually typed.
 *     `applyProfileFieldMirrors` (backend/services/profileFieldMirrors.js) runs
 *     the rules after every section save and on boot for every profile.
 *   - On the boot backfill only, `seedCanonical` also runs the REVERSE rule:
 *     when the canonical field is still empty but the legacy field carries an
 *     answer from the old form, the canonical field is seeded from it, so the
 *     user is never asked again for something they already told us.
 *
 * Pure / data-driven: no DB, no I/O. Safe to import from the frontend, the
 * backend and tests. Every rule names ONE target (a deprecated field) and the
 * canonical source(s) it is derived from; `tests/unit/sectionMetadataAlignment`
 * pins that every target is deprecated and every source is not.
 */

const EMPTY = Symbol('empty')

export function isEmptyValue(value) {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return Object.keys(value).length === 0
  return false
}

/** boolean_tri reader: true / false / undefined (unanswered). */
export function readTri(value) {
  if (value === true || value === 1) return true
  if (value === false || value === 0) return false
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (['true', 'yes', 'y', '1'].includes(v)) return true
    if (['false', 'no', 'n', '0'].includes(v)) return false
  }
  return undefined
}

function text(value) {
  if (isEmptyValue(value)) return ''
  return String(value).trim()
}

function ageFromDateOfBirth(dob, now = new Date()) {
  const raw = text(dob)
  if (!raw) return null
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return null
  let age = now.getFullYear() - d.getFullYear()
  const m = now.getMonth() - d.getMonth()
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age -= 1
  if (age < 0 || age > 130) return null
  return age
}

export function ageGroupForAge(age) {
  if (age === null || age === undefined) return ''
  if (age < 18) return 'youth'
  if (age < 25) return 'young adult'
  if (age < 65) return 'adult'
  return 'senior'
}

const IMMIGRATION_OPTIONS = ['us_citizen', 'permanent_resident', 'refugee', 'undocumented', 'other', 'unknown']
const EMPLOYMENT_OPTIONS = ['student', 'not_in_labor_force', 'unemployed_seeking', 'employed_full_time', 'employed_part_time', 'self_employed', 'retired']
const HOUSING_STATUS_OPTIONS = ['stable', 'at_risk', 'homeless', 'temporary', 'unknown']

function normalizeEnum(value, options) {
  const v = text(value).toLowerCase().replace(/[\s-]+/g, '_')
  if (!v) return ''
  if (options.includes(v)) return v
  if (v === 'citizen' || v === 'us_citizen' || v === 'united_states_citizen') return options.includes('us_citizen') ? 'us_citizen' : ''
  if (/^(green_card|lpr|permanent)/.test(v)) return options.includes('permanent_resident') ? 'permanent_resident' : ''
  return ''
}

/** Derive one tri-state from a set of canonical tri-states: true if any true, false if any answered, else unanswered. */
function anyTri(values) {
  let answered = false
  for (const v of values) {
    const t = readTri(v)
    if (t === true) return true
    if (t === false) answered = true
  }
  return answered ? false : undefined
}

const DISABILITY_FLAG_LABELS = Object.freeze({
  visual_impairment: 'visual impairment',
  hearing_impairment: 'hearing impairment',
  wheelchair_user: 'wheelchair user',
  tbi_survivor: 'traumatic brain injury',
  amputee: 'amputee',
  mental_health_condition: 'mental health condition',
  neurodivergent: 'neurodivergent',
})

/**
 * The benefit questions, pointed the way the SECTION GUARD actually stores them.
 *
 * `shared/profileSuggestionGuards.js` (`normalizeProfileSectionAliases` +
 * `selfTargetFor`) rewrites the legacy spelling — `medicaid_enrolled`,
 * `ssi_recipient`, `section8_housing`, `<base>_recipient` — onto
 * `<base>_recipient_self` on EVERY save, and the guard is the choke point every
 * write passes through. So `_self` is the key an answer lands in and the legacy
 * key is never written by the form. The legacy key nevertheless has the most
 * readers (`ssi_recipient` 28 files vs `ssi_recipient_self` 8), which is exactly
 * what a mirror is for: the user answers the field the guard stores, and the
 * legacy key is derived from it so its readers keep seeing the truth.
 *
 * `_household` stays hidden and is fed by the guard's OWN evidence routing
 * (`householdTargetFor`), not by a rule — it is on the alignment test's
 * explicit no-mirror list.
 */
function benefitPair(base, legacyKey) {
  const self = `${base}_recipient_self`
  const household = `${base}_recipient_household`
  return [
    {
      target: ['government_assistance', legacyKey],
      sources: [['government_assistance', self]],
      // "you or someone in your household" is the ONE question, so the legacy
      // flag is true when either side of the stored pair is true.
      forward: (get) => anyTri([get('government_assistance', self), get('government_assistance', household)]),
      reverse: (get) => anyTri([get('government_assistance', legacyKey), get('government_assistance', household)]),
      reverseTarget: ['government_assistance', self],
      reverseSources: [['government_assistance', legacyKey], ['government_assistance', household]],
    },
  ]
}

/**
 * Every rule: `target` is the DEPRECATED field that readers still consume,
 * `sources` are the canonical fields the user actually answers, `forward`
 * derives the target from the sources (undefined = sources unanswered, leave
 * the target alone), `reverse` (optional, backfill only) derives the canonical
 * field from the legacy answer when the canonical one is still empty, and
 * `reverseSources` names the legacy fields `reverse` reads when they are not
 * simply `target` (at least one must carry a value for a seed to run).
 */
export const PROFILE_FIELD_MIRROR_RULES = Object.freeze([
  // ── Demographics ──────────────────────────────────────────────────────
  {
    target: ['demographics', 'immigrant_status'],
    sources: [['demographics', 'immigration_status']],
    forward: (get) => text(get('demographics', 'immigration_status')) || undefined,
    reverse: (get) => normalizeEnum(get('demographics', 'immigrant_status'), IMMIGRATION_OPTIONS) || undefined,
    reverseTarget: ['demographics', 'immigration_status'],
  },
  {
    target: ['demographics', 'us_citizen'],
    sources: [['demographics', 'immigration_status']],
    forward: (get) => {
      const v = text(get('demographics', 'immigration_status'))
      if (!v || v === 'unknown') return undefined
      return v === 'us_citizen'
    },
    reverse: (get) => (readTri(get('demographics', 'us_citizen')) === true ? 'us_citizen' : undefined),
    reverseTarget: ['demographics', 'immigration_status'],
  },
  {
    target: ['demographics', 'citizenship'],
    sources: [['demographics', 'immigration_status']],
    forward: (get) => {
      const v = text(get('demographics', 'immigration_status'))
      if (!v || v === 'unknown') return undefined
      return v === 'us_citizen' ? 'US citizen' : v.replace(/_/g, ' ')
    },
    reverse: (get) => normalizeEnum(get('demographics', 'citizenship'), IMMIGRATION_OPTIONS) || (/\b(us|u\.s\.|united states|american)\b/i.test(text(get('demographics', 'citizenship'))) ? 'us_citizen' : undefined),
    reverseTarget: ['demographics', 'immigration_status'],
  },
  {
    target: ['demographics', 'religious_denomination'],
    sources: [['demographics', 'religious_affiliation']],
    forward: (get) => text(get('demographics', 'religious_affiliation')) || undefined,
    reverse: (get) => text(get('demographics', 'religious_denomination')) || undefined,
  },
  {
    target: ['demographics', 'heritage'],
    sources: [['demographics', 'ethnicity']],
    forward: (get) => text(get('demographics', 'ethnicity')) || undefined,
    reverse: (get) => text(get('demographics', 'heritage')) || undefined,
  },
  {
    target: ['demographics', 'veteran_status'],
    sources: [
      ['military_service', 'veteran'],
      ['military_service', 'disabled_veteran'],
      ['military_service', 'active_duty_military'],
      ['military_service', 'national_guard'],
    ],
    forward: (get) => {
      const disabled = readTri(get('military_service', 'disabled_veteran'))
      const veteran = readTri(get('military_service', 'veteran'))
      const active = readTri(get('military_service', 'active_duty_military'))
      const guard = readTri(get('military_service', 'national_guard'))
      if (disabled === true) return 'disabled veteran'
      if (veteran === true) return 'veteran'
      if (active === true) return 'active duty'
      if (guard === true) return 'national guard / reserve'
      if ([disabled, veteran, active, guard].some((v) => v === false)) return ''
      return undefined
    },
    reverse: (get) => (/\bveteran\b/i.test(text(get('demographics', 'veteran_status'))) ? true : undefined),
    reverseTarget: ['military_service', 'veteran'],
  },
  {
    target: ['demographics', 'disability_status'],
    sources: [['health_medical', 'disability_type'], ...Object.keys(DISABILITY_FLAG_LABELS).map((k) => ['health_medical', k])],
    forward: (get) => {
      const types = get('health_medical', 'disability_type')
      const list = Array.isArray(types) ? types.map(text).filter(Boolean) : text(types) ? [text(types)] : []
      const flags = Object.entries(DISABILITY_FLAG_LABELS)
        .filter(([k]) => readTri(get('health_medical', k)) === true)
        .map(([, label]) => label)
      const all = [...new Set([...list, ...flags])]
      if (all.length > 0) return all.join(', ')
      const answered = Object.keys(DISABILITY_FLAG_LABELS).some((k) => readTri(get('health_medical', k)) === false)
      return answered ? '' : undefined
    },
    reverse: (get) => {
      const v = text(get('demographics', 'disability_status'))
      if (!v || /^(none|no|n\/a|not applicable)$/i.test(v)) return undefined
      return v.split(/[,;]/).map((s) => s.trim()).filter(Boolean)
    },
    reverseTarget: ['health_medical', 'disability_type'],
  },
  {
    target: ['demographics', 'age_group'],
    sources: [['basic_information', 'date_of_birth']],
    forward: (get) => {
      const age = ageFromDateOfBirth(get('basic_information', 'date_of_birth'))
      return age === null ? undefined : ageGroupForAge(age)
    },
  },
  {
    target: ['basic_information', 'age'],
    sources: [['basic_information', 'date_of_birth']],
    forward: (get) => {
      const age = ageFromDateOfBirth(get('basic_information', 'date_of_birth'))
      return age === null ? undefined : String(age)
    },
  },
  {
    target: ['demographics', 'gender'],
    sources: [['basic_information', 'gender']],
    forward: (get) => text(get('basic_information', 'gender')) || undefined,
    reverse: (get) => text(get('demographics', 'gender')) || undefined,
  },
  {
    target: ['demographics', 'appalachian_heritage'],
    sources: [['location_focus', 'appalachian_region']],
    forward: (get) => readTri(get('location_focus', 'appalachian_region')),
    reverse: (get) => (readTri(get('demographics', 'appalachian_heritage')) === true ? true : undefined),
  },
  {
    target: ['demographics', 'good_credit_score'],
    sources: [['financial_information', 'credit_score']],
    forward: (get) => {
      const raw = get('financial_information', 'credit_score')
      if (isEmptyValue(raw)) return undefined
      const n = Number(raw)
      if (!Number.isFinite(n)) return undefined
      return n >= 700
    },
  },
  // ── Financial / employment ────────────────────────────────────────────
  {
    target: ['financial_information', 'unemployed'],
    sources: [['financial_information', 'employment_status']],
    forward: (get) => {
      const v = text(get('financial_information', 'employment_status'))
      if (!v) return undefined
      return v === 'unemployed_seeking'
    },
    reverse: (get) => (readTri(get('financial_information', 'unemployed')) === true ? 'unemployed_seeking' : undefined),
    reverseTarget: ['financial_information', 'employment_status'],
  },
  {
    target: ['employment', 'current_status'],
    sources: [['financial_information', 'employment_status']],
    forward: (get) => text(get('financial_information', 'employment_status')) || undefined,
    reverse: (get) => normalizeEnum(get('employment', 'current_status'), EMPLOYMENT_OPTIONS) || undefined,
    reverseTarget: ['financial_information', 'employment_status'],
  },
  // ── Government assistance: `<base>_recipient_self` IS the question (the
  //    guard stores answers there); the legacy spelling is derived. ─────────
  ...benefitPair('medicaid', 'medicaid_enrolled'),
  ...benefitPair('medicare', 'medicare_recipient'),
  ...benefitPair('ssi', 'ssi_recipient'),
  ...benefitPair('ssdi', 'ssdi_recipient'),
  ...benefitPair('snap', 'snap_recipient'),
  ...benefitPair('tanf', 'tanf_recipient'),
  ...benefitPair('section8', 'section8_housing'),
  // ── Family / household / housing ──────────────────────────────────────
  {
    target: ['family_life', 'family_caregiver'],
    sources: [['family_life', 'caregiver']],
    forward: (get) => readTri(get('family_life', 'caregiver')),
    reverse: (get) => (readTri(get('family_life', 'family_caregiver')) === true ? true : undefined),
  },
  {
    target: ['family_life', 'household_size'],
    sources: [['financial_information', 'household_size']],
    forward: (get) => (isEmptyValue(get('financial_information', 'household_size')) ? undefined : get('financial_information', 'household_size')),
    reverse: (get) => (isEmptyValue(get('family_life', 'household_size')) ? undefined : get('family_life', 'household_size')),
  },
  {
    target: ['family', 'household_size'],
    sources: [['financial_information', 'household_size']],
    forward: (get) => (isEmptyValue(get('financial_information', 'household_size')) ? undefined : get('financial_information', 'household_size')),
    reverse: (get) => (isEmptyValue(get('family', 'household_size')) ? undefined : get('family', 'household_size')),
  },
  {
    target: ['family_life', 'homeless'],
    sources: [['housing', 'status']],
    forward: (get) => {
      const v = normalizeEnum(get('housing', 'status'), HOUSING_STATUS_OPTIONS)
      if (!v || v === 'unknown') return undefined
      return v === 'homeless'
    },
    reverse: (get) => (readTri(get('family_life', 'homeless')) === true ? 'homeless' : undefined),
    reverseTarget: ['housing', 'status'],
  },
  // ── Education / basic information ─────────────────────────────────────
  {
    target: ['basic_information', 'current_school'],
    sources: [['education', 'current_institution']],
    forward: (get) => text(get('education', 'current_institution')) || undefined,
    reverse: (get) => text(get('basic_information', 'current_school')) || undefined,
  },
  // ── Organization details vs Story & goals ─────────────────────────────
  {
    target: ['organization_details', 'mission'],
    sources: [['narrative', 'mission']],
    forward: (get) => text(get('narrative', 'mission')) || undefined,
    reverse: (get) => text(get('organization_details', 'mission')) || undefined,
  },
  {
    target: ['nonprofit_compliance', 'sam_registered'],
    sources: [['organization_details', 'sam_gov_registered']],
    forward: (get) => readTri(get('organization_details', 'sam_gov_registered')),
    reverse: (get) => (readTri(get('nonprofit_compliance', 'sam_registered')) === true ? true : undefined),
  },
  {
    target: ['narrative', 'supports'],
    sources: [['health_medical', 'support_needs']],
    forward: (get) => {
      const v = get('health_medical', 'support_needs')
      if (Array.isArray(v)) return v.map(text).filter(Boolean).length ? v.map(text).filter(Boolean) : undefined
      return text(v) ? [text(v)] : undefined
    },
    reverse: (get) => {
      const v = get('narrative', 'supports')
      const list = Array.isArray(v) ? v.map(text).filter(Boolean) : text(v) ? [text(v)] : []
      return list.length ? list : undefined
    },
  },
  {
    target: ['narrative', 'focus_areas'],
    sources: [['programs_services', 'focus_areas']],
    forward: (get) => {
      const v = get('programs_services', 'focus_areas')
      const list = Array.isArray(v) ? v.map(text).filter(Boolean) : text(v) ? [text(v)] : []
      return list.length ? list : undefined
    },
    reverse: (get) => {
      const v = get('narrative', 'focus_areas')
      const list = Array.isArray(v) ? v.map(text).filter(Boolean) : text(v) ? [text(v)] : []
      return list.length ? list : undefined
    },
  },
  {
    target: ['organization_details', 'mission_focus'],
    sources: [['narrative', 'mission']],
    forward: (get) => text(get('narrative', 'mission')) || undefined,
    reverse: (get) => text(get('organization_details', 'mission_focus')) || undefined,
  },
  {
    target: ['organization_details', 'population_served'],
    sources: [['narrative', 'target_population']],
    forward: (get) => text(get('narrative', 'target_population')) || undefined,
    reverse: (get) => text(get('organization_details', 'population_served')) || undefined,
  },
  // ── Essays vs Story & goals ───────────────────────────────────────────
  {
    target: ['essays', 'goals'],
    sources: [['narrative', 'goals']],
    forward: (get) => text(get('narrative', 'goals')) || undefined,
    reverse: (get) => text(get('essays', 'goals')) || undefined,
  },
  {
    target: ['essays', 'personal_statement'],
    sources: [['narrative', 'personal_statement']],
    forward: (get) => text(get('narrative', 'personal_statement')) || undefined,
    reverse: (get) => text(get('essays', 'personal_statement')) || undefined,
  },
])

function sameValue(a, b) {
  if (isEmptyValue(a) && isEmptyValue(b)) return true
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return a === b
  }
}

/**
 * Compute the section patches the mirror rules imply for a profile.
 *
 * @param {Record<string, object>} sections  section_key → data (as stored)
 * @param {{ seedCanonical?: boolean, now?: Date }} [opts]
 * @returns {{ patches: Record<string, Record<string, unknown>>, applied: Array<{section:string, field:string, from:unknown, to:unknown, direction:'forward'|'reverse'}> }}
 */
export function deriveProfileFieldMirrors(sections, { seedCanonical = false } = {}) {
  const store = sections && typeof sections === 'object' ? sections : {}
  const patches = {}
  const applied = []
  const get = (section, field) => {
    const patched = patches[section]
    if (patched && Object.prototype.hasOwnProperty.call(patched, field)) return patched[field]
    const data = store[section]
    return data && typeof data === 'object' && !Array.isArray(data) ? data[field] : undefined
  }
  const set = (section, field, value, direction) => {
    const from = get(section, field)
    if (sameValue(from, value)) return
    patches[section] = patches[section] || {}
    patches[section][field] = value
    applied.push({ section, field, from, to: value, direction })
  }

  if (seedCanonical) {
    // Reverse first, so a legacy answer from the old form becomes the canonical
    // answer BEFORE the forward pass re-derives the legacy key from it.
    for (const rule of PROFILE_FIELD_MIRROR_RULES) {
      if (typeof rule.reverse !== 'function') continue
      const [targetSection, targetField] = rule.reverseTarget || rule.sources[0]
      if (!isEmptyValue(get(targetSection, targetField))) continue
      // The legacy answer may live in ANY of the fields `reverse` reads, not
      // only in `target` — a benefit answered as "<base>_recipient_household"
      // on the old form carries no `target` value, and requiring one there
      // silently skipped the seed (the household-only profile keeps being
      // asked for something it already told us).
      const legacyFields = rule.reverseSources || [rule.target]
      if (legacyFields.every(([s, f]) => isEmptyValue(get(s, f)))) continue
      const value = rule.reverse(get)
      if (value === undefined || value === EMPTY) continue
      set(targetSection, targetField, value, 'reverse')
    }
  }

  for (const rule of PROFILE_FIELD_MIRROR_RULES) {
    const value = rule.forward(get)
    if (value === undefined) continue
    set(rule.target[0], rule.target[1], value, 'forward')
  }

  return { patches, applied }
}

/** Every deprecated field that a mirror rule feeds — the tripwire tests read this. */
export function mirrorTargets() {
  return PROFILE_FIELD_MIRROR_RULES.map((r) => `${r.target[0]}.${r.target[1]}`)
}

export function mirrorSources() {
  const out = new Set()
  for (const r of PROFILE_FIELD_MIRROR_RULES) for (const [s, f] of r.sources) out.add(`${s}.${f}`)
  return [...out]
}

export default { PROFILE_FIELD_MIRROR_RULES, deriveProfileFieldMirrors, mirrorTargets, mirrorSources, readTri, isEmptyValue, ageGroupForAge }
