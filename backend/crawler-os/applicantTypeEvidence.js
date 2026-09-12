// crawler-os/applicantTypeEvidence.js
//
// ONE predicate for the applicant half of the four-truth `profile_qualifies`
// leg, shared by crawler-os/matchEngine.buildFourTruthProof and
// fundingTruthPolicy.refreshFourTruthProof so the two proof builders cannot
// drift.
//
// Measured 2026-09-11: an independent review of 24 surfaced direct ACCEPTs
// against the funders' own pages found 15 false. Every reviewed
// catalog-rescore-link row stated NO applicant types and still proved
// `profile_qualifies`, because (1) the engine's `applicant_type` signal is a
// substring hit anywhere in title + description ("students", "residents") and
// (2) the proof accepted ANY non-empty eligibility text, including page copy
// such as "Career Services" and "Scholarships & Waivers - Apply Now".
//
// Evidence now means the funder SAID who may apply: stated applicant types, an
// official "unrestricted" applicant code captured from the award detail
// (Grants.gov code 99), or eligibility prose naming the applicant bucket the
// gate matched, at a word boundary. The engine's signal is still required on
// top. A lane's `['*']` fallback means the lane stated nothing, so it is not
// evidence. The profile's own answers are never copied into the opportunity to
// manufacture evidence.
import { APPLICANT_BUCKET_TOKENS } from '../config/applicantBucketTokens.js'
import { grantsGovApplicantCodesFrom } from '../../shared/grantsGovProtocol.js'

/** Grants.gov applicant code for "Unrestricted (open to any type of entity)". */
const UNRESTRICTED_APPLICANT_CODE = '99'

const WILDCARD_APPLICANT_TOKENS = new Set(['*', 'any', 'all', 'anyone', 'unrestricted'])

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value
  const text = value.trim()
  if (!text || !/^[[{]/.test(text)) return value
  try { return JSON.parse(text) } catch { return value }
}

function flattenStrings(value, out = []) {
  const parsed = parseMaybeJson(value)
  if (parsed === null || parsed === undefined) return out
  if (Array.isArray(parsed)) {
    for (const item of parsed) flattenStrings(item, out)
  } else if (typeof parsed === 'object') {
    // Stored eligibility is sometimes {"text": ..., "bullets": [...]}.
    for (const item of Object.values(parsed)) flattenStrings(item, out)
  } else {
    const text = String(parsed).trim()
    if (text) out.push(text)
  }
  return out
}

function unique(values) {
  return [...new Set(values)]
}

function statedApplicantTypes(opportunity, previous) {
  const current = unique(
    flattenStrings([opportunity?.applicant_types, opportunity?.entity_types_allowed])
      .map((t) => t.toLowerCase())
      .filter((t) => !WILDCARD_APPLICANT_TOKENS.has(t)),
  )
  if (current.length > 0) return current
  return unique(flattenStrings(previous?.applicant_type_evidence).map((t) => t.toLowerCase()))
    .filter((t) => !WILDCARD_APPLICANT_TOKENS.has(t))
}

function eligibilityProse(opportunity, previous) {
  const current = unique(flattenStrings([
    opportunity?.eligibility_text,
    opportunity?.eligibility,
    opportunity?.eligibility_requirements,
    opportunity?.eligibility_bullets,
  ]))
  return current.length > 0 ? current : unique(flattenStrings(previous?.eligibility_prose_evidence))
}

function tokenPattern(token) {
  const body = String(token).toLowerCase()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/_/g, '[ _-]')
  return new RegExp(`(^|[^a-z0-9])${body}([^a-z0-9]|$)`)
}

/** The applicant bucket the canonical gate matched, or null when it recorded none. */
export function matchedApplicantBucket(canonical) {
  const explain = canonical?.match_explain ?? {}
  const gate = explain.applicant_type_gate ?? explain.applicantTypeGate ?? null
  const bucket = String(gate?.matched_bucket ?? '').trim().toLowerCase()
  return bucket || null
}

/**
 * Decide whether the opportunity carries applicant evidence the engine matched.
 *
 * @param {object} input
 * @param {object} input.opportunity  catalog row or OS-normalized opportunity
 * @param {object} input.canonical    canonical engine decision (reads match_explain)
 * @param {object} [input.previous]   previous proof's `profile_qualifies` leg, for carry-forward
 * @returns {{ evidenced: boolean, via: string|null, bucket: string|null,
 *             stated_applicant_types: string[], eligibility_prose: string[] }}
 */
export function applicantTypeEvidence({ opportunity, canonical, previous = null } = {}) {
  const explain = canonical?.match_explain ?? {}
  const signals = [...(explain.matchedSignals ?? []), ...(explain.matched_signals ?? [])]
    .map((s) => String(s ?? '').toLowerCase())
  const stated = statedApplicantTypes(opportunity, previous)
  const prose = eligibilityProse(opportunity, previous)
  const bucket = matchedApplicantBucket(canonical)
  const result = { evidenced: false, via: null, bucket, stated_applicant_types: stated, eligibility_prose: prose }

  if (!signals.includes('applicant_type')) return result
  if (stated.length > 0) return { ...result, evidenced: true, via: 'stated_applicant_types' }
  if (grantsGovApplicantCodesFrom(opportunity)?.includes(UNRESTRICTED_APPLICANT_CODE)) {
    return { ...result, evidenced: true, via: 'unrestricted_applicant_code' }
  }

  const tokens = (bucket && APPLICANT_BUCKET_TOKENS[bucket]) || []
  const text = prose.join('\n').toLowerCase()
  const hit = tokens.find((token) => tokenPattern(token).test(text))
  return hit ? { ...result, evidenced: true, via: `eligibility_prose:${hit}` } : result
}

export default { applicantTypeEvidence, matchedApplicantBucket }
