# 2026-09-22 requested funding-use evidence

Scope: explicit requested expenses through the shared need gate, canonical adapter, and funding result card. Based on main be2e8bed058da55c5c3521a6423d709ac609d090. Other active crawler/benchmark branches were not changed.

Reproduced on main: a small-business profile requesting laboratory building, equipment, supplies and research salaries yielded only business as its declared need. A travel-only award excluding those costs then passed the need gate through its business category.

Changes: preserve concrete requests; retain legacy selected canonical need tags, but do not replace concrete requests with type/tag defaults. Evaluate recorded source funding-use statements conservatively with supported/excluded/conditional/unknown evidence. Missing support is REVIEW, not fabricated applicant ineligibility. Preserve partial support and pre-existing hard rejection. Use the same predicate in canonical matching and pipeline admission, and expose evidence in result cards. Matcher 4.2.0; signal version 2026.09.22-5 with pinned derivation files. No database schema changes.

Executed so far: initial red assertions reproduced the defect; 15 new native regressions pass. Focused Vitest run: 7 files, 102 tests pass, including the legacy pipeline sweep, admission, eligibility-confirmation and research guards, and rendered funding cards. An initially observed legacy need-tag regression was corrected. A project npm test attempt was interrupted while linting when that focused regression was found; final full verification must not be inferred from focused counts.

Release: production health still reports be2e8bed. GitHub check 106574489110 has the explicit annotation: The job was not started because your account is locked due to a billing issue. This branch has not been deployed. Do not bypass the required release checks or treat synthetic tests as a live Axiom funding search.

Known limits: source expense parsing is deliberately conservative and bounded. Unknown or truncated/unrecognized wording is not positive coverage. Existing source capture, applicant eligibility, geography, and four-truth proof gates remain required. The change does not claim exhaustive funding discovery or grant eligibility.
