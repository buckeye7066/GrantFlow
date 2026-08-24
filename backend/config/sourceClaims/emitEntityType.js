/**
 * emitEntityType.js — the `entity_type` CLAIM emitter (Stage-2 evidence model).
 *
 * An entity-type word ("nonprofit", "university", "institution", "business") is
 * only a hard eligibility bar when it names WHO MAY RECEIVE the award — the
 * STRUCTURED allow-list the crawler wrote into `entity_types_allowed`. The very
 * same word is NOT a bar when it merely sits in the FUNDER's org name
 * ("Robert Wood Johnson FOUNDATION Grant", "United Way — Emergency Assistance")
 * or in free-text prose describing the program. `applicantTypeGate`'s free-text
 * `INSTITUTION_ONLY_PATTERNS` fire on ANY occurrence in the gathered
 * title+description+eligibility blob, which over-rejects an individual-benefit
 * program whose SPONSOR name or DESCRIPTION happens to contain an institutional
 * word.
 *
 * This emitter carries the entity-type VALUE from `applicantTypeGate`'s reader
 * (`entity_types_allowed`, parsed with the same `safeParseArrayField`, and the
 * same wildcard tokens), and attaches the correct SCOPE:
 *
 *   - applicant   → a required entity type stated in the STRUCTURED allow-list
 *                   (the reliable, crawler-set applicant bar). Only this scope
 *                   can hard-reject.
 *   - sponsor     → an entity word inside the FUNDER's org name. Informs fit;
 *                   never an applicant bar.
 *
 * By emitting the applicant bar ONLY from the structured column — never from
 * prose or the sponsor name — the scoped version REDUCES exactly the
 * over-rejection where an institutional word appears in a sponsor/prose context.
 * The bucket comparison stays in `entityTypeApplicantConflict.js`.
 */

import { makeClaim } from './core.js'
import { safeParseArrayField } from '../../services/profileHelpers.js'
import { normalizeApplicantToken } from '../../services/eligibility/farmIdentity.js'

const DIMENSION = 'entity_type'

/** Tokens that mean "unrestricted / not stated", never a concrete entity bar. */
const WILDCARD_TOKENS = new Set(['*', 'any', 'all', 'anyone', 'unrestricted'])

/** The structured columns that carry an allowed-applicant-type list. */
const STRUCTURED_FIELDS = Object.freeze([
  'entity_types_allowed', 'applicant_types', 'eligible_profile_types',
  'eligibility_types', 'eligible_applicants',
])

/** Org-identity words: an entity word wrapped in one of these names a FUNDER. */
const ORG_NAME_WORD_RX =
  /\b(?:foundation|fund|trust|society|association|institute|council|coalition|federation|alliance|university|college|school|district|hospital|center|centre|ministry|church|department|agency|authority|corporation|company|united\s+way|community\s+action)\b/i

/**
 * Every distinct allowed entity type the award STRUCTURALLY declares, deduped,
 * with wildcards dropped. These are the applicant-scoped bar.
 */
function structuredEntityTypes(o) {
  const out = []
  const seen = new Set()
  for (const field of STRUCTURED_FIELDS) {
    const parsed = safeParseArrayField(o?.[field], [])
    if (!Array.isArray(parsed)) continue
    for (const v of parsed) {
      if (v === null || v === undefined) continue
      const lowered = String(v).trim().toLowerCase()
      if (!lowered || WILDCARD_TOKENS.has(lowered)) continue
      const norm = normalizeApplicantToken(lowered) || lowered
      if (!seen.has(norm)) { seen.add(norm); out.push(norm) }
    }
  }
  return out
}

/** True when the award's structured list contains a wildcard (⇒ no entity bar). */
function hasWildcard(o) {
  for (const field of STRUCTURED_FIELDS) {
    const parsed = safeParseArrayField(o?.[field], [])
    if (Array.isArray(parsed) && parsed.some((v) => WILDCARD_TOKENS.has(String(v).trim().toLowerCase()))) {
      return true
    }
  }
  return false
}

/**
 * emitEntityType — the entity-type claims an opportunity makes about itself.
 * @param {object} opportunity  the catalog/candidate row
 * @returns {import('./core.js').Claim[]}
 */
export default function emitEntityType(opportunity = {}) {
  const o = opportunity && typeof opportunity === 'object' ? opportunity : {}
  const claims = []
  const push = (c) => { if (c) claims.push(c) }

  // ── APPLICANT: the structured allow-list is the reliable applicant bar. A
  //    wildcard anywhere in it means "unrestricted" — emit no applicant bar.
  if (!hasWildcard(o)) {
    const evidence = { field: 'entity_types_allowed', text: structuredEntityTypes(o).join(', ') }
    for (const t of structuredEntityTypes(o)) {
      push(makeClaim({ dimension: DIMENSION, value: t, scope: 'applicant', strength: 'explicit', evidence }))
    }
  }

  // ── SPONSOR: an entity word sitting in the FUNDER's org name names the FUNDER,
  //    never the applicant. Emitted as a soft sponsor signal (never a reject).
  const sponsorText = String(o.sponsor ?? o.funder ?? o.organization ?? '')
  if (sponsorText && ORG_NAME_WORD_RX.test(sponsorText)) {
    push(makeClaim({
      dimension: DIMENSION,
      value: 'org',
      scope: 'sponsor',
      strength: 'detected',
      evidence: { field: 'sponsor', text: sponsorText.slice(0, 200) },
    }))
  }

  return claims
}
