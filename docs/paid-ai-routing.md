# Paid API fallback configuration

`AI_PAID_ROUTES` is a server-only JSON array; array order is the owner-selected
rank, not a universal model quality ranking. Unset preserves the existing
OpenAI model then Anthropic model defaults. An empty array disables paid routes;
invalid configuration fails closed. No credentials are provisioned by this code.

Example using existing native accounts (inference availability must be probed
separately by the deployment owner):

```json
[
  {"provider":"openai","model":"gpt-4.1"},
  {"provider":"anthropic","model":"claude-sonnet-4-6"},
  {"provider":"openai","model":"gpt-4.1-mini"}
]
```

The first configured native primary runs first, followed by the other native
primary if present, then remaining entries in array order, then existing free
routes. Put Anthropic first to select it as primary. Native accounts use the
existing OPENAI_API_KEY / ANTHROPIC_API_KEY. Explicit `openai: null` still disables
native OpenAI; omission still resolves the server client. Configured route models
take precedence over caller model hints; hints remain supported in legacy mode.

Optional `provider: "compatible"` entries require `model`, an HTTPS `base_url`
without userinfo/query/fragment, and `api_key_env` referencing an existing
`PAID_AI_ROUTE_<NAME>_API_KEY`. No arbitrary credential references or inline keys
are used. Missing keys skip the route. URLs are never taken from invocation
options. Native routes cannot override endpoints or credential references.
At most 24 entries are considered; duplicate account/model pairs are removed.

Only chat-compatible models are supported here: `api: "responses"` and known
native pro/deep-research models are skipped, never silently sent to chat.
Native GPT-5+ and o-series models use `max_completion_tokens` without temperature.
Compatible entries may set `reasoning: true` for that parameter convention.
Deployment must verify each configured model's chat and JSON capabilities.

Receipts add `model` and `billing_mode: "paid_api"`; free receipts carry
`billing_mode: "free_or_local"`. These label the API route, not a price guarantee
or subscription entitlement. No billing, admission, or receipt gates change.

Auth/credit exhaustion cools the account for five minutes. Retryable 429 cools
only that model, honoring Retry-After (seconds or HTTP date), bounded to 1–300
seconds (30 seconds if absent/invalid). Other failures cool the model for five
seconds. State holds at most 256 hashed account/model entries with expiring
timestamps; credential rotation changes the account identity. Configured ladders
share process-local state; legacy calls use request-local state for compatibility.
Tests can inject `paidCircuitState: new Map()` or reset the shared state via
`resetPaidAiCircuitState` in the companion module. Logs and returned diagnostics
exclude upstream messages and credential values.

One caller deadline covers initialization, all attempts and free routes. Each
paid model gets half the remaining paid window when another eligible model
follows; the last gets the rest. The free reserve defaults to six seconds, capped
at half the total budget. SDK retries are disabled per request, cancellation
reaches the active request, and OpenAI JSON truncation gets at most one recovery
inside its original slice, capped at 8192 output tokens with aggregate usage.

The webGrantExtractor call remains 1800 output tokens, sharing its existing page
deadline. No worker or interactive timeout, grounding rule, or eligibility rule
was changed. Mocked tests cover order, fallback, invalid output, cancellation,
cooldown expiry/rotation/bounds, credentials, safe logs, and legacy extraction.
Live inference, production route order, deployment, and improved submitted or
confirmed application counts are outside this verification.
