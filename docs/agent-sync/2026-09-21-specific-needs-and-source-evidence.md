# Specific needs and source evidence

No new real application or confirmed award is claimed by this change. The owner
asked for crawlers that return real, relevant, non-loan sources meeting the
profile's needs and qualifications. This pass repairs reproduced discovery and
evidence defects; it does not certify every profile or every live provider.

## Changed

- Keep the wording from declared request fields through the live profile bridge
  into early web queries, with a rotating opportunity for additional needs.
  Type defaults, narrative, contacts and budget-only values are not declared
  search subjects. The registered fields are shared with canonical profile
  normalization and pipeline admission. Previously, matching ignored several
  of these fields and substituted default needs.
- A funding query must match its subject before suffix-only results can mark a
  search provider healthy. For example, Microsoft nonprofit software offers
  must not count as a healthy response to a nonprofit passenger-bus query.
  Cached results undergo the same quality test; weak results remain backfill.
- Profile-blind extraction now validates the actual eligibility text and each
  bullet against the captured page, not just an associated quote. The extractor
  version changes so old cached extractions cannot bypass the new validation.
- Marketing copy mentioning students/nonprofits is insufficient prose evidence
  that they may apply. The shared applicant-evidence predicate requires a stated
  eligibility/recipient relationship. Structured eligibility still uses the
  canonical engine and the existing rules.
- A new-loan title cannot escape the shared debt classifier because the
  description advertises possible forgiveness or generic loan assistance.
  Genuine repayment and forgiveness programs remain distinct from new debt.
- Federal funding traces request and retain USAspending's generated internal
  award identifier for detail links and deduplication. Display award numbers
  remain separate; a missing unique identifier does not invent a detail URL.

## Verified

Local commands returned exit 0:

- 274 affected Vitest regressions across 14 files, including profile coverage,
  cross-profile matching, structured eligibility, search, loans and four truths.
- `npm run crawler-os:test`: 537 passed, zero failed or skipped.
- Funding-trace consolidation and fail-closed pipeline tests: 27 passed.
- Earlier focused extraction, provider, item and funding-trace regressions also
  passed. The new request-field test failed before the normalizer repair and
  passed afterward; it rejects turning a dollar budget into a need.

Read-only public live evidence in the workspace scratch receipts:

- `grantflow-funding-trace-repaired.json`: University of Dayton federal search
  returned 260 award rows / 21 funding offices. Three sampled generated-ID award
  detail URLs returned HTTP 200; the earlier display-ID URLs returned 404.
- `grantflow-specific-need-live-search-repaired.json`: bus, wheelchair and home
  repair queries still encountered foreign programs, vendors, directories and
  unrelated results. A search provider's HTTP success is not a qualified match.
- `grantflow-free-fallback-live-smoke.json`: a local model extracted a public
  historical bus donation with a matching source quote in 20.4 seconds. This is
  extraction evidence, not current grant availability or applicant eligibility.

## Remaining limits

The free search provider still has poor recall/precision on some specific needs.
Do not relax admission rules to fill the page. Broad category overlap does not
prove an arbitrary requested item is funded; unclassified needs and missing
eligibility facts still require more source evidence. Historical donors,
directories and vendors are research leads, not current direct awards.

Native owner Codex execution still reports OS error 5 in this workspace. The
application fallback change is separate from repairing that filesystem denial.
No paid setup probe, real submission, email or production profile mutation was
performed for the public source checks above. No new Amy production learning run
is claimed; regression coverage records the reproduced weaknesses in code.
