# Subscription routing for scheduled discovery

Owner clarification: exhausted paid-provider credit must not prevent discovery when the monthly subscription and free fallback are available. The signed-in Anya path already reached the live Codex subscription worker, but scheduled Amy and Robert discovery had no owner inference scope.

`OWNER_AI_BACKGROUND_ENABLED=true` explicitly authorizes the two internal scheduled workloads to resolve the configured owner from the database and use the existing subscription-first gateway. Default is disabled. Missing, ambiguous, demoted, synthetic, or mismatched owner identities fail closed. Customer requests and ordinary queued jobs gain no owner authority. Background scopes cannot sign durable owner queue parameters.

Amy scheduled/startup runs and Robert's discovery scheduler use bounded detached scopes. Lease cancellation reaches discovery, and the scheduler retains exclusion until the underlying task settles. Robert now renews its lease. Existing paid-fallback policy is unchanged; free/local fallback remains available. A sanitized `owner_subscription_completed` log records workload, provider, and model without prompts or identity data.

Verified: 626 relevant tests across 40 files passed; 12 scope and actual-scheduler regressions passed after the heartbeat repair. Full prepush checks passed, and final changed-file lint passed. Live authenticated bridge status reported enabled, online, and Codex ready before deployment. Actual scheduled subscription receipts and current extraction health still require post-deployment verification.

Operator setup: enable the background flag only for the deployment whose configured OWNER_AI_EMAIL (and optional OWNER_AI_USER_ID) identifies the consenting account. The database account must currently be an admin. The subscription worker must remain connected; readiness alone does not establish successful extraction or complete discovery coverage.
