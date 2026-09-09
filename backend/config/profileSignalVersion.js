/**
 * profileSignalVersion.js — WHEN a stored match verdict stops being trusted.
 *
 * `profile_opportunity_matches` is a rolling snapshot: a row's
 * `match_explain_json` records what the engine believed about the PROFILE on
 * the day it scored the pair — its needs, its stage, its geography. That
 * belief is derived by code (`profileHelpers`, `profileNormalizer`, the
 * matcher's own gates). When that code changes, every stored explain is a
 * claim the current code no longer makes — and nothing re-read it.
 *
 * Owner report 2026-09-07: three official housing locators told a student
 * "Why this matched: Veteran / Emergency need". Her profile denies veteran
 * status three times and never mentions an emergency. The rows had been
 * scored on Aug 24 and Sep 5 under a reader that turned `tags` (which the
 * crawler lane fills with applicant types and mined keywords) into NEED
 * categories; that reader was fixed on Sep 5 (#1564) and again here — but
 * `isStaleMatchExplain` only asked whether a `scoring_policy_version` was
 * PRESENT, never whether it was CURRENT, so the stale evidence kept surfacing
 * (291 rows across 20 profiles carried "veteran" on 2026-09-07).
 *
 * THE RULE. Every persisted explain carries `signal_version`. A row whose
 * `signal_version` is not the current one is STALE and the boot drain
 * (`stale_match_explain_refresh`) re-scores it. This constant MUST be bumped
 * whenever any file in `PROFILE_SIGNAL_DERIVATION_FILES` changes — and that
 * is ENFORCED, not remembered: `backend/tests/profileSignalVersion.test.js`
 * hashes those files and fails until the hash below is re-pinned, which the
 * author does with `node scripts/pin-signal-version.mjs` AFTER bumping the
 * version. Bumping without changing the derivation is harmless (one bounded
 * re-score); changing the derivation without bumping is the defect this
 * exists to make impossible.
 */

/** Bump on ANY change to the files below (date + counter). */
// Re-score profiles whose registered applicant ancestry was missing from
// entity normalization or positive applicant-type evidence.
export const PROFILE_SIGNAL_VERSION = '2026.09.09-1'

/** Repo-relative files whose content decides what the engine believes about a profile. */
export const PROFILE_SIGNAL_DERIVATION_FILES = Object.freeze([
  'backend/config/conditionTerms.js',
  'backend/config/conditionSpecificity.js',
  'backend/config/sourceLanes.js',
  'backend/services/profileHelpers.js',
  'backend/services/profileNormalizer.js',
  'backend/services/profileDataPoints.js',
  'backend/config/profileDerivedFacts.js',
  'backend/config/profileFactTimeline.js',
  'backend/config/temporalRelatability.js',
  'backend/config/stageOfLifeEligibility.js',
  'backend/services/matching/needFirstScoringAdapter.js',
  'backend/services/matchEngine.js',
])

/**
 * sha256 over the LF-normalized concatenation of the files above, pinned by
 * `scripts/pin-signal-version.mjs`. The test recomputes it.
 */
export const PROFILE_SIGNAL_DERIVATION_HASH = '8a7643d33d22ea044d5d1aa37f43a2493e59097d0a4e8b2567982959414de01a'

export default { PROFILE_SIGNAL_VERSION, PROFILE_SIGNAL_DERIVATION_FILES, PROFILE_SIGNAL_DERIVATION_HASH }
