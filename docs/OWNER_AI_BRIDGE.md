# Owner official-CLI subscription bridge

This is an owner-only, ephemeral bridge to the owner's Home machine. It does not
increase customer capacity or reuse subscription OAuth in an API SDK. No funding,
application, submission, or confirmation outcome has been established by this work.

## Availability and provider order

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
items and a final turn.completed with actual input/cached-input/output counters.
Tool, command, file-change, MCP, browser, error, failed or unknown events fail closed.
Empty, nonterminal or malformed output fails. Model attribution is the requested
model with `model_source: 'explicit_cli_argument'`, not an independently reported
server model. Output tokens must remain below the caller's cap.

The worker tries the server's provider order under one deadline, including auth
probes. Each provider gets an independent abort slice reserving time for remaining
providers. Success stops the ladder; native failure/quota exhaustion proceeds to
the next subscription, then returns null for the separate gateway's paid ladder.

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

## Integration contract for coordinator

Import `tryOwnerSubscription` from `backend/services/ownerAi/ownerAiBroker.js` at
the top of both existing fallback gateways. Pass `{ format: 'json' | 'text', system,
prompt, maxTokens, signal, timeoutMs }`. Allocate a bounded subscription slice from
the gateway's existing absolute deadline. On null, calculate **remaining** API
time from that original deadline; never reset the deadline or turn zero into a
default. Return a successful bridge result directly, preserving provider, model,
`billing_mode: 'subscription'`, model_source when present, raw, usage, and json/text. No gateway edits are
included here, by assignment. Do not wrap jobs/schedulers in a fabricated scope.

The canonical request-context middleware establishes scope automatically. It
requires resolved real-user identity, admin status, exact trusted stored email
matching trimmed/lowercased configured AGENT_CONTROL_ADMIN_EMAIL (or ADMIN_EMAIL
when absent); trusted ctx.email itself is not normalized here. It requires exact
OWNER_AI_USER_ID if configured. Service/profile tokens and other admins fail.
Response finish/close revokes the scope and cancels pending work.

Configure server OWNER_AI_BRIDGE_ENABLED=true and a dedicated cryptographically
random OWNER_AI_BRIDGE_TOKEN (at least 32 characters; use 32 random bytes encoded
as hex). It is separate from all admin/service secrets. Environment examples are
left to the coordinator. Keep this channel on **one persistent backend process**:
jobs and heartbeats are process-local, so multi-instance/serverless routing without
affinity can lose availability. There are no database migrations or durable prompts.

The worker router `/api/owner-ai/worker` owns a 384 KiB authenticated JSON parser
before the general parser and before user identity middleware. It grants no user
or admin authority. POST /poll advertises readiness and claims one job; POST /result
requires that job's random lease. An active-job poll checks cancellation. One job
total is allowed; concurrent calls immediately fall back. Heartbeat freshness is
15 seconds. Jobs last at most 120 seconds and no longer than the caller budget.
Completion/cancel/timeout releases all broker references to prompts/results.
Worker memory is transient (JavaScript cannot guarantee physical memory zeroing).

GET `/api/admin/owner-ai/status` uses the same exact owner predicate and returns
only readiness/order. Its card appears in the existing Admin screen only after
this owner-only endpoint authorizes it. Customers/other admins see no card.

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
no subscription success; the gateway decides its separate paid-API fallback.
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
