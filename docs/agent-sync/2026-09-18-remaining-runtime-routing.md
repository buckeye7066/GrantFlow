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

## Measured legacy gap queue defect

Production held older benchmark seeds marked gated_out without a gate or outcome record, while a later per-page ledger explicitly recorded extraction_failed. Those records were excluded from all future seed attempts. The new row-aware pending predicate reoffers only this positively evidenced legacy case, under the existing cooldown and offer cap. Genuine gate decisions, owner dismissals, other producers, unrelated profiles, and exhausted attempts remain untouched. Reads do not rewrite history; an actual new offer preserves the legacy claim beside its newly measured outcome. Admin backlog counts and queue retention use the same predicate. Four new assertions failed first, then all 130 parity/replay/admin/acceptance tests passed.

## Owner API bypass and final dependency closure

A real integration reproduced direct OpenAI calls in owner Anya chat bypassing the subscription gateway. The tool-calling chat now uses provider-neutral JSON planning for owner/subscription/free fallback while executing only the existing authenticated tool registry. Direct OpenAI factory clients and runtime Anthropic clients now check owner scope at invocation, including cached clients. Supported text/JSON/tool calls use the shared gateway; native-only operations fail closed rather than silently charging or pretending a provider-only tool ran. The gateway unwraps native clients only after its own billing decision, avoiding recursive routing. Non-owner native calls retain their successful path and use the configured fallback after provider quota/auth/server failure.

An actual local protocol integration through the repaired SDK factory, owner scope, broker and dedicated Codex CLI completed in 5.6 seconds with provider subscription:codex and billing_mode subscription, while both API keys were absent and free routes were disabled. This is a real subscription call with synthetic test input, not a claim that a live user clicked the production UI.

Review follow-through adds quota cooldown for classified HTTP-400/no-status exhausted-credit errors, and permits canonical procedural-notice rejection to demote historical linker ACCEPT rows while retaining the row, lane and prior proof history. The strict acceptance dependency probe now allows the same bounded strong-model extraction window instead of imposing a separate 15-second cap; explicit shorter caller bounds remain honored. The combined related suite passed 990 tests across 74 files before the final response-budget propagation and extra guard controls; final CI remains mandatory.

## Resume after interrupted verification

The exact combined tree 45cc110015a3a3cf22e47a4fe156cfcb758ebbad completed 1,066 tests across 81 suites and the full check:prepush before interruption. The script committed that verified merge locally as 5899a5e; it had not yet been pushed. Subsequent review exposed the real owner UI background-message path inheriting an aborted HTTP scope after its 202 acknowledgement. A route-level regression reproduced it. Owner background replies now capture authenticated authority before the acknowledgement and use a separately bounded, single-use job scope. Authorized Stop cancels that job; a rejected cross-session cancellation does not. Synchronous HTTP scope behavior remains unchanged. The explicit native-provider diagnostic no longer treats subscription output as proof of a working Anthropic key. Owner no-metered policy reports not_tested; an explicitly opted-in diagnostic calls only the native provider. All 36 focused follow-through tests pass with no relaxed assertions.
