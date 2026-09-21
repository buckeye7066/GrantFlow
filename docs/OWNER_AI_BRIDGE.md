Owner direct-SDK callers now pass through the same invocation-time policy, including clients constructed before login. Supported text, JSON and authorized function-tool planning use the subscription first, then configured APIs and free/local models according to owner policy. Native-only hosted search tools, streaming, embeddings and image/audio operations are not simulated by the text bridge; when paid fallback is disabled, unsupported owner calls fail explicitly before a metered request. Such an error is not completion evidence.

## September 18 runtime routing correction

Canonical owner calls use the dedicated monthly-subscription bridge first. Per the September 21 owner directive, metered OpenAI/Anthropic API fallback is enabled by default, followed by configured free/local models. Explicit `OWNER_AI_ALLOW_PAID_FALLBACK=false` disables metered fallback. The owner status endpoint and admin card show this policy. Customer traffic never uses the owner subscription.

The extraction timeout is addressed separately in PR #1763 by a bounded page deadline that preserves the owner's ranked strong models. Free model quota cooldowns are model-scoped, respect Retry-After, are invalidated on key rotation, and never hide surviving candidates or record a failed response as a success.

# Owner official-CLI subscription bridge

This is an owner-only, ephemeral bridge to the owner's Home machine. It does not
increase customer capacity or reuse subscription OAuth in an API SDK. No funding,
application, submission, or confirmation outcome has been established by this work.

## Availability and provider order

Server setup requires OWNER_AI_BRIDGE_ENABLED=true plus a dedicated random
OWNER_AI_BRIDGE_TOKEN of at least 32 characters. The worker receives the same
token through DPAPI installation; never use a provider API/OAuth token for it.
Set OWNER_AI_USER_ID to the canonical owner id when an additional id binding is
needed. The default 20000 ms subscription cap is bounded by the caller's whole
budget. Half the caller budget is reserved when metered fallback is
allowed or a free route is configured. With both absent, the owner subscription
can use the full caller budget, still subject to the configured cap. The primary retains 80% of a short worker
window (all but two seconds of a longer window); the next subscription receives
the actual remaining time. A short caller deadline can force fallback to configured free models; metered fallback is enabled by default and can be disabled with OWNER_AI_ALLOW_PAID_FALLBACK=false.

Order is subscription:codex, subscription:claude, then the separately integrated
cloud API fallback. **Codex is implemented:** readiness requires native `exec
--help`, every required supported feature toggle from `features list`, and exact
`Logged in using ChatGPT` native login status (stdout or stderr). Unknown or
failed capability/auth probes remain unavailable; API-key auth is refused.
The local worker's `OWNER_AI_CODEX_MODEL` defaults to `gpt-6-astra`; only a bounded
alphanumeric model identifier with dots, underscores, colons or hyphens is accepted.
Each invocation explicitly selects that model, low reasoning effort, ChatGPT-only
login, read-only sandbox, ephemeral mode, ignored user config and strict config.
Web search, agents, MCP and update-plan are disabled. The supported feature toggles
disabled individually are shell_tool, unified_exec, apps, plugins, remote_plugin,
browser_use, browser_use_external, image_generation, view_image, multi_agent,
tool_suggest, skill_search, skill_mcp_dependency_install, in_app_browser, memories
and sleep_tool. Removed/unsupported toggles never trigger a weaker retry.

Codex accepts bounded NDJSON containing thread/turn start, completed agent-message
items, optional completed reasoning records, and a final turn.completed with actual
input/cached-input/output counters. Reasoning records are validated as non-output
metadata and never included in returned text. At least one completed, nonempty
agent message is required. Tool, command, file-change, MCP, browser, error, failed
or unknown events fail closed, as do malformed records and incomplete turns.
Model attribution is the requested model with `model_source: 'explicit_cli_argument'`,
not an independently reported server model. Positive terminal token usage and the
shared 262144-byte accepted-text limit remain mandatory. Codex's unenforced token
hint is not a truncation verdict; the Claude output-token limit remains enforced.

The worker tries the server's provider order under one deadline, including auth
probes. Each provider gets an independent abort slice reserving time for remaining
providers. Success stops the ladder; native failure/quota exhaustion proceeds to
the next subscription, then returns null for the separate gateway's configured fallback policy.

Claude requires native `auth status --json` to positively report claude.ai with a
Pro or Max subscription and no API-key source. An unknown/null subscription plan,
managed API key, expired login, missing safe-mode flags or any other ambiguity
fails closed. Pending official login is not readiness. The worker checks supported
flags and auth again before each inference. `--safe` (accepted abbreviation for
`--safe-mode`), no tools, no skills, empty strict MCP configuration, empty setting
sources, no Chrome and no session persistence constrain each run. Admin-managed
CLI policy still applies; incompatible policy must leave the provider unavailable.
CLI output must contain a successful terminal result, end_turn, exactly one
reported model and positive token usage below the caller's cap. Quotas, truncation,
empty output and malformed JSON are failures, never success.

Official references: [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference),
[Codex authentication](https://developers.openai.com/codex/auth),
[Claude Code compliance](https://code.claude.com/docs/en/legal-and-compliance).
Only the unmodified native CLI owns provider credentials. The bridge does not read,
copy, upload or configure token files. Subscription quotas and provider terms apply;
this is not unlimited service and must never route other users through the owner.

## Shared gateway integration

Both text and JSON entry points use the same owner-aware gateway. Only a live,
canonical owner request may reach the broker. The subscription slice is bounded
by OWNER_AI_SUBSCRIPTION_TIMEOUT_MS (default 20000 ms, maximum 60000 ms) and the
original request deadline. Half that deadline is reserved only when metered
fallback is explicitly allowed or a free route is configured. An unavailable
worker returns immediately.
A subscription failure leaves only the original remaining budget for permitted fallback and
free routes; closing the owner's response cancels all later attempts too.
Successful receipts preserve provider, model, billing_mode, model_source and usage.
Customer, other-admin and unattended scheduler requests never acquire this scope.
Do not wrap jobs or schedulers in a fabricated owner context.

Worker metadata is cached for no more than 30 seconds between heartbeats. Every
actual execution revalidates native authentication before sending a prompt.

## Home installation (coordinator performs after review/deploy)

Requires current-user Windows, Node, official claude.exe/codex.exe on PATH, and a
stable checkout containing these scripts. No package installation is required.
Run PowerShell in a separate current-user process; never dot-source the wrapper.

1. Use `tools/owner-ai/manage.ps1 -Action LoginClaude` for the official interactive
   login when needed. Codex login is `-Action LoginCodex`. Homes are respectively
   `%LOCALAPPDATA%\GrantFlow\subscriptions\claude` and `...\codex`.
2. Run `tools/owner-ai/manage.ps1 -Action Install -Url https://YOUR-BACKEND-HOST`.
   Enter the dedicated bridge token at the secure prompt. Do not put it in shell
   history, scripts, logs or this repository. The installer stores only a DPAPI
   encrypted token accessible to the current Windows account, plus the public URL.
3. Run `tools/owner-ai/manage.ps1 -Action Start`. The current-user, limited-privilege
   scheduled task starts hidden and also starts on that user's interactive logon.
   Install does not start the worker or change any provider login/configuration.

Alternatively launch `node tools/owner-ai/bridge.mjs` with GRANTFLOW_OWNER_AI_URL
and OWNER_AI_BRIDGE_TOKEN already in its local process environment. Only an explicit
HTTPS origin is accepted, with redirects refused. No listening port is opened.
Every CLI child gets an environment allowlist that strips API keys, auth tokens,
provider overrides, helpers, Node injection and the bridge secret. Prompts go only
through stdin, with shell spawning disabled and a fresh private temporary directory.
Cancellation kills only the owned child process tree; broker cancellation reaches
the worker through its active lease heartbeat (normally within a second).

Home offline, busy, missing auth, exhausted subscription or disabled bridge means
no subscription success; the gateway applies its separate owner billing policy (configured paid APIs, then free/local fallback by default; explicit paid opt-out is honored).
The bridge itself never calls paid APIs or silently substitutes API authentication.

Stop: `tools/owner-ai/manage.ps1 -Action Stop`.
Uninstall: `tools/owner-ai/manage.ps1 -Action Uninstall`; this removes only the
current-user task and its bridge URL/DPAPI secret. Native provider auth homes remain
owned by their CLIs; use official logout separately if wanted. Rotate/disable the
server bridge token to revoke access. No installation was performed in this task.

## Local verification

`node --test tests/unit/ownerAiBridge.test.mjs tests/unit/ownerAiTransport.test.mjs tests/unit/ownerAiCodex.test.mjs`
uses fake child processes and loopback HTTP only; no provider or production calls.
These files are automatically discovered by `scripts/run-unit-tests.mjs` in CI.
The implementation follow-up reproduced 7 failing tests and 1 passing control
before changes. A native metadata/help-only probe then reported Codex ready.
Parent-reported Home evidence established ChatGPT Pro, actual fixed-JSON Codex
completion and a synthetic file-read boundary refusal with no tool events, using
the same strict controls. Those inference calls were not repeated in this follow-up.
This is bounded regression evidence, not universal prompt-injection immunity.
Claude remains pending genuine login. Installation, cloud integration and any
end-to-end funding outcome remain unverified.

## Integration verification, September 18, 2026

The integrated gateway passed 110 focused tests, including subscription-first
routing and cancellation, after four new gateway cases failed before wiring.
The native worker completed a real fixed-JSON request via ChatGPT Pro using
gpt-6-astra in 7793 ms, including metadata probes, with billing_mode subscription
and explicit_cli_argument model provenance. No API key entered the CLI child.
This is local worker proof, not a live cloud request, deployment or acceptance
benchmark claim. Claude subscription login remains unverified.

## Explicit owner account binding

Set server-only `OWNER_AI_EMAIL` to the exact database-backed email of the owner
account used to sign in to GrantFlow when it differs from `ADMIN_EMAIL`. This
setting affects subscription routing only: it does not grant administrator
rights or change agent-control permissions. The caller must still be a real,
resolved database administrator; service/profile tokens remain excluded, and
`OWNER_AI_USER_ID`, when configured, remains an additional exact-ID restriction.
Without this setting the existing canonical administrator-email fallback remains.
Never use a comma-separated alias list or a customer account for this binding.
