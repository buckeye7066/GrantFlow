# Security Policy

## Reporting a Vulnerability

Please open a private GitHub security advisory on `buckeye7066/GrantFlow`
(the verified channel), or email **security@axiombiolabs.org** (the
product's live domain — see `vercel.json`; `grantflow.app` is not the
production domain and should not be used). Do **not** file a public issue
for security-relevant findings.

We aim to acknowledge reports within 48 business hours.

## Secret Management

GrantFlow never stores credentials in source control. Every externally
issued credential (OpenAI, Anthropic, Stripe, Railway, Google, JWT
signing keys, database URLs) lives in `process.env` and is loaded via
`backend/config/env.js`.

### Allowed patterns

```
// good
const key = process.env.OPENAI_API_KEY
```

```
// not allowed — rejected by CI (npm run scan:secrets)
const key = 'sk-proj-abc123...'
```

Documentation placeholders (`sk-...`, `sk-ant-your-anthropic-key`,
`AKIAIOSFODNN7EXAMPLE`, `your-api-key`) are tolerated by the scanner.

### Rotation Runbook

If a secret leaks, execute in order:

1. **Revoke**
   - OpenAI: https://platform.openai.com/api-keys → Revoke key
   - Anthropic: https://console.anthropic.com/settings/keys
   - Stripe: https://dashboard.stripe.com/apikeys → Roll key
   - JWT signing key: rotate `JWT_SECRET` in Railway/production env
   - Database URL: rotate DB password; regenerate `DATABASE_URL`

2. **Reissue**
   - Generate a new key/secret from the provider console.

3. **Deploy**
   - Update Railway variables (`railway variables set KEY=value`).
   - Restart the service: `railway redeploy`.

4. **Confirm**
   - Run `npm run scan:secrets` locally — must be `[scan-secrets] OK`.
   - Hit `admin.diagnostics` and verify integrations are `ok`.

5. **Purge history (only if the literal was pushed to git)**
   - Coordinate with a repo admin to rewrite history and force-push to
     `main`. Open a private security advisory documenting the rotation.

### Tooling

| Command | What it does |
| --- | --- |
| `npm run scan:secrets` | Scans the repo for common credential formats. Fails CI on any hit. Uses `gitleaks` when installed, otherwise falls back to a built-in regex sweep that respects `.gitleaks.toml`. |
| `npm run db:check` | Verifies the live DB has the expected schema — prevents drift-induced outages. |
| `npm run safe-sql:check` | Fails CI on template-literal SQL with untrusted interpolation. |
| `npm run profile-scope:check` | Flags route-level SQL that targets tenant-owned tables without a `profile_id` predicate. |

All four run in CI on every PR.

## Supported Versions

Only the latest `main` branch is supported. Patches are not backported.
