# Owner fallback and retired exact-50 acceptance

Owner directive: remove the 50-profile acceptance test. Admin inference should prefer the ChatGPT subscription, then configured OpenAI/Anthropic APIs, then configured free/local models. This supersedes the earlier no-metered-default requirement for application inference. The Codex coding launcher still uses ChatGPT authentication.

Removed the exact-50 CLI, isolated acceptance service, deployed launcher, subscription-only acceptance context, workflow, npm command and tests dedicated to those removed entry points. Ordinary Amy training, scratch cleanup, learning, crawler tests, billing tests and release gates remain. Historical receipts and dated notes are retained as history, not current acceptance requirements. Removal is a scope decision, not a passing acceptance result.

One owner policy function now supplies the default to the inference gateway, SDK guard, named-provider diagnostic route and owner status API. Absent/empty configuration permits paid fallback; explicit false or malformed values deny it. Production OWNER_AI_ALLOW_PAID_FALLBACK was set to true through Railway, triggering a redeployment. No credential values were retrieved or changed.

Verification: owner JSON/text and SDK routing tests passed. A regression test exercises subscription unavailable -> OpenAI insufficient quota -> Anthropic exhausted credit -> successful free model, asserting order and billing provenance. Explicit no-metered policy and cancellation remain tested.

Native subscription blocker remains: official Codex login status exits 0 with ChatGPT sign-in, but inference exits 1 with Windows access denied during app-server initialization. A focused open-for-write-access probe of the existing app profile installation_id (without reading or writing its contents) returns EPERM. An escalated retry also failed. No auth file was read/copied and no sandbox, ACL or execution policy was weakened. The fallback handles subscription unavailability; it does not prove native subscription inference repaired.
