/**
 * conditionSpecificity.js — does THIS opportunity's condition match a condition
 * the profile actually NAMED?
 *
 * THE DEFECT THIS CLOSES (owner audit of Demo Tennessee STEM Student, 2026-08-03).
 * Her profile carries `demographics.disability_status = "Has disability"` while
 * her own health sections state "No confirmed medical conditions" — a disability
 * with NO NAMED CONDITION. The planner-side gate
 * (`sourceLanes.sourceServesDeclaredCondition`, shipped 2026-08-02) stopped the
 * condition CRAWLER LANES from firing on that bare flag, but the MATCH ENGINE
 * still treated the flag as full condition evidence: `evaluateEligibility` and
 * `makeDecision` both exempt a disease-specific row from their condition gate
 * whenever `hasDisabilityNeed`/`needCategories.includes('disability')` is true,
 * and the flag mints exactly that need. Result: her 116 crawler matches carried
 * a block of condition-specific programs — Brain Injury Association, Autism
 * Speaks, Arthritis Foundation, Amputee Coalition, Reeve Foundation, NORD, HLAA
 * hearing aids — admitted and scored on a flag that names no condition.
 *
 * THE RULE (same shape as the lane gate, applied at the engine choke point):
 *   - A profile with a NAMED matching condition keeps its boost and admission.
 *   - A bare/unnamed disability flag is NEUTRAL toward a condition-specific
 *     row: it buys no score contribution and no ACCEPT — at most a REVIEW.
 *     It is NEVER a new hard reject ("these programs may still serve general
 *     disability" — reduce/neutralize, do not invent rejects).
 *   - A profile with no health signal at all keeps the PRE-EXISTING behavior
 *     (the condition gate's ineligibility/REJECT), unchanged by this module.
 *
 * VOCABULARY DISCIPLINE: generic category-of-person words are refused on the
 * profile side via the SAME registries the lane gate uses
 * (`GENERIC_HEALTH_DESCRIPTORS`, `GENERIC_CONDITION_WORDS` — sourceLanes.js),
 * so `disability`, `special needs`, `physical disability` never count as a
 * named condition here either. Negated prose ("No confirmed medical
 * conditions") never mints a condition — the #1095 "veteran inside its own
 * denial" class, one vocabulary over.
 *
 * Pure predicates, no I/O.
 */

import {
  GENERIC_HEALTH_DESCRIPTORS,
  GENERIC_CONDITION_WORDS,
  containsTerm,
} from './sourceLanes.js'

/**
 * Prose shapes that are a DENIAL or an unknown, not a diagnosis. A condition
 * string starting with (or equal to) one of these must never become a named
 * condition — "No confirmed medical conditions" is how the motivating profile
 * states its own health sections.
 */
const NEGATION_PREFIX_RX = /^(?:no\b|none\b|n\/a\b|na\b|not\b|denies\b|denied\b|without\b|unknown\b|nothing\b)/i

/** Boolean health-section flags that NAME a condition (flag key → condition term). */
export const NAMED_CONDITION_FLAGS = Object.freeze({
  hearing_impairment: 'hearing impairment',
  visual_impairment: 'visual impairment',
  autism: 'autism',
  epilepsy: 'epilepsy',
  diabetes: 'diabetes',
  cancer: 'cancer',
})

/** Normalize one candidate condition string; return null when it is not a NAME. */
function normalizeConditionTerm(value) {
  const raw = String(value ?? '')
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!raw || raw.length < 4) return null
  if (NEGATION_PREFIX_RX.test(raw)) return null
  if (GENERIC_CONDITION_WORDS.has(raw) || GENERIC_HEALTH_DESCRIPTORS.has(raw)) return null
  return raw
}

/**
 * Split a free-text conditions field ("arthritis; type 2 diabetes, anxiety")
 * into candidate terms. Comma/semicolon/newline separated — never word-split,
 * so "type 2 diabetes" stays one term.
 */
function splitConditionList(value) {
  if (Array.isArray(value)) return value.flatMap((v) => splitConditionList(v))
  return String(value ?? '').split(/[,;\n/]+/)
}

/**
 * The profile's NAMED conditions, from every surface that can name one:
 * `profileNorm.namedHealthConditions` (profileNormalizer's health-section read)
 * plus `signals.health_conditions` (profileHelpers' diagnosis-provenance set).
 * Bare flags ("Has disability") contribute NOTHING here by construction.
 */
export function namedProfileConditions(profileNorm = null, signals = null) {
  const out = new Set()
  for (const v of profileNorm?.namedHealthConditions ?? []) {
    const t = normalizeConditionTerm(v)
    if (t) out.add(t)
  }
  const sigConditions = signals?.health_conditions
  const iterable = sigConditions instanceof Set ? sigConditions : Array.isArray(sigConditions) ? sigConditions : []
  for (const v of iterable) {
    const t = normalizeConditionTerm(v)
    if (t) out.add(t)
  }
  return [...out]
}

/**
 * Does the opportunity's OWN text state one of the profile's named conditions?
 *
 * Match rule, in order of strictness:
 *   1. whole-term token-boundary containment in either direction
 *      (`autism` ⊂ "living with autism"; "hearing impairment" ⊂ text);
 *   2. a DISTINCTIVE token of a multi-word condition ("hearing" from
 *      "hearing impairment" reaching "Hearing Loss Association") — generic
 *      shape words are dropped first, so "physical disability" contributes
 *      no token at all.
 *
 * Direction of error is deliberate: a FALSE POSITIVE here merely preserves the
 * pre-gate behavior (the profile keeps its boost), while a false negative
 * would drop a genuinely-matching condition to REVIEW. The one-shared-word
 * risk (#937) is bounded because this predicate only runs on rows already
 * detected as condition-specific.
 */
export function opportunityStatesCondition(oppText, conditions = []) {
  const hay = String(oppText ?? '').toLowerCase()
  if (!hay) return null
  for (const condition of conditions) {
    if (containsTerm(hay, condition)) return condition
    const tokens = condition
      .split(/\s+/)
      .filter((t) => t.length >= 4 && !GENERIC_CONDITION_WORDS.has(t) && !GENERIC_HEALTH_DESCRIPTORS.has(t))
    if (tokens.some((t) => containsTerm(hay, t))) return condition
  }
  return null
}

/**
 * Three-way assessment for a CONDITION-SPECIFIC opportunity:
 *   'named'   — the profile names a condition this row's own text states
 *               (boost and admission are KEPT);
 *   'unnamed' — the profile carries a disability/chronic-illness signal but
 *               names no condition this row states (NEUTRAL: no score gain,
 *               no ACCEPT, never a new reject);
 *   'none'    — the profile has no disability/chronic-illness signal at all
 *               (the caller keeps its pre-existing behavior).
 * Returns null when the opportunity is not condition-specific.
 */
export function conditionSpecificAlignment({ profileNorm, signals = null, oppNorm, oppText = '' }) {
  if (!oppNorm?.diseaseSpecific) return null
  // The signal is the EXPLICIT flags only — never needCategories, which carry
  // buildProfileSignals' type-shaped FALLBACK needs ('healthcare' →
  // 'health_medical') for a sparse profile (#1094 `needsDefaulted`: "we could
  // not read it" ≠ "there is a health need"). Keying on them would turn the
  // pre-existing no-signal REJECT into a pass for every sparse profile.
  const hasSignal = Boolean(profileNorm?.hasDisabilityNeed || profileNorm?.hasChronicIllness)
  const conditions = namedProfileConditions(profileNorm, signals)
  const text = oppText || [oppNorm?.title, ...(oppNorm?.keywords ?? [])].filter(Boolean).join(' ')
  if (conditions.length > 0 && opportunityStatesCondition(text, conditions)) return 'named'
  return hasSignal ? 'unnamed' : 'none'
}

export default {
  NAMED_CONDITION_FLAGS,
  namedProfileConditions,
  opportunityStatesCondition,
  conditionSpecificAlignment,
}
