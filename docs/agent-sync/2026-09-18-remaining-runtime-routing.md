# Remaining runtime routing repairs, September 18

Baseline: main 0ca17c3e72204ab2f47d2b0f64e3e3f00ab84eca. Work is isolated from the locked shared checkout. No matching thresholds, qualification proofs, client histories, or benchmark baselines are relaxed or reset.

## Reproduced production cause

The bounded web extractor requests gpt-4o-mini / claude-haiku-4-5 and a 20-second shared deadline, but the configured general model ranking displaced those explicit task models. Against the same HTTP-200 Caring Place case-management page, the production ranking timed out with zero extracted candidates; a process-local comparison using the requested task model returned Getting Ahead and Access Home candidates in 5.6 seconds. Candidate extraction is not an eligibility or admission claim.

The task-model comparison was diagnostic. Concurrent PR #1763 demonstrated the strong model completing the same class of extraction in about 15 seconds and gives it a bounded 60-second page deadline. This repair defers to that approach and preserves the configured strong-model ranking; no competing task-model priority ships here.

## Owner subscriptions and free fallback

A real dedicated Codex subscription call completed in 7.4 seconds with billing_mode=subscription and valid JSON. The dedicated Claude configuration is not authenticated; its official authorization flow was opened on Home. That missing authorization is not reported as a working subscription.

Canonical owner requests now disable metered API fallback by default. OWNER_AI_ALLOW_PAID_FALLBACK=true is an explicit opt-in. Subscription failure routes to configured free models or an honest failure, never a hidden API charge. Customer and scheduler requests retain paid-to-free routing and cannot borrow the owner's monthly subscription. The status API, admin card, generated configuration examples, and tests expose the same policy.

A live Qwen free-model probe succeeded while the previously configured GPT-OSS model returned 429. Qwen was added to the production free-route list without increasing any budget. Free providers still have independent quotas: a later full-page probe hit limits on all configured free models. Model-scoped cooldowns now honor Retry-After and key rotation and do not prevent another model on the account from answering.

## Source and login follow-through

All three actual Federal Register adapter requests passed from the production container. They also exposed a procedural 60-Day Comment Request incorrectly admitted as a candidate. Both the adapter and canonical normalizer now reject that title form, with the existing drift guard and genuine-NOFO controls preserved.

The original intermittent EVA login failure was not reproduced. A genuinely cold cache required 12.7 seconds for the first journey versus 1.9 seconds warm. Vite now warms the HTML entry and lazy login route; EVA additionally requires stable responses from the app's main and login modules, not only Vite's own client. The original GrantFlow text assertion and startup deadline are unchanged. Three cold/warm reruns passed after the repair; this is evidence for startup hardening, not a claim that every possible intermittent browser failure is eliminated.

## Verification and remaining acceptance

Before repair, four new routing assertions, a repeated free-quota-call assertion, the Federal Register title assertion, the owner status policy check, and the login warmup contract failed. The candidate before removing the now-redundant task-priority change passed 398 tests in 22 suites; the final combination must be rerun. Node owner/configuration and EVA checks passed separately. Exact-head CI, review, deployment and fresh live outcome checks remain mandatory before release.

The four original coverage/cohort/recall/parity findings cannot be closed from code tests or health endpoints. Fresh qualified admissions and healthy cohort/parity receipts must be evaluated on the deployed revision. Old seven-day failure totals remain historical evidence, not data to overwrite.
