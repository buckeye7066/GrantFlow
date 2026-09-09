# Federal crawler qualification evidence

## Changed

The Grants.gov, FEMA and USDA federal adapters now read the matching award's
`fetchOpportunity` synopsis through the shared crawler fetcher. Search2 is used
to discover identities. Its titles and the registry's routing categories no
longer become asserted applicant eligibility. Detail reads are cached per run,
recorded in fetch telemetry, and share a sixty-second deadline. A failed or
mismatched detail retains an unqualified catalog candidate.

The official synopsis supplies purpose, applicant descriptions, additional
eligibility, dates, loan instruments, cost share and award figures. The existing award parser is
shared through `shared/grantsGovProtocol.js`; no second amount rule is introduced.
Structured applicant codes remain in field provenance and reach the canonical
applicant gate on both fresh and persisted rows. A private school cannot inherit
district-only eligibility, and a public agency cannot assume it is a state
government. Unconfirmed identity stays REVIEW.

The shared four-truth validator refuses historical qualification claims whose
capture is only Grants.gov Search2. Refresh preserves the original reality
receipt and marks applicant qualification unproven. Signal version
`2026.09.09-2` triggers the existing bounded refresh.

## Verified before deployment

After the ancestry repair deployed at `e92b427`, the same school-district
scenario stored 126 registry candidates and produced 39 positive machine
verdicts. Inspection showed those verdicts were relying on inferred applicant
types. This is a defect receipt, not evidence of 39 usable grants.

Production returned the actual Impact Aid synopsis: independent school districts,
emergency school-facility construction, a November deadline, and structured
award figures. JAG State Formula explicitly names state governments, while
the old candidate carried the registry's broad applicant list. Those facts
established the missing detail step and the need to preserve narrower identities.

A real senior-profile crawl after the ancestry repair fetched 46 of 50 pages,
extracted 22 candidates and stored 21 web candidates. Its accepted-match count
rose from the original zero to two. These are machine decisions; independent
eligibility and application outcomes have not been established. Several model
extractions timed out, and the paid search fallback was at its daily pace limit.

Regression coverage runs the real pipeline, canonical matcher and proof
validator. It checks detail identity, repeated-hit deduplication, failed reads,
actual amounts, narrow applicant restrictions, cost share and stale proofs.
The original nightly Amy receipt remains 1 clean / 50 evaluated. It must not be
rewritten as a successful post-fix cohort.

## Remaining verification

Finish release checks, merge through the required script, then measure fresh
deployed discovery. Higher stored or accepted counts cannot establish that the
source is real, relevant, meets the declared need and confirms qualification.
