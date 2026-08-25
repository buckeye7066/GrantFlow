/**
 * emitGender.js — the `gender` CLAIM emitter (Stage-2 evidence model).
 *
 * A gender-exclusivity phrase is inherently an APPLICANT bar: "women only",
 * "must be female", "men only" all name who may RECEIVE the award. The detection
 * VOCABULARY is REUSED wholesale from the canonical classifiers the match engine
 * and the normalizer already share — `WOMEN_EXCLUSIVE_OPPORTUNITY_PATTERN`
 * (`demographicRestrictionPatterns.js`) and `MEN_ONLY_PATTERNS`
 * (`opportunityNormalizer.js`) — so this emitter forks no second gender rule.
 *
 * These patterns already REQUIRE exclusivity phrasing ("only", "must be"), so a
 * funder name that merely contains a gender word ("Society of Women Engineers
 * Scholarship") never matches — there is no sponsor-name false positive for this
 * dimension, which is why gender is APPLICANT-scoped only. Each field is scanned
 * as its own fragment (#1086) so the matched phrase in the evidence is one a
 * single field actually contains.
 */

import { makeClaim } from './core.js'
import { WOMEN_EXCLUSIVE_OPPORTUNITY_PATTERN } from '../demographicRestrictionPatterns.js'
import { MEN_ONLY_PATTERNS } from '../../services/opportunityNormalizer.js'

const DIMENSION = 'gender'

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
 * emitGender — at most ONE applicant gender claim. Female-only wins if both
 * somehow appear (a self-contradicting row is not our problem to reconcile;
 * the first precise hit is reported).
 *
 * @param {object} opportunity  the catalog/candidate row
 * @returns {import('./core.js').Claim[]}
 */
export default function emitGender(opportunity = {}) {
  const o = opportunity && typeof opportunity === 'object' ? opportunity : {}
  for (const frag of fragments(o)) {
    const w = WOMEN_EXCLUSIVE_OPPORTUNITY_PATTERN.exec(frag.text)
    if (w) {
      const c = makeClaim({
        dimension: DIMENSION, value: 'female', scope: 'applicant', strength: 'explicit',
        evidence: { field: frag.field, text: w[0].trim() },
      })
      return c ? [c] : []
    }
    for (const rx of MEN_ONLY_PATTERNS) {
      const m = rx.exec(frag.text)
      if (m) {
        const c = makeClaim({
          dimension: DIMENSION, value: 'male', scope: 'applicant', strength: 'explicit',
          evidence: { field: frag.field, text: m[0].trim() },
        })
        return c ? [c] : []
      }
    }
  }
  return []
}
