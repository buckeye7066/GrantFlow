# Source application-link acceptance

GrantFlow only. The broad readiness scope in the billing/crawler resumption note
remains active; exact-50 remains retired.

## CHANGED

Live extraction of the public Cass County Electric RDFC page selected its utility
account link as a grant application. The URL genuinely appeared in the page's
inventory, but it had no application-intent signal. The canonical page-fact
extractor now requires that signal before emitting `apply_url`. Schema-capable
models can select only those application IDs; both prompts describe the same
rule. Intent cannot be borrowed from a sibling link in a shared container, and
explicit utility/newsletter purposes override generic register/application words.
Single-target contextual "Click here" application links remain supported.
Extraction and prompt versions advance to v6 so cached v5 facts cannot
silently retain the former rule. Information links remain separately available.

## VERIFIED

- The utility-link regression failed before the fix and passed afterward.
- 545 crawler-os tests and 37 focused web-extraction/provider tests passed.
- PR #1793 is deployed as `05611627aaa5563a2eb711ca76767d260047737e`; health,
  readiness and data-readiness returned 200 on that build.
- Full-page local inference succeeded in 12.2 seconds after deployment. The
  evidence gate removed invented deadlines/reporting dates and unsupported
  amount/geography citations. This does not certify the model's completeness.
- The earlier discovery job was interrupted by that deployment; its heartbeat
  recovery correctly closed it as failed, with zero recorded results. It is not
  a successful discovery acceptance. Preserve that receipt.
- The selected-profile fix is in PR #1794. Its complete pre-push checks passed;
  complete CI and live retest are still pending at this note's creation.

## UNKNOWN / ongoing

The application-link fix needs review, full release gates, deployment and live
retest. Wait for deployment stabilization before starting another multi-minute
acceptance crawl. No completed Anya reply, successful live discovery, end-user
purchase or externally confirmed application is asserted by these checks.
