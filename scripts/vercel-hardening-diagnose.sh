#!/usr/bin/env bash
set -euo pipefail

node scripts/prepare-global-hardening-run.mjs
node scripts/apply-code-hardening.mjs
node scripts/apply-readiness-deployment.mjs
node scripts/apply-runtime-secret-wiring.mjs
node scripts/apply-hardening-test-updates.mjs
node scripts/generate-env-examples.mjs

# Vercel preview builds inherit deployment integrations. The test suite must run
# like clean CI, with no ability to send mail, invoke paid models, mutate Stripe,
# or inherit production database/verification switches.
unset NODE_ENV VERCEL VERCEL_ENV VERCEL_URL VERCEL_GIT_COMMIT_SHA
unset DATABASE_URL POSTGRES_URL POSTGRES_PRISMA_URL POSTGRES_URL_NON_POOLING
unset DB_PROVIDER DB_DIALECT PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGSSLMODE
unset RESEND_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY ANYA_API_KEY
unset TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN TWILIO_MESSAGING_SERVICE_SID TWILIO_FROM_NUMBER
unset STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET
unset SAM_GOV_PUBLIC_API_KEY SIMPLER_GRANTS_API_KEY API_DATA_GOV_KEY GRANTS_GOV_API_KEY
unset URL_VERIFICATION_ENABLED FUNDING_APIS_REQUIRE_KEYS GRANTFLOW_SKIP_VERIFICATION_GATE
unset RUN_SQLITE_MIGRATION MIGRATE_ON_BOOT DB_AUTO_MIGRATE
unset RUNTIME_SECRETS_KEY RUNTIME_SECRETS_KEY_PREVIOUS RUNTIME_SECRETS_KEY_FILE
export CI=true

node --test tests/unit/anya-tools.test.mjs
node --test tests/unit/auth-access-check.test.mjs
node --test tests/unit/auth-email-otp.test.mjs
node --test tests/unit/auth-email-production-503.test.mjs
node --test tests/unit/healthz-schema-bootstrap.test.mjs
node --test tests/unit/startup-smoke-mode.test.mjs
node --test tests/unit/runtime-secrets-hardening.test.mjs
node --test tests/unit/runtime-secrets-startup-wiring.test.mjs

npm exec -- vitest run tests/unit/api-rate-limit-policy.test.mjs tests/unit/production-readiness-hardening.test.mjs --reporter=verbose
npm run build
