/**
 * emitCondition.js — the `condition` CLAIM emitter (Stage-2 evidence model).
 *
 * A disease-specific award ("Autism Speaks Scholarship", "American Kidney Fund
 * Grant") names a NAMED condition its recipient must have. The condition
 * VOCABULARY (the VALUE) is REUSED wholesale from `opportunityNormalizer`'s
 * `DISEASE_SPECIFIC_PATTERNS` — the same list that sets `oppNorm.diseaseSpecific`
 * — so this emitter forks no second disease list.
 *
 * DELICATE, and deliberately conservative:
 *   - Only a CONCRETE condition NAME is emitted (cancer, autism, arthritis,
 *     epilepsy, …). The generic disease-SPECIFICITY markers in that list
 *     ("rare disease", "diagnosed with", "condition-specific") say a row is
 *     disease-specific but name no condition to compare against, so they emit
 *     NOTHING — an unnameable condition can never be a provable applicant
 *     mismatch (silence is neutral).
 *   - The scope is APPLICANT: a disease-specific award's condition is a
 *     requirement on who may receive it. Each field is scanned separately
 *     (#1086), so the evidence phrase is one a single field actually contains.
 *
 * The alignment/neutrality semantics (a bare disability flag is NEUTRAL, a
 * profile with a DIFFERENT named condition conflicts) live in
 * `conditionApplicantConflict.js`, which reuses `conditionSpecificity.js`.
 */

import { makeClaim } from './core.js'
import { DISEASE_SPECIFIC_PATTERNS } from '../../services/opportunityNormalizer.js'
import { GENERIC_CONDITION_WORDS, GENERIC_HEALTH_DESCRIPTORS } from '../sourceLanes.js'

const DIMENSION = 'condition'

/** The disease-SPECIFICITY markers that name no concrete condition. */
const NON_NAMING_MARKERS = new Set([
  'rare disease', 'rare disorder', 'specific diagnosis', 'diagnosed with',
  'living with this condition', 'condition-specific', 'disease-specific',
])

/** Concrete condition NAMES from the shared vocabulary (generic markers dropped). */
const CONCRETE_CONDITIONS = Object.freeze(
  DISEASE_SPECIFIC_PATTERNS.filter(
    (p) => !NON_NAMING_MARKERS.has(p)
      && !GENERIC_CONDITION_WORDS.has(p)
      && !GENERIC_HEALTH_DESCRIPTORS.has(p),
  ),
)

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The row's own fields, each scanned separately (never joined). */
function fragments(o) {
  const out = []
  const push = (field, value) => {
    const s = String(value ?? '').trim()
    if (s) out.push({ field, text: s })
  }
  push('title', o.title)
  push('sponsor', o.sponsor ?? o.funder ?? o.organization)
  push('eligibility_text', o.eligibility_text ?? o.eligibilityText)
  const bullets = Array.isArray(o.eligibility_bullets)
    ? o.eligibility_bullets
    : Array.isArray(o.eligibilityBullets) ? o.eligibilityBullets : []
  bullets.forEach((b, i) => push(`eligibility_bullets[${i}]`, b))
  push('description', o.description ?? o.summary)
  return out
}

/**
 * emitCondition — the concrete named conditions this award requires. One claim
 * per distinct condition, applicant-scoped.
 *
 * @param {object} opportunity  the catalog/candidate row
 * @returns {import('./core.js').Claim[]}
 */
export default function emitCondition(opportunity = {}) {
  const o = opportunity && typeof opportunity === 'object' ? opportunity : {}
  const claims = []
  const seen = new Set()
  for (const frag of fragments(o)) {
    const hay = frag.text.toLowerCase()
    for (const cond of CONCRETE_CONDITIONS) {
      if (seen.has(cond)) continue
      if (new RegExp(`\\b${escapeRe(cond)}`, 'i').test(hay)) {
        seen.add(cond)
        const c = makeClaim({
          dimension: DIMENSION, value: cond, scope: 'applicant', strength: 'detected',
          evidence: { field: frag.field, text: frag.text.slice(0, 200) },
        })
        if (c) claims.push(c)
      }
    }
  }
  return claims
}
