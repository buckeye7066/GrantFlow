/**
 * emitJurisdiction.js — the geography/residency emitter for the source-claims
 * evidence model (Stage-2 PoC; see core.js).
 *
 * THE WHOLE POINT HERE IS SCOPE. Today's code conflates three DIFFERENT
 * geographic facts a row can carry, and treats the crawl-stamped `state` column
 * (which is provenance, not a claim) as if it were an applicant bar. This
 * emitter separates them:
 *
 *   • APPLICANT residency  — the row states a residency REQUIREMENT on the
 *     applicant ("Ohio residents only", "must reside in Tennessee"). This is the
 *     only geographic claim that can hard-reject a profile.
 *       → dimension 'residency', scope 'applicant', value = 2-letter state.
 *   • SERVICE AREA         — the award SERVES a place but states no applicant
 *     residency bar (a "<Place>, ST —" locator title, a named service region).
 *     A soft geo signal in this PoC, never an applicant hard-reject.
 *       → dimension 'jurisdiction', scope 'service_area', value = 2-letter state.
 *   • SPONSOR              — the administering body is foreign (a ccTLD host or a
 *     foreign-government funder name). A strong signal, but about the FUNDER.
 *       → dimension 'jurisdiction', scope 'sponsor', value = country code.
 *
 * The bare `state` column ALONE is never emitted: matchEngine notes it is
 * "stamped by whichever profile's crawl minted the row" — crawl provenance, not
 * a fact the source stated about itself.
 *
 * VALUE DETECTION is REUSED, never forked: `detectForeignOpportunity` (funder
 * location: ccTLD host / foreign funder name) and `declaredStateFromTitle` (the
 * row's own declared "<Place>, ST —" service state) are the same functions the
 * geography gate consults.
 *
 * The residency-EXCLUSIVE detector is deliberately RE-DECLARED locally rather
 * than imported from `services/matchEngine.js` (where the canonical
 * `RESIDENCY_EXCLUSIVE_RX` lives). This module is `config/`; matchEngine imports
 * config/, so importing matchEngine back here would close a config↔services
 * import cycle (the ESM import-time boot-crash class) the moment core.js is
 * wired into the engine — the exact reason opportunityJurisdiction.js
 * re-declares `IDENTITY_FRAGMENT_SEPARATOR` instead of importing it. The local
 * pattern accepts the same residency phrasings and adds the "open to <State>
 * residents" shape; the STATE itself is resolved by the canonical
 * `normalizeStateFromText`.
 */

import { makeClaim } from './core.js'
import { detectForeignOpportunity, declaredStateFromTitle } from '../opportunityJurisdiction.js'
import { normalizeStateFromText } from '../../utils/stateNormalization.js'

/**
 * A residency REQUIREMENT the SOURCE states about the applicant. Every space is
 * whitespace-tolerant (`\s+`) so it runs on raw row text without a normalization
 * pass. Mirrors the canonical RESIDENCY_EXCLUSIVE_RX phrasings and additionally
 * catches "open/limited to <State> residents" (no trailing "only"/"facing"/…).
 */
const RESIDENCY_REQUIREMENT_RX = new RegExp(
  '\\b(?:' +
    [
      'residents?\\s+only',
      'must\\s+be\\s+an?\\s+resident',
      'must\\s+reside\\s+in',
      'limited\\s+to\\s+residents',
      'residents?\\s+of\\b',
      '(?:open|limited|exclusively)\\s+(?:to|for)\\s+\\w+(?:\\s+\\w+)?\\s+residents?',
      'for\\s+\\w+(?:\\s+\\w+)?\\s+residents?',
      '\\w+\\s+residents?\\s+(?:only|facing|who|experiencing|must)',
    ].join('|') +
    ')\\b',
  'i',
)

/** The text fields a row may carry residency/eligibility prose in, longest-lived first. */
const TEXT_FIELDS = Object.freeze([
  ['title', (o) => o.title ?? o.name],
  ['eligibility_text', (o) => o.eligibility_text],
  ['eligibility', (o) => o.eligibility],
  ['description', (o) => o.description],
  ['summary', (o) => o.summary],
])

/** Every readable text fragment of a row, with the field it came from. */
function textFragments(opportunity) {
  const out = []
  for (const [field, read] of TEXT_FIELDS) {
    const v = read(opportunity)
    if (typeof v === 'string' && v.trim()) out.push([field, v])
  }
  const bullets = opportunity.eligibility_bullets
  if (Array.isArray(bullets)) {
    const joined = bullets.filter((b) => typeof b === 'string').join(' ').trim()
    if (joined) out.push(['eligibility_bullets', joined])
  }
  return out
}

/**
 * emitJurisdiction — every geographic/residency claim the opportunity makes
 * about ITSELF.
 * @param {object} opportunity
 * @returns {import('./core.js').Claim[]}
 */
export default function emitJurisdiction(opportunity) {
  if (!opportunity || typeof opportunity !== 'object') return []
  const claims = []
  const fragments = textFragments(opportunity)

  // ── APPLICANT residency (hard-reject scope) ───────────────────────────────
  // The row states a residency REQUIREMENT on the applicant. The value is the
  // state named in the SAME fragment that carries the requirement — so a state
  // mentioned only in unrelated prose never becomes an applicant bar.
  let residencyState = null
  for (const [field, text] of fragments) {
    if (!RESIDENCY_REQUIREMENT_RX.test(text)) continue
    const state = normalizeStateFromText(text)
    if (!state) continue
    const phrase = RESIDENCY_REQUIREMENT_RX.exec(text)?.[0] ?? text
    const claim = makeClaim({
      dimension: 'residency',
      value: state,
      scope: 'applicant',
      strength: 'explicit',
      evidence: { field, text: phrase },
    })
    if (claim) {
      claims.push(claim)
      residencyState = state
    }
    break
  }

  // ── SPONSOR (foreign funder / administering body) ─────────────────────────
  // A ccTLD host or a registered foreign-government funder name. Scoped to the
  // FUNDER — a strong identity signal, never an applicant residency bar.
  const foreign = detectForeignOpportunity(opportunity)
  if (foreign?.foreign && foreign.cctld) {
    claims.push(
      makeClaim({
        dimension: 'jurisdiction',
        value: String(foreign.cctld).toUpperCase(),
        scope: 'sponsor',
        strength: 'detected',
        evidence: {
          field: foreign.host ? 'url' : 'sponsor',
          text: foreign.host || foreign.funder || '',
        },
      }),
    )
  }

  // ── SERVICE AREA (the place the award SERVES) ─────────────────────────────
  // A title-declared "<Place>, ST —" service state. It is a soft geo signal, not
  // an applicant bar — so it is emitted only when the row did NOT already state
  // an applicant residency requirement (that governing bar would supersede it).
  if (!residencyState) {
    const serviceState = declaredStateFromTitle(opportunity)
    if (serviceState) {
      const titleFragment = fragments.find(([f]) => f === 'title')
      claims.push(
        makeClaim({
          dimension: 'jurisdiction',
          value: serviceState,
          scope: 'service_area',
          strength: 'detected',
          evidence: {
            field: 'title',
            text: titleFragment ? titleFragment[1] : '',
          },
        }),
      )
    }
  }

  return claims.filter(Boolean)
}
