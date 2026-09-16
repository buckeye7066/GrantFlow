# 2026-09-16 — P1 readiness claims become measurable

## Owner objective

Close the remaining production-readiness contracts without substituting code
presence for live outcome evidence.

## Changed

- The canonical rules no longer say the profile-blind page-fact extractor is
  unbuilt. They name the wired extraction chain and distinguish unit wiring from
  production population evidence.
- The protected, read-only production database audit now emits two global
  findings:
  - `nationwide_zip_coverage`: a 0/1/2/3+ census over every persisted ZIP,
    counting distinct active URL-backed catalog opportunities only when their
    verification is no more than 30 days old. `sources_found` and a completed
    progress row are reported for comparison but never treated as proof.
  - `page_fact_provenance`: active crawler-origin rows grouped by origin, with
    counts for schema version, provenance, eligibility text, and at least one
    fact carrying both an evidence snippet and source.
- The deterministic-runner wording now describes the implemented contract:
  every active profile is enumerated, while the canonical profile-aware planner
  selects relevant crawler sources. “Every crawler × every profile” is not a
  desired Cartesian contract because it would deliberately run irrelevant
  sources.

## Verified locally

- The new audit-query contract tests pass.
- The existing profile-blind extractor and page-fact persistence suites pass
  (44 tests).
- The production-audit mutation policy still passes all 26 cases and detects all
  four red-flag routes.

## Unknown until the protected production audit runs

- How many claimed ZIPs currently have 0, 1, 2, or 3+ freshly verified sources.
- What share of live crawler-origin rows carry cited page facts.
- Whether either population currently satisfies a release bar. This change
  measures the gaps; it does not manufacture a green result.

## Intentionally deferred

- Broad conversion of inline route-level HTTP 500 responses to the global error
  handler. That requires a route-by-route semantic review so expected client or
  upstream failures are not blindly reclassified. It should be a separate PR
  with typed-error regression coverage for each high-traffic route group.
- Crawler/pipeline rewrites. The existing per-profile scheduler and canonical
  persistence path are the authority; this pass corrects the stale Cartesian
  requirement rather than creating a competing runner.
