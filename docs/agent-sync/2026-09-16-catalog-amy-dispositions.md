# Catalog and Amy production-finding dispositions

## Changed

- Corrected the protected audit's below-threshold query so it measures only
  `accept`/`review` decisions. Rejected rows cannot surface and must not inflate
  this release finding.
- Reclassified `funding_opportunities.profile_id` as discovery provenance, in
  agreement with the live matcher, router, Hamilton, and recall contracts. A
  grouped inventory remains in the report, but a nonzero inventory is not by
  itself "catalog contamination."
- Added the latest exact-cohort Amy flywheel receipt to the protected audit.
  Operators now receive finding classes, issue examples, and run receipts that
  distinguish quality defects from blocked/unevaluable members.

## Verified

- Static contract tests pin all three audit semantics.
- The change is read-only and does not alter matching, display thresholds,
  catalog rows, or Amy results.

## Unknown / production acceptance

- The earlier `42/50 clean` result cannot be honestly fixed or attributed from
  its derived total alone. After deployment, rerun the protected audit and the
  exact-50 Amy/web-parity acceptance. Close the phase only from the fresh
  receipt's `finding_types`, provider health, stage counters, and parity
  dispositions.
- Any remaining accepted/reviewed match below the canonical bar is a real
  choke-point violation. Any suspicious provenance group must be traced to its
  producer and an actual cross-profile visibility path before it is called
  contamination.
