# GrantFlow requested funding-use repair: September 22, 2026

## Delivery status
Implemented on fix/axiom-funding-needs-20260922, PR #1813. Not merged or deployed. Base: be2e8bed058da55c5c3521a6423d709ac609d090. Other active crawler and benchmark branches were preserved.

## Reproduced failure
An Axiom-shaped small-business profile requested laboratory premises, equipment, supplies, and research salaries. The shared admission helper reduced those concrete requests to the type-derived business category. A synthetic travel-only award explicitly excluding those expenses then passed through its business category. This was executed against main, not inferred from a screenshot.

## Implemented behavior
- Preserve explicit requested-item wording, including aliases such as equipment, instead of replacing it with a broad category. Preserve established selected-category behavior separately.
- Exclude amount-only fields such as under $1 million, $50k, and ranges with typographic dashes from the needs list. Do not send contact data or negative declarations into request terms.
- Evaluate bounded source-owned funding-use statements from description and actual persisted eligibility columns. Report supported, excluded, conditional, or unknown evidence. This is recorded source wording, not proof that all applicant requirements are satisfied.
- Keep genuine partial support without claiming that a building is covered merely because salaries or equipment are covered. Handle leading no, conflicting terms, approval conditions, rent versus purchase, capacity building versus real property, and restricted supply categories.
- Carry the same verdict through canonical scoring, admission, persisted explanations, and the existing funding result card. Preserve earlier eligibility warnings and hard rejection.
- Hold missing or conditional expense evidence for review. Existing pipeline rows are not deleted merely because expense wording is absent. The boot sweep records needVerificationRequired and retains the canonical REVIEW state. Other definitive eligibility, reality, and source gates remain active.
- Carry saved-grant match evidence only for the active profile authorized by the DB-backed request context. A supplied profile header alone cannot expose another profile's match data. Older schemas retain saved rows without invented evidence.
- Bump matcher version to 4.2.0, profile signal version to 2026.09.22-5, and admission policy generation to 4. Old terminal promotion outcomes are invalidated by the changed policy fingerprint. No schema migration.

## Executed verification
- 26 new native regression cases passed, with failing-before/fixed-after evidence for the original defect and review findings.
- Final focused native run: 73 passed, 0 failed.
- Expanded integration, matcher, promotion, saved-grants API/store/page, and rendered-card run: 24 files, 299 tests passed.
- After the last typographic-budget-range adjustment: final native run repeated at 73/73; changed-file lint passed; profile-signal and declared-need-query validation repeated at 22/22; production build repeated successfully.
- Full profile metadata check, full zero-warning lint, typecheck, and build passed on the reviewed implementation. The final delta was separately linted and rebuilt.
- The broader npm test attempt was NOT green: its native stage reported 3,435 passes and 4 failures out of 3,439. Two matcher-documentation assertions introduced by the version bump were corrected and passed on rerun. The two application-generation timing assertions also failed when the modified executable files were temporarily replaced by unchanged main in the isolated test checkout, then restored byte-for-byte. Those existing failures remain unresolved; no full-suite success is claimed.

## Review and release limits
The nine initial Codex review findings were addressed with code and regression evidence: leading negation; non-destructive cleanup; admission fingerprint invalidation; capacity-building semantics; retained eligibility explanations; scoped saved-card evidence; matching documentation; raw item aliases; and persisted eligibility fields. Addressing findings is not a claim of independent final approval.

Required GitHub Actions checks could not start. Checks 106886552588 and 106886550720 both reported: The job was not started because your account is locked due to a billing issue. Failed-to-start checks were not treated as passing tests or bypassed. The frontend preview is not a deployed backend repair.

Public production health still reported base be2e8bed at the checkpoint. An authenticated live acceptance attempt was blocked before execution by the tool safety check. It was not retried through another route. No production Axiom profile was read or edited, no application was submitted, and no credential or payment was changed.

This is a bounded, tested matching/persistence repair, not certification of whole-product readiness, an exhaustive live Axiom search, or eligibility for a named grant. The full project gate, merge, deployment, and authenticated live acceptance remain open.

## Local evidence locations
Primary checkout: G:\GrantFlow-Axiom-20260922
Isolated test checkout: C:\Users\firer\GrantFlow-Axiom-Test-20260922
Logs: G:\GrantFlow-task-cache\axiom-*-20260922.log
Key records: axiom-project-test-final, axiom-baseline-autopopulate, axiom-release-vitest, axiom-final-native, axiom-final-signal-validation, axiom-final-build.
