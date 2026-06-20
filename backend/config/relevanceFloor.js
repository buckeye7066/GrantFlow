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
 * Value: 55. This matches `saveToProfilePipeline`'s long-standing default
 * `minMatchThreshold = 55` ("solid matches without being too strict"). It is
 * deliberately NOT 80 — that was a one-time manual prune number, not the
 * standing floor.
 *
 * Relationship to the BOOT-SWEEP purge floor
 * (`RELEVANCE_FLOOR` in startup/enforceInvariants.js, default 50):
 *   - The boot sweep is the destructive net that removes existing rows that
 *     are clearly junk; it is intentionally lenient (50) so it never
 *     over-deletes borderline rows a user might care about.
 *   - This INSERT floor is the first line of defense and is set >= the purge
 *     floor, so the saver never inserts a row that the boot sweep would then
 *     turn around and purge. Per the standing invariant rule, the per-call
 *     gate (here) is the first line of defense; the boot sweep is the net.
 *
 * Override via env `PIPELINE_INSERT_RELEVANCE_FLOOR` for ops tuning; falls back
 * to 55 if unset or non-numeric.
 *
 * NULL / unknown score handling is the saver's responsibility (see
 * opportunityMatcher.js): a NULL match_score is never "junk" and a clearly
 * eligible ACCEPT is not dropped just because the engine produced no number.
 */
const parsed = Number.parseInt(process.env.PIPELINE_INSERT_RELEVANCE_FLOOR || '55', 10)
export const RELEVANCE_FLOOR = Number.isFinite(parsed) && parsed > 0 ? parsed : 55
