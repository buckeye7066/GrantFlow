/**
 * sourceClaims/core.js — the SHARED CONTRACT for the evidence model
 * (Stage-2 proof-of-concept; see docs/architecture/evidence-model-diagnosis.md).
 *
 * A source makes CLAIMS about itself. Each claim carries a VALUE, a SCOPE (what
 * the value is ABOUT — the dimension GrantFlow omits today and the reason a
 * sponsor name trips an applicant restriction), a STRENGTH, and EVIDENCE.
 *
 * This is the opportunity-side twin of profileDerivedFacts.DERIVED_FACT_FIELDS.
 * The per-dimension EMITTERS live in their own files and each export a default
 * `emit(opportunity) => Claim[]`. This file aggregates them (`deriveSourceClaims`),
 * reads the profile side (`profileFactsFor`), and compares (`applicantConflicts`).
 *
 * PoC dimensions: field_of_study, profession, jurisdiction/residency.
 */

import emitFieldOfStudy from './emitFieldOfStudy.js'
import emitProfession from './emitProfession.js'
import emitJurisdiction from './emitJurisdiction.js'

/** WHAT a claim's value is ABOUT. The missing dimension. */
export const SCOPES = Object.freeze([
  'applicant', // who may RECEIVE the award (the only scope that can hard-reject)
  'beneficiary', // who the award ultimately serves (also applicant-like for reject)
  'sponsor', // who FUNDS/administers it (identity, never an applicant bar)
  'institution', // a school/org the award is tied to (not an applicant trait)
  'service_area', // the geography the award SERVES (a residency requirement only if stated so)
  'award', // a property of the award itself (amount, deadline)
])

/** The scopes under which a provable mismatch is a HARD eligibility conflict. */
export const APPLICANT_SCOPES = Object.freeze(['applicant', 'beneficiary'])

/** The kinds of fact a claim can carry. */
export const DIMENSIONS = Object.freeze([
  'field_of_study', 'profession', 'jurisdiction', 'residency',
  // (future) 'entity_type','academic_stage','gender','condition','military_service','aid_type','need','award_ceiling'
])

/**
 * @typedef {Object} Claim
 * @property {string} dimension  one of DIMENSIONS
 * @property {string} value      canonical value (e.g. 'nursing', 'OH')
 * @property {string} scope      one of SCOPES
 * @property {'explicit'|'inferred'|'detected'} strength
 * @property {{field:string, text:string}} evidence  which opportunity field + the phrase
 */

/** Build a validated claim (emitters SHOULD use this). */
export function makeClaim({ dimension, value, scope, strength = 'detected', evidence }) {
  if (!DIMENSIONS.includes(dimension)) return null
  if (!SCOPES.includes(scope)) return null
  const v = String(value ?? '').trim()
  if (!v) return null
  return Object.freeze({
    dimension,
    value: v,
    scope,
    strength,
    evidence: {
      field: String(evidence?.field ?? '').trim() || 'unknown',
      text: String(evidence?.text ?? '').slice(0, 200),
    },
  })
}

const EMITTERS = Object.freeze([emitFieldOfStudy, emitProfession, emitJurisdiction])

/**
 * Every claim an opportunity makes about itself, across all emitters.
 * @returns {Claim[]}
 */
export function deriveSourceClaims(opportunity = {}) {
  const out = []
  for (const emit of EMITTERS) {
    try {
      const claims = emit(opportunity)
      if (Array.isArray(claims)) for (const c of claims) if (c) out.push(c)
    } catch { /* an emitter must never take the pipeline down */ }
  }
  return out
}

// ── Profile side ─────────────────────────────────────────────────────────────
// Reuses the CANONICAL profile-fact readers so this never forks a second
// taxonomy. Each returns a Set of canonical values for the dimension.

import { declaredProfileFields } from '../fieldOfStudyEligibility.js'

/**
 * The profile's facts for a dimension, as a Set of canonical values.
 * @returns {Set<string>}
 */
export function profileFactsFor(dimension, sections = {}, deps = {}) {
  const s = sections && typeof sections === 'object' ? sections : {}
  if (dimension === 'field_of_study') {
    return declaredProfileFields(s)
  }
  if (dimension === 'profession') {
    // Reuse professionEligibility's profile reader when available (injected by
    // the comparator to avoid a hard import cycle in the PoC).
    try {
      // resolveProfileProfessions returns a Set (or array); normalize both.
      const professions = deps.resolveProfileProfessions ? deps.resolveProfileProfessions(s) : []
      return new Set(Array.from(professions || []).map((p) => String(p).toLowerCase()))
    } catch { return new Set() }
  }
  if (dimension === 'jurisdiction' || dimension === 'residency') {
    try {
      const states = deps.profileStates ? deps.profileStates(s) : []
      return new Set((states || []).map((x) => String(x).toUpperCase()))
    } catch { return new Set() }
  }
  return new Set()
}

// ── The comparator ───────────────────────────────────────────────────────────

/**
 * Per-dimension conflict rule: does an APPLICANT-scoped claim value conflict
 * with the profile's facts for that dimension? Returns true only on a PROVABLE
 * mismatch (both sides specific, no overlap); silence on either side is neutral.
 */
function dimensionConflicts(dimension, claimValue, profileValues) {
  if (!profileValues || profileValues.size === 0) return false // profile silent → neutral
  if (dimension === 'field_of_study' || dimension === 'profession') {
    const v = String(claimValue).toLowerCase()
    return ![...profileValues].some((p) => String(p).toLowerCase() === v)
  }
  if (dimension === 'jurisdiction' || dimension === 'residency') {
    const v = String(claimValue).toUpperCase()
    return !profileValues.has(v) // required state not among the profile's states
  }
  return false
}

/**
 * applicantConflicts — the single comparator.
 *
 * For every claim whose SCOPE is applicant/beneficiary, compare to the profile's
 * facts for that dimension; a provable mismatch is a hard conflict. Claims scoped
 * sponsor/institution/service_area/award are NEVER applicant rejects (they inform
 * fit/geography/ranking). This is the one change that dissolves the
 * sponsor-name-trips-applicant class of false positive.
 *
 * @param {Claim[]} claims  from deriveSourceClaims
 * @param {object}  sections  profile sections
 * @param {object}  deps  { resolveProfileProfessions, profileStates }
 * @returns {Array<{dimension,value,scope,evidence,reason}>}
 */
export function applicantConflicts(claims, sections = {}, deps = {}) {
  const conflicts = []
  const factCache = new Map()
  const facts = (dim) => {
    if (!factCache.has(dim)) factCache.set(dim, profileFactsFor(dim, sections, deps))
    return factCache.get(dim)
  }
  for (const c of claims || []) {
    if (!c || !APPLICANT_SCOPES.includes(c.scope)) continue
    if (dimensionConflicts(c.dimension, c.value, facts(c.dimension))) {
      conflicts.push({
        dimension: c.dimension,
        value: c.value,
        scope: c.scope,
        evidence: c.evidence,
        reason: `${c.dimension.replace(/_/g, ' ')}: the award requires "${c.value}" `
          + `(${c.evidence.field}: "${c.evidence.text}") and the profile does not declare it`,
      })
    }
  }
  return conflicts
}

/**
 * SCOPE-AWARE field-of-study conflict — the drop-in replacement for
 * config/fieldOfStudyEligibility.fieldOfStudyConflict, returning the SAME shape
 * ({classId,label,phrase,field,reason}) so makeDecision + the boot net need no
 * other change. The ONLY difference: it fires only on an APPLICANT-scoped field
 * claim, so a field word that is part of the SPONSOR's name ("American Society of
 * Highway ENGINEERS Scholarship") no longer hard-rejects a paramedic — the exact
 * over-rejection the title-only gate #1360 produces.
 *
 * @returns {null|{classId,label,phrase,field,reason}}
 */
export function fieldOfStudyApplicantConflict(sections, opportunity = {}) {
  let claims
  try { claims = emitFieldOfStudy(opportunity) } catch { return null }
  const applicant = (claims || []).filter(
    (c) => c && c.dimension === 'field_of_study' && APPLICANT_SCOPES.includes(c.scope),
  )
  if (applicant.length === 0) return null
  const profileFields = profileFactsFor('field_of_study', sections)
  if (profileFields.size === 0) return null // profile declares no major → neutral
  const declared = new Set([...profileFields].map((f) => String(f).toLowerCase()))
  for (const c of applicant) {
    if (!declared.has(String(c.value).toLowerCase())) {
      return {
        classId: c.value,
        label: c.value,
        phrase: c.evidence.text,
        field: c.evidence.field,
        reason:
          `Field of study: this award is for ${c.value} — its own ${c.evidence.field} says `
          + `"${c.evidence.text}" — and the profile's declared major does not include it`,
      }
    }
  }
  return null
}

export default {
  SCOPES, APPLICANT_SCOPES, DIMENSIONS, makeClaim,
  deriveSourceClaims, profileFactsFor, applicantConflicts,
  fieldOfStudyApplicantConflict,
}
