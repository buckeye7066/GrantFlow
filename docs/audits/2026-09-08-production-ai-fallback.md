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

## Follow-up from deployed diagnostics

PR #1634 merged as `45a5e8abaa25cd21a399093576467b3495eb35ce` and was
confirmed live through Railway and `/api/version`. At 18:58:35 UTC its new logs
reported an OpenAI JSON parse failure. At 18:58:36 the Anthropic attempt failed
for insufficient credit with `openai_available: true` and
`openai_attempted: true`. Another OpenAI parse failure followed at 18:59:30.
For these requests, OpenAI was attempted; the failure was its unusable response,
not an absent fallback. These logs do not expose the original finish reason or
response, so truncation is not yet proven to explain the live failures.

The follow-up explicitly instructs OpenAI to return a complete JSON object and
adds a single recovery attempt only for SDK-confirmed output truncation. The
retry doubles the initial output ceiling, capped at 8,192 tokens, and stays
inside the existing deadline and free-route time reserve. It may consume
additional tokens; successful recovery combines both requests' token counters.
The helper never treats a truncated prefix as a complete response, nor repairs
partial facts by inventing missing fields. Other invalid output still falls
through to the existing providers. Logs now record a fixed SDK finish reason
and successful truncation recovery, without exposing model output.

After the owner reported Anthropic billing resolved, provider priority remained
OpenAI → Anthropic → configured free routes. Railway's variable-name inventory
showed `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`, but no `FREE_AI_*` or `OLLAMA_*`
configuration. The free-provider code path exists; a production free endpoint
and model still need to be connected. No credentials or endpoints were invented.
