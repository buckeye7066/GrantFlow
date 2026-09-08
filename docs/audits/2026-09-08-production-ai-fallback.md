# Production AI fallback investigation — September 8, 2026

## Verified

Railway and the public version endpoint identified production release
`ded718e4878d183c49127731966d65aca37f2c5c`. Runtime logs between 17:52 and
18:26 UTC contained 59 Anthropic JSON failures reporting insufficient credit.
There were no OpenAI log entries in that filtered interval. Code inspection
established that the shared helper retained OpenAI errors in its return value
but did not log them; absence of those logs is not evidence of OpenAI health.

The shared provider order was OpenAI, Anthropic, then configured free routes,
under one deadline. OpenAI required a caller-supplied client, whereas Anthropic
was created from the environment automatically. `fundingTraceService` omitted
the OpenAI client from its optional AI research-hypothesis request, so that
path skipped a configured OpenAI key. The crawl extraction callers explicitly
supplied clients; the funding-trace defect does not establish the cause of
every observed production error.

Live search logs also showed degraded SearXNG results (rate limits, CAPTCHAs
and a protocol failure) and Brave reaching its existing daily pacing allowance
of 40 searches. Two crawler completion logs reported result counts of 66 and
62. Those counts do not establish qualified grants, applications or awards.

## Changed

Both shared JSON/text helpers now create the optional server OpenAI client
when the argument is omitted. Injected clients and explicit null opt-outs
retain their behavior. Caller review covered routes, discovery/extraction,
funding trace, drafting, portal sync and the intentional Anthropic-only or
already-attempted-OpenAI callers. Response shapes and eligibility gates remain
compatible; no API/UI migration is required.

Provider failures now log fixed diagnostic fields without raw upstream
messages, prompts or keys. Anthropic failure logs identify whether OpenAI was
available and attempted. Credit classification recognizes Anthropic's
"credit balance is too low" wording without requiring the billing footer.
Provider priority, request deadlines and configured search budgets are unchanged.

## Validation and remaining unknowns

The new regression suite initially failed 10 of 16 tests against the old
implementation. After the repair, all 44 tests across provider defaults,
free-route fallback, web extraction and portal extraction passed with mocked
SDKs. This proves routing and diagnostic behavior, not live provider service.

The connected deployment access supplies runtime logs and redacted variable
names, not an authenticated application session. OpenAI key validity and quota,
per-profile eligible results, and confirmed application outcomes have not been
verified in this investigation. The public health response reported normal
operation while provider failures occurred; its diagnostic implementation
checks catalog counts and terminal crawler failures, not model-provider health.
Do not use that response as proof of crawl quality. Deployment and required CI
evidence for this repair are recorded on its pull request.
