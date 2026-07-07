/**
 * Canonical INSERT-time relevance floor for the per-profile pipeline.
 *
 * This is the hard floor enforced at the single choke point every crawler /
 * import path funnels through: `saveToProfilePipeline` in
 * services/opportunityMatcher.js. No caller may insert an opportunity whose
 * match score is below this value — the saver computes
 * `effectiveThreshold = max(callerThreshold, RELEVANCE_FLOOR)` so a caller that
 * passes a low/zero `minMatchThreshold` (e.g. a crawler that relaxed its own
 * threshold to 0 to fill a result quota) can never lower the bar below the
 * floor and let junk into the pipeline.
 *
 * Value: 7 on the DATA-POINT scale (owner directive 2026-07-06 evening):
 * the pipeline bar (8) with the unknown-eligibility discount (×0.8) lands
 * just under 7, so this floor admits "bar-worthy coverage, unverified
 * eligibility" and blocks anything with less matched evidence. Mapping from
 * the retired need-anchored 20 is population-preserving — see the
 * calibration block in matchThresholds.js.
 *
 * Relationship to the BOOT-SWEEP purge floor
 * (`RELEVANCE_FLOOR` in startup/enforceInvariants.js, default 15):
 *   - The boot sweep is the destructive net that removes existing rows that
 *     are clearly junk; it is intentionally lenient (15) so it never
 *     over-deletes borderline rows a user might care about.
 *   - This INSERT floor is the first line of defense and is set >= the purge
 *     floor, so the saver never inserts a row that the boot sweep would then
 *     turn around and purge. Per the standing invariant rule, the per-call
 *     gate (here) is the first line of defense; the boot sweep is the net.
 *
 * Override via env `PIPELINE_INSERT_RELEVANCE_FLOOR` for ops tuning; falls back
 * to 7 if unset or non-numeric.
 *
 * NULL / unknown score handling is the saver's responsibility (see
 * opportunityMatcher.js): a NULL match_score is never "junk" and a clearly
 * eligible ACCEPT is not dropped just because the engine produced no number.
 */
const parsed = Number.parseInt(process.env.PIPELINE_INSERT_RELEVANCE_FLOOR || '7', 10)
export const RELEVANCE_FLOOR = Number.isFinite(parsed) && parsed > 0 ? parsed : 7

/**
 * TRUSTED-SOURCE FLOOR EXEMPTION.
 *
 * The 7 INSERT floor is the right bar for the open web (live/geo crawlers that
 * relax their own threshold to fill a quota). But it silently drops legitimately
 * relevant aid scoring 5–6 from sources we have already vetted — partial
 * coverage from a curated catalog, scholarship crawler, or federal feed. Those
 * rows are NOT junk.
 *
 * So: for an opportunity whose `record_origin` is in TRUSTED_RECORD_ORIGINS AND
 * whose decision is NOT REJECT, the effective floor drops to
 * TRUSTED_RELEVANCE_FLOOR (5, the data-point mapping of the old trusted 12).
 * Untrusted/open-web rows keep the full 7 floor, and a REJECT decision still
 * blocks the save regardless of origin — so the precision risk is bounded by
 * (a) the origin allowlist and (b) the hard REJECT gate that runs before the
 * threshold.
 *
 * Override the trusted floor via env `PIPELINE_TRUSTED_RELEVANCE_FLOOR`; falls
 * back to 5 if unset or non-numeric. It is clamped to never exceed
 * RELEVANCE_FLOOR (a "trusted floor" above the normal floor would be nonsense).
 */
const parsedTrusted = Number.parseInt(process.env.PIPELINE_TRUSTED_RELEVANCE_FLOOR || '5', 10)
const trustedRaw = Number.isFinite(parsedTrusted) && parsedTrusted > 0 ? parsedTrusted : 5
export const TRUSTED_RELEVANCE_FLOOR = Math.min(trustedRaw, RELEVANCE_FLOOR)

/**
 * Canonical set of `record_origin` values we consider VETTED enough to qualify
 * for TRUSTED_RELEVANCE_FLOOR. These are curated catalogs, scholarship/school
 * crawlers, federal feeds, and explicitly-verified rows — never the open-web
 * `live_crawl` / `geo_crawl` paths. This is the single source of truth shared by
 * the per-insert gate (services/opportunityMatcher.js) and the boot purge
 * (startup/enforceInvariants.js) so the two can never disagree about which
 * origins are exempt.
 */
export const TRUSTED_RECORD_ORIGINS = Object.freeze([
  'curated_catalog',
  'scholarship_crawler',
  'scholarships',
  'grants_gov',
  'verified_real',
  'school_portal',
])

/**
 * True iff `origin` is a trusted/vetted record origin. Case- and
 * whitespace-insensitive; a null/empty origin is never trusted.
 */
export function isTrustedRecordOrigin(origin) {
  if (origin === null || origin === undefined) return false
  const o = String(origin).trim().toLowerCase()
  if (o === '') return false
  return TRUSTED_RECORD_ORIGINS.includes(o)
}
