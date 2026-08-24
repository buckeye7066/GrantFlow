/**
 * emitAidType.js — the `aid_type` CLAIM emitter (Stage-2 evidence model).
 *
 * A household that has decided against a KIND of aid (a loan is debt with the
 * student's name on it; work-study is a job) must never find one sitting in the
 * pipeline as though it were an award. The award's aid type is classified from
 * its OWN NAME using the canonical `classifyAidType` (`aidTypePreferences.js`) —
 * TITLE + amount/status label only, never description prose, exactly as
 * `evaluateOpportunityAgainstPreferences` does, so a scholarship page that merely
 * mentions a loan option is never mis-classified as one. This forks no second aid
 * taxonomy.
 *
 * SCOPE. A declined aid type is a hard applicant-side filter (the owner rule:
 * "no loans, only grants/endowments/scholarships"), so the claim is
 * APPLICANT-scoped. An `unknown` type is NEVER a claim — refusing to record an
 * award because we could not name its type would hide real money from a student.
 */

import { makeClaim } from './core.js'
import { classifyAidType } from '../aidTypePreferences.js'

const DIMENSION = 'aid_type'

/**
 * emitAidType — at most ONE aid-type claim, classified from the award's own name.
 * @param {object} opportunity  the catalog/candidate row
 * @returns {import('./core.js').Claim[]}
 */
export default function emitAidType(opportunity = {}) {
  const o = opportunity && typeof opportunity === 'object' ? opportunity : {}
  const title = String(o.title ?? '')
  if (!title.trim()) return []

  const aidType = classifyAidType({
    title,
    amountDisplay: o.amount_text ?? o.amountDisplay ?? '',
    status: o.amount_status ?? o.status ?? '',
    // description deliberately omitted — the row's own NAME classifies it.
  })
  if (aidType === 'unknown') return []

  const c = makeClaim({
    dimension: DIMENSION,
    value: aidType,
    scope: 'applicant',
    strength: 'detected',
    evidence: { field: 'title', text: title.slice(0, 200) },
  })
  return c ? [c] : []
}
