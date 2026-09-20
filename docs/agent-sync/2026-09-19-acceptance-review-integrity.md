# Release review: honest cache and acceptance evidence

Scope: PR1769, following the deployed 877d8ffc65dedbad076b56bb7564925dab39d3f2 release.

## Repairs
- Cached page facts remain usable but do not count as successful live model calls. Model-health detail reports cached_pages separately. Cache-only runs are unknown; cache plus only failed live calls is unavailable.
- An interrupted acceptance wrapper rejects the child receipt even when that child exits zero. This does not establish which signal ended the previous disconnected run.
- Extractor results expose the actual provider identifier as non-enumerable metadata. Cached results carry no live provider identifier.
- Dependency preflight requires a grounded, non-cached result from a provider named in its declared configuration. A paid, unknown or different route cannot prove a configured free route healthy.

## Verification before commit
- Cache-health regression: two new cases failed with the old healthy/degraded verdicts; after repair, all 38 tests across the ledger, health-ledger and memo suites passed.
- Acceptance regression: the new interruption guard and six provider/metadata cases failed before repair.
- After repair: native isolation suite 5/5; preflight, memo and extractor failure-class suites 54/54.
- The broad npm test run began on the prior clean head and overlapped later edits. Its terminal result is not exact-revision proof for this repair; require fresh checks on the committed revision.

## Still open
- Windows local-free-model installer model availability: creation of its regression test was safety-blocked before execution. No installer source change, installation, task update or alternate retry was performed.
- Real fifty-profile acceptance: run 20260920000801763-3242b3b6 ended without a canonical receipt. Its isolated log stopped at filesystem mtime 2026-09-20T01:15:35.230924330Z; client reported WebSocket reset at 01:16:07Z. No acceptance process or final receipt remained. Cause/signal unknown.
- A synthetic three-program diagnostic returned three grounded facts from the private local model; it is explicitly NOT a cohort benchmark or production-readiness certificate.
- Prior denied worker/provider/ForgePress actions and other portfolio activation gaps remain open. A private local fallback is not monthly ChatGPT subscription activation.
- Railway source still tracks fix/grantflow-production-release-20260919. Change the existing service to main only AFTER a policy-compliant merge, then verify the deployed merge SHA. Do not create a replacement service.

Do not merge with unresolved review defects or claim the fifty-profile requirement passed. Keep all billing boundaries and acceptance criteria unchanged.
