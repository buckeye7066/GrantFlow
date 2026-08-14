/**
 * robertOpportunityNormalizer.js
 *
 * Maps a Robert opportunity candidate (output of
 * `robertOpportunityExtractor.extractCandidates`) into the canonical
 * `funding_opportunities` row shape that
 * `backend/services/opportunityInserter.upsertFundingOpportunity`
 * already accepts. Robert never invents new opportunity columns.
 *
 * The normalizer is PURE — no DB writes, no network. Returns an
 * object that should be passed straight into upsertFundingOpportunity.
 */

const RECORD_ORIGIN = 'discovered'

export function normalizeForCanonicalInsert(candidate, { now = new Date() } = {}) {
  if (!candidate) return null

  const geo = candidate.geography || {}
  // GEOGRAPHIC SCOPE IS DECLARED, NEVER INFERRED FROM SILENCE.
  //
  // This used to read `Boolean(geo.is_national) || (!geo.state && applicant_types
  // is empty)` — two defects in one expression. (1) `applicant_types` says WHO may
  // apply, not WHERE; a candidate that simply carried no applicant types was
  // stamped nationwide on the strength of an unrelated field. (2) A row with no
  // state was not merely un-scoped, it was promoted to a fully-eligible NATIONWIDE
  // US program — the exact class CLAUDE.md records as the 2026-08-01 GeneMac
  // finding ("osOppToLiveRow stamps is_national whenever the lane supplies no
  // geography"). MISSING = NEUTRAL: an undeclared scope is left UNSET (stripped
  // below) so the canonical gates treat it as unknown rather than as a claim.
  const isNational = typeof geo.is_national === 'boolean'
    ? geo.is_national
    : (geo.state ? false : undefined)

  const normalized = {
    title: trim(candidate.title),
    sponsor: trim(candidate.sponsor),
    description: trim(candidate.description),
    amount_min: numberOrNull(candidate.amount_min),
    amount_max: numberOrNull(candidate.amount_max),
    amount_description: trim(candidate.amount_description),
    deadline: trim(candidate.deadline),
    deadline_type: trim(candidate.deadline_type) || (candidate.deadline ? 'fixed' : 'unknown'),
    application_url: trim(candidate.application_url),
    apply_url: trim(candidate.application_url),
    source_url: trim(candidate.source_url) || trim(candidate.application_url),
    categories: Array.isArray(candidate.categories) ? candidate.categories.slice() : [],
    keywords: Array.isArray(candidate.keywords) ? candidate.keywords.slice() : [],
    eligibility_bullets: Array.isArray(candidate.eligibility) ? candidate.eligibility.slice() : [],
    applicant_types: Array.isArray(candidate.applicant_types) ? candidate.applicant_types.slice() : [],
    need_categories: Array.isArray(candidate.need_categories) ? candidate.need_categories.slice() : [],
    state: trim(geo.state),
    is_national: isNational,
    source: 'robert',
    source_id: trim(candidate.source_url) || trim(candidate.application_url) || null,
    record_origin: RECORD_ORIGIN,
    raw_source_payload: candidate.raw_payload || null,
    // EXTRACTION IS NOT VERIFICATION. This used to emit
    //   verification_method: extraction_method || 'robert_extractor'
    //   last_verified_at:    now
    // on every candidate, before any probe had run. That is the one combination
    // the canonical inserter's own reality gate cannot defend against:
    // `applyVerificationGate` (services/opportunityInserter.js) strips a
    // caller-supplied `last_verified_at` UNLESS the caller also supplies a
    // non-empty `verification_method` as proof — so supplying an EXTRACTION
    // label as the verification method made the fabricated timestamp survive.
    // Robert's bridge calls the inserter with `verifyUrl: false`, so no probe
    // ever happened. Three downstream harms followed, all of them documented
    // invariants of this repo:
    //   - schema.sql: "last_verified_at = last time the URL was actually probed
    //     … Crawlers are NOT allowed to stamp this without a network check";
    //   - linkVerificationService re-verifies after 30d and SKIPS rows that look
    //     freshly verified, so the row's real target was never probed;
    //   - the boot net `enforceLiveCrawlVerifiedAtHonesty` cannot repair these:
    //     its predicate requires `verification_method IS NULL` AND
    //     `record_origin = 'live_crawl'`, and a Robert row satisfies neither.
    // Both fields are now OMITTED. The inserter then marks the row
    // `link_status: 'unverified'` with a NULL `last_verified_at`, which is what
    // puts it at the FRONT of the real verifier's candidate queue. The
    // extraction method is not lost — it stays on the robert_opportunity_candidates
    // row and inside `normalized_opportunity_json`.
    // WHEN A REAL PROBE HAPPENS: robertVerification.verifyOpportunity already
    // returns a live `link` result under allowLiveWeb + requireRealApplicationUrl,
    // and robertAgent currently DISCARDS it. Stamping the verification fields
    // from that probe is the correct place to earn the timestamp back.
    discovered_at: now.toISOString(),
  }

  // Strip empties so downstream insert validation gets a clean object.
  for (const k of Object.keys(normalized)) {
    if (normalized[k] === null || normalized[k] === undefined || normalized[k] === '') delete normalized[k]
  }
  return normalized
}

function trim(value) {
  if (value === null || value === undefined) return null
  const s = String(value).trim()
  return s.length === 0 ? null : s
}
function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export const ROBERT_RECORD_ORIGIN = RECORD_ORIGIN
export const __testing__ = { trim, numberOrNull }
