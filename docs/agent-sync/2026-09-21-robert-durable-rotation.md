# Robert rotates using durable production crawl receipts

## Changed

Production logs showed Robert falling back to profile update recency because `crawler_runs` does not exist in PostgreSQL. That table belongs to the synchronous Crawler OS store, whereas live discovery writes durable coverage receipts to `crawler_source_runs` on both database providers. Profile selection now uses the latest receipt timestamp from the durable table, preserving never-crawled-first and least-recently-crawled ordering, active-profile filtering, and the configured batch cap.

## Verified

The regression uses the production receipt schema and deliberately makes the most recently crawled profile the most recently edited profile. The prior test's edit order accidentally matched the intended crawl order and concealed the fallback. The regression failed before the query repair, then all eight Robert agent tests passed. After inserting a fresh receipt, a second assertion proves rotation advances to other profiles. Targeted ESLint and diff checks passed.

A read-only execution of the replacement query succeeded against production PostgreSQL. It selected the normal capped batch, including never-crawled profiles, and changed ordering compared with update-recency fallback. No production profile was changed or crawl started by that check.

## Unknown

Independent review, required CI, merge, and deployment remain pending. This corrects scheduling fairness; it is not evidence of successful grant submission or full production readiness. The retired exact-50 acceptance requirement remains retired; the existing scheduler batch cap is unrelated.
