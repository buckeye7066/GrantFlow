# Substantive coverage evidence and live acceptance

## Changed

Canonical coverage now excludes mined keywords from both numerator and denominator. Keywords remain topical evidence. Source text must contain the declared phrase or an established synonym; reverse containment and arbitrary specialized-need fragments no longer establish need satisfaction. Persisted matched counts use the same coverage fact classes. Profile signal version advances to invalidate stale explanations through the existing refresh service.

The canonical decision separates ranking coverage from positive need evidence: a full-credit need can be admitted after every substantive hold even when unrelated profile facts lower its coverage score. Unknown applicability, generic listings, and unnamed-condition holds apply regardless of score; all later URL, eligibility-confirmation, and purpose guards remain. No numeric score or threshold is raised or lowered to manufacture an ACCEPT.

## Verified

Synthetic regressions first reproduced keyword score inflation and generic-word credit for specialized biomedical needs. The corrected cases preserve an accepted opportunity that explicitly supports those needs, and a deliberately broad declared research need. Targeted tests: 34 passed. The broader matching/version family passed 1,128 tests in 97 files; the full pre-push checks, typecheck, and production build passed. CI initially exposed four legitimate low-coverage admission regressions. The central decision repair preserved those original assertions; 55 focused tests and 1,450 tests across 115 matching/eligibility files then passed, along with the full pre-push checks and build. Independent review found no blocking issue in either the scoring or admission repair.

Live acceptance since the earlier service-price brief: the authenticated Anya response was traced in runtime logs to `subscription:codex` with no fallback reason. Stripe configuration mapped all 72 payable service prices; a repeat dry run required no creations or mappings. Actual Stripe verification found zero missing, mismatched, or inactive prices, and the signed-in mapping endpoint reported zero missing. This created no customer payment or subscription.

The fresh discovery job completed with 143 stored source records and 81 match records, but was partial and these counts do not establish qualified funding. Live result inspection exposed the coverage defects addressed here. Runtime health and readiness passed after the billing and rotation deployments.

## Unknown / remaining

This scoring change still requires CI, deployment, and live verification of refreshed results. Existing source availability, local inference reliability, actual customer payment lifecycle, and application-to-confirmed-submission acceptance remain distinct gates. GrantFlow is not declared production ready. No external grant or email submission was performed. Private profile evidence and operational receipts remain outside the repository.
