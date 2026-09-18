## September 18 runtime routing correction

Canonical owner calls use the dedicated monthly-subscription bridge first. Metered API fallback is now off by default for those calls: only an explicit `OWNER_AI_ALLOW_PAID_FALLBACK=true` allows it. When a subscription cannot answer, the default owner route goes to configured free models or reports failure; it never silently charges an API. The owner status endpoint and admin card show this policy. Ordinary customer and scheduler requests retain the configured paid-to-free order; customer traffic never uses the owner's subscription.

The bounded web extractor explicitly requests task-model priority. Its fast native extraction models precede the general-purpose model ranking without changing the shared deadline or normal callers' ranking. Free model quota cooldowns are model-scoped, respect Retry-After, are invalidated on key rotation, and never hide surviving candidates or record a failed response as a success.

# Paid API fallback configuration

`AI_PAID_ROUTES` is a server-only JSON array; array order is the owner-selected
rank, not a universal model quality ranking. Unset preserves the existing
OpenAI model then Anthropic model defaults. Empty or invalid configuration with zero valid routes recovers the two legacy
native defaults (subject to available credentials and explicit client opt-out),
with sanitized `paid_routes_default_recovery` diagnostics. No credentials are provisioned by this code.

Example ranked paid chain, explicitly selected configuration rather than a
cross-vendor benchmark. The owner reports these identifiers were returned by
official model-list endpoints on 2026-09-18. Catalog metadata is not generation
proof; the parent must verify live inference and account access separately.
This example does not activate production configuration or provision keys.

```json
[
  {"provider":"openai","model":"gpt-6-astra","api":"responses","reasoning_effort":"low"},
  {"provider":"anthropic","model":"claude-fable-5-1","thinking":"adaptive"},
  {"provider":"openai","model":"gpt-5.6-sol","api":"responses","reasoning_effort":"low"},
  {"provider":"anthropic","model":"claude-opus-5","thinking":"adaptive"},
  {"provider":"openai","model":"gpt-5.6-terra","api":"responses","reasoning_effort":"low"},
  {"provider":"anthropic","model":"claude-sonnet-5","thinking":"adaptive"},
  {"provider":"openai","model":"gpt-5.6-luna","api":"responses","reasoning_effort":"low"},
  {"provider":"openai","model":"gpt-4.1","api":"chat"},
  {"provider":"anthropic","model":"claude-haiku-4-5-20251001"}
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

Native OpenAI supports `api: "responses"` through `client.responses.create`,
using `max_output_tokens`, `store:false`, `instructions`/`input`, and
`text.format: {"type":"json_object"}` for JSON. Only completed assistant
`output_text` is accepted; refusals, tool outputs, incomplete, malformed and
empty answers fail. An output-token truncation may retry once within the same
remaining time slice. Usage counters aggregate across that recovery; the
returned Responses model identifier is retained when present.

Optional `reasoning_effort` maps to `reasoning.effort` for native Responses.
Known enum values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`;
model support varies, and the gateway never inserts `none` by default.
`gpt-6-astra` specifically permits only `low`, `medium`, `high`, `xhigh`, `max`.
The strong-route example uses `low`. Native chat behavior remains unchanged:
GPT-5+ and o-series use `max_completion_tokens` without temperature; known
pro/deep-research models require Responses. Compatible routes remain chat-only
and may set `reasoning:true` for the completion-token convention.

Native Anthropic accepts explicitly configured `thinking:"adaptive"` for
`claude-fable-5-1`, `claude-opus-5`, and `claude-sonnet-5`, omitting temperature.
Optional `effort` (`low`, `medium`, `high`, `max`) maps to `output_config.effort`
only with adaptive thinking; no effort is inferred. Other thinking options or
unknown effort values invalidate the route. Legacy Haiku defaults retain their
existing temperature and do not enable thinking. Model-specific generation
capabilities remain subject to live verification.

The existing `amy-web-parity-acceptance.yml` receives the same server-side JSON
from GitHub repository variable `AI_PAID_ROUTES` through its job environment.
Existing provider secrets retain their scopes; the variable is never interpolated
into shell code. This change does not dispatch the workflow.

Receipts add `model` and `billing_mode: "paid_api"`; free receipts carry
`billing_mode: "free_or_local"`. These label the API route, not a price guarantee
or subscription entitlement. No billing, admission, or receipt gates change.

Auth/credit exhaustion cools the account for five minutes. Model-only 403 denials
remain model-scoped so other paid models can still run. Sanitized status and
transient classifications survive cooldowns; Hamilton continues retrying outages
instead of interpreting them as zero-result page facts. Retryable 429 cools
only that model, honoring Retry-After (seconds or HTTP date), bounded to 1–300
seconds (30 seconds if absent/invalid). Other failures cool the model for five
seconds. State holds at most 256 process-salted account/model fingerprints with expiring
timestamps and sanitized failure causes; credential rotation changes the account identity. Configured ladders
share process-local state across chat and Responses API shapes for the same
account/model; legacy calls use request-local state for compatibility.
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

## Live validation follow-up, September 18, 2026

A fixed synthetic request reproduced HTTP 400 because Responses JSON mode
requires the input messages themselves to contain the word JSON; instructions
alone do not satisfy that guard. The gateway now includes its JSON instruction
in the input, with a red/green regression test. All 61 gateway/provider tests
passed. The same live request then completed with gpt-6-astra in 2381 ms,
returned the expected object, and reported paid_api billing and real usage.
This is a single-request dependency proof, not the full acceptance benchmark.

Review follow-up: sanitized provider status and retryability now survive account
cooldowns, model-only 403s no longer block an entire paid account, and account
identities use process-salted KDF identifiers rather than reusable API-key hashes.
The owner bridge rejects impossible token caps, preserves cancellation through
closed response contexts, checks installation prerequisites, and handles native
Windows termination failure. Owner UI loading/error states remain visible.
Verification: 39 Node tests and 97 related Vitest cases passed with no skips;
changed-file lint passed. Final-head CI and deployment remain separate gates.

The full-scan policy also treats API-key fingerprints as credential derivation.
Those identifiers now use process-salted scrypt, memoized within each routing pass
so multiple models on one account share one derivation. No scan threshold is
relaxed. Final failure metadata retains any earlier transient outage, and
Hamilton also recognizes final free-route 429s as retryable.
