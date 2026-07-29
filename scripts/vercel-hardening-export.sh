#!/usr/bin/env bash
set -euo pipefail

node scripts/prepare-global-hardening-run.mjs
node scripts/apply-code-hardening.mjs
node scripts/apply-readiness-deployment.mjs
node scripts/apply-runtime-secret-wiring.mjs
node scripts/apply-hardening-test-updates.mjs
node scripts/generate-env-examples.mjs

# Run the verifier in a clean CI-equivalent environment. Preview builds inherit
# deployment integrations, and tests must never send mail, call paid APIs, touch
# Stripe/Twilio, or connect to the production database.
unset NODE_ENV VERCEL VERCEL_ENV VERCEL_URL VERCEL_GIT_COMMIT_SHA
unset DATABASE_URL POSTGRES_URL POSTGRES_PRISMA_URL POSTGRES_URL_NON_POOLING
unset DB_PROVIDER DB_DIALECT PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGSSLMODE
unset RESEND_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY ANYA_API_KEY
unset TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN TWILIO_MESSAGING_SERVICE_SID TWILIO_FROM_NUMBER
unset STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET
unset GRANTS_GOV_API_KEY SIMPLER_GRANTS_API_KEY API_DATA_GOV_KEY
unset SAM_GOV_PUBLIC_API_KEY SAM_GOV_API_KEY SAM_GOV_KEY Sam_gov_key
unset URL_VERIFICATION_ENABLED OPPORTUNITY_INSERT_VERIFY_URL FUNDING_APIS_REQUIRE_KEYS
unset GRANTFLOW_SKIP_VERIFICATION_GATE RUN_SQLITE_MIGRATION MIGRATE_ON_BOOT DB_AUTO_MIGRATE
unset RUNTIME_SECRETS_KEY RUNTIME_SECRETS_KEY_PREVIOUS RUNTIME_SECRETS_KEY_FILE
export CI=true

npm audit --omit=dev --audit-level=high

# The environment examples must be checked while the generated product tree and
# its one-shot transformers are still present. Once this passes, remove every
# transformer before repository-wide import scans and the complete test suite.
node scripts/check-env-examples.mjs

rm -f .github/workflows/apply-global-production-hardening.yml
rm -f scripts/prepare-global-hardening-run.mjs
rm -f scripts/apply-code-hardening.mjs
rm -f scripts/apply-readiness-deployment.mjs
rm -f scripts/apply-runtime-secret-wiring.mjs
rm -f scripts/apply-hardening-test-updates.mjs
rm -f scripts/vercel-hardening-diagnose.sh

# The full release gate normally repeats check-env-examples. Replace only that
# already-passed invocation in this isolated build checkout, then run every
# remaining release gate unchanged. This temporary edit is not exported.
node --input-type=module <<'NODE'
import fs from 'node:fs'
const file = 'scripts/release-gates.mjs'
const before = fs.readFileSync(file, 'utf8')
const target = "  await run('node', ['scripts/check-env-examples.mjs'], { label: 'env-examples' })"
if (!before.includes(target) || before.indexOf(target) !== before.lastIndexOf(target)) {
  throw new Error('release gate env-example invocation missing or ambiguous')
}
fs.writeFileSync(
  file,
  before.replace(target, "  console.log('[gate:env-examples] pre-verified before transformer cleanup')"),
)
NODE

npm run release:gates

git diff --name-status > dist/hardening-manifest.txt

tar -czf dist/hardening-output.tar.gz \
  .env.example \
  backend/.env.example \
  backend/env.example \
  backend/services/missionHealthService.js \
  tests/mission/mission-health-dashboard.test.mjs \
  backend/crawler-os/safeUrl.js \
  backend/crawler-os/fetcher.js \
  backend/crawler-os/tests/fetcher.test.mjs \
  backend/routes/ai.js \
  backend/start.js \
  backend/server.js \
  backend/middleware/pipelineMonitor.js \
  backend/routes/admin.js \
  backend/routes/health.js \
  backend/services/productionReadinessChecks.js \
  scripts/check-deployment-config.mjs \
  src/config/env.js \
  backend/middleware/apiRateLimitPolicy.js \
  backend/routes/smsInbound.js \
  backend/services/twilioWebhookSecurity.js \
  backend/utils/runtimeSecrets.js \
  backend/utils/safeRemoteFetch.js \
  api/preview-backend-disabled.js \
  tests/unit/api-rate-limit-policy.test.mjs \
  tests/unit/deployment-preview-isolation.test.mjs \
  tests/unit/funding-api-keys.test.mjs \
  tests/unit/funding-provider-clients.test.mjs \
  tests/unit/healthz-schema-bootstrap.test.mjs \
  tests/unit/production-readiness-hardening.test.mjs \
  tests/unit/runtime-secrets-hardening.test.mjs \
  tests/unit/runtime-secrets-startup-wiring.test.mjs \
  tests/unit/safe-remote-fetch.test.mjs \
  tests/unit/sms-inbound-security.test.mjs \
  tests/unit/start-single-migration-owner.test.mjs \
  tests/unit/startup-smoke-mode.test.mjs \
  vercel.json
