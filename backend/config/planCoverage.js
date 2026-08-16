/**
 * planCoverage.js — WHAT A PROFILE'S INSURANCE PLAN CLASS TYPICALLY COVERS,
 * keyed by (plan class × condition class).
 *
 * THE OWNER'S RULE (2026-08-15): "Once a profile enters their health insurance
 * information … grantflow should be able to use their insurance plan against
 * their profile to see what items and help they are eligible for. Or even a
 * combination of the health insurance plan and listed issues/ICD10 codes."
 *
 * WHAT THIS IS. A conservative HINT layer over the item lane: when the
 * profile's detected plan class (and, for paired rows, a detected condition
 * class — medical necessity is what actually gates coverage) maps to an item's
 * category, the item carries an eligibility hint phrased as "typically
 * covers … verify with your plan". It answers "what help are you already
 * eligible for" AHEAD of "what needs fundraising".
 *
 * WHAT THIS IS NOT. Not a coverage oracle, not a benefits determination, and
 * not a new admission path: no score changes, no gate changes, no result is
 * added or removed — existing results gain a label. Plan-DOCUMENT specifics
 * are never claimed; every row is a PLAN CLASS generalization with the public
 * basis noted beside it.
 *
 * INPUTS ARE STRUCTURED, MISSING = NEUTRAL. Plan classes come from
 * `medical_insurance` (insurance_provider / plan_type / plan_name tokens) and
 * `government_assistance` (enrollment booleans across BOTH fleet shapes:
 * `medicaid_enrolled` and `medicaid_recipient_self`, etc.). Program names are
 * additionally recognized as word-boundary tokens inside PROGRAM-LIST fields
 * (`other_programs`, `medicaid_waiver_program`) — a declared field's own
 * content, not narrative prose (a real member's ECF CHOICES enrollment lives
 * verbatim in `other_programs`), with a negation guard so "not enrolled in…"
 * declares nothing. A profile with no insurance section and no enrollment
 * flags resolves to ZERO plan classes and sees ZERO change.
 *
 * CONDITION CLASSES reuse the canonical health vocabulary direction: declared
 * `disability_type[]` / `conditions[]` / `chronic_illness_type` strings and
 * the canonical boolean flags — plus ICD-10 CODES appearing as word-boundary
 * tokens inside those SAME declared fields (prod declares "Cognitive
 * disability (F70)" verbatim). `ICD10_TO_CONDITION` maps code prefixes to the
 * SAME condition-class tokens the string vocabulary uses — one taxonomy, two
 * spellings, totality-tested.
 */

/** Recognized plan classes. Coverage rules may only reference these. */
export const PLAN_CLASSES = Object.freeze([
  'medicaid', // incl. TennCare — state Medicaid programs
  'medicaid_waiver', // HCBS waivers: ECF CHOICES / CHOICES / Katie Beckett class
  'medicare', // Part A/B (original Medicare)
  'medicare_advantage', // Part C
  'commercial', // employer / marketplace private plans
])

/** Recognized condition classes. One vocabulary for strings AND ICD codes. */
export const CONDITION_CLASSES = Object.freeze([
  'mobility_impairment', // wheelchair use, grip/dexterity loss, musculoskeletal
  'diabetes',
  'vision_impairment',
  'hearing_impairment',
  'neuro_cognitive', // epilepsy, brain injury, cognitive/developmental (F70 class), autism, dementia
  'cardiac',
  'respiratory',
])

/**
 * ICD-10 PREFIX → condition class. Prefix match on a word-boundary code token
 * (E11, E11.9, F70, Z74.09 …) found inside a DECLARED structured health field.
 * Never a parallel taxonomy: targets are CONDITION_CLASSES members only
 * (totality-tested). Unknown codes resolve to nothing.
 */
export const ICD10_TO_CONDITION = Object.freeze({
  E08: 'diabetes', E09: 'diabetes', E10: 'diabetes', E11: 'diabetes', E13: 'diabetes',
  F70: 'neuro_cognitive', F71: 'neuro_cognitive', F72: 'neuro_cognitive', F73: 'neuro_cognitive',
  F78: 'neuro_cognitive', F79: 'neuro_cognitive', F84: 'neuro_cognitive',
  G30: 'neuro_cognitive', G31: 'neuro_cognitive', G40: 'neuro_cognitive', G93: 'neuro_cognitive',
  G80: 'mobility_impairment', G81: 'mobility_impairment', G82: 'mobility_impairment',
  M05: 'mobility_impairment', M06: 'mobility_impairment', M15: 'mobility_impairment',
  M16: 'mobility_impairment', M17: 'mobility_impairment', M19: 'mobility_impairment',
  Z74: 'mobility_impairment', // reduced mobility / care-provider dependency
  H54: 'vision_impairment', H35: 'vision_impairment', H33: 'vision_impairment',
  H90: 'hearing_impairment', H91: 'hearing_impairment',
  I10: 'cardiac', I11: 'cardiac', I20: 'cardiac', I25: 'cardiac', I50: 'cardiac',
  J44: 'respiratory', J45: 'respiratory', J96: 'respiratory',
})

/**
 * Declared-string vocabulary → condition class. Same both-direction
 * token-boundary containment discipline as the item vocabularies (≥4 chars,
 * multi-word where a single word would be a coincidence magnet).
 */
export const CONDITION_TERM_VOCABULARY = Object.freeze({
  'wheelchair': 'mobility_impairment',
  'mobility': 'mobility_impairment',
  'clawing effect': 'mobility_impairment',
  'grip strength': 'mobility_impairment',
  'arthritis': 'mobility_impairment',
  'paralysis': 'mobility_impairment',
  'amputation': 'mobility_impairment',
  'amputee': 'mobility_impairment',
  'diabetes': 'diabetes',
  'diabetic': 'diabetes',
  'retina detachment': 'vision_impairment',
  'retinal detachment': 'vision_impairment',
  'blind': 'vision_impairment',
  'low vision': 'vision_impairment',
  'visual impairment': 'vision_impairment',
  'deaf': 'hearing_impairment',
  'hearing loss': 'hearing_impairment',
  'hearing impairment': 'hearing_impairment',
  'epilepsy': 'neuro_cognitive',
  'seizure': 'neuro_cognitive',
  'brain injury': 'neuro_cognitive',
  'cognitive disability': 'neuro_cognitive',
  'dementia': 'neuro_cognitive',
  'alzheimer': 'neuro_cognitive',
  'autism': 'neuro_cognitive',
  'cerebral palsy': 'mobility_impairment',
  'heart disease': 'cardiac',
  'heart failure': 'cardiac',
  'hypertension': 'cardiac',
  'copd': 'respiratory',
  'asthma': 'respiratory',
})

/**
 * Program-name tokens recognized inside PROGRAM-LIST fields (`other_programs`,
 * `medicaid_waiver_program`). Names, never topics. A matching segment that
 * begins with a negation declares nothing.
 */
const WAIVER_PROGRAM_TOKENS = Object.freeze([
  'ecf choices', 'employment and community first', 'tenncare choices',
  'katie beckett', 'medicaid waiver', 'hcbs waiver', 'choices program',
])
const NEGATION_RX = /^(?:no\b|not\b|none\b|denied\b|denies\b|without\b|never\b|ineligible\b)/i

/** Lowercase, punctuation → space, collapsed — the item-lane normalizer. */
function norm(v) {
  return String(v ?? '').toLowerCase().replace(/[^a-z0-9.]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function tokenContains(haystack, term) {
  const h = ` ${norm(haystack)} `
  const t = norm(term)
  return t.length >= 4 && h.includes(` ${t} `)
}

function obj(v) {
  if (!v) return {}
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return p && typeof p === 'object' ? p : {} } catch { return {} }
  }
  return typeof v === 'object' ? v : {}
}

function programListDeclares(fieldValue, tokens) {
  const segments = String(fieldValue ?? '').split(/[;,.]/)
  for (const seg of segments) {
    const s = norm(seg)
    if (!s || NEGATION_RX.test(s)) continue
    for (const t of tokens) {
      if (` ${s} `.includes(` ${norm(t)} `)) return true
    }
  }
  return false
}

/**
 * resolvePlanClasses — the profile's detected plan classes, from STRUCTURED
 * fields only. Empty array when nothing is declared (missing = neutral).
 */
export function resolvePlanClasses(sections = {}) {
  const ins = obj(sections.medical_insurance)
  const ga = obj(sections.government_assistance)
  const classes = new Set()

  const insText = norm([ins.insurance_provider, ins.plan_type, ins.plan_name].filter(Boolean).join(' '))
  if (insText.includes('medicaid') || insText.includes('tenncare')) classes.add('medicaid')
  if (/\bmedicare advantage\b|\bpart c\b|\bma plan\b/.test(insText)) classes.add('medicare_advantage')
  else if (insText.includes('medicare')) classes.add('medicare')
  // A named commercial carrier / employer plan with no public-program token.
  if (insText && !classes.size && /\b(?:bcbs|blue cross|aetna|cigna|united|humana|employer|commercial|marketplace|ppo|hmo)\b/.test(insText)) {
    classes.add('commercial')
  }

  // Enrollment booleans — BOTH fleet shapes (measured in prod 2026-08-15:
  // `medicaid_enrolled` ×3 rows, `medicaid_recipient_self` ×28).
  if (ga.medicaid_enrolled === true || ga.medicaid_recipient_self === true) classes.add('medicaid')
  if (ga.medicare_enrolled === true || ga.medicare_recipient_self === true) classes.add('medicare')

  // Waiver programs: a truthy structured waiver field, or a program NAME
  // declared inside a program-list field (the real member's `other_programs` holds
  // "Medicaid Waiver Program (ECF CHOICES - TN)" verbatim).
  const waiverField = ga.medicaid_waiver_program
  // `medical_insurance.notes` is PROSE and is deliberately never read here.
  const waiverDeclared =
    waiverField === true ||
    (typeof waiverField === 'string' && waiverField.trim() && !NEGATION_RX.test(norm(waiverField))) ||
    programListDeclares(ga.other_programs, WAIVER_PROGRAM_TOKENS)
  if (waiverDeclared) { classes.add('medicaid_waiver'); classes.add('medicaid') }

  return [...classes]
}

/** ICD-10 code tokens (word-boundary) inside a declared string. */
export function icdCodesIn(value) {
  const out = []
  const text = String(value ?? '').toUpperCase()
  for (const m of text.matchAll(/(?<![A-Z0-9])([A-Z]\d{2})(?:\.\d{1,4})?(?![A-Z0-9])/g)) {
    out.push(m[1])
  }
  return out
}

/**
 * resolveCoverageConditionClasses — condition classes from the declared
 * structured health fields (arrays + short scalar type fields + canonical
 * boolean flags + ICD codes inside those same declared values). Prose fields
 * (notes, histories) are never read.
 */
export function resolveCoverageConditionClasses(sections = {}) {
  const hm = obj(sections.health_medical)
  const mh = obj(sections.medical_history)
  const classes = new Set()

  const declaredStrings = []
  for (const arr of [hm.disability_type, hm.conditions, hm.support_needs, mh.dme_needed, mh.secondary_conditions]) {
    if (Array.isArray(arr)) declaredStrings.push(...arr)
  }
  if (typeof hm.chronic_illness_type === 'string') declaredStrings.push(hm.chronic_illness_type)

  for (const raw of declaredStrings) {
    for (const [term, cls] of Object.entries(CONDITION_TERM_VOCABULARY)) {
      if (tokenContains(raw, term)) classes.add(cls)
    }
    for (const code of icdCodesIn(raw)) {
      const cls = ICD10_TO_CONDITION[code]
      if (cls) classes.add(cls)
    }
  }

  // Canonical boolean flags that NAME a condition.
  if (hm.wheelchair_user === true) classes.add('mobility_impairment')
  if (hm.visual_impairment === true) classes.add('vision_impairment')
  if (hm.hearing_impairment === true) classes.add('hearing_impairment')
  if (hm.autism === true || hm.epilepsy === true) classes.add('neuro_cognitive')
  if (hm.diabetes === true) classes.add('diabetes')

  return [...classes]
}

/**
 * THE COVERAGE RULES. `condition: null` rows need no diagnosis key (class-level
 * benefits); paired rows require BOTH keys. `categories` reference the item
 * lane's own category tokens. Public basis for each row is noted — CLASS-level
 * facts, never plan-document claims.
 */
export const COVERAGE_RULES = Object.freeze([
  // Rule order IS precedence (first match wins in annotateItemsWithCoverage):
  // the waiver row sits above plain medicaid so an ECF CHOICES enrollee's
  // hint names the waiver — the more specific benefit — not base Medicaid.
  // ECF CHOICES' published service list: assistive technology, adaptive
  // equipment and supplies, minor home modifications, personal assistance,
  // respite (TennCare ECF CHOICES member materials).
  { plan: 'medicaid_waiver', condition: null, categories: ['adaptive_equipment', 'mobility', 'medical_equipment', 'housing'], note: 'HCBS waiver programs (e.g. ECF CHOICES) typically cover assistive technology, adaptive equipment and supplies, and minor home modifications' },
  // Medicaid covers DME with medical necessity (42 CFR 440.70 class).
  { plan: 'medicaid', condition: 'mobility_impairment', categories: ['mobility', 'medical_equipment', 'adaptive_equipment'], note: 'Medicaid typically covers medically necessary durable medical equipment and mobility aids' },
  { plan: 'medicaid', condition: 'diabetes', categories: ['medical', 'medical_equipment'], note: 'Medicaid typically covers diabetes supplies and monitoring equipment as medically necessary' },
  { plan: 'medicaid', condition: 'vision_impairment', categories: ['medical_equipment', 'adaptive_equipment'], note: 'Medicaid typically covers medically necessary low-vision aids (state benefits vary)' },
  { plan: 'medicaid', condition: 'hearing_impairment', categories: ['medical_equipment', 'adaptive_equipment'], note: 'Medicaid typically covers hearing aids and assistive listening devices in many states' },
  // Medicare Part B DME benefit (medicare.gov DME coverage class).
  { plan: 'medicare', condition: 'mobility_impairment', categories: ['mobility', 'medical_equipment'], note: 'Medicare Part B typically covers medically necessary durable medical equipment such as wheelchairs and walkers' },
  { plan: 'medicare', condition: 'diabetes', categories: ['medical', 'medical_equipment'], note: 'Medicare Part B typically covers glucose monitors and diabetes testing supplies' },
  // MA plans commonly carry OTC/flex allowances — class-level only.
  { plan: 'medicare_advantage', condition: null, categories: ['medical', 'medical_equipment'], note: 'Many Medicare Advantage plans include over-the-counter or flex allowances for health items' },
  // Commercial plans: DME with prior authorization, class-level.
  { plan: 'commercial', condition: 'mobility_impairment', categories: ['mobility', 'medical_equipment'], note: 'Commercial plans typically cover durable medical equipment with prior authorization' },
])

/**
 * annotateItemsWithCoverage — add an `eligibility_hint` to items whose
 * category a (plan × condition) rule covers. Items are returned UNCHANGED in
 * membership and order; only the label is added. Zero detected plan classes →
 * the input array object is returned as-is (missing = neutral, provably).
 */
export function annotateItemsWithCoverage(items, { planClasses = [], conditionClasses = [] } = {}) {
  if (!Array.isArray(items) || items.length === 0 || planClasses.length === 0) return items
  const plans = new Set(planClasses)
  const conditions = new Set(conditionClasses)
  return items.map((item) => {
    const category = String(item?.category ?? '')
    if (!category) return item
    for (const rule of COVERAGE_RULES) {
      if (!plans.has(rule.plan)) continue
      if (rule.condition !== null && !conditions.has(rule.condition)) continue
      if (!rule.categories.includes(category)) continue
      const conditionPart = rule.condition ? `with your declared ${rule.condition.replace(/_/g, ' ')}, ` : ''
      return {
        ...item,
        eligibility_hint: Object.freeze({
          plan_class: rule.plan,
          condition_class: rule.condition,
          note: `${conditionPart}${rule.note} — check with your plan before fundraising for this item.`,
        }),
      }
    }
    return item
  })
}

export default {
  PLAN_CLASSES,
  CONDITION_CLASSES,
  ICD10_TO_CONDITION,
  CONDITION_TERM_VOCABULARY,
  COVERAGE_RULES,
  resolvePlanClasses,
  resolveCoverageConditionClasses,
  annotateItemsWithCoverage,
  icdCodesIn,
}
