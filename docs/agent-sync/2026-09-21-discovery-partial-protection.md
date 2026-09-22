# Partial discovery must not retire unevaluated funding matches

The owner excluded Amy cohort validation from this readiness pass. This change addresses real applicant discovery reliability and preservation of qualifying pipeline sources.

Two regressions were reproduced: a 900,000 ms crawl deadline replaced the intended 60,000 ms page extraction budget, and an all-503 full refresh deleted a previously accepted award. Extraction now uses the smaller of the caller's remaining budget and 60 seconds. Incomplete source, search, extraction, or deadline evidence selects evaluated-pair reconciliation with an explicit primary profile. Fresh evaluated rejections continue to apply through the existing persistence gate.

A mixed source can find awards and still fail later requests. Source summaries now retain partial_failure and its reason separately from outcome=ok; the service preserves unevaluated matches and the coverage dashboard records both the successful count and the partial failure. Clean complete refreshes retain full reconciliation.

Validation: 82 crawler-service/extractor tests and 545 crawler tests passed. The long-deadline, all-503 preservation, and partial-success coverage regressions failed before their fixes. Independent review identified the mixed-source hole; it is fixed with a live-service regression. Local pre-push validation passed, including lint, backend smoke, and the production build. GitHub Actions continues to refuse startup with an account billing lock as of 2026-09-22T00:29Z; these changes are not deployed.

Operational evidence is separate from these code changes: free cloud extraction can succeed but also hits rate limits under real profile workload; a single successful request is not a fleet health verdict. Findhelp returns a Cloudflare 403 from production. An unsupported legacy scholarship identity was archived with an audit trail; its amount was not invented or marked none-published. Genuine existing school scholarship pipeline records were retained. Private receipts remain outside Git.

