# Requested funding-use implementation plan

Goal: Preserve explicit requests through matching and show which requested expenses the source actually supports.
Architecture: Extend the existing declared-need boundary, not a separate matching engine. Reuse the verdict in canonical scoring, admission, non-destructive reconciliation, and existing result cards. Preserve existing source, identity, applicant eligibility and purpose gates.

- [x] Reproduce the Axiom-shaped failure against main and observe failing regressions.
- [x] Preserve sanitized explicit requests and distinguish budget ranges from needs.
- [x] Add bounded, source-owned expense evidence with partial support and uncertainty.
- [x] Propagate through canonical decisions, admission, cleanup, persistence and scoped saved-card output.
- [x] Correct the initial automated-review findings and execute focused verification.
- [x] Execute the project verification command and separate introduced failures from baseline failures.
- [ ] Obtain a green complete project gate: two unchanged-main application-generation timing tests still fail in this environment.
- [ ] Pass mandatory hosted checks; currently blocked by GitHub account billing.
- [ ] Merge and deploy through the normal release path, then verify an authenticated live Axiom search.

See docs/agent-sync/2026-09-22-requested-funding-use.md for exact evidence and limitations. No synthetic test is represented as a production funding result.
